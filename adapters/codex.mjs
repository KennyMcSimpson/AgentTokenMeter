import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { canonicalFileKey, collectJsonlFiles, isNotSymlink, isPathInsideRoot } from '../core/fs-utils.mjs';
import { readJsonlDelta, truncateTitle } from '../core/jsonl-reader.mjs';
import { normalizeModel } from '../core/pricing.mjs';
import { isValidTimestamp } from '../core/store.mjs';

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(UUID_SRC, 'gi');
const NATIVE_REVERT_RE = new RegExp(`(${UUID_SRC})_(${UUID_SRC}|[^_]+)$`, 'i');
const LAST_DUP_WINDOW_MS = 10_000;
const TC_UR_HANDOFF_WINDOW_MS = 2_000;
const MAX_SEEN_TOTALS = 256;
const MAX_RECENT_UR = 64;
const FAST_SKIP_LINE_BYTES = 16 * 1024;
const CODEX_EXTENSIONS = ['.jsonl', '.jsonl.zst'];

// Bump when rollout identity / parsing semantics change so legacy cursors self-heal on next sync.
export const CODEX_PARSER_VERSION = 2;

function cleanModel(raw) {
  return typeof raw === 'string' && raw.trim() ? normalizeModel(raw) : '';
}

function normalizeDisjointUsage(stepUsage) {
  if (!stepUsage) return null;
  const crTok = Math.max(0, Math.min(stepUsage.cr, stepUsage.in));
  const cwTok = Math.max(0, Math.min(stepUsage.cw, stepUsage.in - crTok));
  const uncachedIn = Math.max(0, stepUsage.in - crTok - cwTok);
  const outTok = Math.max(0, stepUsage.out);
  const reasoningTok = Math.max(0, Math.min(stepUsage.r, outTok));
  if (uncachedIn + crTok + cwTok + outTok === 0) return null;
  return { in: uncachedIn, cr: crTok, cw5: cwTok, out: outTok, r: reasoningTok };
}

function readUsageTuple(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const hasIn = obj.input_tokens !== undefined;
  const hasCr = obj.cached_input_tokens !== undefined;
  const hasCw = obj.cache_write_input_tokens !== undefined;
  const hasOut = obj.output_tokens !== undefined;
  const hasR = obj.reasoning_output_tokens !== undefined;
  if (!hasIn && !hasCr && !hasCw && !hasOut && !hasR) return null;
  return {
    in: Math.max(0, Number(obj.input_tokens) || 0),
    cr: Math.max(0, Number(obj.cached_input_tokens) || 0),
    cw: Math.max(0, Number(obj.cache_write_input_tokens) || 0),
    out: Math.max(0, Number(obj.output_tokens) || 0),
    r: Math.max(0, Number(obj.reasoning_output_tokens) || 0),
    hasCr,
    hasCw,
    hasR,
  };
}

function tuplesEqual(a, b) {
  if (!a || !b) return false;
  return a.in === b.in && a.cr === b.cr && a.cw === b.cw && a.out === b.out && a.r === b.r;
}

function totalSig(t) {
  return `${t.in}:${t.cr}:${t.cw}:${t.out}:${t.r}`;
}

function extractCodexUserText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item.type === 'input_text' || item.type === 'text') && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join(' ');
}

function cleanCodexTitle(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (
    s.startsWith('<environment_context>') ||
    s.startsWith('# AGENTS.md') ||
    s.startsWith('<INSTRUCTIONS>') ||
    s.startsWith('<permissions ')
  ) {
    return '';
  }
  return truncateTitle(s.replace(/<[^>]+>/g, ' '));
}

function stripCodexExtensions(filePath) {
  let name = basename(filePath);
  if (name.toLowerCase().endsWith('.zst')) name = name.slice(0, -4);
  if (name.toLowerCase().endsWith('.jsonl')) name = name.slice(0, -6);
  return name || 'unknown';
}

