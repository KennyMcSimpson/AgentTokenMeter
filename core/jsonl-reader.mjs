import { Buffer, constants as bufferConstants } from 'node:buffer';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import * as zlib from 'node:zlib';

const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';
// Default 2 GiB safety cap per `.zst` archive (real multi-day rollouts can exceed 450 MiB).
// Overridable via `TOKEN_METER_MAX_ZSTD_BYTES` or per-call options.
const MAX_BUFFER_BYTES = bufferConstants.MAX_LENGTH;
const DEFAULT_MAX_ZSTD_BYTES = Math.min(2 * 1024 * 1024 * 1024, MAX_BUFFER_BYTES);
const PLAIN_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MiB chunked read for large plain `.jsonl` files
const ZSTD_MAGIC = 0xfd2fb528;

export function supportsZstd() {
  return HAS_ZSTD;
}

function resolveMaxZstdBytes(override) {
  if (Number.isFinite(override) && override > 0) return Math.min(override, MAX_BUFFER_BYTES);
  const envRaw = process.env.TOKEN_METER_MAX_ZSTD_BYTES;
  if (envRaw !== undefined && envRaw.trim()) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, MAX_BUFFER_BYTES);
  }
  return DEFAULT_MAX_ZSTD_BYTES;
}

/**
 * Validate a complete RFC 8878 zstd frame by parsing its Frame Header, walking every
 * 3-byte Block_Header through `Last_Block === 1`, and checking the optional 4-byte checksum.
 * Works for both known-size frames and streaming frames omitting `Frame_Content_Size`.
 * Returns `{ frameLen, expectedFcs }` or `null` if truncated or malformed.
 */
function inspectZstdFrame(buf) {
  if (buf.length < 5) return null;
  if (buf.readUInt32LE(0) !== ZSTD_MAGIC) return null;
  const fhd = buf[4];
  const fcsFlag = (fhd >> 6) & 0x03;
  const singleSegment = (fhd >> 5) & 0x01;
  const contentChecksum = (fhd >> 2) & 0x01;
  const dictIdFlag = fhd & 0x03;
  const winLen = singleSegment ? 0 : 1;
  const dictLen = dictIdFlag === 3 ? 4 : dictIdFlag;
  const fcsLen = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag; // 2, 4, or 8
  const fcsOffset = 5 + winLen + dictLen;
  let pos = fcsOffset + fcsLen;
  if (buf.length < pos) return null;

  let expectedFcs = null;
  if (fcsLen === 1) expectedFcs = buf[fcsOffset];
  else if (fcsLen === 2) expectedFcs = buf.readUInt16LE(fcsOffset) + 256;
  else if (fcsLen === 4) expectedFcs = buf.readUInt32LE(fcsOffset);
  else if (fcsLen === 8) {
    const val = buf.readBigUInt64LE(fcsOffset);
    expectedFcs = val > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(val);
  }

  // Walk RFC 8878 block chain to verify full frame integrity (catches streaming mid-frame truncation)
  while (true) {
    if (pos + 3 > buf.length) return null;
    const bh = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    const lastBlock = bh & 0x01;
    const blockType = (bh >> 1) & 0x03;
    const blockSize = bh >>> 3;
    if (blockType === 3) return null; // Reserved invalid block type
    const payloadLen = blockType === 1 ? 1 : blockSize; // RLE block payload is always 1 byte
    pos += 3 + payloadLen;
    if (pos > buf.length) return null;
    if (lastBlock === 1) break;
  }

  if (contentChecksum) {
    pos += 4;
    if (pos > buf.length) return null;
  }

  return { frameLen: pos, expectedFcs };
}

/**
 * Pre-validate all zstd and skippable frames in `compressed` before emitting any records.
 * Returns an array of data frame descriptors `{ offset, frameLen, expectedFcs }` or `null` if invalid/over-cap.
 */
