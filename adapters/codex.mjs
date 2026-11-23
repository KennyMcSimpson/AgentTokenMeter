import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { collectJsonlFiles, isNotSymlink, isPathInsideRoot } from '../core/fs-utils.mjs';
import { readJsonlDelta, truncateTitle } from '../core/jsonl-reader.mjs';
import { normalizeModel } from '../core/pricing.mjs';
import { isValidTimestamp } from '../core/store.mjs';

const UUID_TAIL_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const LAST_DUP_WINDOW_MS = 10_000;

function readUsageTuple(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const hasIn = obj.input_tokens !== undefined;
  const hasCr = obj.cached_input_tokens !== undefined;
  const hasOut = obj.output_tokens !== undefined;
  const hasR = obj.reasoning_output_tokens !== undefined;
  if (!hasIn && !hasCr && !hasOut && !hasR) return null;
  return {
    in: Math.max(0, Number(obj.input_tokens) || 0),
    cr: Math.max(0, Number(obj.cached_input_tokens) || 0),
    out: Math.max(0, Number(obj.output_tokens) || 0),
    r: Math.max(0, Number(obj.reasoning_output_tokens) || 0),
    hasCr,
    hasR,
  };
}

function tuplesEqual(a, b) {
  if (!a || !b) return false;
  return a.in === b.in && a.cr === b.cr && a.out === b.out && a.r === b.r;
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

export function discoverCodexSessionRoots() {
  if (process.env.TOKEN_METER_CODEX_ROOTS !== undefined) {
    const raw = process.env.TOKEN_METER_CODEX_ROOTS.trim();
    if (!raw) return [];
    return raw
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s && existsSync(s) && isNotSymlink(s))
      .map((dir) => {
        const sub = join(dir, 'sessions');
        return existsSync(sub) && isNotSymlink(sub) ? sub : dir;
      });
  }

  const base = process.env.CODEX_HOME ? process.env.CODEX_HOME.trim() : join(homedir(), '.codex');
  const sessionsDir = join(base, 'sessions');
  if (existsSync(sessionsDir) && isNotSymlink(sessionsDir)) {
    return [sessionsDir];
  }
  return [];
}

