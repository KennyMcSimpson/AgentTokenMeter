import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Shared incremental JSONL reader with inode/truncation/shrink detection and torn-line safety.
 *
 * Returns:
 * - null if the file cannot be statted
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

  const replacedOrShrank = Boolean(
    prev &&
      ((prev.ino && prev.ino !== st.ino) ||
        (typeof prev.offset === 'number' && st.size < prev.offset) ||
        (typeof prev.size === 'number' && st.size < prev.size)),
  );
  const reset = Boolean(forceFull || replacedOrShrank || !prev || typeof prev.offset !== 'number');
  const startOffset = reset ? 0 : prev.offset;
  const bytesToRead = st.size - startOffset;

  const records = [];
  let newOffset = startOffset;

  if (bytesToRead > 0) {
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
            // Torn trailing line still being flushed: hold newOffset at lastNl + 1.
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
          // Single incomplete line without newline yet: keep offset unchanged.
        }
      } else {
        newOffset = startOffset + slice.length;
      }
    }
  }

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