function inspectAllZstdFrames(compressed, maxZstdBytes) {
  if (!HAS_ZSTD || !Buffer.isBuffer(compressed)) return null;
  if (compressed.length === 0) return [];

  const frames = [];
  let offset = 0;
  let knownOutTotal = 0;

  while (offset < compressed.length) {
    const frameSlice = compressed.subarray(offset);
    if (frameSlice.length >= 8) {
      const magic = frameSlice.readUInt32LE(0);
      if ((magic & 0xfffffff0) === 0x184d2a50) {
        const skipLen = frameSlice.readUInt32LE(4);
        if (8 + skipLen > frameSlice.length) return null;
        offset += 8 + skipLen;
        continue;
      }
    }
    const info = inspectZstdFrame(frameSlice);
    if (!info) return null;
    if (info.expectedFcs !== null) {
      knownOutTotal += info.expectedFcs;
      if (knownOutTotal > maxZstdBytes) return null;
    }
    frames.push({ offset, frameLen: info.frameLen, expectedFcs: info.expectedFcs });
    offset += info.frameLen;
  }

  return frames;
}

function isBlankAsciiBuffer(buf) {
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    i = 3;
  }
  for (; i < buf.length; i++) {
    const c = buf[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) return false;
  }
  return true;
}

function parseLineBuffer(lineBuf, byteOffset, emit, shouldParseLine) {
  if (lineBuf.length === 0 || isBlankAsciiBuffer(lineBuf)) return true;
  if (shouldParseLine && !shouldParseLine(lineBuf)) return true;
  const rawLine = lineBuf.toString('utf-8').replace(/^\uFEFF/, '').trim();
  if (!rawLine) return true;
  try {
    const obj = JSON.parse(rawLine);
    if (obj && typeof obj === 'object') {
      emit(obj, byteOffset);
      return true;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Stateful streaming JSONL line feeder supporting chunked buffers (plain or multi-frame `.zst`)
 * without holding the entire file's parsed objects in memory.
 */
function createLineFeeder({ startOffset = 0, allowIncompleteTail = true, onRecord = null, shouldParseLine = null }) {
  const records = onRecord ? null : [];
  const emit = onRecord || ((obj, byteOffset) => records.push({ obj, byteOffset }));
  let carry = Buffer.alloc(0);
  let carryOffset = startOffset;
  let newOffset = startOffset;

  function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const baseOffset = carryOffset;
    let lineStart = 0;
    let lastNl = -1;

    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        const lineBuf = buf.subarray(lineStart, i);
        parseLineBuffer(lineBuf, baseOffset + lineStart, emit, shouldParseLine);
        lineStart = i + 1;
        lastNl = i;
      }
    }

    if (lastNl >= 0) {
      newOffset = baseOffset + lastNl + 1;
    }

    if (lineStart < buf.length) {
      // Copy remaining tail so the large chunk buffer can be GC'd immediately
      carry = Buffer.from(buf.subarray(lineStart));
      carryOffset = baseOffset + lineStart;
    } else {
      carry = Buffer.alloc(0);
      carryOffset = baseOffset + buf.length;
    }
  }

  function finish() {
    if (carry.length > 0) {
      if (isBlankAsciiBuffer(carry)) {
        newOffset = carryOffset + carry.length;
      } else {
        // Always attempt JSON.parse on trailing non-newline tail when allowIncompleteTail=true
        // so torn lines are never skipped past; honor shouldParseLine only when !allowIncompleteTail
        const filter = allowIncompleteTail ? null : shouldParseLine;
        const ok = parseLineBuffer(carry, carryOffset, emit, filter);
        if (ok || !allowIncompleteTail) {
          newOffset = carryOffset + carry.length;
        }
      }
      carry = Buffer.alloc(0);
    }
    return { records: records || [], newOffset };
  }

  return { push, finish };
}

/**
 * Shared incremental JSONL (and streaming frame-by-frame `.jsonl.zst`) reader with
 * inode/truncation/shrink detection and torn-line safety.
 *
 * Options (optional 4th arg):
 * - `onRecord(obj, byteOffset)`: streaming callback (avoids allocating `records[]` for huge files)
 * - `shouldParseLine(lineBuf)`: optional fast Buffer pre-filter before `JSON.parse`
 * - `maxZstdBytes`: override default 2 GiB zstd decompression safety cap
 *
 * Returns:
 * - null if the file cannot be statted or zstd decompression is unsupported/corrupt/over-cap
 * - { unchanged: true } if size, mtimeMs, and ino match the previous cursor
 * - { unchanged: false, reset: boolean, stat, newOffset, records: Array<{ obj, byteOffset }> }
 */
