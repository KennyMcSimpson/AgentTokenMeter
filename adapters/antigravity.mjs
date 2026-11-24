import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import {
  canonicalRealKey,
  isNotSymlink,
  isPathInsideRoot,
  safeReaddir,
  safeReaddirWithTypes,
} from '../core/fs-utils.mjs';
import { readJsonlDelta, truncateTitle } from '../core/jsonl-reader.mjs';
import { normalizeModel } from '../core/pricing.mjs';
import { isValidTimestamp } from '../core/store.mjs';

// Bounded matcher (<=80 chars per model name): allows decimal version dots (e.g. `3.1`, `4.6`)
// while preventing quadratic backtracking and sentence-crossing matches into following prose.
const MODEL_CHANGE_RE =
  /Model Selection`\s+from\s+(?:[^\n.]|\.(?=\d)){1,80}?\s+to\s+((?:[^\n.]|\.(?=\d)){1,80}?)\.(?=[`'"]?(?:\s|$))/g;
const SENDER_CONV_RE = /\bsender=([0-9a-f-]{36})\b/i;
const IN_FLIGHT_STATUSES = new Set(['PENDING', 'RUNNING', 'IN_PROGRESS', 'STREAMING']);
export const ANTIGRAVITY_PARSER_VERSION = 3;

function extractTitleFromUserInput(content) {
  if (!content || typeof content !== 'string') return '';
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = reqMatch && reqMatch[1] ? reqMatch[1] : content.replace(/<[^>]+>/g, ' ');
  return truncateTitle(raw);
}

function extractTitleFromSystemMessage(content) {
  if (!content || typeof content !== 'string') return '';
  const sysMatch = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i.exec(content);
  const body = sysMatch ? sysMatch[1] : content;
  const contentIdx = body.indexOf('content=');
  const payload = contentIdx >= 0 ? body.slice(contentIdx + 8).trim() : body.trim();
  if (!payload || /^\[swarm\]\s+new board message\b/i.test(payload)) return '';

  const swarmAssign = /Your assignment\s*\([^)]*for\s+(@[\w-]+)\)\s*:\s*([\s\S]+)/i.exec(payload);
  if (swarmAssign) {
    return truncateTitle(`[Swarm ${swarmAssign[1]}] ${swarmAssign[2]}`);
  }

  const origTask = /<original_task>\s*([\s\S]*?)(?:<\/original_task>|\n---|$)/i.exec(payload);
  if (origTask) {
    const cleanedTask = origTask[1].replace(/^\s*\*\*Task\*\*\s*:\s*/i, '');
    return truncateTitle(`[Subagent] ${cleanedTask}`);
  }

  return truncateTitle(`[Subagent] ${payload.replace(/<[^>]+>/g, ' ')}`);
}

function extractSenderConvId(content) {
  if (!content || typeof content !== 'string') return '';
  const m = SENDER_CONV_RE.exec(content);
  return m ? m[1] : '';
}

