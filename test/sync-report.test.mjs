import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildReport, exportDailyCsv, localDateKey } from '../core/report.mjs';
import { syncAllSources } from '../core/sync.mjs';
import { createTestEnv, HOOK_SCRIPT } from './helpers.mjs';

function spawnHook(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      if (code === 0 && out.trim() === '{}') resolve();
      else reject(new Error(`hook exit=${code} out=${out} err=${err}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('Cross-agent concurrent hooks, archive preservation, filtering, DST bucketing, and >730-day CSV', async () => {
  const h = createTestEnv('atm-sync-');
  try {
    const agFile = h.mkAgTranscript('ag-conv-1');
    writeFileSync(
      agFile,
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-01T04:30:00Z',
          content: '<USER_REQUEST>AG task</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-01T04:30:05Z',
          model: 'gemini-4-neon-xhigh',
          input_tokens: 100_000,
          cache_read_tokens: 200_000,
          output_tokens: 10_000,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const ccFile = h.mkClaudeTranscript('repo-a', 'cc-conv-1');
    writeFileSync(
      ccFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'cc-conv-1',
        requestId: 'req_cc_1',
        timestamp: '2023-01-01T12:00:00Z',
        message: {
          id: 'msg_cc_1',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 50_000,
            cache_read_input_tokens: 100_000,
            cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 },
            output_tokens: 5_000,
          },
        },
      }) + '\n',
      'utf-8',
    );

    const codexFile = h.mkCodexRollout('2026/11/20', 'rollout-2026-11-20T10-00-00-codex-1.jsonl');
    writeFileSync(
      codexFile,
      [
        JSON.stringify({
          timestamp: '2026-11-20T10:00:00Z',
          type: 'session_meta',
          payload: { id: 'codex-conv-1', model: 'gpt-5.3-codex' },
        }),
        JSON.stringify({
          timestamp: '2026-11-20T10:00:10Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 80_000,
                cached_input_tokens: 60_000,
                output_tokens: 4_000,
                reasoning_output_tokens: 1_000,
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // Fire 6 concurrent cross-agent Stop hooks fighting for the same ledger lock
    await Promise.all([
      spawnHook({ conversationId: 'ag-conv-1', transcriptPath: agFile }, h.env),
      spawnHook({ conversationId: 'ag-conv-1', transcriptPath: agFile }, h.env),
      spawnHook({ session_id: 'cc-conv-1', transcript_path: ccFile }, h.env),
      spawnHook({ session_id: 'cc-conv-1', transcript_path: ccFile }, h.env),
      spawnHook({ session_id: 'codex-conv-1', transcript_path: codexFile, turn_id: 't1' }, h.env),
      spawnHook({ session_id: 'codex-conv-1', transcript_path: codexFile, turn_id: 't1' }, h.env),
    ]);

    // Delete Claude transcript and run full rescan: archived events MUST survive
    rmSync(ccFile, { force: true });
    syncAllSources({ dataDir: h.dataDir, forceFullRescan: true });

    // DST transition verification
    assert.equal(localDateKey(Date.parse('2026-11-01T04:30:00Z'), 'America/New_York'), '2026-11-01');

    const allRep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(allRep.allTime.totalEvents, 3);
    assert.equal(allRep.agents.filter((a) => a.steps > 0).length, 3);

    // Agent filter isolation
    const ccRep = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'claude-code', timeZone: 'UTC' });
    assert.equal(ccRep.allTime.totalEvents, 1);
    assert.equal(ccRep.period.cacheWrite, 10_000);
    // Filter still exposes global per-agent counts for UI pill badges
    assert.equal(ccRep.agents.filter((a) => a.steps > 0).length, 3);

    // >730-day span CSV keeps both 2023-01-01 and 2026-11-20
    const csv = exportDailyCsv(allRep);
    assert.ok(csv.includes('cache_write_tokens'));
    assert.ok(csv.includes('2023-01-01') && csv.includes('2026-11-20'));
  } finally {
    h.cleanup();
  }
});

test('Backward compatibility with v1 Antigravity ledger events and cursors', () => {
  const h = createTestEnv('atm-v1compat-');
  try {
    const evDir = join(h.dataDir, 'events');
    mkdirSync(evDir, { recursive: true });
    // Legacy v1 event without `a`, `e`, `cw5`, `cw1h`, `r`
    writeFileSync(
      join(evDir, '2026-11.jsonl'),
      JSON.stringify({
        c: 'legacy-conv-1',
        i: 3,
        ts: Date.parse('2026-11-15T09:00:00Z'),
        m: 'gemini-4-hydrogen-high',
        k: 'P',
        in: 100_000,
        cr: 200_000,
        out: 10_000,
      }) + '\n',
      'utf-8',
    );
    // Legacy v1 cursors.json with un-namespaced session key
    writeFileSync(
      join(h.dataDir, 'cursors.json'),
      JSON.stringify({
        version: 1,
        files: {},
        sessions: {
          'legacy-conv-1': {
            convId: 'legacy-conv-1',
            app: 'antigravity',
            title: 'Old Antigravity Session',
            firstTs: Date.parse('2026-11-15T09:00:00Z'),
            lastTs: Date.parse('2026-11-15T09:00:00Z'),
          },
        },
      }),
      'utf-8',
    );

    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 1);
    assert.equal(rep.sessions[0].agent, 'antigravity');
    assert.equal(rep.sessions[0].title, 'Old Antigravity Session');
    assert.equal(rep.period.total, 310_000);
  } finally {
    h.cleanup();
  }
});
