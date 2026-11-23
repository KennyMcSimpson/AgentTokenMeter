import { closeSync, openSync, readSync } from 'node:fs';
import { antigravityAdapter } from './antigravity.mjs';
import { claudeCodeAdapter } from './claude-code.mjs';
import { codexAdapter } from './codex.mjs';

export const ADAPTERS = [antigravityAdapter, claudeCodeAdapter, codexAdapter];

export const AGENT_IDS = ADAPTERS.map((a) => a.id);

export const AGENT_LABELS = Object.fromEntries(ADAPTERS.map((a) => [a.id, a.label]));

const ADAPTER_MAP = new Map(ADAPTERS.map((a) => [a.id, a]));

export function normalizeAgentId(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key || key === 'all') return '';
  if (key === 'ag' || key === 'antigravity') return 'antigravity';
  if (key === 'cc' || key === 'claude' || key === 'claude-code') return 'claude-code';
  if (key === 'codex' || key === 'openai-codex') return 'codex';
  return ADAPTER_MAP.has(key) ? key : '';
}

export function getAdapter(agentId) {
  const id = normalizeAgentId(agentId);
  return id ? ADAPTER_MAP.get(id) || null : null;
}

export function getEnabledAgentIds() {
  const raw = process.env.TOKEN_METER_AGENTS;
  if (raw === undefined) return AGENT_IDS;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'all') return AGENT_IDS;
  const ids = [];
  const seen = new Set();
  for (const part of trimmed.split(/[,\s;]+/)) {
    const id = normalizeAgentId(part);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.length ? ids : AGENT_IDS;
}

export function getAdapters(filterList = null) {
  const enabled = new Set(getEnabledAgentIds());
  if (!filterList || filterList === 'all') {
    return ADAPTERS.filter((a) => enabled.has(a.id));
  }
  const list = Array.isArray(filterList) ? filterList : [filterList];
  const resolved = [];
  const seen = new Set();
  for (const item of list) {
    const adapter = getAdapter(item);
    if (adapter && enabled.has(adapter.id) && !seen.has(adapter.id)) {
      seen.add(adapter.id);
      resolved.push(adapter);
    }
  }
  return resolved;
}

const SNIFF_BYTES = 64 * 1024;
const CLAUDE_TYPES = new Set([
  'user',
  'assistant',
  'summary',
  'system',
  'file-history-snapshot',
  'queue-operation',
  'progress',
]);
const CODEX_TYPES = new Set(['session_meta', 'turn_context', 'event_msg', 'response_item']);
const AG_TYPES = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'SYSTEM_MESSAGE', 'CHECKPOINT']);

function classifyObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (CODEX_TYPES.has(obj.type)) return codexAdapter;
  if (obj.step_index !== undefined || AG_TYPES.has(obj.type)) return antigravityAdapter;
  if (
    CLAUDE_TYPES.has(obj.type) ||
    obj.sessionId !== undefined ||
    obj.isSidechain !== undefined ||
    obj.requestId !== undefined
  ) {
    return claudeCodeAdapter;
  }
  return null;
}

function sniffAdapterFromContent(filePath) {
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    let n = 0;
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    const sample = buf.subarray(0, n).toString('utf-8').replace(/^\uFEFF/, '');
    const lines = sample.split('\n');

    // Try parsing complete JSON lines first (handles leading snapshots/metadata lines)
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const hit = classifyObject(obj);
        if (hit) return hit;
      } catch {
        // Line may exceed SNIFF_BYTES; fall through to structural prefix sniffing below
      }
    }

    // Fallback for oversized first lines (>64KB) truncated mid-JSON
    if (/"type"\s*:\s*"(?:session_meta|turn_context|event_msg|response_item)"/.test(sample)) {
      return codexAdapter;
    }
    if (/"step_index"\s*:|"type"\s*:\s*"(?:USER_INPUT|PLANNER_RESPONSE|SYSTEM_MESSAGE|CHECKPOINT)"/.test(sample)) {
      return antigravityAdapter;
    }
    if (
      /"type"\s*:\s*"(?:user|assistant|file-history-snapshot|queue-operation|progress|summary)"/.test(sample) ||
      /"(?:sessionId|isSidechain|cache_creation_input_tokens)"\s*:/.test(sample)
    ) {
      return claudeCodeAdapter;
    }
  } catch {
    // ignore sniff failure
  }
  return null;
}

export function detectAdapterForPath(filePath) {
  for (const adapter of ADAPTERS) {
    if (adapter.matchesPath(filePath)) return adapter;
  }
  return sniffAdapterFromContent(filePath);
}
