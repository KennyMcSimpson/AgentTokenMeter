import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import {
  canonicalRealKey,
  collectJsonlFiles,
  isNotSymlink,
  isPathInsideRoot,
  safeReaddirWithTypes,
} from '../core/fs-utils.mjs';
import { readJsonlDelta, truncateTitle } from '../core/jsonl-reader.mjs';
import { normalizeInferenceGeo, normalizeModel, normalizeServiceTier } from '../core/pricing.mjs';
import { isValidTimestamp } from '../core/store.mjs';

export const CLAUDE_CODE_PARSER_VERSION = 2;
const FAST_SKIP_LINE_BYTES = 16 * 1024;

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

function addClaudeProjectRoot(candidateDir, out, seen) {
  if (!candidateDir || !existsSync(candidateDir)) return;
  const sub = join(candidateDir, 'projects');
  const target = existsSync(sub) ? sub : candidateDir;
  if (!existsSync(target)) return;
  const realKey = canonicalRealKey(target);
  if (seen.has(realKey)) return;
  seen.add(realKey);
  out.push(target);
}

export function discoverClaudeProjectRoots() {
  const roots = [];
  const seen = new Set();

  if (process.env.TOKEN_METER_CLAUDE_ROOTS !== undefined) {
    const raw = process.env.TOKEN_METER_CLAUDE_ROOTS.trim();
    if (!raw) return [];
    for (const entry of raw.split(delimiter)) {
      const dir = entry.trim();
      if (!dir || !existsSync(dir) || !isNotSymlink(dir)) continue;
      const sub = join(dir, 'projects');
      const target = existsSync(sub) && isNotSymlink(sub) ? sub : dir;
      const rk = canonicalRealKey(target);
      if (!seen.has(rk)) {
        seen.add(rk);
        roots.push(target);
      }
    }
    return roots;
  }

  // 1. Explicit CLAUDE_CONFIG_DIR (authoritative override; supports single or delimiter-separated multi-account dirs)
  if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()) {
    for (const entry of process.env.CLAUDE_CONFIG_DIR.split(delimiter)) {
      const dir = entry.trim();
      if (dir) {
        const sub = join(dir, 'projects');
        if (existsSync(sub)) addClaudeProjectRoot(dir, roots, seen);
      }
    }
    return roots;
  }

  // 2. Default ~/.claude plus sibling multi-account profiles (~/.claude-*, ~/.claude_*)
  const home = homedir();
  const defaultProjects = join(home, '.claude', 'projects');
  if (existsSync(defaultProjects)) {
    addClaudeProjectRoot(join(home, '.claude'), roots, seen);
  }
  for (const entry of safeReaddirWithTypes(home)) {
    if (!entry.name) continue;
    const low = entry.name.toLowerCase();
    if (!low.startsWith('.claude-') && !low.startsWith('.claude_')) continue;
    const base = join(home, entry.name);
    if (existsSync(join(base, 'projects'))) {
      addClaudeProjectRoot(base, roots, seen);
    }
  }

  // 3. XDG config convention (~/.config/claude, ~/.config/claude-*)
  const xdgConfig = process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME.trim() : join(home, '.config');
  if (xdgConfig && existsSync(xdgConfig)) {
    for (const entry of safeReaddirWithTypes(xdgConfig)) {
      if (!entry.name) continue;
      const low = entry.name.toLowerCase();
      if (low !== 'claude' && !low.startsWith('claude-') && !low.startsWith('claude_')) continue;
      const base = join(xdgConfig, entry.name);
      if (existsSync(join(base, 'projects'))) {
        addClaudeProjectRoot(base, roots, seen);
      }
    }
  }

  return roots;
}

