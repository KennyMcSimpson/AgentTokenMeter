import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFile,
  canonicalFileKey,
  isPathInsideRoot,
  readJsonSafe,
  safeReaddir,
  safeStat,
} from './fs-utils.mjs';
import { getDataDir, prefsMtime } from './pricing.mjs';

// Safe epoch range: 1970-01-01T00:00:00Z .. 9999-12-31T23:59:59.999Z
const MAX_SAFE_TS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export function isValidTimestamp(ts) {
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 && ts <= MAX_SAFE_TS;
}

export function cursorsPath(dataDir = getDataDir()) {
  return join(dataDir, 'cursors.json');
}

export function eventsDir(dataDir = getDataDir()) {
  return join(dataDir, 'events');
}

export function eventKey(e) {
  return `${e.a}:${e.c}:${e.e}`;
}

export function sessionKey(agent, sessionId) {
  return `${agent}:${sessionId}`;
}

/**
 * Normalize raw persisted JSONL event into canonical v2 disjoint schema.
 * Backward compatible with v1 Antigravity Token Meter events `{ c, i, ts, m, k, in, cr, out }`.
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.c !== 'string' || !raw.c) return null;
  const ts = Number(raw.ts);
  if (!isValidTimestamp(ts)) return null;

  const agent = typeof raw.a === 'string' && raw.a ? raw.a : 'antigravity';
  let evId = '';
  if (typeof raw.e === 'string' && raw.e) {
    evId = raw.e;
  } else if (typeof raw.i !== 'boolean' && raw.i !== null && raw.i !== '' && Number.isFinite(Number(raw.i))) {
    evId = String(Number(raw.i));
  } else {
    return null;
  }

  const ev = {
    a: agent,
    c: raw.c,
    e: evId,
    ts,
    m: typeof raw.m === 'string' && raw.m ? raw.m : 'unknown',
    k: typeof raw.k === 'string' && raw.k ? raw.k : 'P',
    in: Math.max(0, Number(raw.in) || 0),
    cr: Math.max(0, Number(raw.cr) || 0),
    cw5: Math.max(0, Number(raw.cw5) || 0),
    cw1h: Math.max(0, Number(raw.cw1h) || 0),
    out: Math.max(0, Number(raw.out) || 0),
    r: Math.max(0, Number(raw.r) || 0),
  };
  const rawSt = typeof raw.st === 'string' ? raw.st.trim().toLowerCase() : '';
  if (rawSt === 'fast' || rawSt === 'priority') ev.st = 'fast';
  else if (rawSt === 'flex') ev.st = 'flex';
  const rawGeo = typeof raw.geo === 'string' ? raw.geo.trim().toLowerCase() : '';
  if (rawGeo === 'us') ev.geo = 'us';
  return ev;
}

function parseMonthFile(fullPath) {
  const parsed = [];
  let text = '';
  try {
    text = readFileSync(fullPath, 'utf-8');
  } catch {
    return parsed;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = normalizeEvent(JSON.parse(line));
      if (e) parsed.push(e);
    } catch {
      // skip corrupted line
    }
  }
  return parsed;
}

export function readCursorsState(dataDir = getDataDir()) {
  const path = cursorsPath(dataDir);
  if (!existsSync(path)) {
    return { version: 2, files: {}, sessions: {} };
  }
  const parsed = readJsonSafe(path, null);
  if (!parsed || typeof parsed !== 'object') {
    return { version: 2, files: {}, sessions: {} };
  }

  const rawFiles = parsed.files && typeof parsed.files === 'object' ? parsed.files : {};
  const files = {};
  for (const [rawPath, cursor] of Object.entries(rawFiles)) {
    if (!cursor || typeof cursor !== 'object') continue;
    const ck = canonicalFileKey(rawPath);
    const existing = files[ck];
    if (!existing || (Number(cursor.offset) || 0) >= (Number(existing.offset) || 0)) {
      files[ck] = cursor;
    }
  }

  const rawSessions = parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
  const sessions = {};
  for (const [key, val] of Object.entries(rawSessions)) {
    if (!val || typeof val !== 'object') continue;
    const agent = typeof val.agent === 'string' && val.agent ? val.agent : 'antigravity';
    const sid = typeof val.sessionId === 'string' && val.sessionId ? val.sessionId : val.convId || key;
    const normalizedKey = key.includes(':') && key.startsWith(`${agent}:`) ? key : sessionKey(agent, sid);
    sessions[normalizedKey] = {
      agent,
      sessionId: sid,
      app: val.app || agent,
      title: val.title || '',
      parentSessionId: val.parentSessionId || val.parentConvId || '',
      firstModel: val.firstModel || '',
      lastModel: val.lastModel || '',
      firstTs: Number(val.firstTs) || 0,
      lastTs: Number(val.lastTs) || 0,
    };
  }

  const out = { version: 2, files, sessions };
  if (parsed.legacyAntigravityImported) {
    out.legacyAntigravityImported = true;
  }
  return out;
}

function compactFilesForStorage(files) {
  if (!files || typeof files !== 'object') return {};
  const out = {};
  for (const [fk, cursor] of Object.entries(files)) {
    if (!cursor || typeof cursor !== 'object') continue;
    // Immutable `.zst` archives are always re-decoded from byte 0 if their stat changes,
    // so persisting incremental resume buffers (`seenTotals`, `recentUr`, etc.) only bloats cursors.json.
    if (fk.toLowerCase().endsWith('.zst')) {
      const {
        prevTotals: _pt,
        seenTotals: _st,
        prevLastSig: _pl,
        lastTcEmitted: _lt,
        recentUr: _ru,
        pendingUnknownEvents: _pu,
        ...slim
      } = cursor;
      out[fk] = slim;
    } else {
      out[fk] = cursor;
    }
  }
  return out;
}

export function writeCursorsState(dataDir, state) {
  const payload = {
    version: 2,
    files: compactFilesForStorage(state.files),
    sessions: state.sessions || {},
  };
  if (state.legacyAntigravityImported) {
    payload.legacyAntigravityImported = true;
  }
  atomicWriteFile(cursorsPath(dataDir), JSON.stringify(payload) + '\n');
  invalidateDirCache(dataDir);
}

export function readExistingEventKeys(dataDir = getDataDir()) {
  const dir = eventsDir(dataDir);
  const keys = new Set();
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const e of parseMonthFile(join(dir, name))) {
      keys.add(eventKey(e));
    }
  }
  return keys;
}

export function readEventsFromDir(targetDir, { filterAgent = '' } = {}) {
  const dir = eventsDir(targetDir);
  const dedup = new Map();
  for (const name of safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()) {
    for (const e of parseMonthFile(join(dir, name))) {
      if (filterAgent && e.a !== filterAgent) continue;
      dedup.set(eventKey(e), e);
    }
  }
  return Array.from(dedup.values());
}

export function mergeSessionMeta(
  state,
  { agent, sessionId, app, title, parentSessionId, firstModel, lastModel, firstTs, lastTs },
) {
  const sk = sessionKey(agent, sessionId);
  const prev = state.sessions[sk] || {};
  const nextFirst =
    firstTs && prev.firstTs ? Math.min(firstTs, prev.firstTs) : firstTs || prev.firstTs || 0;
  const nextLast = Math.max(lastTs || 0, prev.lastTs || 0);
  const useIncomingFirstModel =
    Boolean(firstModel) &&
    (!prev.firstModel || (Boolean(firstTs) && (!prev.firstTs || firstTs < prev.firstTs)));
  const useIncomingLastModel =
    Boolean(lastModel) &&
    (!prev.lastModel || !prev.lastTs || (Boolean(lastTs) && lastTs >= prev.lastTs));
  state.sessions[sk] = {
    agent,
    sessionId,
    app: app || prev.app || agent,
    title: title || prev.title || '',
    parentSessionId: parentSessionId || prev.parentSessionId || '',
    firstModel: useIncomingFirstModel ? firstModel : prev.firstModel || '',
    lastModel: useIncomingLastModel ? lastModel : prev.lastModel || '',
    firstTs: nextFirst,
    lastTs: nextLast,
  };
}

export function appendEventsByMonth(dataDir, events) {
  if (!events.length) return;
  const dir = eventsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const byMonth = new Map();
  for (const raw of events) {
    const e = normalizeEvent(raw);
    if (!e) continue;
    const month = new Date(e.ts).toISOString().slice(0, 7);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = [];
      byMonth.set(month, bucket);
    }
    bucket.push(JSON.stringify(e));
  }
  for (const [month, lines] of byMonth.entries()) {
    appendFileSync(join(dir, `${month}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  }
  invalidateDirCache(dataDir);
}

function matchesReplaceScope(e, scope) {
  if (e.a !== scope.agent || e.c !== scope.sessionId) return false;
  if (e.a !== 'codex') return true;
  if (scope.rolloutId) {
    return e.e.startsWith(`rev:${scope.rolloutId}:`);
  }
  return !e.e.startsWith('rev:');
}

/**
 * Full-rescan / upgrade compaction that preserves archived events from deleted transcripts
 * (including deleted sibling rollouts sharing a Codex thread ID), replaces events only for
 * explicitly targeted file namespaces (`replaceScopes`) or sessions (`replaceSessionKeys`),
 * overwrites matching keys with rebuilt events, and removes orphaned empty month files.
 * Returns `{ survivingSessionKeys: Set<string> }`.
 */