function extractLastModelChange(content) {
  if (!content || typeof content !== 'string') return null;
  let last = null;
  MODEL_CHANGE_RE.lastIndex = 0;
  let m;
  while ((m = MODEL_CHANGE_RE.exec(content)) !== null) {
    const raw = String(m[1] || '')
      .trim()
      .replace(/^[`'"]+|[`'"]+$/g, '')
      .trim();
    if (!raw || raw.length > 64) continue;
    if (raw.split(/\s+/).length > 7) continue;
    const norm = normalizeModel(raw);
    if (norm && norm !== 'unknown') last = norm;
  }
  return last;
}

function pushBrainRoot(app, brainDir, out, seen) {
  if (!brainDir || !existsSync(brainDir)) return;
  const rk = canonicalRealKey(brainDir);
  if (seen.has(rk)) return;
  seen.add(rk);
  out.push({ app: app || 'antigravity', brainDir });
}

export function discoverBrainRoots() {
  const roots = [];
  const seen = new Set();

  if (process.env.TOKEN_METER_BRAIN_ROOTS !== undefined) {
    const raw = process.env.TOKEN_METER_BRAIN_ROOTS.trim();
    if (!raw) return [];
    for (const entry of raw.split(delimiter)) {
      const brainDir = entry.trim();
      if (brainDir && existsSync(brainDir) && isNotSymlink(brainDir)) {
        pushBrainRoot(basename(dirname(brainDir)) || 'antigravity', brainDir, roots, seen);
      }
    }
    return roots;
  }

  // 1. Active host app data dir (supports custom multi-profile Antigravity launches)
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR.trim();
    if (appDir) {
      const brainDir = join(appDir, 'brain');
      if (existsSync(brainDir)) {
        pushBrainRoot(basename(appDir) || 'antigravity', brainDir, roots, seen);
      }
    }
  }

  // 2. Default ~/.gemini/*/brain (covers Antigravity 2.0, Antigravity IDE, and agy CLI)
  //    plus sibling multi-account/profile directories (~/.gemini-*, ~/.gemini_*).
  const home = homedir();
  const scanGeminiBase = (geminiBase) => {
    if (!existsSync(geminiBase)) return;
    const directBrain = join(geminiBase, 'brain');
    if (existsSync(directBrain) && isNotSymlink(directBrain)) {
      pushBrainRoot(basename(geminiBase) || 'antigravity', directBrain, roots, seen);
    }
    for (const name of safeReaddir(geminiBase).sort()) {
      const appDir = join(geminiBase, name);
      if (!isNotSymlink(appDir)) continue;
      const brainDir = join(appDir, 'brain');
      if (existsSync(brainDir) && isNotSymlink(brainDir)) {
        pushBrainRoot(name, brainDir, roots, seen);
      }
    }
  };

  scanGeminiBase(join(home, '.gemini'));
  for (const entry of safeReaddirWithTypes(home)) {
    if (!entry.name) continue;
    const low = entry.name.toLowerCase();
    if (!low.startsWith('.gemini-') && !low.startsWith('.gemini_')) continue;
    scanGeminiBase(join(home, entry.name));
  }

  return roots;
}

export const antigravityAdapter = {
  id: 'antigravity',
  label: 'Antigravity',
  parserVersion: ANTIGRAVITY_PARSER_VERSION,

  discoverSources() {
    const out = [];
    for (const { app, brainDir } of discoverBrainRoots()) {
      for (const convId of safeReaddir(brainDir)) {
        if (!convId || convId.startsWith('.')) continue;
        const convDir = join(brainDir, convId);
        if (!isNotSymlink(convDir)) continue;
        const filePath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(filePath) && isNotSymlink(filePath)) {
          out.push({ agent: 'antigravity', app, sessionId: convId, filePath });
        }
      }
    }
    return out;
  },

  inferMeta(filePath) {
    const logsDir = dirname(filePath);
    const sysDir = dirname(logsDir);
    const convDir = dirname(sysDir);
    const brainDir = dirname(convDir);
    const appDir = dirname(brainDir);
    return {
      agent: 'antigravity',
      sessionId: basename(convDir) || 'unknown',
      app: basename(brainDir) === 'brain' ? basename(appDir) : 'antigravity',
    };
  },

  matchesPath(filePath) {
    const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (norm.endsWith('/.system_generated/logs/transcript.jsonl') || norm.includes('/.gemini/')) {
      return true;
    }
    for (const { brainDir } of discoverBrainRoots()) {
      if (isPathInsideRoot(filePath, brainDir)) return true;
    }
    return false;
  },

  scanDelta(filePath, prevCursor, meta, forceFull = false) {
    const cursorNeedsUpgrade = Boolean(
      prevCursor &&
        typeof prevCursor === 'object' &&
        (Number(prevCursor.parserVersion) || 0) < ANTIGRAVITY_PARSER_VERSION,
    );
    const delta = readJsonlDelta(filePath, prevCursor, Boolean(forceFull || cursorNeedsUpgrade));
    if (!delta) return null;
    if (delta.unchanged) return { unchanged: true };

    const prev = !delta.reset && prevCursor && typeof prevCursor === 'object' ? prevCursor : {};
    let lastModel = typeof prev.lastModel === 'string' ? prev.lastModel : '';
    let firstModel = typeof prev.firstModel === 'string' && prev.firstModel ? prev.firstModel : lastModel;
    let parentSessionId =
      typeof prev.parentSessionId === 'string'
        ? prev.parentSessionId
        : typeof prev.parentConvId === 'string'
          ? prev.parentConvId
          : '';
    let title = typeof prev.title === 'string' ? prev.title : '';
    let firstTs = Number(prev.firstTs) || 0;
    let lastTs = Number(prev.lastTs) || 0;

    const sessionId = meta.sessionId;
    const eventsByKey = new Map();
    const pendingUnknown = [];

    const noteResolvedModel = (m) => {
      if (!m || m === 'unknown') return;
      if (!firstModel) firstModel = m;
      lastModel = m;
      if (pendingUnknown.length > 0) {
        for (const ev of pendingUnknown) {
          if (ev.m === 'unknown') ev.m = m;
        }
        pendingUnknown.length = 0;
      }
    };

    for (const { obj } of delta.records) {
      const ts = obj.created_at ? Date.parse(obj.created_at) : NaN;
      const validTs = isValidTimestamp(ts);
      if (validTs) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      if (obj.type === 'USER_INPUT') {
        if (!title || title.startsWith('[Subagent]') || title.startsWith('[Swarm ')) {
          const extracted = extractTitleFromUserInput(obj.content);
          if (extracted) title = extracted;
        }
        const changedModel = extractLastModelChange(obj.content);
        if (changedModel) noteResolvedModel(changedModel);
      } else if (obj.type === 'SYSTEM_MESSAGE') {
        const rawStep = obj.step_index;
        const stepOk =
          typeof rawStep !== 'boolean' && rawStep !== null && rawStep !== '' && Number.isFinite(Number(rawStep));
        if (
          !parentSessionId &&
          stepOk &&
          Number(rawStep) <= 10 &&
          (!title || title.startsWith('[Subagent]') || title.startsWith('[Swarm '))
        ) {
          const sender = extractSenderConvId(obj.content);
          if (sender && sender !== sessionId) parentSessionId = sender;
        }
        if (!title) {
          const extracted = extractTitleFromSystemMessage(obj.content);
          if (extracted) title = extracted;
        }
      }

      const hasTokens =
        Object.prototype.hasOwnProperty.call(obj, 'input_tokens') ||
        Object.prototype.hasOwnProperty.call(obj, 'cache_read_tokens') ||
        Object.prototype.hasOwnProperty.call(obj, 'cache_write_tokens') ||
        Object.prototype.hasOwnProperty.call(obj, 'cache_creation_tokens') ||
        Object.prototype.hasOwnProperty.call(obj, 'output_tokens');

      if (!hasTokens || !validTs) continue;
      // Skip only in-flight streaming placeholders; keep terminal DONE/ERROR/CANCELLED steps that already billed tokens
      if (typeof obj.status === 'string' && IN_FLIGHT_STATUSES.has(obj.status.toUpperCase())) continue;

      if (
        typeof obj.step_index === 'boolean' ||
        obj.step_index === null ||
        obj.step_index === undefined ||
        obj.step_index === ''
      ) {
        continue;
      }
      const stepIdx = Number(obj.step_index);
      if (!Number.isFinite(stepIdx)) continue;

      const normRawModel = obj.model ? normalizeModel(obj.model) : 'unknown';
      if (normRawModel !== 'unknown') {
        noteResolvedModel(normRawModel);
      }
      const model = normRawModel !== 'unknown' ? normRawModel : lastModel || 'unknown';
      const inTok = Math.max(0, Number(obj.input_tokens) || 0);
      const crTok = Math.max(0, Number(obj.cache_read_tokens) || 0);
      const cw5Tok = Math.max(0, Number(obj.cache_write_tokens ?? obj.cache_creation_tokens) || 0);
      const outTok = Math.max(0, Number(obj.output_tokens) || 0);
      const thinkTok = Math.min(
        Math.max(0, Number(obj.thinking_tokens ?? obj.reasoning_tokens) || 0),
        outTok,
      );
      if (inTok + crTok + cw5Tok + outTok === 0) continue;

      const kind =
        obj.type === 'CHECKPOINT' ? 'C' : obj.type === 'PLANNER_RESPONSE' ? 'P' : String(obj.type || 'O').slice(0, 1);
      const evId = String(stepIdx);

      const ev = {
        a: 'antigravity',
        c: sessionId,
        e: evId,
        ts,
        m: model,
        k: kind,
        in: inTok,
        cr: crTok,
        cw5: cw5Tok,
        cw1h: 0,
        out: outTok,
        r: thinkTok,
      };
      eventsByKey.set(evId, ev);
      if (model === 'unknown') {
        pendingUnknown.push(ev);
      }
    }

    return {
      unchanged: false,
      events: Array.from(eventsByKey.values()),
      cursor: {
        agent: 'antigravity',
        app: meta.app || 'antigravity',
        parserVersion: ANTIGRAVITY_PARSER_VERSION,
        sessionId,
        size: delta.stat.size,
        mtimeMs: delta.stat.mtimeMs,
        ino: delta.stat.ino,
        offset: delta.newOffset,
        firstModel,
        lastModel,
        parentSessionId,
        title,
        firstTs,
        lastTs,
      },
    };
  },
};
