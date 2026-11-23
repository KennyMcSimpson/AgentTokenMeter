import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { collectJsonlFiles, isNotSymlink, isPathInsideRoot } from '../core/fs-utils.mjs';
import { readJsonlDelta, truncateTitle } from '../core/jsonl-reader.mjs';
import { normalizeModel } from '../core/pricing.mjs';
import { isValidTimestamp } from '../core/store.mjs';

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join(' ');
}

function cleanUserTitle(rawText, isSubagent) {
  if (!rawText) return '';
  const stripped = rawText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/gi, '$1 ')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/gi, '$1 ')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  if (!stripped) return '';
  return truncateTitle(isSubagent ? `[Subagent] ${stripped}` : stripped);
}

export function discoverClaudeProjectRoots() {
  if (process.env.TOKEN_METER_CLAUDE_ROOTS !== undefined) {
    const raw = process.env.TOKEN_METER_CLAUDE_ROOTS.trim();
    if (!raw) return [];
    return raw
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s && existsSync(s) && isNotSymlink(s))
      .map((dir) => {
        const sub = join(dir, 'projects');
        return existsSync(sub) && isNotSymlink(sub) ? sub : dir;
      });
  }

  const base = process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR.trim() : join(homedir(), '.claude');
  const projectsDir = join(base, 'projects');
  if (existsSync(projectsDir) && isNotSymlink(projectsDir)) {
    return [projectsDir];
  }
  return [];
}

export const claudeCodeAdapter = {
  id: 'claude-code',
  label: 'Claude Code',

  discoverSources() {
    const out = [];
    for (const root of discoverClaudeProjectRoots()) {
      collectJsonlFiles(root, 3, (full) => {
        out.push({ ...claudeCodeAdapter.inferMeta(full), filePath: full });
      });
    }
    return out;
  },

  inferMeta(filePath) {
    const fileName = basename(filePath, '.jsonl') || 'unknown';
    const parentDir = dirname(filePath);
    const parentName = basename(parentDir);

    if (parentName === 'subagents') {
      const parentSessionId = basename(dirname(parentDir)) || '';
      return {
        agent: 'claude-code',
        app: 'claude-code',
        sessionId: parentSessionId ? `${parentSessionId}:${fileName}` : fileName,
        parentSessionId,
        isSubagent: true,
      };
    }

    return {
      agent: 'claude-code',
      app: 'claude-code',
      sessionId: fileName,
      parentSessionId: '',
      isSubagent: fileName.startsWith('agent-'),
    };
  },

  matchesPath(filePath) {
    const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (norm.includes('/.claude/projects/') || norm.includes('/subagents/agent-')) {
      return true;
    }
    for (const root of discoverClaudeProjectRoots()) {
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
    let parentSessionId =
      typeof prev.parentSessionId === 'string' ? prev.parentSessionId : meta.parentSessionId || '';
    let lastModel = typeof prev.lastModel === 'string' ? prev.lastModel : '';
    let title = typeof prev.title === 'string' ? prev.title : '';
    let firstTs = Number(prev.firstTs) || 0;
    let lastTs = Number(prev.lastTs) || 0;
    const isSubagent = Boolean(meta.isSubagent);

    const eventsByKey = new Map();

    for (const { obj, byteOffset } of delta.records) {
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : obj.created_at ? Date.parse(obj.created_at) : NaN;
      const validTs = isValidTimestamp(ts);
      if (validTs) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      if (!isSubagent && typeof obj.sessionId === 'string' && obj.sessionId) {
        sessionId = obj.sessionId;
      } else if (isSubagent && !parentSessionId && typeof obj.sessionId === 'string' && obj.sessionId) {
        parentSessionId = obj.sessionId;
      }

      if (!title && obj.type === 'user' && !obj.isMeta) {
        const text = extractTextFromContent(obj.message?.content ?? obj.content);
        const cleaned = cleanUserTitle(text, isSubagent);
        if (cleaned) title = cleaned;
      }

      if (obj.type !== 'assistant' || !validTs) continue;
      const msg = obj.message;
      const usage = msg?.usage || obj.usage;
      if (!usage || typeof usage !== 'object') continue;

      const rawModel = msg?.model || obj.model || '';
      if (typeof rawModel === 'string' && rawModel.trim() === '<synthetic>') continue;
      if (rawModel) {
        lastModel = normalizeModel(rawModel);
      }
      const model = rawModel ? normalizeModel(rawModel) : lastModel || 'unknown';

      const inTok = Math.max(0, Number(usage.input_tokens) || 0);
      const crTok = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
      const outTok = Math.max(0, Number(usage.output_tokens) || 0);

      let cw5Tok = Math.max(0, Number(usage.cache_creation?.ephemeral_5m_input_tokens) || 0);
      const cw1hTok = Math.max(0, Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0);
      const flatCw = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
      if (flatCw > cw5Tok + cw1hTok) {
        cw5Tok += flatCw - (cw5Tok + cw1hTok);
      }

      if (inTok + crTok + cw5Tok + cw1hTok + outTok === 0) continue;

      const msgId = typeof msg?.id === 'string' && msg.id ? msg.id : '';
      const reqId = typeof obj.requestId === 'string' && obj.requestId ? obj.requestId : '';
      let evId = '';
      if (msgId && reqId) evId = `${msgId}:${reqId}`;
      else if (msgId) evId = `msg:${msgId}`;
      else if (reqId) evId = `req:${reqId}`;
      else if (typeof obj.uuid === 'string' && obj.uuid) evId = `uuid:${obj.uuid}`;
      else evId = `off:${byteOffset}`;

      // Last-write-wins: later streaming chunks overwrite earlier placeholder stubs
      eventsByKey.set(evId, {
        a: 'claude-code',
        c: sessionId,
        e: evId,
        ts,
        m: model,
        k: isSubagent ? 'S' : 'A',
        in: inTok,
        cr: crTok,
        cw5: cw5Tok,
        cw1h: cw1hTok,
        out: outTok,
        r: 0,
      });
    }

    return {
      unchanged: false,
      events: Array.from(eventsByKey.values()),
      cursor: {
        agent: 'claude-code',
        app: 'claude-code',
        sessionId,
        parentSessionId,
        size: delta.stat.size,
        mtimeMs: delta.stat.mtimeMs,
        ino: delta.stat.ino,
        offset: delta.newOffset,
        lastModel,
        title,
        firstTs,
        lastTs,
      },
    };
  },
};
