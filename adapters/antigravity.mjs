import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { isNotSymlink, isPathInsideRoot, safeReaddir } from '../core/fs-utils.mjs';
import { readJsonlDelta, truncateTitle } from '../core/jsonl-reader.mjs';
import { normalizeModel } from '../core/pricing.mjs';
import { isValidTimestamp } from '../core/store.mjs';

const MODEL_CHANGE_RE = /Model Selection`\s+from\s+.*?\s+to\s+([^\n]+?)\.(?=\s|$)/g;
const SENDER_CONV_RE = /\bsender=([0-9a-f-]{36})\b/i;

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
    if (m[1]) last = normalizeModel(m[1]);
  }
  return last;
}

export function discoverBrainRoots() {
  if (process.env.TOKEN_METER_BRAIN_ROOTS !== undefined) {
    const raw = process.env.TOKEN_METER_BRAIN_ROOTS.trim();
    if (!raw) return [];
    return raw
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s && existsSync(s) && isNotSymlink(s))
      .map((brainDir) => ({ app: basename(dirname(brainDir)) || 'antigravity', brainDir }));
  }

  const geminiRoot = join(homedir(), '.gemini');
  const roots = [];
  for (const name of safeReaddir(geminiRoot).sort()) {
    const appDir = join(geminiRoot, name);
    if (!isNotSymlink(appDir)) continue;
    const brainDir = join(appDir, 'brain');
    if (existsSync(brainDir) && isNotSymlink(brainDir)) {
      roots.push({ app: name, brainDir });
    }
  }
  return roots;
}

export const antigravityAdapter = {
  id: 'antigravity',
  label: 'Antigravity',

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
    const delta = readJsonlDelta(filePath, prevCursor, forceFull);
    if (!delta) return null;
    if (delta.unchanged) return { unchanged: true };

    const prev = !delta.reset && prevCursor && typeof prevCursor === 'object' ? prevCursor : {};
    let lastModel = typeof prev.lastModel === 'string' ? prev.lastModel : '';
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
        if (changedModel) lastModel = changedModel;
      } else if (obj.type === 'SYSTEM_MESSAGE') {
        const rawStep = obj.step_index;
        const stepOk =
          typeof rawStep !== 'boolean' && rawStep !== null && rawStep !== '' && Number.isFinite(Number(rawStep));
        if (
          !parentSessionId &&
          stepOk &&
          Number(rawStep) <= 2 &&
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
        Object.prototype.hasOwnProperty.call(obj, 'output_tokens');

      if (!hasTokens || !validTs) continue;
      if (obj.status && obj.status !== 'DONE') continue;

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

      if (obj.model) {
        lastModel = normalizeModel(obj.model);
      }
      const model = obj.model ? normalizeModel(obj.model) : lastModel || 'unknown';
      const inTok = Math.max(0, Number(obj.input_tokens) || 0);
      const crTok = Math.max(0, Number(obj.cache_read_tokens) || 0);
      const outTok = Math.max(0, Number(obj.output_tokens) || 0);
      if (inTok + crTok + outTok === 0) continue;

      const kind =
        obj.type === 'CHECKPOINT' ? 'C' : obj.type === 'PLANNER_RESPONSE' ? 'P' : String(obj.type || 'O').slice(0, 1);
      const evId = String(stepIdx);

      eventsByKey.set(evId, {
        a: 'antigravity',
        c: sessionId,
        e: evId,
        ts,
        m: model,
        k: kind,
        in: inTok,
        cr: crTok,
        cw5: 0,
        cw1h: 0,
        out: outTok,
        r: 0,
      });
    }

    return {
      unchanged: false,
      events: Array.from(eventsByKey.values()),
      cursor: {
        agent: 'antigravity',
        app: meta.app || 'antigravity',
        sessionId,
        size: delta.stat.size,
        mtimeMs: delta.stat.mtimeMs,
        ino: delta.stat.ino,
        offset: delta.newOffset,
        lastModel,
        parentSessionId,
        title,
        firstTs,
        lastTs,
      },
    };
  },
};
