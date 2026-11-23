import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { buildReport } from '../core/report.mjs';
import { syncAllSources, syncSingleSource } from '../core/sync.mjs';
import { createTestEnv } from './helpers.mjs';

test('Antigravity adapter: torn line recovery, Model Selection change, and parent model inheritance', () => {
  const h = createTestEnv('atm-ag-');
  try {
    const parentId = '11111111-1111-1111-1111-111111111111';
    const childId = '22222222-2222-2222-2222-222222222222';
    const tParent = h.mkAgTranscript(parentId);
    const tChild = h.mkAgTranscript(childId);

    // Write torn trailing line on parent
    writeFileSync(
      tParent,
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-20T08:00:00Z',
        content: '<USER_REQUEST>Refactor auth flow</USER_REQUEST>\nModel Selection` from None to Gemini 4 Neon (XHigh).',
      }) +
        '\n' +
        '{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-20T08:00:05Z","input_tokens":100000,"cache_read_tok',
      'utf-8',
    );

    let r1 = syncSingleSource(tParent, { agent: 'antigravity', sessionId: parentId, dataDir: h.dataDir });
    assert.equal(r1.added, 0);

    // Complete torn line + add checkpoint
    appendFileSync(
      tParent,
      'ens":400000,"output_tokens":20000}\n' +
        JSON.stringify({
          step_index: 2,
          type: 'CHECKPOINT',
          status: 'DONE',
          created_at: '2026-11-20T08:00:10Z',
          input_tokens: 50_000,
          cache_read_tokens: 0,
          output_tokens: 5_000,
        }) +
        '\n',
      'utf-8',
    );
    r1 = syncSingleSource(tParent, { agent: 'antigravity', sessionId: parentId, dataDir: h.dataDir });
    assert.equal(r1.added, 2);

    // Child subagent without model field inherits parent's gemini-4-neon-xhigh
    writeFileSync(
      tChild,
      JSON.stringify({
        step_index: 0,
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-20T08:01:00Z',
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${parentId} content=Your assignment (recorded on the board as #1 for @verifier):\n\nAudit edge cases\n</SYSTEM_MESSAGE>`,
      }) +
        '\n' +
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T08:01:05Z',
          input_tokens: 100_000,
          cache_read_tokens: 0,
          output_tokens: 10_000,
        }) +
        '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });

    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 3);
    assert.equal(rep.models.length, 1);
    assert.equal(rep.models[0].model, 'gemini-4-neon-xhigh');
    const childSession = rep.sessions.find((s) => s.sessionId === childId);
    assert.ok(childSession && childSession.title.includes('[Swarm @verifier]'));
  } finally {
    h.cleanup();
  }
});

