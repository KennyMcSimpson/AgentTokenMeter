import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 6_000;
const RENAME_RETRIES = 6;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

export function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, ms));
}

export function isPidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

/**
 * Canonical filesystem key for cursor maps so mixed slashes or Windows casing
 * never split a single transcript into two cursor entries.
 */
export function canonicalFileKey(filePath) {
  const abs = resolve(String(filePath || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Canonical real-path key (resolving symlinks/junctions) for root-directory deduplication,
 * so a symlinked `~/.codex -> /path/to/codex-home` is never scanned twice while distinct
 * multi-account directories are both discovered.
 */
export function canonicalRealKey(filePath) {
  let target = String(filePath || '');
  try {
    target = realpathSync(target);
  } catch {
    target = resolve(target);
  }
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

export function isPathInsideRoot(filePath, rootDir) {
  const target = canonicalFileKey(filePath);
  const root = canonicalFileKey(rootDir);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

export function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function safeReaddirWithTypes(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function isNotSymlink(filePath) {
  try {
    return !lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Shared recursive log collector (no symlink traversal, bounded depth).
 * Defaults to `.jsonl`; callers may pass custom suffixes such as `['.jsonl', '.jsonl.zst']`.
 */
export function collectJsonlFiles(dir, maxDepth, onFile, options = {}, depth = 0) {
  if (typeof options === 'number') {
    return collectJsonlFiles(dir, maxDepth, onFile, {}, options);
  }
  const extensions =
    Array.isArray(options?.extensions) && options.extensions.length > 0 ? options.extensions : ['.jsonl'];
  if (depth > maxDepth) return;
  for (const entry of safeReaddirWithTypes(dir)) {
    if (!entry.name || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (!isNotSymlink(full)) continue;
    if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (extensions.some((ext) => lower.endsWith(ext))) {
        onFile(full);
      }
    } else if (entry.isDirectory()) {
      collectJsonlFiles(full, maxDepth, onFile, options, depth + 1);
    }
  }
}

/**
 * Atomic UTF-8 (no BOM) file write with Windows EPERM/EBUSY retry protection.
 */
export function atomicWriteFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    let lastErr = null;
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      try {
        renameSync(tmp, filePath);
        return;
      } catch (err) {
        lastErr = err;
        if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
          sleepMs(15 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

export function atomicWriteJson(filePath, obj) {
  atomicWriteFile(filePath, JSON.stringify(obj, null, 2) + '\n');
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Cross-process file mutex backed by exclusive lock creation (`wx`),
 * atomic rename stale-lock reclamation (no unlink TOCTOU), and Windows EPERM retry.
 */
export function withLock(dataDir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const lockFile = join(dataDir, '.ledger.lock');
  const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}\n`;
  const deadline = Date.now() + Math.max(10, waitMs);
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        writeSync(fd, owner);
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      const retryable =
        err &&
        (err.code === 'EEXIST' ||
          (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')));
      if (!retryable) throw err;

      if (err.code === 'EEXIST') {
        try {
          const s = statSync(lockFile);
          if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
            let holderPid = 0;
            try {
              holderPid = Number(readFileSync(lockFile, 'utf-8').split(':')[0]);
            } catch {
              holderPid = 0;
            }
            if (isPidDead(holderPid)) {
              const staleTarget = `${lockFile}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
              try {
                renameSync(lockFile, staleTarget);
                unlinkSync(staleTarget);
              } catch {
                // another worker already reclaimed it
              }
              continue;
            }
          }
        } catch {
          continue;
        }
      }
      sleepMs(15 + Math.floor(Math.random() * 25));
    }
  }

  if (!acquired) {
    const err = new Error('Ledger lock busy; retry shortly.');
    err.code = 'ELOCKED';
    throw err;
  }

  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockFile, 'utf-8') === owner) {
        unlinkSync(lockFile);
      }
    } catch {
      // already removed
    }
  }
}