function extractRolloutMetaFromStem(stem) {
  // 1. Explicit `-revert-` format takes precedence over `_` suffix matching:
  //    `rollout-...-<threadId>-revert-<rolloutId>`
  const revertIdx = stem.toLowerCase().indexOf('-revert-');
  if (revertIdx > 0) {
    const threadPart = stem.slice(0, revertIdx);
    const revertPart = stem.slice(revertIdx + '-revert-'.length);
    const threadMatches = threadPart.match(UUID_RE);
    const fileThreadId =
      threadMatches && threadMatches.length > 0 ? threadMatches[threadMatches.length - 1].toLowerCase() : '';
    const revMatches = revertPart.match(UUID_RE);
    const rolloutId =
      revMatches && revMatches.length > 0 ? revMatches[revMatches.length - 1].toLowerCase() : revertPart.toLowerCase();
    const allMatches = !fileThreadId ? stem.match(UUID_RE) : null;
    const sessionId =
      fileThreadId || (allMatches && allMatches.length > 0 ? allMatches[allMatches.length - 1].toLowerCase() : stem);
    return { sessionId, fileThreadId, rolloutId };
  }

  // 2. Native Codex 0.171+ revert/fork rollout format: `rollout-...-<threadId>_<rolloutId>`
  const nativeMatch = NATIVE_REVERT_RE.exec(stem);
  if (nativeMatch) {
    const fileThreadId = nativeMatch[1].toLowerCase();
    const rolloutId = nativeMatch[2].toLowerCase();
    return { sessionId: fileThreadId, fileThreadId, rolloutId };
  }

  // 3. Standard rollout format: `rollout-...-<threadId>`
  const matches = stem.match(UUID_RE);
  const fileThreadId = matches && matches.length > 0 ? matches[matches.length - 1].toLowerCase() : '';
  return { sessionId: fileThreadId || stem, fileThreadId, rolloutId: '' };
}

function pushUniqueRoot(dir, out, seen) {
  const key = canonicalFileKey(dir);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(dir);
}

function addExistingRoots(baseDir, out, seen) {
  const sessionsDir = join(baseDir, 'sessions');
  const archivedDir = join(baseDir, 'archived_sessions');
  let addedSub = false;
  if (existsSync(sessionsDir) && isNotSymlink(sessionsDir)) {
    pushUniqueRoot(sessionsDir, out, seen);
    addedSub = true;
  }
  if (existsSync(archivedDir) && isNotSymlink(archivedDir)) {
    pushUniqueRoot(archivedDir, out, seen);
    addedSub = true;
  }
  return addedSub;
}

export function discoverCodexSessionRoots() {
  const roots = [];
  const seen = new Set();
  if (process.env.TOKEN_METER_CODEX_ROOTS !== undefined) {
    const raw = process.env.TOKEN_METER_CODEX_ROOTS.trim();
    if (!raw) return [];
    for (const entry of raw.split(delimiter)) {
      const dir = entry.trim();
      if (!dir || !existsSync(dir) || !isNotSymlink(dir)) continue;
      if (!addExistingRoots(dir, roots, seen)) {
        pushUniqueRoot(dir, roots, seen);
      }
    }
    return roots;
  }

  const base = process.env.CODEX_HOME ? process.env.CODEX_HOME.trim() : join(homedir(), '.codex');
  addExistingRoots(base, roots, seen);
  return roots;
}

function extractUsageRecord(obj) {
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  if (obj.type === 'token_usage_record') {
    const usage = obj.usage || payload?.usage;
    if (usage && typeof usage === 'object') {
      const rawRespId = obj.response_id || payload?.response_id || '';
      return {
        usage,
        model: cleanModel(obj.model || payload?.model),
        responseId: typeof rawRespId === 'string' ? rawRespId.trim() : '',
      };
    }
  }
  if (obj.type === 'event_msg' && payload?.type === 'token_usage_record' && payload.usage) {
    const rawRespId = payload.response_id || obj.response_id || '';
    return {
      usage: payload.usage,
      model: cleanModel(payload.model),
      responseId: typeof rawRespId === 'string' ? rawRespId.trim() : '',
    };
  }
  return null;
}

