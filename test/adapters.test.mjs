import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';
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

test('Codex adapter: forked session_meta isolation, revert rollout disambiguation, cache_write_input_tokens, delayed replay, and token_usage_record', () => {
  const h = createTestEnv('atm-codex-v2-');
  try {
    const parentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const revertRolloutId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const replayId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const recId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    // 1. Parent rollout + forked child rollout containing TWO session_meta lines (child first, parent copied second)
    const parentFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T10-00-00-${parentId}.jsonl`);
    writeFileSync(
      parentFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T10:00:00Z', type: 'session_meta', payload: { id: parentId } }),
        JSON.stringify({ timestamp: '2026-11-22T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T10:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 100_000, cached_input_tokens: 60_000, cache_write_input_tokens: 15_000, output_tokens: 2_000 } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T10:00:10Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 150_000, cached_input_tokens: 90_000, cache_write_input_tokens: 25_000, output_tokens: 3_000 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const childFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T10-01-00-${childId}.jsonl`);
    writeFileSync(
      childFile,
      [
        JSON.stringify({
          timestamp: '2026-11-22T10:01:00Z',
          type: 'session_meta',
          payload: { id: childId, forked_from_id: parentId },
        }),
        // Copied parent session_meta later in the file MUST be ignored
        JSON.stringify({ timestamp: '2026-11-22T10:01:01Z', type: 'session_meta', payload: { id: parentId } }),
        JSON.stringify({ timestamp: '2026-11-22T10:01:02Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
        JSON.stringify({
          timestamp: '2026-11-22T10:01:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 40_000, cached_input_tokens: 20_000, output_tokens: 1_000 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 2. Revert rollout for parentId: distinct rolloutId MUST NOT collide with parentFile's tc:1
    const revertFile = h.mkCodexRollout(
      '2026/11/22',
      `rollout-2026-11-22T10-05-00-${parentId}-revert-${revertRolloutId}.jsonl`,
    );
    writeFileSync(
      revertFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T10:05:00Z', type: 'session_meta', payload: { id: parentId } }),
        JSON.stringify({ timestamp: '2026-11-22T10:05:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T10:05:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 20_000, cached_input_tokens: 10_000, output_tokens: 500 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 3. Delayed replay of older total_token_usage snapshot (110 -> 220 -> 110 -> 330 => total 330, NOT 440)
    const replayFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T10-10-00-${replayId}.jsonl`);
    writeFileSync(
      replayFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T10:10:00Z', type: 'session_meta', payload: { id: replayId } }),
        JSON.stringify({ timestamp: '2026-11-22T10:10:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T10:10:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T10:10:03Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 20 }, last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
        }),
        // Delayed replay of snapshot 1 -> MUST be skipped
        JSON.stringify({
          timestamp: '2026-11-22T10:10:04Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T10:10:05Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 30 }, last_token_usage: { input_tokens: 100, output_tokens: 10 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 4. Per-request token_usage_record preferred over token_count (even with repeated response_id)
    const recFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T10-20-00-${recId}.jsonl`);
    writeFileSync(
      recFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T10:20:00Z', type: 'session_meta', payload: { id: recId } }),
        JSON.stringify({ timestamp: '2026-11-22T10:20:01Z', type: 'turn_context', payload: { model: 'gpt-6-astra' } }),
        JSON.stringify({
          timestamp: '2026-11-22T10:20:02Z',
          type: 'event_msg',
          payload: {
            type: 'token_usage_record',
            response_id: 'resp_shared',
            usage: { input_tokens: 1_000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 200 },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T10:20:03Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 200 } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T10:20:04Z',
          type: 'event_msg',
          payload: {
            type: 'token_usage_record',
            response_id: 'resp_shared',
            usage: { input_tokens: 2_000, cached_input_tokens: 1_000, output_tokens: 300 },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h.dataDir });

    // Incremental append to childFile MUST stay locked to childId via persisted sessionMetaSeen
    appendFileSync(
      childFile,
      JSON.stringify({
        timestamp: '2026-11-22T10:02:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 50_000, cached_input_tokens: 25_000, output_tokens: 1_500 } },
        },
      }) + '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });

    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.sessions.length, 4);

    const parentSess = rep.sessions.find((s) => s.sessionId === parentId);
    const childSess = rep.sessions.find((s) => s.sessionId === childId);
    const replaySess = rep.sessions.find((s) => s.sessionId === replayId);
    const recSess = rep.sessions.find((s) => s.sessionId === recId);

    // Parent = 2 steps from parentFile (150k inTotal, 90k cr, 25k cw5, 3k out) + 1 step from revertFile (20k inTotal, 10k cr, 500 out)
    assert.equal(parentSess.steps, 3);
    assert.equal(parentSess.input, 45_000); // (150k - 90k - 25k) + (20k - 10k)
    assert.equal(parentSess.cacheRead, 100_000);
    assert.equal(parentSess.cacheWrite5m, 25_000);
    assert.equal(parentSess.input + parentSess.cacheRead + parentSess.cacheWrite5m, 170_000);
    assert.equal(parentSess.output, 3_500);

    // Child = 2 steps (never collided with parent), parentSessionId recorded in cursors
    assert.equal(childSess.steps, 2);
    assert.equal(childSess.total, 51_500);
    const cursors = JSON.parse(readFileSync(join(h.dataDir, 'cursors.json'), 'utf-8'));
    assert.equal(cursors.sessions[`codex:${childId}`].parentSessionId, parentId);

    // Delayed replay skipped -> 3 steps, total = 330 (NOT 440)
    assert.equal(replaySess.steps, 3);
    assert.equal(replaySess.total, 330);

    // token_usage_record: both records counted even with shared response_id; token_count ignored
    assert.equal(recSess.steps, 2);
    assert.equal(recSess.input, 1_500); // 500 + 1000
    assert.equal(recSess.cacheRead, 1_400); // 400 + 1000
    assert.equal(recSess.cacheWrite5m, 100);
    assert.equal(recSess.output, 500);
    assert.equal(recSess.total, 3_500);
  } finally {
    h.cleanup();
  }
});

test('Codex adapter: .jsonl.zst compression, archived_sessions/ discovery, .jsonl->.zst dedup, and pre-turn_context lookahead', () => {
  const h = createTestEnv('atm-codex-zst-');
  try {
    // Allow CODEX_HOME discovery of both sessions/ and archived_sessions/
    delete process.env.TOKEN_METER_CODEX_ROOTS;
    const archivedDir = join(h.codexDir, 'archived_sessions');
    mkdirSync(archivedDir, { recursive: true });

    const sessA = '12121212-1212-1212-1212-121212121212';
    const sessB = '34343434-3434-3434-3434-343434343434';

    // Rollout A has its first token_count BEFORE the first turn_context (tests model lookahead!)
    const contentA =
      [
        JSON.stringify({ timestamp: '2026-11-10T08:00:00Z', type: 'session_meta', payload: { id: sessA } }),
        JSON.stringify({
          timestamp: '2026-11-10T08:00:02Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 1_000 } },
          },
        }),
        JSON.stringify({ timestamp: '2026-11-10T08:00:03Z', type: 'turn_context', payload: { model: 'gpt-6-astra' } }),
      ].join('\n') + '\n';

    const plainFileA = h.mkCodexRollout('2026/11/10', `rollout-2026-11-10T08-00-00-${sessA}.jsonl`);
    writeFileSync(plainFileA, contentA, 'utf-8');
    syncAllSources({ dataDir: h.dataDir });

    let rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 1);
    assert.equal(rep.models[0].model, 'gpt-6-astra');
    assert.equal(rep.models[0].matchType, 'official');

    // Now write the SAME rollout compressed as .jsonl.zst inside flat archived_sessions/,
    // plus a second compressed archived rollout B.
    const zstA = join(archivedDir, `rollout-2026-11-10T08-00-00-${sessA}.jsonl.zst`);
    writeFileSync(zstA, zlib.zstdCompressSync(Buffer.from(contentA, 'utf-8')));

    const contentB =
      [
        JSON.stringify({ timestamp: '2026-11-05T09:00:00Z', type: 'session_meta', payload: { id: sessB } }),
        JSON.stringify({ timestamp: '2026-11-05T09:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-05T09:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 80_000, cached_input_tokens: 60_000, output_tokens: 2_000 } },
          },
        }),
      ].join('\n') + '\n';
    const zstB = join(archivedDir, `rollout-2026-11-05T09-00-00-${sessB}.jsonl.zst`);
    writeFileSync(zstB, zlib.zstdCompressSync(Buffer.from(contentB, 'utf-8')));

    // Also verify TOKEN_METER_CODEX_ROOTS pointing to CODEX_HOME picks up both sessions/ and archived_sessions/
    process.env.TOKEN_METER_CODEX_ROOTS = h.codexDir;
    syncAllSources({ dataDir: h.dataDir });

    rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    // Session A MUST NOT double-count when present as both .jsonl and .jsonl.zst; Session B IS added
    assert.equal(rep.allTime.totalEvents, 2);
    assert.equal(rep.sessions.length, 2);
    assert.equal(rep.period.total, 51_000 + 82_000);
    assert.deepEqual(
      rep.models.map((m) => m.model).sort(),
      ['gpt-5.6-sol', 'gpt-6-astra'],
    );
  } finally {
    h.cleanup();
  }
});

test('Codex red-team regressions: multi-frame & truncated .zst, sparse replay, v2.0.0 cursor, mixed ur/tc, case-insensitive UUID, whitespace model, and root dedup', () => {
  const h = createTestEnv('atm-codex-rt-');
  try {
    // 1. Multi-frame concatenated .jsonl.zst MUST decompress all frames (not just frame 1)
    const multiId = '77777777-7777-7777-7777-777777777777';
    const frame1 = zlib.zstdCompressSync(
      Buffer.from(
        JSON.stringify({ timestamp: '2026-11-15T10:00:00Z', type: 'session_meta', payload: { id: multiId } }) +
          '\n' +
          JSON.stringify({ timestamp: '2026-11-15T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) +
          '\n',
        'utf-8',
      ),
    );
    const frame2 = zlib.zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          timestamp: '2026-11-15T10:00:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
        }) + '\n',
        'utf-8',
      ),
    );
    const frame3 = zlib.zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          timestamp: '2026-11-15T10:00:03Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2_500, output_tokens: 250 } } },
        }) + '\n',
        'utf-8',
      ),
    );
    const multiFile = h.mkCodexRollout('2026/11/15', `rollout-2026-11-15T10-00-00-${multiId}.jsonl.zst`);
    writeFileSync(multiFile, Buffer.concat([frame1, frame2, frame3]));

    // 2. Delayed replay of sparse snapshot (omitted reasoning_output_tokens) + whitespace payload.model
    //    AND sparse duplicate refresh (Turn 1b omitting `r`) followed by advance and verbatim replay!
    const sparseId = '88888888-aaaa-8888-8888-888888888888';
    const sparseParent = '99999999-bbbb-9999-9999-999999999999';
    // Mixed-case UUID in filename vs lowercase in session_meta
    const sparseFile = h.mkCodexRollout(
      '2026/11/22',
      `rollout-2026-11-22T12-00-00-${sparseId.toUpperCase()}.jsonl`,
    );
    writeFileSync(
      sparseFile,
      [
        JSON.stringify({
          timestamp: '2026-11-22T12:00:00Z',
          type: 'session_meta',
          payload: { id: sparseId, forked_from_id: sparseParent },
        }),
        JSON.stringify({ timestamp: '2026-11-22T12:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
        // Turn 1 with reasoning_output_tokens = 50
        JSON.stringify({
          timestamp: '2026-11-22T12:00:02Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            model: '   ',
            info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 50 } },
          },
        }),
        // Turn 1b: sparse duplicate refresh omitting `r` (must record raw 1000:500:0:100:0 before continuing!)
        JSON.stringify({
          timestamp: '2026-11-22T12:00:02.500Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 100 } },
          },
        }),
        // Turn 2 omits reasoning_output_tokens
        JSON.stringify({
          timestamp: '2026-11-22T12:00:03Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 2_000, cached_input_tokens: 1_000, output_tokens: 200 } },
          },
        }),
        // Turn 2b: delayed replay of Turn 1b sparse refresh -> MUST be skipped (NOT trigger reset!)
        JSON.stringify({
          timestamp: '2026-11-22T12:00:03.500Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 100 } },
          },
        }),
        // Turn 3 advances
        JSON.stringify({
          timestamp: '2026-11-22T12:00:04Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 3_000, cached_input_tokens: 1_500, output_tokens: 300 } },
          },
        }),
        // Turn 4: verbatim delayed replay of Turn 2 (without reasoning_output_tokens) -> MUST be skipped!
        JSON.stringify({
          timestamp: '2026-11-22T12:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 2_000, cached_input_tokens: 1_000, output_tokens: 200 } },
          },
        }),
        // Turn 5 advances to 4000/400 -> delta MUST be 1000/100 (NOT 2000/200!)
        JSON.stringify({
          timestamp: '2026-11-22T12:00:06Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 4_000, cached_input_tokens: 2_000, output_tokens: 400 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 3. Empty/invalid token_usage_record MUST NOT poison valid token_count in the same file
    const poisonId = '10101010-1010-1010-1010-101010101010';
    const poisonFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T13-00-00-${poisonId}.jsonl`);
    writeFileSync(
      poisonFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T13:00:00Z', type: 'session_meta', payload: { id: poisonId } }),
        JSON.stringify({ timestamp: '2026-11-22T13:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
        JSON.stringify({ timestamp: '2026-11-22T13:00:02Z', type: 'token_usage_record', usage: {} }),
        JSON.stringify({
          timestamp: '2026-11-22T13:00:03Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5_000, output_tokens: 500 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 4. Incremental tc -> ur transition + duplicate response_id + full rescan / .zst must NEVER double-count
    const mixId = '20202020-2020-2020-2020-202020202020';
    const mixFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T14-00-00-${mixId}.jsonl`);
    writeFileSync(
      mixFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T14:00:00Z', type: 'session_meta', payload: { id: mixId } }),
        JSON.stringify({ timestamp: '2026-11-22T14:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T14:00:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // Duplicate overlapping roots in TOKEN_METER_CODEX_ROOTS MUST be deduplicated
    process.env.TOKEN_METER_CODEX_ROOTS = `${h.codexDir}${process.platform === 'win32' ? ';' : ':'}${h.codexSessionsDir}`;
    syncAllSources({ dataDir: h.dataDir });

    // Batch 2 on mixFile: token_usage_record + exact duplicate response_id replay + paired token_count
    appendFileSync(
      mixFile,
      [
        JSON.stringify({
          timestamp: '2026-11-22T14:00:10Z',
          type: 'event_msg',
          payload: {
            type: 'token_usage_record',
            response_id: 'resp_dup_1',
            usage: { input_tokens: 1_000, output_tokens: 100 },
          },
        }),
        // Exact duplicate replay with same response_id & identical usage 1s later -> MUST be skipped
        JSON.stringify({
          timestamp: '2026-11-22T14:00:11Z',
          type: 'event_msg',
          payload: {
            type: 'token_usage_record',
            response_id: 'resp_dup_1',
            usage: { input_tokens: 1_000, output_tokens: 100 },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T14:00:12Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2_000, output_tokens: 200 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });
    // Full rescan after incremental tc -> ur transition MUST keep exact count (2 steps, 2200 tokens, NOT 4400)
    syncAllSources({ dataDir: h.dataDir, forceFullRescan: true });

    // Simulate v2.0.0 cursor (lacking `seenTotals`) followed by delayed replay on a fresh rollout
    const v2Id = '30303030-3030-3030-3030-303030303030';
    const v2File = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T15-00-00-${v2Id}.jsonl`);
    writeFileSync(
      v2File,
      [
        JSON.stringify({ timestamp: '2026-11-22T15:00:00Z', type: 'session_meta', payload: { id: v2Id } }),
        JSON.stringify({ timestamp: '2026-11-22T15:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
        JSON.stringify({
          timestamp: '2026-11-22T15:00:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });
    // Strip `seenTotals` from persisted cursor to emulate v2.0.0 upgrade
    const cursorsPath = join(h.dataDir, 'cursors.json');
    const curState = JSON.parse(readFileSync(cursorsPath, 'utf-8'));
    for (const c of Object.values(curState.files)) {
      if (c.sessionId === v2Id) delete c.seenTotals;
    }
    writeFileSync(cursorsPath, JSON.stringify(curState, null, 2), 'utf-8');
    appendFileSync(
      v2File,
      [
        JSON.stringify({
          timestamp: '2026-11-22T15:00:05Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2_000, output_tokens: 200 } } },
        }),
        // Delayed replay of initial snapshot (1000/100) after v2.0.0 cursor upgrade -> MUST be skipped
        JSON.stringify({
          timestamp: '2026-11-22T15:00:06Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });

    // 5. Millisecond-offset paired `token_count` -> `token_usage_record` handoff (5ms apart) MUST NOT double-count step 1
    const handoffId = '40404040-4040-4040-4040-404040404040';
    const handoffFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T15-10-00-${handoffId}.jsonl`);
    writeFileSync(
      handoffFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T15:10:00.000Z', type: 'session_meta', payload: { id: handoffId } }),
        JSON.stringify({ timestamp: '2026-11-22T15:10:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T15:10:02.100Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
        }),
        // Paired token_usage_record flushed 5ms later for step 1 -> MUST dedup against step 1!
        JSON.stringify({
          timestamp: '2026-11-22T15:10:02.105Z',
          type: 'event_msg',
          payload: { type: 'token_usage_record', response_id: 'r_h1', usage: { input_tokens: 1_000, output_tokens: 100 } },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T15:10:05.200Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2_000, output_tokens: 200 } } },
        }),
        JSON.stringify({
          timestamp: '2026-11-22T15:10:05.205Z',
          type: 'event_msg',
          payload: { type: 'token_usage_record', response_id: 'r_h2', usage: { input_tokens: 1_000, output_tokens: 100 } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    syncAllSources({ dataDir: h.dataDir });

    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    const multiSess = rep.sessions.find((s) => s.sessionId === multiId);
    const sparseSess = rep.sessions.find((s) => s.sessionId === sparseId);
    const poisonSess = rep.sessions.find((s) => s.sessionId === poisonId);
    const mixSess = rep.sessions.find((s) => s.sessionId === mixId);
    const v2Sess = rep.sessions.find((s) => s.sessionId === v2Id);
    const handoffSess = rep.sessions.find((s) => s.sessionId === handoffId);

    assert.equal(multiSess.steps, 2);
    assert.equal(multiSess.total, 2_750);

    assert.equal(sparseSess.steps, 4);
    assert.equal(sparseSess.total, 4_400);
    assert.equal(sparseSess.unpricedSteps, 0);
    const finalCursors = JSON.parse(readFileSync(cursorsPath, 'utf-8'));
    assert.equal(finalCursors.sessions[`codex:${sparseId}`].parentSessionId, sparseParent);

    assert.equal(poisonSess.steps, 1);
    assert.equal(poisonSess.total, 5_500);

    assert.equal(mixSess.steps, 2);
    assert.equal(mixSess.total, 2_200);

    assert.equal(v2Sess.steps, 2);
    assert.equal(v2Sess.total, 2_200);

    assert.equal(handoffSess.steps, 2);
    assert.equal(handoffSess.total, 2_200);
  } finally {
    h.cleanup();
  }
});