export function compactEventsPreservingArchived(
  dataDir,
  rebuiltEvents,
  { replaceSessionKeys = null, replaceScopes = null } = {},
) {
  const dir = eventsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const existingFiles = safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const replaceSet =
    replaceSessionKeys instanceof Set
      ? replaceSessionKeys
      : Array.isArray(replaceSessionKeys)
        ? new Set(replaceSessionKeys)
        : null;
  const scopesBySession = new Map();
  if (replaceScopes) {
    const iterable = replaceScopes instanceof Map ? replaceScopes.values() : replaceScopes;
    for (const s of iterable) {
      if (!s || !s.agent || !s.sessionId) continue;
      const sk = sessionKey(s.agent, s.sessionId);
      let list = scopesBySession.get(sk);
      if (!list) {
        list = [];
        scopesBySession.set(sk, list);
      }
      list.push(s);
    }
  }
  const merged = new Map();

  for (const file of existingFiles) {
    for (const e of parseMonthFile(join(dir, file))) {
      const sk = sessionKey(e.a, e.c);
      if (replaceSet && replaceSet.has(sk)) {
        continue;
      }
      const scopes = scopesBySession.get(sk);
      if (scopes && scopes.some((s) => matchesReplaceScope(e, s))) {
        continue;
      }
      merged.set(eventKey(e), e);
    }
  }

  for (const raw of rebuiltEvents) {
    const e = normalizeEvent(raw);
    if (e) merged.set(eventKey(e), e);
  }

  const survivingSessionKeys = new Set();
  const byMonth = new Map();
  for (const e of merged.values()) {
    survivingSessionKeys.add(sessionKey(e.a, e.c));
    const month = new Date(e.ts).toISOString().slice(0, 7);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = [];
      byMonth.set(month, bucket);
    }
    bucket.push(e);
  }

  const writtenFiles = new Set();
  for (const [month, list] of byMonth.entries()) {
    list.sort((a, b) => a.ts - b.ts || (a.e < b.e ? -1 : a.e > b.e ? 1 : 0));
    const fileName = `${month}.jsonl`;
    writtenFiles.add(fileName);
    atomicWriteFile(join(dir, fileName), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  // Remove stale month files that no longer contain any deduplicated events
  for (const file of existingFiles) {
    if (!writtenFiles.has(file)) {
      const stalePath = join(dir, file);
      try {
        unlinkSync(stalePath);
      } catch {
        // ignore removal race
      }
      monthFileCache.delete(stalePath);
    }
  }

  invalidateDirCache(dataDir);
  return { survivingSessionKeys };
}

// Per-file parsed cache keyed by `mtimeMs:size:ino`
const monthFileCache = new Map();
// Read-only parsed sessions cache for `cursors.json`, keyed by canonical path
const sessionsFileCache = new Map();
// Whole-ledger assembled snapshot cache keyed by `${canonicalDir}|${monthsKey}`
const MAX_SNAPSHOT_CACHE = 8;
const ledgerSnapshotCache = new Map();

function invalidateDirCache(dataDir) {
  const dirKey = canonicalFileKey(dataDir);
  const cPath = canonicalFileKey(cursorsPath(dataDir));
  sessionsFileCache.delete(cPath);
  for (const key of ledgerSnapshotCache.keys()) {
    if (key.startsWith(`${dirKey}|`)) {
      ledgerSnapshotCache.delete(key);
    }
  }
}

export function clearLedgerCache() {
  monthFileCache.clear();
  sessionsFileCache.clear();
  ledgerSnapshotCache.clear();
}

export function getLedgerFingerprint(dataDir = getDataDir(), { months = null } = {}) {
  const dir = eventsDir(dataDir);
  const allowedMonths = Array.isArray(months) && months.length > 0 ? new Set(months.map((m) => `${m}.jsonl`)) : null;
  const allDiskFiles = safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const files = allowedMonths ? allDiskFiles.filter((f) => allowedMonths.has(f)) : allDiskFiles;
  const fpParts = [];
  for (const name of files) {
    const st = safeStat(join(dir, name));
    if (!st) continue;
    fpParts.push(`${name}=${st.mtimeMs}:${st.size}:${st.ino}`);
  }
  const cs = safeStat(cursorsPath(dataDir));
  const cursorsStamp = cs ? `${cs.mtimeMs}:${cs.size}:${cs.ino}` : 'none';
  return `${fpParts.join('|')}|p=${prefsMtime(dataDir)}|c=${cursorsStamp}`;
}

export function loadLedger(dataDir = getDataDir(), { months = null } = {}) {
  const dir = eventsDir(dataDir);
  const allowedMonths = Array.isArray(months) && months.length > 0 ? new Set(months.map((m) => `${m}.jsonl`)) : null;
  const allDiskFiles = safeReaddir(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  // Prune cache entries for deleted files within this dataDir
  const livePaths = new Set(allDiskFiles.map((f) => join(dir, f)));
  for (const cachedPath of monthFileCache.keys()) {
    if (isPathInsideRoot(cachedPath, dir) && !livePaths.has(cachedPath)) {
      monthFileCache.delete(cachedPath);
    }
  }

  const files = allowedMonths ? allDiskFiles.filter((f) => allowedMonths.has(f)) : allDiskFiles;
  const fileEntries = [];
  const fpParts = [];

  for (const name of files) {
    const fullPath = join(dir, name);
    const st = safeStat(fullPath);
    if (!st) continue;
    const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    fpParts.push(`${name}=${key}`);
    fileEntries.push({ fullPath, key });
  }

  const cPath = cursorsPath(dataDir);
  const cs = safeStat(cPath);
  const cursorsStamp = cs ? `${cs.mtimeMs}:${cs.size}:${cs.ino}` : 'none';
  const dataStamp = `${fpParts.join('|')}|c=${cursorsStamp}`;
  const fingerprint = `${fpParts.join('|')}|p=${prefsMtime(dataDir)}|c=${cursorsStamp}`;

  const monthsKey = allowedMonths ? Array.from(allowedMonths).sort().join(',') : '*';
  const snapKey = `${canonicalFileKey(dataDir)}|${monthsKey}`;
  const cachedSnap = ledgerSnapshotCache.get(snapKey);
  if (cachedSnap && cachedSnap.dataStamp === dataStamp) {
    return {
      events: cachedSnap.events,
      sessions: cachedSnap.sessions,
      fingerprint,
    };
  }

  const dedup = new Map();
  for (const { fullPath, key } of fileEntries) {
    let cached = monthFileCache.get(fullPath);
    if (!cached || cached.key !== key) {
      cached = { key, events: parseMonthFile(fullPath) };
      monthFileCache.set(fullPath, cached);
    }
    for (const e of cached.events) {
      dedup.set(eventKey(e), e);
    }
  }

  const cCanon = canonicalFileKey(cPath);
  let cachedSessions = sessionsFileCache.get(cCanon);
  if (!cachedSessions || cachedSessions.stamp !== cursorsStamp) {
    const state = readCursorsState(dataDir);
    cachedSessions = { stamp: cursorsStamp, sessions: state.sessions };
    if (sessionsFileCache.size >= MAX_SNAPSHOT_CACHE && !sessionsFileCache.has(cCanon)) {
      const oldest = sessionsFileCache.keys().next().value;
      if (oldest !== undefined) sessionsFileCache.delete(oldest);
    }
    sessionsFileCache.set(cCanon, cachedSessions);
  }

  const events = Array.from(dedup.values()).sort(
    (a, b) => a.ts - b.ts || (a.a < b.a ? -1 : a.a > b.a ? 1 : 0) || (a.e < b.e ? -1 : a.e > b.e ? 1 : 0),
  );

  if (ledgerSnapshotCache.size >= MAX_SNAPSHOT_CACHE && !ledgerSnapshotCache.has(snapKey)) {
    const oldestKey = ledgerSnapshotCache.keys().next().value;
    if (oldestKey !== undefined) ledgerSnapshotCache.delete(oldestKey);
  }
  ledgerSnapshotCache.set(snapKey, {
    dataStamp,
    events,
    sessions: cachedSessions.sessions,
  });

  return {
    events,
    sessions: cachedSessions.sessions,
    fingerprint,
  };
}