function extractParentSessionId(payload) {
  const candidates = [
    payload.parent_thread_id,
    payload.forked_from_id,
    payload.source?.subagent?.thread_spawn?.parent_thread_id,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return '';
}

export const codexAdapter = {
  id: 'codex',
  label: 'Codex',
  parserVersion: CODEX_PARSER_VERSION,

  discoverSources() {
    const out = [];
    for (const root of discoverCodexSessionRoots()) {
      collectJsonlFiles(
        root,
        5,
        (full) => {
          out.push({ ...codexAdapter.inferMeta(full), filePath: full });
        },
        { extensions: CODEX_EXTENSIONS },
      );
    }
    return out;
  },

  inferMeta(filePath) {
    const stem = stripCodexExtensions(filePath);
    const { sessionId, fileThreadId, rolloutId } = extractRolloutMetaFromStem(stem);
    return {
      agent: 'codex',
      app: 'codex',
      sessionId,
      fileThreadId,
      rolloutId,
      parentSessionId: '',
    };
  },

  matchesPath(filePath) {
    const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (
      norm.includes('/.codex/sessions/') ||
      norm.includes('/.codex/archived_sessions/') ||
      /\/rollout-[^/]+\.jsonl(?:\.zst)?$/.test(norm)
    ) {
      return true;
    }
    for (const root of discoverCodexSessionRoots()) {
      if (isPathInsideRoot(filePath, root)) return true;
    }
    return false;
  },

  scanDelta(filePath, prevCursor, meta, forceFull = false) {
    const cursorNeedsUpgrade = Boolean(
      prevCursor &&
        typeof prevCursor === 'object' &&
        (Number(prevCursor.parserVersion) || 0) < CODEX_PARSER_VERSION,
    );
    const effectiveForceFull = Boolean(forceFull || cursorNeedsUpgrade);

    let fileThreadId = '';
    let rolloutId = '';
    let eventKeyPrefix = '';
    let sessionId = '';
    let parentSessionId = '';
    let sessionMetaSeen = false;
    let lastModel = '';
    let title = '';
    let firstTs = 0;
    let lastTs = 0;
    let prevTotals = null;
    let seenTotals = [];
    let seenTotalsSet = new Set();
    let prevLastSig = null;
    let lastTcEmitted = null;
    let recentUr = [];
    let deltaSeq = 0;
    let hasUsageRecords = false;

    const events = [];
    const pendingUnknownEvents = [];

    const rememberTotal = (t) => {
      const sig = totalSig(t);
      if (!seenTotalsSet.has(sig)) {
        seenTotalsSet.add(sig);
        seenTotals.push(sig);
        if (seenTotals.length > MAX_SEEN_TOTALS) {
          seenTotalsSet.delete(seenTotals.shift());
        }
      }
    };

    const rememberUr = (entry) => {
      recentUr.push(entry);
      if (recentUr.length > MAX_RECENT_UR) {
        recentUr.shift();
      }
    };

    const isDupUr = (responseId, ts, norm) => {
      if (!responseId) return false;
      for (let i = recentUr.length - 1; i >= 0; i--) {
        const u = recentUr[i];
        if (
          u.rid === responseId &&
          Math.abs(ts - u.ts) <= LAST_DUP_WINDOW_MS &&
          u.in === norm.in &&
          u.cr === norm.cr &&
          u.cw5 === norm.cw5 &&
          u.out === norm.out &&
          u.r === norm.r
        ) {
          return true;
        }
      }
      return false;
    };

    const noteResolvedModel = (m) => {
      if (!m) return;
      lastModel = m;
      if (pendingUnknownEvents.length > 0) {
        for (const ev of pendingUnknownEvents) {
          if (ev.m === 'unknown') ev.m = m;
        }
        pendingUnknownEvents.length = 0;
      }
    };

    const initFromCursor = (reset) => {
      const prev = !reset && prevCursor && typeof prevCursor === 'object' ? prevCursor : {};
      fileThreadId = (typeof prev.fileThreadId === 'string' ? prev.fileThreadId : meta.fileThreadId || '').toLowerCase();
      rolloutId = (typeof prev.rolloutId === 'string' ? prev.rolloutId : meta.rolloutId || '').toLowerCase();
      eventKeyPrefix = rolloutId ? `rev:${rolloutId}:` : '';
      sessionId =
        typeof prev.sessionId === 'string' && prev.sessionId
          ? prev.sessionId
          : fileThreadId || meta.sessionId;
      parentSessionId =
        typeof prev.parentSessionId === 'string' ? prev.parentSessionId : meta.parentSessionId || '';
      sessionMetaSeen = Boolean(prev.sessionMetaSeen);
      lastModel = typeof prev.lastModel === 'string' ? prev.lastModel : '';
      title = typeof prev.title === 'string' ? prev.title : '';
      firstTs = Number(prev.firstTs) || 0;
      lastTs = Number(prev.lastTs) || 0;
      prevTotals =
        prev.prevTotals && typeof prev.prevTotals === 'object'
          ? {
              in: Number(prev.prevTotals.in) || 0,
              cr: Number(prev.prevTotals.cr) || 0,
              cw: Number(prev.prevTotals.cw) || 0,
              out: Number(prev.prevTotals.out) || 0,
              r: Number(prev.prevTotals.r) || 0,
            }
          : null;
      seenTotals = Array.isArray(prev.seenTotals) ? [...prev.seenTotals] : [];
      seenTotalsSet = new Set(seenTotals);
      if (prevTotals) {
        rememberTotal(prevTotals);
      }
      prevLastSig =
        prev.prevLastSig && typeof prev.prevLastSig === 'object'
          ? {
              ts: Number(prev.prevLastSig.ts) || 0,
              in: Number(prev.prevLastSig.in) || 0,
              cr: Number(prev.prevLastSig.cr) || 0,
              cw: Number(prev.prevLastSig.cw) || 0,
              out: Number(prev.prevLastSig.out) || 0,
              r: Number(prev.prevLastSig.r) || 0,
            }
          : null;
      lastTcEmitted =
        prev.lastTcEmitted && typeof prev.lastTcEmitted === 'object'
          ? {
              ts: Number(prev.lastTcEmitted.ts) || 0,
              in: Number(prev.lastTcEmitted.in) || 0,
              cr: Number(prev.lastTcEmitted.cr) || 0,
              cw5: Number(prev.lastTcEmitted.cw5) || 0,
              out: Number(prev.lastTcEmitted.out) || 0,
              r: Number(prev.lastTcEmitted.r) || 0,
            }
          : null;
      recentUr = Array.isArray(prev.recentUr) ? [...prev.recentUr] : [];
      deltaSeq = Number.isInteger(prev.deltaSeq) && prev.deltaSeq >= 0 ? prev.deltaSeq : 0;
      hasUsageRecords = Boolean(prev.hasUsageRecords);
    };

    // Fast pre-filter for giant (>16KB) tool-output `response_item` lines in multi-hundred-MB rollouts:
    // skips expensive `JSON.parse` on irrelevant blobs while never skipping any metadata or usage line.
    const shouldParseLine = (lineBuf) => {
      if (lineBuf.length <= FAST_SKIP_LINE_BYTES) return true;
      if (
        lineBuf.includes('token_count') ||
        lineBuf.includes('token_usage_record') ||
        lineBuf.includes('turn_context') ||
        lineBuf.includes('session_meta') ||
        lineBuf.includes('user_message')
      ) {
        return true;
      }
      if (!title && lineBuf.includes('response_item') && lineBuf.includes('user')) {
        return true;
      }
      return false;
    };

    const handleRecord = (obj) => {
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : obj.created_at ? Date.parse(obj.created_at) : NaN;
      const validTs = isValidTimestamp(ts);
      if (validTs) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;

      // Only trust the FIRST matching `session_meta` in a rollout file.
      // Forked/subagent rollouts copy the parent's `session_meta` later in the file;
      // adopting subsequent entries overwrites the child's sessionId and collides event keys.
      if (obj.type === 'session_meta' && payload) {
        if (!sessionMetaSeen) {
          const metaId = typeof payload.id === 'string' ? payload.id.trim() : '';
          if (!fileThreadId || !metaId || metaId.toLowerCase() === fileThreadId) {
            sessionMetaSeen = true;
            if (metaId) {
              sessionId = fileThreadId || metaId;
            }
            const parent = extractParentSessionId(payload);
            if (parent && parent.toLowerCase() !== sessionId.toLowerCase()) {
              parentSessionId = UUID_RE.test(parent) ? parent.toLowerCase() : parent;
              UUID_RE.lastIndex = 0;
            }
            const m = cleanModel(payload.model || payload.model_name);
            if (m) noteResolvedModel(m);
          }
        }
        return;
      }

      if (obj.type === 'turn_context' && payload) {
        const m = cleanModel(payload.model || payload.collaboration_mode?.settings?.model);
        if (m) noteResolvedModel(m);
        return;
      }

      if (!title && obj.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
        const cleaned = cleanCodexTitle(extractCodexUserText(payload.content));
        if (cleaned) title = cleaned;
        return;
      }

      // Authoritative per-request `token_usage_record` (switches cleanly from `token_count`
      // without changing the `tc:N` key space, preserving .jsonl -> .jsonl.zst deduplication).
      const rec = extractUsageRecord(obj);
      if (rec) {
        if (!validTs) return;
        const stepUsage = readUsageTuple(rec.usage);
        const norm = normalizeDisjointUsage(stepUsage);
        if (!norm) return;

        const wasUsingTc = !hasUsageRecords;
        hasUsageRecords = true;

        // If `token_count` was emitted within the same flush window (<=2s) for this identical step
        // just before switching to `token_usage_record`, avoid emitting a duplicate step.
        if (
          wasUsingTc &&
          lastTcEmitted &&
          Math.abs(ts - lastTcEmitted.ts) <= TC_UR_HANDOFF_WINDOW_MS &&
          lastTcEmitted.in === norm.in &&
          lastTcEmitted.cr === norm.cr &&
          lastTcEmitted.cw5 === norm.cw5 &&
          lastTcEmitted.out === norm.out &&
          lastTcEmitted.r === norm.r
        ) {
          lastTcEmitted = null;
          if (rec.responseId) {
            rememberUr({ rid: rec.responseId, ts, ...norm });
          }
          return;
        }
        lastTcEmitted = null;

        // Skip exact duplicate replays (same response_id + identical usage within 10s),
        // while keeping distinct usages that reuse the same response_id.
        if (isDupUr(rec.responseId, ts, norm)) {
          return;
        }
        if (rec.responseId) {
          rememberUr({ rid: rec.responseId, ts, ...norm });
        }

        if (rec.model) noteResolvedModel(rec.model);
        const model = rec.model || lastModel || 'unknown';
        deltaSeq += 1;
        const ev = {
          a: 'codex',
          c: sessionId,
          e: `${eventKeyPrefix}tc:${deltaSeq}`,
          ts,
          m: model,
          k: 'T',
          in: norm.in,
          cr: norm.cr,
          cw5: norm.cw5,
          cw1h: 0,
          out: norm.out,
          r: norm.r,
        };
        events.push(ev);
        if (model === 'unknown') pendingUnknownEvents.push(ev);
        return;
      }

      if (obj.type !== 'event_msg' || !payload) return;

      if (!title && payload.type === 'user_message') {
        const cleaned = cleanCodexTitle(payload.message || payload.text);
        if (cleaned) title = cleaned;
        return;
      }

      if (payload.type !== 'token_count' || !validTs) return;
      // Avoid double-counting once the rollout emits valid `token_usage_record` events
      if (hasUsageRecords) return;

      const info = payload.info && typeof payload.info === 'object' ? payload.info : payload;
      const tot = readUsageTuple(info.total_token_usage);
      const last = readUsageTuple(info.last_token_usage);

      let stepUsage = null;
      if (tot) {
        // First determine monotonic progression strictly via primary totals (`in` / `out`).
        const counterAdvanced = Boolean(
          prevTotals && tot.in >= prevTotals.in && tot.out >= prevTotals.out,
        );

        if (counterAdvanced) {
          const effCr = tot.hasCr ? tot.cr : prevTotals.cr;
          const effCw = tot.hasCw ? tot.cw : prevTotals.cw;
          const effR = tot.hasR ? tot.r : prevTotals.r;
          const effectiveTot = { in: tot.in, cr: effCr, cw: effCw, out: tot.out, r: effR };

          if (tuplesEqual(effectiveTot, prevTotals)) {
            rememberTotal({
              in: tot.in,
              cr: tot.hasCr ? tot.cr : 0,
              cw: tot.hasCw ? tot.cw : 0,
              out: tot.out,
              r: tot.hasR ? tot.r : 0,
            });
            return;
          }

          stepUsage = {
            in: effectiveTot.in - prevTotals.in,
            cr: Math.max(0, effectiveTot.cr - prevTotals.cr),
            cw: Math.max(0, effectiveTot.cw - prevTotals.cw),
            out: effectiveTot.out - prevTotals.out,
            r: Math.max(0, effectiveTot.r - prevTotals.r),
          };
          prevTotals = {
            in: effectiveTot.in,
            cr: Math.max(prevTotals.cr, effectiveTot.cr),
            cw: Math.max(prevTotals.cw, effectiveTot.cw),
            out: effectiveTot.out,
            r: Math.max(prevTotals.r, effectiveTot.r),
          };
          rememberTotal(prevTotals);
          // Also remember the raw unpadded snapshot (with omitted optional fields as 0)
          // so verbatim delayed replays of sparse snapshots still hit `seenTotalsSet`.
          rememberTotal({
            in: tot.in,
            cr: tot.hasCr ? tot.cr : 0,
            cw: tot.hasCw ? tot.cw : 0,
            out: tot.out,
            r: tot.hasR ? tot.r : 0,
          });
        } else {
          const resetTot = {
            in: tot.in,
            cr: tot.hasCr ? tot.cr : 0,
            cw: tot.hasCw ? tot.cw : 0,
            out: tot.out,
            r: tot.hasR ? tot.r : 0,
          };

          // Guard against delayed replay of an older cumulative snapshot (e.g. 110 re-emitted after 220):
          // if this exact total tuple was already observed earlier in the file, skip instead of treating as reset.
          if (prevTotals && seenTotalsSet.has(totalSig(resetTot))) {
            return;
          }

          stepUsage = last || resetTot;
          prevTotals = resetTot;
          rememberTotal(prevTotals);
        }
      } else if (last) {
        if (
          prevLastSig &&
          tuplesEqual(last, prevLastSig) &&
          Math.abs(ts - prevLastSig.ts) <= LAST_DUP_WINDOW_MS
        ) {
          return;
        }
        stepUsage = last;
        prevLastSig = { ts, in: last.in, cr: last.cr, cw: last.cw, out: last.out, r: last.r };
      } else {
        return;
      }

      // OpenAI inclusive -> disjoint normalization:
      // `input_tokens` includes both `cached_input_tokens` and `cache_write_input_tokens`;
      // `output_tokens` includes `reasoning_output_tokens`.
      const norm = normalizeDisjointUsage(stepUsage);
      if (!norm) return;

      const inlineModel = cleanModel(info.model || payload.model);
      if (inlineModel) noteResolvedModel(inlineModel);
      const model = inlineModel || lastModel || 'unknown';

      deltaSeq += 1;
      lastTcEmitted = { ts, ...norm };
      const ev = {
        a: 'codex',
        c: sessionId,
        e: `${eventKeyPrefix}tc:${deltaSeq}`,
        ts,
        m: model,
        k: 'T',
        in: norm.in,
        cr: norm.cr,
        cw5: norm.cw5,
        cw1h: 0,
        out: norm.out,
        r: norm.r,
      };
      events.push(ev);
      if (model === 'unknown') pendingUnknownEvents.push(ev);
    };

    const delta = readJsonlDelta(filePath, prevCursor, effectiveForceFull, {
      onStart: ({ reset }) => initFromCursor(reset),
      onRecord: handleRecord,
      shouldParseLine,
    });
    if (!delta) return null;
    if (delta.unchanged) return { unchanged: true };

    return {
      unchanged: false,
      events,
      cursor: {
        agent: 'codex',
        app: 'codex',
        parserVersion: CODEX_PARSER_VERSION,
        sessionId,
        fileThreadId,
        rolloutId,
        parentSessionId,
        sessionMetaSeen,
        size: delta.stat.size,
        mtimeMs: delta.stat.mtimeMs,
        ino: delta.stat.ino,
        offset: delta.newOffset,
        lastModel,
        title,
        firstTs,
        lastTs,
        prevTotals,
        seenTotals,
        prevLastSig,
        lastTcEmitted,
        recentUr,
        deltaSeq,
        hasUsageRecords,
      },
    };
  },
};
