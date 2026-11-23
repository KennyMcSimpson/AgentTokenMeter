#!/usr/bin/env node
/**
 * Universal cross-host Stop / SubagentStop lifecycle hook for Agent Token Meter.
 *
 * Automatically detects the calling host from the stdin JSON payload:
 * - Antigravity: camelCase `transcriptPath`, `conversationId`
 * - Claude Code: snake_case `transcript_path`, `agent_transcript_path`, `session_id`
 * - Codex:       snake_case `transcript_path`, `session_id`, `turn_id`
 *
 * Always prints `{}\n` and exits 0 so it never blocks any agent turn loop.
 */
import { readFileSync } from 'node:fs';
import { detectAdapterForPath } from '../adapters/index.mjs';
import { canonicalFileKey } from '../core/fs-utils.mjs';
import { syncSingleSource } from '../core/sync.mjs';

function isSubagentPath(p) {
  return /[/\\]subagents[/\\][^/\\]+\.jsonl$/i.test(String(p || ''));
}

function collectTargets(payload) {
  const targets = [];
  if (!payload || typeof payload !== 'object') return targets;

  // Antigravity Stop hook
  if (typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()) {
    targets.push({
      filePath: payload.transcriptPath.trim(),
      agent: 'antigravity',
      sessionId: typeof payload.conversationId === 'string' ? payload.conversationId : '',
    });
  }

  // Claude Code SubagentStop hook
  if (typeof payload.agent_transcript_path === 'string' && payload.agent_transcript_path.trim()) {
    targets.push({
      filePath: payload.agent_transcript_path.trim(),
      agent: 'claude-code',
      sessionId: '',
    });
  }

  // Claude Code or Codex Stop hook
  if (typeof payload.transcript_path === 'string' && payload.transcript_path.trim()) {
    const filePath = payload.transcript_path.trim();
    const explicitAgent =
      typeof payload.agent === 'string' && payload.agent
        ? payload.agent
        : payload.turn_id !== undefined
          ? 'codex'
          : detectAdapterForPath(filePath)?.id || '';
    targets.push({
      filePath,
      agent: explicitAgent,
      sessionId:
        !isSubagentPath(filePath) && typeof payload.session_id === 'string' ? payload.session_id : '',
    });
  }

  return targets;
}

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch {
    raw = '';
  }

  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const seen = new Set();
    for (const target of collectTargets(payload)) {
      const key = canonicalFileKey(target.filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      syncSingleSource(target.filePath, {
        agent: target.agent,
        sessionId: target.sessionId,
      });
    }
  } catch (err) {
    process.stderr.write(`[agent-token-meter hook] ${err?.message || err}\n`);
  }

  process.stdout.write('{}\n');
}

main();