test('Claude Code adapter: cross-batch streaming LWW deduplication, 5m/1h cache writes, synthetic skip, and subagent isolation', () => {
  const h = createTestEnv('atm-cc-');
  try {
    const mainSession = 'cc-sess-001';
    const mainFile = h.mkClaudeTranscript('my-app', mainSession);
    const subFile = h.mkClaudeTranscript('my-app', mainSession, 'agent-a1b2');

    // Batch 1: user message + intermediate streaming chunk (stub output_tokens=8) + synthetic line
    writeFileSync(
      mainFile,
      [
        JSON.stringify({
          type: 'user',
          sessionId: mainSession,
          timestamp: '2026-11-21T10:00:00Z',
          message: {
            role: 'user',
            content: '<system-reminder>noise</system-reminder>Implement rate limiter',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: mainSession,
          requestId: 'req_01',
          timestamp: '2026-11-21T10:00:02Z',
          message: {
            id: 'msg_01',
            model: 'claude-sonnet-4-6-20260514',
            usage: {
              input_tokens: 1_000,
              cache_read_input_tokens: 20_000,
              cache_creation_input_tokens: 5_000,
              cache_creation: {
                ephemeral_5m_input_tokens: 3_000,
                ephemeral_1h_input_tokens: 2_000,
              },
              output_tokens: 8,
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: mainSession,
          requestId: 'req_syn',
          timestamp: '2026-11-21T10:00:03Z',
          message: {
            id: 'msg_syn',
            model: '<synthetic>',
            usage: { input_tokens: 500, output_tokens: 50 },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h.dataDir });
    let rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 1);
    assert.equal(rep.period.output, 8);

    // Batch 2: final streaming chunk for SAME msg_01:req_01 with real output_tokens=450
    // MUST overwrite stub 8 -> 450 (NOT double count 458!)
    appendFileSync(
      mainFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: mainSession,
        requestId: 'req_01',
        timestamp: '2026-11-21T10:00:05Z',
        message: {
          id: 'msg_01',
          model: 'claude-sonnet-4-6-20260514',
          usage: {
            input_tokens: 1_000,
            cache_read_input_tokens: 20_000,
            cache_creation_input_tokens: 5_000,
            cache_creation: {
              ephemeral_5m_input_tokens: 3_000,
              ephemeral_1h_input_tokens: 2_000,
            },
            output_tokens: 450,
          },
        },
      }) + '\n',
      'utf-8',
    );

    // Subagent file using legacy flat cache_creation_input_tokens (mapped to cw5)
    writeFileSync(
      subFile,
      [
        JSON.stringify({
          type: 'user',
          sessionId: mainSession,
          isSidechain: true,
          timestamp: '2026-11-21T10:01:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Search tests' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: mainSession,
          isSidechain: true,
          requestId: 'req_sub_1',
          timestamp: '2026-11-21T10:01:04Z',
          message: {
            id: 'msg_sub_1',
            model: 'claude-haiku-4-5',
            usage: {
              input_tokens: 2_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 4_000,
              output_tokens: 300,
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h.dataDir });
    rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });

    assert.equal(rep.allTime.totalEvents, 2);
    assert.equal(rep.sessions.length, 2);
    assert.equal(rep.period.input, 3_000);
    assert.equal(rep.period.cacheRead, 20_000);
    assert.equal(rep.period.cacheWrite5m, 7_000); // 3000 + 4000
    assert.equal(rep.period.cacheWrite1h, 2_000);
    assert.equal(rep.period.cacheWrite, 9_000);
    assert.equal(rep.period.output, 750); // 450 + 300 (NOT 458 + 300!)

    const mainSessObj = rep.sessions.find((s) => s.sessionId === mainSession);
    const subSessObj = rep.sessions.find((s) => s.sessionId === `${mainSession}:agent-a1b2`);
    assert.equal(mainSessObj.title, 'Implement rate limiter');
    assert.equal(subSessObj.title, '[Subagent] Search tests');
  } finally {
    h.cleanup();
  }
});

test('Codex adapter: duplicate snapshot elimination, cumulative delta across scans, inclusive subtraction, and turn_context model switch', () => {
  const h = createTestEnv('atm-codex-');
  try {
    const rollout = h.mkCodexRollout(
      '2026/11/21',
      'rollout-2026-11-21T12-00-00-33333333-3333-3333-3333-333333333333.jsonl',
    );

    // Batch 1: session_meta, preamble (must be skipped for title), real user message,
    // turn 1 token_count + DUPLICATE snapshot with identical total_token_usage!
    writeFileSync(
      rollout,
      [
        JSON.stringify({
          timestamp: '2026-11-21T12:00:00Z',
          type: 'session_meta',
          payload: { id: '33333333-3333-3333-3333-333333333333', model: 'gpt-5.3-codex' },
        }),
        JSON.stringify({
          timestamp: '2026-11-21T12:00:01Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>cwd=/repo</environment_context>' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-21T12:00:02Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Optimize SQL query plan' },
        }),
        JSON.stringify({
          timestamp: '2026-11-21T12:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100_000,
                cached_input_tokens: 80_000,
                output_tokens: 2_000,
                reasoning_output_tokens: 600,
              },
              last_token_usage: {
                input_tokens: 100_000,
                cached_input_tokens: 80_000,
                output_tokens: 2_000,
                reasoning_output_tokens: 600,
              },
            },
          },
        }),
        // Duplicate UI refresh snapshot — MUST BE IGNORED
        JSON.stringify({
          timestamp: '2026-11-21T12:00:06Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100_000,
                cached_input_tokens: 80_000,
                output_tokens: 2_000,
                reasoning_output_tokens: 600,
              },
              last_token_usage: {
                input_tokens: 100_000,
                cached_input_tokens: 80_000,
                output_tokens: 2_000,
                reasoning_output_tokens: 600,
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h.dataDir });
    let rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 1);
    // Inclusive subtraction: uncached = 100k - 80k = 20k; cacheRead = 80k; output = 2k; total = 102k (reasoning 600 NOT added again!)
    assert.equal(rep.period.input, 20_000);
    assert.equal(rep.period.cacheRead, 80_000);
    assert.equal(rep.period.output, 2_000);
    assert.equal(rep.period.reasoning, 600);
    assert.equal(rep.period.total, 102_000);
    assert.equal(rep.sessions[0].title, 'Optimize SQL query plan');

    // Batch 2: switch model via turn_context, then advance cumulative total_token_usage
    appendFileSync(
      rollout,
      [
        JSON.stringify({
          timestamp: '2026-11-21T12:01:00Z',
          type: 'turn_context',
          payload: { model: 'gpt-6-luna' },
        }),
        JSON.stringify({
          timestamp: '2026-11-21T12:01:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 150_000,
                cached_input_tokens: 125_000,
                output_tokens: 3_000,
                reasoning_output_tokens: 900,
              },
              last_token_usage: {
                input_tokens: 50_000,
                cached_input_tokens: 45_000,
                output_tokens: 1_000,
                reasoning_output_tokens: 300,
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h.dataDir });
    rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 2);
    // Turn 2 delta: inTotal 50k, cr 45k -> uncached 5k, cr 45k, out 1k, r 300
    assert.equal(rep.period.input, 25_000);
    assert.equal(rep.period.cacheRead, 125_000);
    assert.equal(rep.period.output, 3_000);
    assert.equal(rep.period.reasoning, 900);
    assert.equal(rep.period.total, 153_000);
    assert.deepEqual(
      rep.models.map((m) => m.model).sort(),
      ['gpt-5.3-codex', 'gpt-6-luna'],
    );

    // Full rescan must produce identical totals (idempotent delta calculation)
    syncAllSources({ dataDir: h.dataDir, forceFullRescan: true });
    const repFull = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(repFull.allTime.totalEvents, 2);
    assert.equal(repFull.period.total, 153_000);
    assert.equal(repFull.period.input, 25_000);
    assert.equal(repFull.period.cacheRead, 125_000);
  } finally {
    h.cleanup();
  }
});