export function readJsonlDelta(filePath, prevCursor, forceFull = false, options = null) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const prev = prevCursor && typeof prevCursor === 'object' ? prevCursor : null;
  if (
    !forceFull &&
    prev &&
    prev.size === st.size &&
    prev.mtimeMs === st.mtimeMs &&
    (!prev.ino || prev.ino === st.ino)
  ) {
    return { unchanged: true };
  }

  const onStart = typeof options?.onStart === 'function' ? options.onStart : null;
  const onRecord = typeof options?.onRecord === 'function' ? options.onRecord : null;
  const shouldParseLine = typeof options?.shouldParseLine === 'function' ? options.shouldParseLine : null;

  // Compressed `.zst` archives are immutable snapshots: validate all frames, then stream-decompress frame by frame
  if (String(filePath).toLowerCase().endsWith('.zst')) {
    if (!HAS_ZSTD) return null;
    try {
      const maxZstdBytes = resolveMaxZstdBytes(options?.maxZstdBytes);
      const compressed = readFileSync(filePath);
      const frames = inspectAllZstdFrames(compressed, maxZstdBytes);
      if (!frames) return null;

      if (onStart) onStart({ reset: true, stat: st });
      const feeder = createLineFeeder({
        startOffset: 0,
        allowIncompleteTail: false,
        onRecord,
        shouldParseLine,
      });

      let totalOut = 0;
      for (const frame of frames) {
        const remainingCap = maxZstdBytes - totalOut;
        if (remainingCap <= 0) return null;
        const exactFrame = compressed.subarray(frame.offset, frame.offset + frame.frameLen);
        const outBuf = zlib.zstdDecompressSync(exactFrame, { maxOutputLength: remainingCap });
        if (!Buffer.isBuffer(outBuf)) return null;
        if (frame.expectedFcs !== null && outBuf.length !== frame.expectedFcs) return null;
        totalOut += outBuf.length;
        if (totalOut > maxZstdBytes) return null;
        feeder.push(outBuf);
      }

      const { records } = feeder.finish();
      return {
        unchanged: false,
        reset: true,
        stat: st,
        newOffset: st.size,
        records,
      };
    } catch {
      return null;
    }
  }

  const replacedOrShrank = Boolean(
    prev &&
      ((prev.ino && prev.ino !== st.ino) ||
        (typeof prev.offset === 'number' && st.size < prev.offset) ||
        (typeof prev.size === 'number' && st.size < prev.size)),
  );
  const reset = Boolean(forceFull || replacedOrShrank || !prev || typeof prev.offset !== 'number');
  const startOffset = reset ? 0 : prev.offset;
  const bytesToRead = st.size - startOffset;

  if (onStart) onStart({ reset, stat: st });

  if (bytesToRead <= 0) {
    return {
      unchanged: false,
      reset,
      stat: st,
      newOffset: startOffset,
      records: [],
    };
  }

  const feeder = createLineFeeder({
    startOffset,
    allowIncompleteTail: true,
    onRecord,
    shouldParseLine,
  });

  const chunkSize = Math.min(bytesToRead, PLAIN_CHUNK_BYTES);
  const buf = Buffer.allocUnsafe(chunkSize);
  const fd = openSync(filePath, 'r');
  let remaining = bytesToRead;
  let filePos = startOffset;
  try {
    while (remaining > 0) {
      const toRead = Math.min(remaining, chunkSize);
      const n = readSync(fd, buf, 0, toRead, filePos);
      if (n <= 0) break;
      feeder.push(n === buf.length ? buf : buf.subarray(0, n));
      filePos += n;
      remaining -= n;
    }
  } finally {
    closeSync(fd);
  }

  const { records, newOffset } = feeder.finish();
  return {
    unchanged: false,
    reset,
    stat: st,
    newOffset,
    records,
  };
}

export function truncateTitle(text, maxLen = 90) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}