export const codexAdapter = {
  id: 'codex',
  label: 'Codex',

  discoverSources() {
    const out = [];
    for (const root of discoverCodexSessionRoots()) {
      collectJsonlFiles(root, 5, (full) => {
        out.push({ ...codexAdapter.inferMeta(full), filePath: full });
      });
    }
    return out;
  },

  inferMeta(filePath) {
    const stem = basename(filePath, '.jsonl') || 'unknown';
    const uuidMatch = UUID_TAIL_RE.exec(stem);
    return {
      agent: 'codex',
      app: 'codex',
      sessionId: uuidMatch ? uuidMatch[1] : stem,
    };
  },

  matchesPath(filePath) {
    const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (norm.includes('/.codex/sessions/') || /\/rollout-[^/]+\.jsonl$/.test(norm)) {
      return true;
    }
    for (const root of discoverCodexSessionRoots()) {
      if (isPathInsideRoot(filePath, root)) return true;
    }
    return false;
  },

  scanDelta(filePath, prevCursor, meta, forceFull = false) {
    const delta = readJsonlDelta(filePath, prevCursor, forceFull);
    if (!delta) return null;
    if (delta.unchanged) return { unchanged: true };

    const prev = !delta.reset && prevCursor && typeof prevCursor === 'object' ? prevCursor : {};
    let sessionId = typeof prev.sessionId === 'string' && prev.sessionId ? prev.sessionId : meta.sessionId;
    let lastModel = typeof prev.lastModel === 'string' ? prev.lastModel : '';
    let title = typeof prev.title === 'string' ? prev.title : '';
    let firstTs = Number(prev.firstTs) || 0;
    let lastTs = Number(prev.lastTs) || 0;
    let prevTotals =
      prev.prevTotals && typeof prev.prevTotals === 'object'
        ? {
            in: Number(prev.prevTotals.in) || 0,
            cr: Number(prev.prevTotals.cr) || 0,
            out: Number(prev.prevTotals.out) || 0,
            r: Number(prev.prevTotals.r) || 0,
          }
        : null;
    let prevLastSig =
      prev.prevLastSig && typeof prev.prevLastSig === 'object'
        ? {
            ts: Number(prev.prevLastSig.ts) || 0,
            in: Number(prev.prevLastSig.in) || 0,
            cr: Number(prev.prevLastSig.cr) || 0,
            out: Number(prev.prevLastSig.out) || 0,
            r: Number(prev.prevLastSig.r) || 0,
          }
        : null;
    let deltaSeq = Number.isInteger(prev.deltaSeq) && prev.deltaSeq >= 0 ? prev.deltaSeq : 0;

    const events = [];

    for (const { obj } of delta.records) {
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : obj.created_at ? Date.parse(obj.created_at) : NaN;
      const validTs = isValidTimestamp(ts);
      if (validTs) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;

      if (obj.type === 'session_meta' && payload) {
        if (typeof payload.id === 'string' && payload.id) {
          sessionId = payload.id;
        }
        const m = payload.model || payload.model_name;
        if (typeof m === 'string' && m.trim()) {
          lastModel = normalizeModel(m);
        }
        continue;
      }

      if (obj.type === 'turn_context' && payload) {
        const m = payload.model || payload.collaboration_mode?.settings?.model;
        if (typeof m === 'string' && m.trim()) {
          lastModel = normalizeModel(m);
        }
        continue;
      }

      if (!title && obj.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
        const cleaned = cleanCodexTitle(extractCodexUserText(payload.content));
        if (cleaned) title = cleaned;
        continue;
      }

      if (obj.type !== 'event_msg' || !payload) continue;

      if (!title && payload.type === 'user_message') {
        const cleaned = cleanCodexTitle(payload.message || payload.text);
        if (cleaned) title = cleaned;
        continue;
      }

      if (payload.type !== 'token_count' || !validTs) continue;

      const info = payload.info && typeof payload.info === 'object' ? payload.info : payload;
      const tot = readUsageTuple(info.total_token_usage);
      const last = readUsageTuple(info.last_token_usage);

      let stepUsage = null;
      if (tot) {
        // First determine monotonic progression strictly via primary totals (`in` / `out`).
        // Never carry forward pre-reset `cr`/`r` across a real counter reset!
        const counterAdvanced = Boolean(
          prevTotals && tot.in >= prevTotals.in && tot.out >= prevTotals.out,
        );

        if (counterAdvanced) {
          const effCr = tot.hasCr ? tot.cr : prevTotals.cr;
          const effR = tot.hasR ? tot.r : prevTotals.r;
          const effectiveTot = { in: tot.in, cr: effCr, out: tot.out, r: effR };

          // Exact duplicate snapshot (e.g. UI refresh / rate-limit ping) -> skip
          if (tuplesEqual(effectiveTot, prevTotals)) {
            continue;
          }

          stepUsage = {
            in: effectiveTot.in - prevTotals.in,
            cr: Math.max(0, effectiveTot.cr - prevTotals.cr),
            out: effectiveTot.out - prevTotals.out,
            r: Math.max(0, effectiveTot.r - prevTotals.r),
          };
          prevTotals = {
            in: effectiveTot.in,
            cr: Math.max(prevTotals.cr, effectiveTot.cr),
            out: effectiveTot.out,
            r: Math.max(prevTotals.r, effectiveTot.r),
          };
        } else {
          // First event in file or genuine counter reset: omitted optional fields start cleanly at 0
          const resetTot = {
            in: tot.in,
            cr: tot.hasCr ? tot.cr : 0,
            out: tot.out,
            r: tot.hasR ? tot.r : 0,
          };
          stepUsage = last || resetTot;
          prevTotals = resetTot;
        }
      } else if (last) {
        // Guard against duplicate back-to-back last_token_usage-only refresh snapshots
        if (
          prevLastSig &&
          tuplesEqual(last, prevLastSig) &&
          Math.abs(ts - prevLastSig.ts) <= LAST_DUP_WINDOW_MS
        ) {
          continue;
        }
        stepUsage = last;
        prevLastSig = { ts, in: last.in, cr: last.cr, out: last.out, r: last.r };
      } else {
        continue;
      }

      // OpenAI inclusive -> disjoint normalization:
      // `input_tokens` includes `cached_input_tokens`; `output_tokens` includes `reasoning_output_tokens`.
      const crTok = Math.max(0, Math.min(stepUsage.cr, stepUsage.in));
      const uncachedIn = Math.max(0, stepUsage.in - crTok);
      const outTok = Math.max(0, stepUsage.out);
      const reasoningTok = Math.max(0, Math.min(stepUsage.r, outTok));

      if (uncachedIn + crTok + outTok === 0) continue;

      const inlineModel = info.model || payload.model;
      if (typeof inlineModel === 'string' && inlineModel.trim()) {
        lastModel = normalizeModel(inlineModel);
      }
      const model = inlineModel ? normalizeModel(inlineModel) : lastModel || 'unknown';

      deltaSeq += 1;
      events.push({
        a: 'codex',
        c: sessionId,
        e: `tc:${deltaSeq}`,
        ts,
        m: model,
        k: 'T',
        in: uncachedIn,
        cr: crTok,
        cw5: 0,
        cw1h: 0,
        out: outTok,
        r: reasoningTok,
      });
    }

    return {
      unchanged: false,
      events,
      cursor: {
        agent: 'codex',
        app: 'codex',
        sessionId,
        size: delta.stat.size,
        mtimeMs: delta.stat.mtimeMs,
        ino: delta.stat.ino,
        offset: delta.newOffset,
        lastModel,
        title,
        firstTs,
        lastTs,
        prevTotals,
        prevLastSig,
        deltaSeq,
      },
    };
  },
};
