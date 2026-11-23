import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import * as zlib from 'node:zlib';

const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';
const MAX_ZSTD_UNCOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB safety cap per archive
const ZSTD_MAGIC = 0xfd2fb528;

export function supportsZstd() {
  return HAS_ZSTD;
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
 * Decompress single-frame or concatenated multi-frame `.zst` buffers safely with a hard output cap.
 * Returns null if truncated/corrupt or if total decompressed size exceeds MAX_ZSTD_UNCOMPRESSED_BYTES.
 */
function decompressZstdAllFrames(compressed) {
  if (!HAS_ZSTD || !Buffer.isBuffer(compressed)) return null;
  if (compressed.length === 0) return Buffer.alloc(0);

  const chunks = [];
  let offset = 0;
  let totalOut = 0;

  while (offset < compressed.length) {
    const remainingCap = MAX_ZSTD_UNCOMPRESSED_BYTES - totalOut;
    if (remainingCap <= 0) return null;
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
    if (info.expectedFcs !== null && info.expectedFcs > remainingCap) return null;

    const exactFrame = frameSlice.subarray(0, info.frameLen);
    const outBuf = zlib.zstdDecompressSync(exactFrame, {
      maxOutputLength: remainingCap,
    });
    if (!Buffer.isBuffer(outBuf)) return null;
    if (info.expectedFcs !== null && outBuf.length !== info.expectedFcs) return null;

    totalOut += outBuf.length;
    if (totalOut > MAX_ZSTD_UNCOMPRESSED_BYTES) return null;
    if (outBuf.length > 0) chunks.push(outBuf);
    offset += info.frameLen;
  }

  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalOut);
}

function parseJsonlBuffer(slice, startOffset, allowIncompleteTail) {
  const records = [];
  let newOffset = startOffset;
  const lastNl = slice.lastIndexOf(0x0a);

  if (lastNl >= 0) {
    let lineStart = 0;
    for (let i = 0; i <= lastNl; i++) {
      if (slice[i] === 0x0a) {
        const lineBuf = slice.subarray(lineStart, i);
        const rawLine = lineBuf.toString('utf-8').replace(/^\uFEFF/, '').trim();
        if (rawLine) {
          try {
            const obj = JSON.parse(rawLine);
            if (obj && typeof obj === 'object') {
              records.push({ obj, byteOffset: startOffset + lineStart });
            }
          } catch {
            // Ignore malformed newline-terminated line
          }
        }
        lineStart = i + 1;
      }
    }
    newOffset = startOffset + lastNl + 1;

    if (lastNl + 1 < slice.length) {
      const trailing = slice.subarray(lastNl + 1).toString('utf-8').replace(/^\uFEFF/, '').trim();
      if (trailing) {
        try {
          const obj = JSON.parse(trailing);
          if (obj && typeof obj === 'object') {
            records.push({ obj, byteOffset: startOffset + lastNl + 1 });
            newOffset = startOffset + slice.length;
          }
        } catch {
          if (!allowIncompleteTail) {
            newOffset = startOffset + slice.length;
          }
        }
      } else {
        newOffset = startOffset + slice.length;
      }
    }
  } else {
    const trailing = slice.toString('utf-8').replace(/^\uFEFF/, '').trim();
    if (trailing) {
      try {
        const obj = JSON.parse(trailing);
        if (obj && typeof obj === 'object') {
          records.push({ obj, byteOffset: startOffset });
          newOffset = startOffset + slice.length;
        }
      } catch {
        if (!allowIncompleteTail) {
          newOffset = startOffset + slice.length;
        }
      }
    } else {
      newOffset = startOffset + slice.length;
    }
  }

  return { records, newOffset };
}

/**
 * Shared incremental JSONL (and whole-file `.jsonl.zst`) reader with
 * inode/truncation/shrink detection and torn-line safety.
 *
 * Returns:
 * - null if the file cannot be statted or zstd decompression is unsupported/corrupt
 * - { unchanged: true } if size, mtimeMs, and ino match the previous cursor
 * - { unchanged: false, reset: boolean, stat, newOffset, records: Array<{ obj, byteOffset }> }
 */
export function readJsonlDelta(filePath, prevCursor, forceFull = false) {
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

  // Compressed `.zst` archives are immutable snapshots: decompress all frames once when changed
  if (String(filePath).toLowerCase().endsWith('.zst')) {
    if (!HAS_ZSTD) return null;
    try {
      const compressed = readFileSync(filePath);
      const plain = decompressZstdAllFrames(compressed);
      if (!plain) return null;
      const { records } = parseJsonlBuffer(plain, 0, false);
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

  if (bytesToRead <= 0) {
    return {
      unchanged: false,
      reset,
      stat: st,
      newOffset: startOffset,
      records: [],
    };
  }

  const buf = Buffer.allocUnsafe(bytesToRead);
  const fd = openSync(filePath, 'r');
  let totalRead = 0;
  try {
    while (totalRead < bytesToRead) {
      const n = readSync(fd, buf, totalRead, bytesToRead - totalRead, startOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
  } finally {
    closeSync(fd);
  }

  const slice = totalRead === bytesToRead ? buf : buf.subarray(0, totalRead);
  const { records, newOffset } = parseJsonlBuffer(slice, startOffset, true);

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