function extractUsageWithIterations(usage) {
  let inTok = Math.max(0, Number(usage.input_tokens) || 0);
  let crTok = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
  let outTok = Math.max(0, Number(usage.output_tokens) || 0);

  let cw5Tok = Math.max(0, Number(usage.cache_creation?.ephemeral_5m_input_tokens) || 0);
  let cw1hTok = Math.max(0, Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0);
  const flatCw = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
  if (flatCw > cw5Tok + cw1hTok) {
    cw5Tok += flatCw - (cw5Tok + cw1hTok);
  }

  // When Anthropic server-side compaction, Advisor tool, or fallback iterations run inside one
  // API request, top-level usage may only report the executor turn (or 0 when aborted after a single
  // compaction step); aggregate `usage.iterations[]` whenever non-empty while preserving top-level 1h TTL splits.
  let iterThink = 0;
  if (Array.isArray(usage.iterations) && usage.iterations.length > 0) {
    let iterIn = 0;
    let iterCr = 0;
    let iterCw5 = 0;
    let iterCw1h = 0;
    let iterOut = 0;
    for (const it of usage.iterations) {
      if (!it || typeof it !== 'object') continue;
      iterIn += Math.max(0, Number(it.input_tokens) || 0);
      iterCr += Math.max(0, Number(it.cache_read_input_tokens) || 0);
      iterOut += Math.max(0, Number(it.output_tokens) || 0);
      let icw5 = Math.max(0, Number(it.cache_creation?.ephemeral_5m_input_tokens) || 0);
      const icw1h = Math.max(0, Number(it.cache_creation?.ephemeral_1h_input_tokens) || 0);
      const iFlat = Math.max(0, Number(it.cache_creation_input_tokens) || 0);
      if (iFlat > icw5 + icw1h) icw5 += iFlat - (icw5 + icw1h);
      iterCw5 += icw5;
      iterCw1h += icw1h;
      iterThink += Math.max(
        0,
        Number(it.output_tokens_details?.thinking_tokens) ||
          Number(it.output_tokens_details?.reasoning_tokens) ||
          0,
      );
    }
    if (iterIn > inTok) inTok = iterIn;
    if (iterCr > crTok) crTok = iterCr;
    if (iterOut > outTok) outTok = iterOut;
    if (iterCw5 + iterCw1h > cw5Tok + cw1hTok) {
      if (iterCw1h === 0 && cw1hTok > 0 && iterCw5 >= cw1hTok) {
        cw5Tok = iterCw5 - cw1hTok;
      } else {
        cw5Tok = iterCw5;
        cw1hTok = iterCw1h;
      }
    }
  }

  const rawThink = Math.max(
    0,
    Number(usage.output_tokens_details?.thinking_tokens) ||
      Number(usage.output_tokens_details?.reasoning_tokens) ||
      0,
  );
  const thinkTok = Math.min(Math.max(rawThink, iterThink), outTok);

  return { inTok, crTok, cw5Tok, cw1hTok, outTok, thinkTok };
}

export const claudeCodeAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  parserVersion: CLAUDE_CODE_PARSER_VERSION,

  discoverSources() {
    const out = [];
    for (const root of discoverClaudeProjectRoots()) {
      const resolvedRoot = resolve(root);
      // Depth 8 covers top-level sessions (d1), direct subagents (d3), and nested workflow subagents
      // (`<project>/<session>/subagents/workflows/wf_<id>/agent-<id>.jsonl`, d5+).
      collectJsonlFiles(root, 8, (full) => {
        out.push({ ...claudeCodeAdapter.inferMeta(full, [resolvedRoot]), filePath: full });
      });
    }
    return out;
  },

  inferMeta(filePath, knownRoots = null) {
    const rawPath = String(filePath || '');
    const absPath = rawPath ? resolve(rawPath) : '';
    const norm = absPath.replace(/\\/g, '/');
    const segs = norm.split('/').filter(Boolean);
    const fileName = basename(rawPath, '.jsonl') || 'unknown';

    // Determine the minimum legal segment index for a `subagents` folder so an ancestor
    // directory or a project folder literally named `subagents` never misclassifies main sessions.
    let minSubIdx = 1;
    let matchedRoot = false;
    const roots = Array.isArray(knownRoots) ? knownRoots : discoverClaudeProjectRoots();
    for (const root of roots) {
      if (!root) continue;
      const absRoot = resolve(String(root));
      if (absPath && isPathInsideRoot(absPath, absRoot)) {
        const rootSegs = absRoot.replace(/\\/g, '/').split('/').filter(Boolean);
        // Layout inside root: `<root>/<project>/<parentSessionId>/subagents/...`
        minSubIdx = Math.max(minSubIdx, rootSegs.length + 2);
        matchedRoot = true;
        break;
      }
    }
    if (!matchedRoot) {
      let projIdx = -1;
      for (let i = segs.length - 2; i >= 0; i--) {
        if (segs[i].toLowerCase() === 'projects') {
          projIdx = i;
          break;
        }
      }
      if (projIdx >= 0) {
        // Layout: `.../projects/<project>/<parentSessionId>/subagents/...`
        minSubIdx = projIdx + 3;
      }
    }

    // Locate the innermost valid `subagents` directory to support both direct (`<sid>/subagents/agent-*.jsonl`)
    // and nested workflow subagents (`<sid>/subagents/workflows/wf_*/agent-*.jsonl`).
    let subIdx = -1;
    for (let i = segs.length - 2; i >= minSubIdx; i--) {
      const low = segs[i].toLowerCase();
      if (low === 'projects' || low.startsWith('.claude')) break;
      if (low === 'subagents') {
        const parentSeg = segs[i - 1] || '';
        const parentLow = parentSeg.toLowerCase();
        if (
          parentSeg &&
          parentLow !== 'projects' &&
          !parentLow.startsWith('.claude') &&
          !/^[a-z]:$/i.test(parentSeg)
        ) {
          subIdx = i;
          break;
        }
      }
    }
    if (subIdx >= 1) {
      const parentSessionId = segs[subIdx - 1] || '';
      const subParts = segs.slice(subIdx + 1);
      if (subParts.length > 0) {
        subParts[subParts.length - 1] = subParts[subParts.length - 1].replace(/\.jsonl$/i, '');
      }
      const subRel = subParts.join('/') || fileName;
      return {
        agent: 'claude-code',
        app: 'claude-code',
        sessionId: parentSessionId ? `${parentSessionId}:${subRel}` : subRel,
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
    const isCodexRollout = /\/rollout-[^/]+\.jsonl(?:\.zst)?$/.test(norm);
    if (
      norm.includes('/.claude/projects/') ||
      /\/\.claude[-_][^/]+\/projects\//.test(norm) ||
      (!isCodexRollout && norm.includes('/subagents/'))
    ) {
      return true;
    }
    for (const root of discoverClaudeProjectRoots()) {
      if (isPathInsideRoot(filePath, root)) return true;
    }
    return false;
  },

  scanDelta(filePath, prevCursor, meta, forceFull = false) {
    const cursorNeedsUpgrade = Boolean(
      prevCursor &&
        typeof prevCursor === 'object' &&
        (Number(prevCursor.parserVersion) || 0) < CLAUDE_CODE_PARSER_VERSION,
    );
    const effectiveForceFull = Boolean(forceFull || cursorNeedsUpgrade);

    let sessionId = meta.sessionId;
    let parentSessionId = meta.parentSessionId || '';
    let lastModel = '';
    let title = '';
    let firstTs = 0;
    let lastTs = 0;
    const isSubagent = Boolean(meta.isSubagent);
    let sessionIdSeen = isSubagent;
    const eventsByKey = new Map();

    const initFromCursor = (reset) => {
      const prev = !reset && prevCursor && typeof prevCursor === 'object' ? prevCursor : {};
      sessionId = typeof prev.sessionId === 'string' && prev.sessionId ? prev.sessionId : meta.sessionId;
      parentSessionId =
        typeof prev.parentSessionId === 'string' ? prev.parentSessionId : meta.parentSessionId || '';
      lastModel = typeof prev.lastModel === 'string' ? prev.lastModel : '';
      title = typeof prev.title === 'string' ? prev.title : '';
      firstTs = Number(prev.firstTs) || 0;
      lastTs = Number(prev.lastTs) || 0;
      sessionIdSeen = isSubagent || Boolean(!reset && prev.sessionId);
    };

    const shouldParseLine = (lineBuf) => {
      if (lineBuf.length <= FAST_SKIP_LINE_BYTES) return true;
      if (lineBuf.includes('assistant') || lineBuf.includes('usage')) return true;
      if (!title && lineBuf.includes('user')) return true;
      if (!sessionIdSeen && lineBuf.includes('sessionId')) return true;
      return false;
    };

    const handleRecord = (obj, byteOffset) => {
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : obj.created_at ? Date.parse(obj.created_at) : NaN;
      const validTs = isValidTimestamp(ts);
      if (validTs) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }

      if (!isSubagent && typeof obj.sessionId === 'string' && obj.sessionId) {
        sessionId = obj.sessionId;
        sessionIdSeen = true;
      } else if (isSubagent && !parentSessionId && typeof obj.sessionId === 'string' && obj.sessionId) {
        parentSessionId = obj.sessionId;
      }

      if (!title && obj.type === 'user' && !obj.isMeta) {
        const text = extractTextFromContent(obj.message?.content ?? obj.content);
        const cleaned = cleanUserTitle(text, isSubagent);
        if (cleaned) title = cleaned;
      }

      if (obj.type !== 'assistant' || !validTs) return;
      const msg = obj.message;
      const usage = msg?.usage || obj.usage;
      if (!usage || typeof usage !== 'object') return;

      const rawModel = msg?.model || obj.model || '';
      if (typeof rawModel === 'string' && rawModel.trim() === '<synthetic>') return;
      const normRawModel = rawModel ? normalizeModel(rawModel) : 'unknown';
      if (normRawModel !== 'unknown') {
        lastModel = normRawModel;
      }
      const model = normRawModel !== 'unknown' ? normRawModel : lastModel || 'unknown';

      const { inTok, crTok, cw5Tok, cw1hTok, outTok, thinkTok } = extractUsageWithIterations(usage);
      if (inTok + crTok + cw5Tok + cw1hTok + outTok === 0) return;

      const msgId = typeof msg?.id === 'string' && msg.id ? msg.id : '';
      const reqId = typeof obj.requestId === 'string' && obj.requestId ? obj.requestId : '';
      let evId = '';
      if (msgId && reqId) evId = `${msgId}:${reqId}`;
      else if (msgId) evId = `msg:${msgId}`;
      else if (reqId) evId = `req:${reqId}`;
      else if (typeof obj.uuid === 'string' && obj.uuid) evId = `uuid:${obj.uuid}`;
      else evId = `off:${byteOffset}`;

      const st = normalizeServiceTier(usage.speed) || normalizeServiceTier(usage.service_tier);
      const geo = normalizeInferenceGeo(usage.inference_geo);

      const ev = {
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
        r: thinkTok,
      };
      if (st) ev.st = st;
      if (geo) ev.geo = geo;

      // Last-write-wins: later streaming chunks overwrite earlier placeholder stubs
      eventsByKey.set(evId, ev);
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
      events: Array.from(eventsByKey.values()),
      cursor: {
        agent: 'claude-code',
        app: 'claude-code',
        parserVersion: CLAUDE_CODE_PARSER_VERSION,
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
