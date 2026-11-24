import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { antigravityAdapter } from '../adapters/antigravity.mjs';
import { claudeCodeAdapter } from '../adapters/claude-code.mjs';
import { detectAdapterForPath } from '../adapters/index.mjs';
import { canonicalFileKey } from '../core/fs-utils.mjs';
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

test('Codex v2.0.2 regressions: >256MiB .jsonl.zst streaming, skippedFiles reporting, native <threadId>_<rolloutId> revert, nested parent_thread_id, cross-batch model backfill, and v2.0.0 ledger upgrade', () => {
  const h = createTestEnv('atm-codex-v202-');
  try {
    // 1. Large (>256 MiB uncompressed) .jsonl.zst must decompress cleanly without silent drops
    const hugeId = '61616161-6161-6161-6161-616161616161';
    const padLine = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'z'.repeat(100_000) } }) + '\n';
    const head =
      JSON.stringify({ timestamp: '2026-11-12T08:00:00Z', type: 'session_meta', payload: { id: hugeId } }) +
      '\n' +
      JSON.stringify({ timestamp: '2026-11-12T08:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }) +
      '\n' +
      JSON.stringify({
        timestamp: '2026-11-12T08:00:02Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
      }) +
      '\n';
    const tail =
      JSON.stringify({
        timestamp: '2026-11-12T08:00:05Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3_000, output_tokens: 300 } } },
      }) + '\n';
    // 270 MiB of uncompressed JSONL (>256 MiB old cap)
    const hugeBuf = Buffer.concat([
      Buffer.from(head, 'utf-8'),
      Buffer.from(padLine.repeat(2750), 'utf-8'),
      Buffer.from(tail, 'utf-8'),
    ]);
    assert.ok(hugeBuf.length > 260 * 1024 * 1024);
    const hugeFile = h.mkCodexRollout('2026/11/12', `rollout-2026-11-12T08-00-00-${hugeId}.jsonl.zst`);
    writeFileSync(hugeFile, zlib.zstdCompressSync(hugeBuf));

    // 2. Native Codex 0.171 `<threadId>_<rolloutId>.jsonl` revert filename
    const natThreadId = '62626262-6262-6262-6262-626262626262';
    const natRolloutId = '63636363-6363-6363-6363-636363636363';
    const natMain = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T09-00-00-${natThreadId}.jsonl`);
    writeFileSync(
      natMain,
      [
        JSON.stringify({ timestamp: '2026-11-22T09:00:00Z', type: 'session_meta', payload: { id: natThreadId } }),
        JSON.stringify({ timestamp: '2026-11-22T09:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T09:00:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5_000, output_tokens: 500 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const natRevertContent =
      [
        JSON.stringify({ timestamp: '2026-11-22T09:05:00Z', type: 'session_meta', payload: { id: natThreadId } }),
        JSON.stringify({ timestamp: '2026-11-22T09:05:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-22T09:05:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2_000, output_tokens: 200 } } },
        }),
      ].join('\n') + '\n';
    const natRevert = h.mkCodexRollout(
      '2026/11/22',
      `rollout-2026-11-22T09-05-00-${natThreadId}_${natRolloutId}.jsonl`,
    );
    writeFileSync(natRevert, natRevertContent, 'utf-8');

    // 3. Nested `source.subagent.thread_spawn.parent_thread_id`
    const nestedChildId = '64646464-6464-6464-6464-646464646464';
    const nestedChild = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T09-10-00-${nestedChildId}.jsonl`);
    writeFileSync(
      nestedChild,
      [
        JSON.stringify({
          timestamp: '2026-11-22T09:10:00Z',
          type: 'session_meta',
          payload: {
            id: nestedChildId,
            source: { subagent: { thread_spawn: { parent_thread_id: natThreadId } } },
          },
        }),
        JSON.stringify({ timestamp: '2026-11-22T09:10:01Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
        JSON.stringify({
          timestamp: '2026-11-22T09:10:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 4. Cross-batch pre-turn_context model backfill (Batch 1 has token_count only, Batch 2 adds turn_context)
    const lateModelId = '65656565-6565-6565-6565-656565656565';
    const lateModelFile = h.mkCodexRollout('2026/11/22', `rollout-2026-11-22T09-20-00-${lateModelId}.jsonl`);
    writeFileSync(
      lateModelFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T09:20:00Z', type: 'session_meta', payload: { id: lateModelId } }),
        JSON.stringify({
          timestamp: '2026-11-22T09:20:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 4_000, output_tokens: 400 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const sync1 = syncAllSources({ dataDir: h.dataDir });
    assert.equal(sync1.skipped, 0);

    // Append turn_context in Batch 2 (NO forceFullRescan!)
    appendFileSync(
      lateModelFile,
      JSON.stringify({ timestamp: '2026-11-22T09:20:05Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }) + '\n',
      'utf-8',
    );
    // Also add compressed twin of natRevert to prove `_<rolloutId>` deduplicates across .jsonl -> .jsonl.zst
    const natRevertZst = h.mkCodexRollout(
      '2026/11/22',
      `rollout-2026-11-22T09-05-00-${natThreadId}_${natRolloutId}.jsonl.zst`,
    );
    writeFileSync(natRevertZst, zlib.zstdCompressSync(Buffer.from(natRevertContent, 'utf-8')));

    syncAllSources({ dataDir: h.dataDir });
    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });

    const hugeSess = rep.sessions.find((s) => s.sessionId === hugeId);
    assert.equal(hugeSess.steps, 2);
    assert.equal(hugeSess.total, 3_300);

    // Native `<threadId>_<rolloutId>` MUST group into `natThreadId`, NOT create a separate `natRolloutId` session
    assert.equal(rep.sessions.find((s) => s.sessionId === natRolloutId), undefined);
    const natSess = rep.sessions.find((s) => s.sessionId === natThreadId);
    assert.equal(natSess.steps, 2);
    assert.equal(natSess.total, 7_700);

    // Nested parent_thread_id extracted
    const cursors = JSON.parse(readFileSync(join(h.dataDir, 'cursors.json'), 'utf-8'));
    assert.equal(cursors.sessions[`codex:${nestedChildId}`].parentSessionId, natThreadId);

    // Cross-batch late turn_context backfilled without needing sync --full
    const lateSess = rep.sessions.find((s) => s.sessionId === lateModelId);
    assert.equal(lateSess.primaryModel, 'gpt-6.2-sol');
    assert.equal(lateSess.unpricedSteps, 0);

    // Lowering TOKEN_METER_MAX_ZSTD_BYTES below hugeFile's size MUST report skippedFiles and preserve existing events
    process.env.TOKEN_METER_MAX_ZSTD_BYTES = String(1024 * 1024);
    const cappedSync = syncAllSources({ dataDir: h.dataDir, forceFullRescan: true });
    assert.equal(cappedSync.skipped, 1);
    assert.equal(cappedSync.skippedFiles[0].filePath, hugeFile);
    const repAfterCap = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(repAfterCap.sessions.find((s) => s.sessionId === hugeId)?.total, 3_300);
    delete process.env.TOKEN_METER_MAX_ZSTD_BYTES;

    // 5. Legacy v2.0.0 ledger upgrade (parent + forked child with ghost `parentId:tc:2` key + deleted archived session)
    const upgEnv = createTestEnv('atm-codex-upg-');
    try {
      const pId = '71717171-7171-7171-7171-717171717171';
      const cId = '72727272-7272-7272-7272-727272727272';
      const delId = '73737373-7373-7373-7373-737373737373';
      const pFile = upgEnv.mkCodexRollout('2026/11/22', `rollout-2026-11-22T10-00-00-${pId}.jsonl`);
      const cFile = upgEnv.mkCodexRollout('2026/11/22', `rollout-2026-11-22T10-01-00-${cId}.jsonl`);

      writeFileSync(
        pFile,
        [
          JSON.stringify({ timestamp: '2026-11-22T10:00:00Z', type: 'session_meta', payload: { id: pId } }),
          JSON.stringify({ timestamp: '2026-11-22T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
          JSON.stringify({
            timestamp: '2026-11-22T10:00:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90, output_tokens: 10 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      writeFileSync(
        cFile,
        [
          JSON.stringify({
            timestamp: '2026-11-22T10:01:00Z',
            type: 'session_meta',
            payload: { id: cId, forked_from_id: pId },
          }),
          JSON.stringify({ timestamp: '2026-11-22T10:01:01Z', type: 'session_meta', payload: { id: pId } }),
          JSON.stringify({ timestamp: '2026-11-22T10:01:02Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
          JSON.stringify({
            timestamp: '2026-11-22T10:01:03Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 20 } } },
          }),
          JSON.stringify({
            timestamp: '2026-11-22T10:01:04Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 290, output_tokens: 30 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );

      // Seed v2.0.0 ledger state: both files marked up-to-date with NO parserVersion & child misattributed to pId
      const pSt = statSync(pFile);
      const cSt = statSync(cFile);
      mkdirSync(join(upgEnv.dataDir, 'events'), { recursive: true });
      writeFileSync(
        join(upgEnv.dataDir, 'cursors.json'),
        JSON.stringify(
          {
            version: 2,
            files: {
              [canonicalFileKey(pFile)]: {
                agent: 'codex',
                app: 'codex',
                sessionId: pId,
                size: pSt.size,
                mtimeMs: pSt.mtimeMs,
                ino: pSt.ino,
                offset: pSt.size,
                deltaSeq: 1,
              },
              [canonicalFileKey(cFile)]: {
                agent: 'codex',
                app: 'codex',
                sessionId: pId,
                size: cSt.size,
                mtimeMs: cSt.mtimeMs,
                ino: cSt.ino,
                offset: cSt.size,
                deltaSeq: 2,
              },
            },
            sessions: {
              [`codex:${pId}`]: { agent: 'codex', sessionId: pId, app: 'codex', lastModel: 'gpt-6-luna' },
              [`codex:${delId}`]: { agent: 'codex', sessionId: delId, app: 'codex', title: 'Archived deleted chat' },
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(
        join(upgEnv.dataDir, 'events', '2026-11.jsonl'),
        [
          // Collided tc:1 (child overwrote parent) + ghost tc:2 (from child misattributed to parent)
          JSON.stringify({ a: 'codex', c: pId, e: 'tc:1', ts: Date.parse('2026-11-22T10:01:03Z'), m: 'gpt-6-luna', k: 'T', in: 200, cr: 0, cw5: 0, cw1h: 0, out: 20, r: 0 }),
          JSON.stringify({ a: 'codex', c: pId, e: 'tc:2', ts: Date.parse('2026-11-22T10:01:04Z'), m: 'gpt-6-luna', k: 'T', in: 90, cr: 0, cw5: 0, cw1h: 0, out: 10, r: 0 }),
          // Genuinely archived event from a deleted transcript -> MUST survive upgrade AND --full
          JSON.stringify({ a: 'codex', c: delId, e: 'tc:1', ts: Date.parse('2026-11-20T10:00:00Z'), m: 'gpt-6-luna', k: 'T', in: 500, cr: 0, cw5: 0, cw1h: 0, out: 50, r: 0 }),
        ].join('\n') + '\n',
        'utf-8',
      );

      // Normal sync MUST auto-upgrade cursors, purge ghost pId:tc:2, and preserve deleted session
      syncAllSources({ dataDir: upgEnv.dataDir });
      let uRep = buildReport({ dataDir: upgEnv.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(uRep.sessions.find((s) => s.sessionId === pId)?.steps, 1);
      assert.equal(uRep.sessions.find((s) => s.sessionId === pId)?.total, 100);
      assert.equal(uRep.sessions.find((s) => s.sessionId === cId)?.steps, 2);
      assert.equal(uRep.sessions.find((s) => s.sessionId === cId)?.total, 320);
      assert.equal(uRep.sessions.find((s) => s.sessionId === delId)?.total, 550);
      assert.equal(uRep.allTime.totalEvents, 4); // 1 parent + 2 child + 1 archived deleted (NOT 5!)

      // Full rescan MUST produce the exact same clean totals
      syncAllSources({ dataDir: upgEnv.dataDir, forceFullRescan: true });
      uRep = buildReport({ dataDir: upgEnv.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(uRep.allTime.totalEvents, 4);
      assert.equal(uRep.period.total, 100 + 320 + 550);
    } finally {
      upgEnv.cleanup();
    }

    // 6. Red-team v2.0.2 upgrade & boundary closures:
    //    (a) syncSingleSource (Hook) runs BEFORE syncAllSources on a legacy v2.0.1 native revert ledger
    //    (b) Dynamic session_meta.id during upgrade converges & rescans unchanged live sibling
    //    (c) Corrupt sibling .zst preserves healthy sibling's title & lastModel in state.sessions
    //    (d) `-revert-` filename containing an underscore still extracts `<threadId>`
    const rtEnv = createTestEnv('atm-codex-v202-rt-');
    try {
      const tId = '81818181-8181-8181-8181-818181818181';
      const rId = '82828282-8282-8282-8282-828282828282';
      const revFile = rtEnv.mkCodexRollout('2026/11/22', `rollout-2026-11-22T11-00-00-${tId}_${rId}.jsonl`);
      writeFileSync(
        revFile,
        [
          JSON.stringify({ timestamp: '2026-11-22T11:00:00Z', type: 'session_meta', payload: { id: tId } }),
          JSON.stringify({ timestamp: '2026-11-22T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
          JSON.stringify({
            timestamp: '2026-11-22T11:00:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10_000, output_tokens: 1_000 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      const revSt = statSync(revFile);
      mkdirSync(join(rtEnv.dataDir, 'events'), { recursive: true });
      // Emulate v2.0.1 ledger where `_<rId>` was misattributed to sessionId = rId (no parserVersion)
      writeFileSync(
        join(rtEnv.dataDir, 'cursors.json'),
        JSON.stringify(
          {
            version: 2,
            files: {
              [canonicalFileKey(revFile)]: {
                agent: 'codex',
                app: 'codex',
                sessionId: rId,
                size: revSt.size,
                mtimeMs: revSt.mtimeMs,
                ino: revSt.ino,
                offset: revSt.size,
                deltaSeq: 1,
              },
            },
            sessions: {
              [`codex:${rId}`]: { agent: 'codex', sessionId: rId, app: 'codex', lastModel: 'gpt-6-sol' },
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(
        join(rtEnv.dataDir, 'events', '2026-11.jsonl'),
        JSON.stringify({ a: 'codex', c: rId, e: 'tc:1', ts: Date.parse('2026-11-22T11:00:02Z'), m: 'gpt-6-sol', k: 'T', in: 10_000, cr: 0, cw5: 0, cw1h: 0, out: 1_000, r: 0 }) + '\n',
        'utf-8',
      );

      // (a) Hook triggers syncSingleSource FIRST, then syncAllSources runs -> MUST clean up ghost rId with zero double-count!
      syncSingleSource(revFile, { agent: 'codex', dataDir: rtEnv.dataDir });
      syncAllSources({ dataDir: rtEnv.dataDir });
      let rtRep = buildReport({ dataDir: rtEnv.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rtRep.sessions.length, 1);
      assert.equal(rtRep.sessions[0].sessionId, tId);
      assert.equal(rtRep.period.total, 11_000);

      // (b) Dynamic session_meta.id on a legacy non-UUID file colliding with already-upgraded unchanged sibling
      const dynSib = rtEnv.mkCodexRollout('2026/11/22', 'rollout-legacy-revert-r2.jsonl');
      writeFileSync(
        dynSib,
        [
          JSON.stringify({ timestamp: '2026-11-22T11:05:00Z', type: 'session_meta', payload: { id: tId } }),
          JSON.stringify({ timestamp: '2026-11-22T11:05:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
          JSON.stringify({
            timestamp: '2026-11-22T11:05:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2_000, output_tokens: 200 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      const dynSt = statSync(dynSib);
      const curNow = JSON.parse(readFileSync(join(rtEnv.dataDir, 'cursors.json'), 'utf-8'));
      curNow.files[canonicalFileKey(dynSib)] = {
        agent: 'codex',
        app: 'codex',
        sessionId: 'rollout-legacy-revert-r2',
        size: dynSt.size,
        mtimeMs: dynSt.mtimeMs,
        ino: dynSt.ino,
        offset: dynSt.size,
        deltaSeq: 1,
      };
      writeFileSync(join(rtEnv.dataDir, 'cursors.json'), JSON.stringify(curNow, null, 2), 'utf-8');
      syncAllSources({ dataDir: rtEnv.dataDir });
      rtRep = buildReport({ dataDir: rtEnv.dataDir, rangeDays: 0, timeZone: 'UTC' });
      // MUST preserve BOTH revFile (11,000) AND dynSib (2,200) = 13,200 (2 steps)!
      assert.equal(rtRep.sessions.find((s) => s.sessionId === tId)?.steps, 2);
      assert.equal(rtRep.sessions.find((s) => s.sessionId === tId)?.total, 13_200);

      // (c) Healthy sibling + corrupt .zst sibling sharing same threadId -> healthy title & lastModel MUST be kept
      const healthId = '83838383-8383-8383-8383-838383838383';
      const healthRev = '84848484-8484-8484-8484-848484848484';
      const healthFile = rtEnv.mkCodexRollout('2026/11/22', `rollout-2026-11-22T12-00-00-${healthId}.jsonl`);
      writeFileSync(
        healthFile,
        [
          JSON.stringify({ timestamp: '2026-11-22T12:00:00Z', type: 'session_meta', payload: { id: healthId } }),
          JSON.stringify({ timestamp: '2026-11-22T12:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
          JSON.stringify({ timestamp: '2026-11-22T12:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'Healthy Title' } }),
          JSON.stringify({
            timestamp: '2026-11-22T12:00:03Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      const corruptSib = rtEnv.mkCodexRollout(
        '2026/11/22',
        `rollout-2026-11-22T12-05-00-${healthId}_${healthRev}.jsonl.zst`,
      );
      writeFileSync(corruptSib, Buffer.from('corrupt-zst-payload'));
      const corRes = syncAllSources({ dataDir: rtEnv.dataDir, forceFullRescan: true });
      assert.equal(corRes.skipped, 1);
      const curAfterCor = JSON.parse(readFileSync(join(rtEnv.dataDir, 'cursors.json'), 'utf-8'));
      assert.equal(curAfterCor.sessions[`codex:${healthId}`]?.title, 'Healthy Title');
      assert.equal(curAfterCor.sessions[`codex:${healthId}`]?.lastModel, 'gpt-6.1-sol');

      // (d) `-revert-` filename containing an underscore still extracts threadId (not rolloutId)
      const uTid = '85858585-8585-8585-8585-858585858585';
      const uRid = '86868686-8686-8686-8686-868686868686';
      const uFile = rtEnv.mkCodexRollout(
        '2026/11/22',
        `rollout-2026-11-22T12-10-00-${uTid}-revert-${uRid}_copy.jsonl`,
      );
      writeFileSync(
        uFile,
        [
          JSON.stringify({ timestamp: '2026-11-22T12:10:00Z', type: 'session_meta', payload: { id: uTid } }),
          JSON.stringify({ timestamp: '2026-11-22T12:10:01Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
          JSON.stringify({
            timestamp: '2026-11-22T12:10:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 50 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      syncAllSources({ dataDir: rtEnv.dataDir });
      const uRep2 = buildReport({ dataDir: rtEnv.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(uRep2.sessions.find((s) => s.sessionId === uTid)?.total, 550);
    } finally {
      rtEnv.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('Codex v2.0.3 regressions: same-thread deleted sibling archive preservation, zero-duplicate hook-first upgrade, and stable firstModel backfill across model switches', () => {
  // 1. Same-thread deleted main rollout preserved when revert sibling remains on disk (v2.0.3 --full AND v2.0.1 upgrade)
  const h1 = createTestEnv('atm-codex-v203-sib-');
  try {
    const tId = '91919191-9191-9191-9191-919191919191';
    const rId = '92929292-9292-9292-9292-929292929292';
    const mainFile = h1.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-00-00-${tId}.jsonl`);
    const revFile = h1.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-05-00-${tId}_${rId}.jsonl`);

    writeFileSync(
      mainFile,
      [
        JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'session_meta', payload: { id: tId } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'Original Thread Title' } }),
        JSON.stringify({
          timestamp: '2026-11-23T10:00:03Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    writeFileSync(
      revFile,
      [
        JSON.stringify({ timestamp: '2026-11-23T10:05:00Z', type: 'session_meta', payload: { id: tId } }),
        JSON.stringify({ timestamp: '2026-11-23T10:05:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-23T10:05:02Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 30 } } },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T10:05:03Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 317, output_tokens: 50 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h1.dataDir });
    let rep = buildReport({ dataDir: h1.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 3);
    assert.equal(rep.period.total, 487);

    // Delete original rollout, keep ONLY revert sibling -> sync --full MUST preserve all 3 steps / 487 tokens & title!
    unlinkSync(mainFile);
    syncAllSources({ dataDir: h1.dataDir, forceFullRescan: true });
    rep = buildReport({ dataDir: h1.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 3);
    assert.equal(rep.period.total, 487);
    assert.equal(rep.sessions.find((s) => s.sessionId === tId)?.title, 'Original Thread Title');

    // Also test v2.0.1 ledger where original was deleted and ONLY revert remains -> hook-first syncSingleSource
    // MUST immediately produce exact 3 steps / 487 tokens (zero temporary inflation in summary --no-sync)!
    const h2 = createTestEnv('atm-codex-v203-hookupg-');
    try {
      const rev2 = h2.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-05-00-${tId}_${rId}.jsonl`);
      writeFileSync(rev2, readFileSync(revFile, 'utf-8'), 'utf-8');
      const revSt = statSync(rev2);
      mkdirSync(join(h2.dataDir, 'events'), { recursive: true });
      writeFileSync(
        join(h2.dataDir, 'cursors.json'),
        JSON.stringify(
          {
            version: 2,
            files: {
              [canonicalFileKey(rev2)]: {
                agent: 'codex',
                app: 'codex',
                sessionId: rId,
                size: revSt.size,
                mtimeMs: revSt.mtimeMs,
                ino: revSt.ino,
                offset: revSt.size,
                deltaSeq: 2,
              },
            },
            sessions: {
              [`codex:${tId}`]: { agent: 'codex', sessionId: tId, app: 'codex', title: 'Archived Main Title', lastModel: 'gpt-6-sol' },
              [`codex:${rId}`]: { agent: 'codex', sessionId: rId, app: 'codex', lastModel: 'gpt-6-sol' },
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(
        join(h2.dataDir, 'events', '2026-11.jsonl'),
        [
          JSON.stringify({ a: 'codex', c: tId, e: 'tc:1', ts: Date.parse('2026-11-23T10:00:03Z'), m: 'gpt-6-sol', k: 'T', in: 100, cr: 0, cw5: 0, cw1h: 0, out: 20, r: 0 }),
          JSON.stringify({ a: 'codex', c: rId, e: 'tc:1', ts: Date.parse('2026-11-23T10:05:02Z'), m: 'gpt-6-sol', k: 'T', in: 200, cr: 0, cw5: 0, cw1h: 0, out: 30, r: 0 }),
          JSON.stringify({ a: 'codex', c: rId, e: 'tc:2', ts: Date.parse('2026-11-23T10:05:03Z'), m: 'gpt-6-sol', k: 'T', in: 117, cr: 0, cw5: 0, cw1h: 0, out: 20, r: 0 }),
        ].join('\n') + '\n',
        'utf-8',
      );

      // Run Hook (syncSingleSource) BEFORE global sync -> immediate exact result with no temporary 817-token spike!
      syncSingleSource(rev2, { agent: 'codex', dataDir: h2.dataDir });
      let rep2 = buildReport({ dataDir: h2.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rep2.allTime.totalEvents, 3);
      assert.equal(rep2.period.total, 487);
      assert.equal(rep2.sessions.length, 1);
      assert.equal(rep2.sessions[0].sessionId, tId);
      assert.equal(rep2.sessions[0].title, 'Archived Main Title');

      // Subsequent normal sync and --full remain identical
      syncAllSources({ dataDir: h2.dataDir });
      syncAllSources({ dataDir: h2.dataDir, forceFullRescan: true });
      rep2 = buildReport({ dataDir: h2.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rep2.allTime.totalEvents, 3);
      assert.equal(rep2.period.total, 487);
    } finally {
      h2.cleanup();
    }

    // 2. Shared-scope v2.0.0 fork collision: hook-first syncSingleSource MUST defer without duplicating,
    //    then syncAllSources cleanly upgrades both parent & child
    const h3 = createTestEnv('atm-codex-v203-forkhook-');
    try {
      const pId = '93939393-9393-9393-9393-939393939393';
      const cId = '94949494-9494-9494-9494-949494949494';
      const pFile = h3.mkCodexRollout('2026/11/23', `rollout-2026-11-23T11-00-00-${pId}.jsonl`);
      const cFile = h3.mkCodexRollout('2026/11/23', `rollout-2026-11-23T11-01-00-${cId}.jsonl`);
      writeFileSync(
        pFile,
        [
          JSON.stringify({ timestamp: '2026-11-23T11:00:00Z', type: 'session_meta', payload: { id: pId } }),
          JSON.stringify({ timestamp: '2026-11-23T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
          JSON.stringify({
            timestamp: '2026-11-23T11:00:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90, output_tokens: 10 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      writeFileSync(
        cFile,
        [
          JSON.stringify({ timestamp: '2026-11-23T11:01:00Z', type: 'session_meta', payload: { id: cId, forked_from_id: pId } }),
          JSON.stringify({ timestamp: '2026-11-23T11:01:01Z', type: 'session_meta', payload: { id: pId } }),
          JSON.stringify({ timestamp: '2026-11-23T11:01:02Z', type: 'turn_context', payload: { model: 'gpt-6-luna' } }),
          JSON.stringify({
            timestamp: '2026-11-23T11:01:03Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 20 } } },
          }),
          JSON.stringify({
            timestamp: '2026-11-23T11:01:04Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 290, output_tokens: 30 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      const pSt = statSync(pFile);
      const cSt = statSync(cFile);
      mkdirSync(join(h3.dataDir, 'events'), { recursive: true });
      writeFileSync(
        join(h3.dataDir, 'cursors.json'),
        JSON.stringify(
          {
            version: 2,
            files: {
              [canonicalFileKey(pFile)]: { agent: 'codex', app: 'codex', sessionId: pId, size: pSt.size, mtimeMs: pSt.mtimeMs, ino: pSt.ino, offset: pSt.size, deltaSeq: 1 },
              [canonicalFileKey(cFile)]: { agent: 'codex', app: 'codex', sessionId: pId, size: cSt.size, mtimeMs: cSt.mtimeMs, ino: cSt.ino, offset: cSt.size, deltaSeq: 2 },
            },
            sessions: {
              [`codex:${pId}`]: { agent: 'codex', sessionId: pId, app: 'codex', lastModel: 'gpt-6-luna' },
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(
        join(h3.dataDir, 'events', '2026-11.jsonl'),
        [
          JSON.stringify({ a: 'codex', c: pId, e: 'tc:1', ts: Date.parse('2026-11-23T11:01:03Z'), m: 'gpt-6-luna', k: 'T', in: 200, cr: 0, cw5: 0, cw1h: 0, out: 20, r: 0 }),
          JSON.stringify({ a: 'codex', c: pId, e: 'tc:2', ts: Date.parse('2026-11-23T11:01:04Z'), m: 'gpt-6-luna', k: 'T', in: 90, cr: 0, cw5: 0, cw1h: 0, out: 10, r: 0 }),
        ].join('\n') + '\n',
        'utf-8',
      );

      const hookRes = syncSingleSource(cFile, { agent: 'codex', dataDir: h3.dataDir });
      assert.equal(hookRes.deferredUpgrade, true);
      // No temporary inflation before global sync
      assert.equal(buildReport({ dataDir: h3.dataDir, rangeDays: 0, timeZone: 'UTC' }).allTime.totalEvents, 2);

      // Next syncAllSources cleanly upgrades both parent and child
      syncAllSources({ dataDir: h3.dataDir });
      const rep3 = buildReport({ dataDir: h3.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rep3.allTime.totalEvents, 3);
      assert.equal(rep3.period.total, 420);
    } finally {
      h3.cleanup();
    }

    // 3. Cross-batch pre-turn_context backfill MUST stay locked to firstModel after a later model switch
    const h4 = createTestEnv('atm-codex-v203-firstmodel-');
    try {
      const mId = '95959595-9595-9595-9595-959595959595';
      const mFile = h4.mkCodexRollout('2026/11/23', `rollout-2026-11-23T12-00-00-${mId}.jsonl`);

      // Batch 1: token_count (120 tok) before any turn_context
      writeFileSync(
        mFile,
        [
          JSON.stringify({ timestamp: '2026-11-23T12:00:00Z', type: 'session_meta', payload: { id: mId } }),
          JSON.stringify({
            timestamp: '2026-11-23T12:00:01Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      syncAllSources({ dataDir: h4.dataDir });
      assert.equal(buildReport({ dataDir: h4.dataDir, rangeDays: 0, timeZone: 'UTC' }).models[0].model, 'unknown');

      // Batch 2: first turn_context arrives (`gpt-6-sol`) -> backfills Batch 1 directly in ledger
      appendFileSync(
        mFile,
        JSON.stringify({ timestamp: '2026-11-23T12:00:05Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }) + '\n',
        'utf-8',
      );
      syncAllSources({ dataDir: h4.dataDir });
      let rep4 = buildReport({ dataDir: h4.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rep4.models.length, 1);
      assert.equal(rep4.models[0].model, 'gpt-6-sol');
      assert.equal(rep4.models[0].total, 120);

      // Batch 3: switch model to `gpt-6.2-astra` + add 100 tok -> Batch 1 MUST stay `gpt-6-sol` (120) and Batch 3 is `gpt-6.2-astra` (100)!
      appendFileSync(
        mFile,
        [
          JSON.stringify({ timestamp: '2026-11-23T12:01:00Z', type: 'turn_context', payload: { model: 'gpt-6.2-astra' } }),
          JSON.stringify({
            timestamp: '2026-11-23T12:01:05Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 190, output_tokens: 30 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      syncAllSources({ dataDir: h4.dataDir });
      rep4 = buildReport({ dataDir: h4.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rep4.models.find((m) => m.model === 'gpt-6-sol')?.total, 120);
      assert.equal(rep4.models.find((m) => m.model === 'gpt-6.2-astra')?.total, 100);

      // Full rescan MUST match incremental breakdown identically
      syncAllSources({ dataDir: h4.dataDir, forceFullRescan: true });
      const rep4Full = buildReport({ dataDir: h4.dataDir, rangeDays: 0, timeZone: 'UTC' });
      assert.equal(rep4Full.models.find((m) => m.model === 'gpt-6-sol')?.total, 120);
      assert.equal(rep4Full.models.find((m) => m.model === 'gpt-6.2-astra')?.total, 100);
    } finally {
      h4.cleanup();
    }

    // 4. Red-team v2.0.3 closures:
    //    (a) Timestamp-aware firstModel/lastModel across out-of-order multi-file thread scans + >128 in-batch unknown backfill
    //    (b) Stale deleted-path cursor does not block syncSingleSource in-place upgrade
    //    (c) tc -> ur 5ms handoff preserves rec.model to backfill unknown first step
    const h5 = createTestEnv('atm-codex-v203-rt-');
    try {
      const mtId = '96969696-9696-9696-9696-969696969696';
      const mrId = '97979797-9797-9797-9797-979797979797';
      const lateRev = h5.mkCodexRollout('2026/11/23', `rollout-2026-11-23T12-00-00-${mtId}_${mrId}.jsonl`);
      writeFileSync(
        lateRev,
        [
          JSON.stringify({ timestamp: '2026-11-23T12:00:00Z', type: 'session_meta', payload: { id: mtId } }),
          JSON.stringify({ timestamp: '2026-11-23T12:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.2-astra' } }),
          JSON.stringify({
            timestamp: '2026-11-23T12:00:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      // Sync LATER revert file FIRST
      syncSingleSource(lateRev, { agent: 'codex', dataDir: h5.dataDir });

      // Now sync EARLIER main file containing 135 pre-turn_context unknown steps followed by gpt-6-sol
      const earlyMain = h5.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-00-00-${mtId}.jsonl`);
      const mainLines = [
        JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'session_meta', payload: { id: mtId } }),
      ];
      for (let i = 1; i <= 135; i++) {
        mainLines.push(
          JSON.stringify({
            timestamp: new Date(Date.parse('2026-11-23T10:00:00Z') + i * 1000).toISOString(),
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: i * 100, output_tokens: i * 10 } } },
          }),
        );
      }
      mainLines.push(
        JSON.stringify({ timestamp: '2026-11-23T10:05:00Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
      );
      writeFileSync(earlyMain, mainLines.join('\n') + '\n', 'utf-8');
      syncSingleSource(earlyMain, { agent: 'codex', dataDir: h5.dataDir });

      const cur5 = JSON.parse(readFileSync(join(h5.dataDir, 'cursors.json'), 'utf-8'));
      assert.equal(cur5.sessions[`codex:${mtId}`].firstModel, 'gpt-6-sol');
      assert.equal(cur5.sessions[`codex:${mtId}`].lastModel, 'gpt-6.2-astra');
      const diskEvents = readFileSync(join(h5.dataDir, 'events', '2026-11.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.equal(diskEvents.filter((e) => e.m === 'unknown').length, 0);

      // (b) Stale deleted-path cursor must NOT block syncSingleSource in-place upgrade
      const stId = '98989898-9898-9898-9898-989898989898';
      const srId = '99999999-9999-9999-9999-999999999999';
      const liveZst = h5.mkCodexRollout('2026/11/23', `rollout-2026-11-23T13-00-00-${stId}_${srId}.jsonl.zst`);
      const liveContent =
        [
          JSON.stringify({ timestamp: '2026-11-23T13:00:00Z', type: 'session_meta', payload: { id: stId } }),
          JSON.stringify({ timestamp: '2026-11-23T13:00:01Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
          JSON.stringify({
            timestamp: '2026-11-23T13:00:02Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3_000, output_tokens: 300 } } },
          }),
        ].join('\n') + '\n';
      writeFileSync(liveZst, zlib.zstdCompressSync(Buffer.from(liveContent, 'utf-8')));
      const liveSt = statSync(liveZst);
      const deletedPlain = h5.mkCodexRollout('2026/11/23', `rollout-2026-11-23T13-00-00-${stId}_${srId}.jsonl`);
      cur5.files[canonicalFileKey(deletedPlain)] = {
        agent: 'codex',
        app: 'codex',
        sessionId: srId,
        size: 100,
        mtimeMs: 1000,
        offset: 100,
      };
      cur5.files[canonicalFileKey(liveZst)] = {
        agent: 'codex',
        app: 'codex',
        sessionId: srId,
        size: liveSt.size,
        mtimeMs: liveSt.mtimeMs,
        ino: liveSt.ino,
        offset: liveSt.size,
      };
      writeFileSync(join(h5.dataDir, 'cursors.json'), JSON.stringify(cur5, null, 2), 'utf-8');
      const liveRes = syncSingleSource(liveZst, { agent: 'codex', dataDir: h5.dataDir });
      assert.equal(liveRes.deferredUpgrade, undefined);
      assert.equal(liveRes.added, 1);

      // (c) tc -> ur 5ms handoff preserves rec.model to backfill unknown first step
      const hId = '9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a9a';
      const hFile = h5.mkCodexRollout('2026/11/23', `rollout-2026-11-23T14-00-00-${hId}.jsonl`);
      writeFileSync(
        hFile,
        [
          JSON.stringify({ timestamp: '2026-11-23T14:00:00.000Z', type: 'session_meta', payload: { id: hId } }),
          JSON.stringify({
            timestamp: '2026-11-23T14:00:01.100Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1_000, output_tokens: 100 } } },
          }),
          JSON.stringify({
            timestamp: '2026-11-23T14:00:01.105Z',
            type: 'event_msg',
            payload: { type: 'token_usage_record', model: 'gpt-6-sol', response_id: 'r_m1', usage: { input_tokens: 1_000, output_tokens: 100 } },
          }),
        ].join('\n') + '\n',
        'utf-8',
      );
      syncSingleSource(hFile, { agent: 'codex', dataDir: h5.dataDir });
      const rep5 = buildReport({ dataDir: h5.dataDir, rangeDays: 0, timeZone: 'UTC' });
      const hSess = rep5.sessions.find((s) => s.sessionId === hId);
      assert.equal(hSess.steps, 1);
      assert.equal(hSess.primaryModel, 'gpt-6-sol');
      assert.equal(hSess.unpricedSteps, 0);
    } finally {
      h5.cleanup();
    }
  } finally {
    h1.cleanup();
  }
});

test('v2.0.4 regressions: Antigravity MODEL_CHANGE_RE sentence boundary & auto-upgrade, plus slim .zst cursors', () => {
  const h = createTestEnv('atm-v204-');
  try {
    // 1. Antigravity notice followed by prose containing "to ..." must NOT cross sentence periods
    const agConv = 'ag-v204-sentence-guard';
    const agFile = h.mkAgTranscript(agConv);
    writeFileSync(
      agFile,
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-23T10:00:00Z',
          content:
            'The user has changed `Model Selection` from Gemini 3.1 Pro (High) to `Claude Opus 4.6 (Thinking)`. ' +
            "Do not feel compelled to comment on this change if the user doesn't ask about it.",
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-23T10:00:05Z',
          input_tokens: 1000,
          cache_read_tokens: 500,
          output_tokens: 200,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // Seed a legacy v2.0.3 Antigravity cursor (lacking parserVersion) with a corrupted model event
    const evDir = join(h.dataDir, 'events');
    mkdirSync(evDir, { recursive: true });
    writeFileSync(
      join(evDir, '2026-11.jsonl'),
      JSON.stringify({
        a: 'antigravity',
        c: agConv,
        e: '1',
        ts: Date.parse('2026-11-23T10:00:05Z'),
        m: 'comment-on-this-change-if-the-user-doesn-t-ask-about-it',
        k: 'P',
        in: 1000,
        cr: 500,
        cw5: 0,
        cw1h: 0,
        out: 200,
        r: 0,
      }) + '\n',
      'utf-8',
    );
    const agStat = statSync(agFile);
    writeFileSync(
      join(h.dataDir, 'cursors.json'),
      JSON.stringify({
        version: 2,
        files: {
          [agFile]: {
            agent: 'antigravity',
            app: 'antigravity',
            sessionId: agConv,
            size: agStat.size,
            mtimeMs: agStat.mtimeMs,
            ino: agStat.ino,
            offset: agStat.size,
            lastModel: 'comment-on-this-change-if-the-user-doesn-t-ask-about-it',
            firstTs: Date.parse('2026-11-23T10:00:00Z'),
            lastTs: Date.parse('2026-11-23T10:00:05Z'),
          },
        },
        sessions: {
          [`antigravity:${agConv}`]: {
            agent: 'antigravity',
            sessionId: agConv,
            app: 'antigravity',
            lastModel: 'comment-on-this-change-if-the-user-doesn-t-ask-about-it',
          },
        },
      }),
      'utf-8',
    );

    // 2. Also create a compressed Codex .jsonl.zst rollout and verify its persisted cursor omits resume buffers
    const zstId = '55555555-5555-5555-5555-555555555555';
    const zstFile = h.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-00-00-${zstId}.jsonl.zst`);
    const zstRaw =
      [
        JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'session_meta', payload: { id: zstId } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-23T10:00:02Z',
          type: 'event_msg',
          payload: {
            type: 'token_usage_record',
            model: 'gpt-6.2-sol',
            response_id: 'r1',
            usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 },
          },
        }),
      ].join('\n') + '\n';
    writeFileSync(zstFile, zlib.zstdCompressSync(Buffer.from(zstRaw, 'utf-8')));

    // Incremental sync should auto-upgrade the legacy Antigravity cursor and slim the .zst cursor
    const res = syncAllSources({ dataDir: h.dataDir });
    assert.equal(res.skipped, 0);

    const repAg = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'antigravity', timeZone: 'UTC' });
    assert.equal(repAg.period.steps, 1);
    assert.equal(repAg.period.unpricedSteps, 0);
    assert.equal(repAg.models[0].model, 'claude-opus-4.6-thinking');

    const rawCursorsText = readFileSync(join(h.dataDir, 'cursors.json'), 'utf-8');
    // Compact single-line JSON (no 2-space pretty indentation)
    assert.equal(rawCursorsText.trim().includes('\n'), false);
    const cursors = JSON.parse(rawCursorsText);
    const zstEntry = Object.entries(cursors.files).find(([k]) => k.endsWith('.jsonl.zst'))?.[1];
    assert.ok(zstEntry, 'expected .jsonl.zst cursor entry');
    assert.equal(zstEntry.seenTotals, undefined);
    assert.equal(zstEntry.recentUr, undefined);
    assert.equal(zstEntry.prevTotals, undefined);
  } finally {
    h.cleanup();
  }
});

test('v2.1.0 regressions: Claude depth-5 workflows/iterations/thinking/fast, Codex priority/flex tiers, Antigravity ReDoS & non-DONE/firstModel, and legacy v1 AG import', () => {
  const h = createTestEnv('atm-v210-');
  const prevLegacyEnv = process.env.TOKEN_METER_LEGACY_AG_DIR;
  try {
    // 1. Claude Code depth-5 workflow subagent (`<project>/<session>/subagents/workflows/wf_1/agent-x.jsonl`)
    //    plus `usage.iterations[]` (multi-step compaction), `output_tokens_details.thinking_tokens`, `speed: fast`, `claude-fable-5-2`
    const wfDir = join(h.claudeProjectsDir, 'proj-wf', 'parent-sess-1', 'subagents', 'workflows', 'wf_abc-1');
    mkdirSync(wfDir, { recursive: true });
    const wfFile = join(wfDir, 'agent-worker-1.jsonl');
    writeFileSync(
      wfFile,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-23T10:00:00Z',
          sessionId: 'parent-sess-1',
          message: { role: 'user', content: 'Analyze workflow step' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-23T10:00:05Z',
          sessionId: 'parent-sess-1',
          requestId: 'req_wf_1',
          message: {
            id: 'msg_wf_1',
            model: 'claude-fable-5-2',
            usage: {
              // Top-level shows executor turn only; iterations[] includes compaction + executor
              input_tokens: 1_000,
              cache_read_input_tokens: 10_000,
              cache_creation_input_tokens: 2_000,
              cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 },
              output_tokens: 500,
              output_tokens_details: { thinking_tokens: 300 },
              speed: 'fast',
              iterations: [
                {
                  type: 'compaction',
                  input_tokens: 4_000,
                  cache_read_input_tokens: 20_000,
                  cache_creation_input_tokens: 0,
                  output_tokens: 1_500,
                },
                {
                  type: 'message',
                  input_tokens: 1_000,
                  cache_read_input_tokens: 10_000,
                  cache_creation_input_tokens: 2_000,
                  cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 },
                  output_tokens: 500,
                },
              ],
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 2. Codex thread_settings_applied priority (2x) -> default (1x) -> flex (0.5x)
    const cxId = '77777777-7777-7777-7777-777777777777';
    const cxFile = h.mkCodexRollout('2026/11/23', `rollout-2026-11-23T11-00-00-${cxId}.jsonl`);
    writeFileSync(
      cxFile,
      [
        JSON.stringify({ timestamp: '2026-11-23T11:00:00Z', type: 'session_meta', payload: { id: cxId } }),
        JSON.stringify({ timestamp: '2026-11-23T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
        JSON.stringify({
          timestamp: '2026-11-23T11:00:02Z',
          type: 'event_msg',
          payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T11:00:03Z',
          type: 'token_usage_record',
          payload: {
            response_id: 'r_p1',
            usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T11:00:04Z',
          type: 'event_msg',
          payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'flex' } },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T11:00:05Z',
          type: 'token_usage_record',
          payload: {
            response_id: 'r_f1',
            usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 0 },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 3. Antigravity: 100KB adversarial MODEL_CHANGE_RE input (must finish in <200ms, no ReDoS),
    //    plus ERROR terminal status with tokens, plus earlier unknown step backfilled by later firstModel
    const agId = 'ag-v210-redos-and-backfill';
    const agFile = h.mkAgTranscript(agId);
    writeFileSync(
      agFile,
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-23T12:00:00Z',
          content: 'User changed `Model Selection` from ' + 'a to '.repeat(20_000) + 'end_without_dot',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'ERROR',
          created_at: '2026-11-23T12:00:01Z',
          input_tokens: 10_000,
          cache_read_tokens: 0,
          output_tokens: 1_000,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'IN_PROGRESS',
          created_at: '2026-11-23T12:00:02Z',
          input_tokens: 999_999,
          cache_read_tokens: 0,
          output_tokens: 999,
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-23T12:00:03Z',
          model: 'gemini-4-neon-high',
          input_tokens: 20_000,
          cache_read_tokens: 0,
          output_tokens: 2_000,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const tRedos0 = performance.now();
    const agScan = antigravityAdapter.scanDelta(agFile, null, { sessionId: agId, app: 'antigravity' }, true);
    const tRedosMs = performance.now() - tRedos0;
    assert.ok(tRedosMs < 200, `MODEL_CHANGE_RE should be linear/bounded (<200ms), got ${tRedosMs.toFixed(1)}ms`);
    // Step 1 (ERROR) kept and backfilled to gemini-4-neon-high; Step 2 (IN_PROGRESS) skipped; Step 3 kept
    assert.equal(agScan.events.length, 2);
    assert.equal(agScan.events[0].m, 'gemini-4-neon-high');
    assert.equal(agScan.events[1].m, 'gemini-4-neon-high');

    // 4. Legacy v1 ~/.gemini/token-meter ledger with one archived deleted session + one overlapping live event
    const legacyDir = join(h.root, 'legacy-v1-tm');
    mkdirSync(join(legacyDir, 'events'), { recursive: true });
    writeFileSync(
      join(legacyDir, 'events', '2026-11.jsonl'),
      [
        // Deleted archived session (must be imported)
        JSON.stringify({
          c: 'ag-deleted-v1-sess',
          i: 5,
          ts: Date.parse('2026-11-18T10:00:00Z'),
          m: 'gemini-4-carbon-high',
          k: 'P',
          in: 50_000,
          cr: 100_000,
          out: 5_000,
        }),
        // Overlapping live event with stale wrong model (must NOT overwrite live v3 event!)
        JSON.stringify({
          c: agId,
          i: 3,
          ts: Date.parse('2026-11-23T12:00:03Z'),
          m: 'stale-v1-wrong-model',
          k: 'P',
          in: 20_000,
          cr: 0,
          out: 2_000,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    writeFileSync(
      join(legacyDir, 'cursors.json'),
      JSON.stringify({
        version: 1,
        files: {},
        sessions: {
          'ag-deleted-v1-sess': {
            convId: 'ag-deleted-v1-sess',
            app: 'antigravity',
            title: 'Archived Legacy Conversation',
            lastModel: 'gemini-4-carbon-high',
            firstTs: Date.parse('2026-11-18T10:00:00Z'),
            lastTs: Date.parse('2026-11-18T10:00:00Z'),
          },
        },
      }),
      'utf-8',
    );
    process.env.TOKEN_METER_LEGACY_AG_DIR = legacyDir;

    const syncRes = syncAllSources({ dataDir: h.dataDir });
    assert.equal(syncRes.legacyImported, 1);

    // Second sync must NOT re-import legacy events
    const syncRes2 = syncAllSources({ dataDir: h.dataDir });
    assert.equal(syncRes2.legacyImported, 0);

    // Verify Claude Code depth-5 workflow subagent + iterations + thinking + fast 2x cost
    const repCc = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'claude-code', timeZone: 'UTC' });
    assert.equal(repCc.period.steps, 1);
    assert.equal(repCc.period.unpricedSteps, 0);
    assert.equal(repCc.period.input, 5_000);
    assert.equal(repCc.period.cacheRead, 30_000);
    assert.equal(repCc.period.cacheWrite5m, 2_000);
    assert.equal(repCc.period.output, 2_000);
    assert.equal(repCc.period.reasoning, 300);
    assert.equal(repCc.sessions[0].sessionId, 'parent-sess-1:workflows/wf_abc-1/agent-worker-1');
    // Fast 2x Fable 5.2: in=$16/M, cr=$0.40/M, cw5=$20/M, out=$80/M
    // 0.005*16 + 0.03*0.4 + 0.002*20 + 0.002*80 = 0.08 + 0.012 + 0.04 + 0.16 = $0.292
    assert.equal(Number(repCc.period.costUsd.toFixed(6)), 0.292);
    assert.equal(repCc.models[0].fastSteps, 1);

    // Verify Codex priority (2x) + >272K (2x) + flex (0.5x)
    const repCx = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'codex', timeZone: 'UTC' });
    assert.equal(repCx.period.steps, 2);
    // Step 1: 1M input (>272K -> $4/M base) * priority 2x = $8.00
    // Step 2: 100K input (<=272K -> $2/M base) * flex 0.5x = $0.10
    // Total = $8.10
    assert.equal(Number(repCx.period.costUsd.toFixed(6)), 8.1);
    assert.equal(repCx.models[0].fastSteps, 1);
    assert.equal(repCx.models[0].flexSteps, 1);

    // Verify Antigravity includes both live v3 steps (no stale overwrite) and archived v1 session
    const repAg = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'antigravity', timeZone: 'UTC' });
    assert.equal(repAg.period.steps, 3);
    assert.equal(repAg.period.unpricedSteps, 0);
    const archivedSess = repAg.sessions.find((s) => s.sessionId === 'ag-deleted-v1-sess');
    assert.ok(archivedSess, 'expected archived v1 session to be imported');
    assert.equal(archivedSess.title, 'Archived Legacy Conversation');
    const liveSess = repAg.sessions.find((s) => s.sessionId === agId);
    assert.equal(liveSess.primaryModel, 'gemini-4-neon-high');
  } finally {
    if (prevLegacyEnv === undefined) delete process.env.TOKEN_METER_LEGACY_AG_DIR;
    else process.env.TOKEN_METER_LEGACY_AG_DIR = prevLegacyEnv;
    h.cleanup();
  }
});

test('v2.1.0 red-team round-2 regressions: Claude subagents path scoping, Codex service_tier reset/handoff, Claude single-element iterations/cw1h/oversized-sessionId, and whitespace model guards', () => {
  const h = createTestEnv('atm-v210-rt2-');
  const prevClaudeRoots = process.env.TOKEN_METER_CLAUDE_ROOTS;
  try {
    // 1. P1-1: Ancestor dir named `subagents` and project dir named `subagents` MUST NOT misclassify top-level sessions,
    //    real subagents under project `subagents` MUST still work, and Codex rollouts under `subagents/` MUST route to codex.
    const ancProjects = join(h.root, 'subagents', '.claude', 'projects');
    const ancSessDir = join(ancProjects, 'proj-alpha');
    mkdirSync(ancSessDir, { recursive: true });
    const ancFile = join(ancSessDir, 'sess-ancestor.jsonl');
    writeFileSync(
      ancFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T09:00:00Z',
        sessionId: 'sess-ancestor',
        requestId: 'req_anc_1',
        message: {
          id: 'msg_anc_1',
          model: 'claude-opus-5',
          usage: { input_tokens: 1_000, output_tokens: 100 },
        },
      }) + '\n',
      'utf-8',
    );

    const projSubDir = join(h.claudeProjectsDir, 'subagents');
    mkdirSync(projSubDir, { recursive: true });
    const projTopFile = join(projSubDir, 'sess-proj-sub.jsonl');
    writeFileSync(
      projTopFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T09:05:00Z',
        sessionId: 'sess-proj-sub',
        requestId: 'req_ps_1',
        message: {
          id: 'msg_ps_1',
          model: 'claude-opus-5',
          usage: { input_tokens: 2_000, output_tokens: 200 },
        },
      }) + '\n',
      'utf-8',
    );

    const realSubDir = join(projSubDir, 'parent-99', 'subagents', 'workflows', 'wf_2');
    mkdirSync(realSubDir, { recursive: true });
    const realSubFile = join(realSubDir, 'agent-9.jsonl');
    writeFileSync(
      realSubFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T09:06:00Z',
        sessionId: 'parent-99',
        requestId: 'req_rs_1',
        message: {
          id: 'msg_rs_1',
          model: 'claude-opus-5',
          usage: { input_tokens: 3_000, output_tokens: 300 },
        },
      }) + '\n',
      'utf-8',
    );

    process.env.TOKEN_METER_CLAUDE_ROOTS = [h.claudeProjectsDir, ancProjects].join(process.platform === 'win32' ? ';' : ':');
    const ancMeta = claudeCodeAdapter.inferMeta(ancFile);
    assert.equal(ancMeta.isSubagent, false);
    assert.equal(ancMeta.parentSessionId, '');
    assert.equal(ancMeta.sessionId, 'sess-ancestor');

    const projMeta = claudeCodeAdapter.inferMeta(projTopFile);
    assert.equal(projMeta.isSubagent, false);
    assert.equal(projMeta.parentSessionId, '');
    assert.equal(projMeta.sessionId, 'sess-proj-sub');

    const realSubMeta = claudeCodeAdapter.inferMeta(realSubFile);
    assert.equal(realSubMeta.isSubagent, true);
    assert.equal(realSubMeta.parentSessionId, 'parent-99');
    assert.equal(realSubMeta.sessionId, 'parent-99:workflows/wf_2/agent-9');

    const codexUnderSub = join(h.root, 'subagents', 'rollout-2026-11-23T10-00-00-11111111-1111-1111-1111-111111111111.jsonl');
    assert.equal(detectAdapterForPath(codexUnderSub)?.id, 'codex');
    assert.equal(detectAdapterForPath(`${codexUnderSub}.zst`)?.id, 'codex');

    // 2. P1-2: Codex service_tier null/'auto' resets + tc->ur handoff service_tier propagation
    const resetId = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
    const resetFile = h.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-00-00-${resetId}.jsonl`);
    writeFileSync(
      resetFile,
      [
        JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'session_meta', payload: { id: resetId } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
        // Fast (2x)
        JSON.stringify({ timestamp: '2026-11-23T10:00:02Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:03Z', type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 100_000, output_tokens: 0 } } }),
        // Reset via explicit null -> standard (1x)
        JSON.stringify({ timestamp: '2026-11-23T10:00:04Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: null } } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:05Z', type: 'token_usage_record', payload: { response_id: 'r2', usage: { input_tokens: 100_000, output_tokens: 0 } } }),
        // Fast again via turn_context
        JSON.stringify({ timestamp: '2026-11-23T10:00:06Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol', service_tier: 'priority' } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:07Z', type: 'token_usage_record', payload: { response_id: 'r3', usage: { input_tokens: 100_000, output_tokens: 0 } } }),
        // Reset via 'auto' -> standard (1x)
        JSON.stringify({ timestamp: '2026-11-23T10:00:08Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol', service_tier: 'auto' } }),
        JSON.stringify({ timestamp: '2026-11-23T10:00:09Z', type: 'token_usage_record', payload: { response_id: 'r4', usage: { input_tokens: 100_000, output_tokens: 0 } } }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const handoffId = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2';
    const handoffFile = h.mkCodexRollout('2026/11/23', `rollout-2026-11-23T10-10-00-${handoffId}.jsonl`);
    writeFileSync(
      handoffFile,
      [
        JSON.stringify({ timestamp: '2026-11-23T10:10:00.000Z', type: 'session_meta', payload: { id: handoffId } }),
        JSON.stringify({ timestamp: '2026-11-23T10:10:01.000Z', type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
        // Step A arrives as token_count without service_tier, then paired token_usage_record 5ms later carries service_tier: 'priority'
        JSON.stringify({ timestamp: '2026-11-23T10:10:02.100Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100_000, output_tokens: 0 } } } }),
        JSON.stringify({ timestamp: '2026-11-23T10:10:02.105Z', type: 'event_msg', payload: { type: 'token_usage_record', response_id: 'rh1', service_tier: 'priority', usage: { input_tokens: 100_000, output_tokens: 0 } } }),
        // Step B omits service_tier and MUST inherit 'fast' from the handoff
        JSON.stringify({ timestamp: '2026-11-23T10:10:05.000Z', type: 'event_msg', payload: { type: 'token_usage_record', response_id: 'rh2', usage: { input_tokens: 100_000, output_tokens: 0 } } }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // 3. P1-3 + P2-2 + P2-3b: Claude single-element iterations, top-level cw1h preserved, iteration thinking_tokens,
    //    >16KB leading file-history-snapshot carrying sessionId, and whitespace-only model guard (CC + AG)
    const iterFile = join(h.claudeProjectsDir, 'proj-iter', 'custom-log-name.jsonl');
    mkdirSync(join(h.claudeProjectsDir, 'proj-iter'), { recursive: true });
    writeFileSync(
      iterFile,
      [
        JSON.stringify({
          type: 'file-history-snapshot',
          sessionId: 'sess-from-big-snapshot',
          snapshot: { blob: 'x'.repeat(20_000) },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-23T11:00:00Z',
          requestId: 'req_it_1',
          message: {
            id: 'msg_it_1',
            model: 'claude-opus-5',
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 5_000,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 },
              output_tokens: 0,
              iterations: [
                {
                  type: 'compaction',
                  input_tokens: 2_000,
                  cache_read_input_tokens: 10_000,
                  cache_creation_input_tokens: 5_000,
                  output_tokens: 400,
                  output_tokens_details: { thinking_tokens: 150 },
                },
              ],
            },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-23T11:00:05Z',
          requestId: 'req_it_2',
          message: {
            id: 'msg_it_2',
            model: '   ',
            usage: { input_tokens: 1_000, output_tokens: 100 },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const agWsId = 'ag-ws-model-guard';
    const agWsFile = h.mkAgTranscript(agWsId);
    writeFileSync(
      agWsFile,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-23T12:00:00Z',
          model: 'gemini-4-neon-high',
          input_tokens: 5_000,
          output_tokens: 500,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-23T12:00:05Z',
          model: '   ',
          input_tokens: 2_000,
          output_tokens: 200,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const syncRes = syncAllSources({ dataDir: h.dataDir });
    assert.equal(syncRes.skipped, 0);

    // Assert Claude Code results
    const repCc = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'claude-code', timeZone: 'UTC' });
    assert.equal(repCc.period.unpricedSteps, 0);
    const ancSess = repCc.sessions.find((s) => s.sessionId === 'sess-ancestor');
    assert.ok(ancSess);
    assert.equal(ancSess.title.startsWith('[Subagent]'), false);
    const projSess = repCc.sessions.find((s) => s.sessionId === 'sess-proj-sub');
    assert.ok(projSess);
    assert.equal(projSess.title.startsWith('[Subagent]'), false);
    assert.ok(repCc.sessions.find((s) => s.sessionId === 'parent-99:workflows/wf_2/agent-9'));

    const iterSess = repCc.sessions.find((s) => s.sessionId === 'sess-from-big-snapshot');
    assert.ok(iterSess, 'sessionId should be extracted from >16KB file-history-snapshot');
    assert.equal(iterSess.steps, 2);
    assert.equal(iterSess.input, 3_000);
    assert.equal(iterSess.cacheRead, 10_000);
    assert.equal(iterSess.cacheWrite5m, 0);
    assert.equal(iterSess.cacheWrite1h, 5_000);
    assert.equal(iterSess.output, 500);
    assert.equal(iterSess.reasoning, 150);
    assert.equal(iterSess.primaryModel, 'claude-opus-5');
    assert.equal(iterSess.unpricedSteps, 0);

    // Assert Codex results
    const repCx = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'codex', timeZone: 'UTC' });
    const resetSess = repCx.sessions.find((s) => s.sessionId === resetId);
    assert.equal(resetSess.steps, 4);
    // 2 fast ($0.40 each) + 2 standard ($0.20 each) = $1.20
    assert.equal(Number(resetSess.costUsd.toFixed(6)), 1.2);

    const handoffSess = repCx.sessions.find((s) => s.sessionId === handoffId);
    assert.equal(handoffSess.steps, 2);
    // Both steps fast (2x $2/M * 0.1M = $0.40 each) = $0.80
    assert.equal(Number(handoffSess.costUsd.toFixed(6)), 0.8);
    assert.equal(repCx.models[0].fastSteps, 4);

    // Assert Antigravity whitespace model guard
    const repAg = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'antigravity', timeZone: 'UTC' });
    const agWsSess = repAg.sessions.find((s) => s.sessionId === agWsId);
    assert.equal(agWsSess.steps, 2);
    assert.equal(agWsSess.unpricedSteps, 0);
    assert.equal(agWsSess.primaryModel, 'gemini-4-neon-high');

    // 4. Red-team round-3 regressions:
    //    (a) Relative TOKEN_METER_CLAUDE_ROOTS preserves subagent parentSessionId & inferMeta(full, [root]) parity
    const relRootAbs = join(h.root, 'cc-rel-root');
    const relSubDir = join(relRootAbs, 'proj-a', 'parent-uuid-rel', 'subagents');
    mkdirSync(relSubDir, { recursive: true });
    const relSubAbs = join(relSubDir, 'agent-worker.jsonl');
    writeFileSync(
      relSubAbs,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-23T12:30:00Z',
        sessionId: 'parent-uuid-rel',
        requestId: 'req_rel_1',
        message: { id: 'msg_rel_1', model: 'claude-opus-5', usage: { input_tokens: 1_000, output_tokens: 100 } },
      }) + '\n',
      'utf-8',
    );
    const prevCwd = process.cwd();
    try {
      process.chdir(h.root);
      const relRootSpec = './cc-rel-root';
      process.env.TOKEN_METER_CLAUDE_ROOTS = relRootSpec;
      const relDiscovered = claudeCodeAdapter.discoverSources();
      assert.equal(relDiscovered.length, 1);
      assert.equal(relDiscovered[0].isSubagent, true);
      assert.equal(relDiscovered[0].parentSessionId, 'parent-uuid-rel');
      assert.equal(relDiscovered[0].sessionId, 'parent-uuid-rel:agent-worker');
      assert.deepEqual(
        claudeCodeAdapter.inferMeta(relDiscovered[0].filePath, [relRootSpec]),
        claudeCodeAdapter.inferMeta(relDiscovered[0].filePath),
      );
    } finally {
      process.chdir(prevCwd);
    }

    //    (b) Codex turn_context with payload.service_tier: null + collaboration_mode.settings.service_tier: 'priority'
    const serdeId = 'a3a3a3a3-a3a3-a3a3-a3a3-a3a3a3a3a3a3';
    const serdeFile = h.mkCodexRollout('2026/11/23', `rollout-2026-11-23T12-40-00-${serdeId}.jsonl`);
    writeFileSync(
      serdeFile,
      [
        JSON.stringify({ timestamp: '2026-11-23T12:40:00Z', type: 'session_meta', payload: { id: serdeId } }),
        JSON.stringify({
          timestamp: '2026-11-23T12:40:01Z',
          type: 'turn_context',
          payload: {
            model: 'gpt-6.2-sol',
            service_tier: null,
            collaboration_mode: { settings: { service_tier: 'priority' } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T12:40:02Z',
          type: 'token_usage_record',
          payload: { response_id: 'r_serde_1', usage: { input_tokens: 100_000, output_tokens: 0 } },
        }),
        // Subsequent explicit null without nested priority resets back to standard (1x)
        JSON.stringify({
          timestamp: '2026-11-23T12:40:03Z',
          type: 'turn_context',
          payload: { model: 'gpt-6.2-sol', service_tier: null },
        }),
        JSON.stringify({
          timestamp: '2026-11-23T12:40:04Z',
          type: 'token_usage_record',
          payload: { response_id: 'r_serde_2', usage: { input_tokens: 100_000, output_tokens: 0 } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    syncSingleSource(serdeFile, { agent: 'codex', dataDir: h.dataDir });
    const repSerde = buildReport({ dataDir: h.dataDir, rangeDays: 0, agent: 'codex', timeZone: 'UTC' });
    const serdeSess = repSerde.sessions.find((s) => s.sessionId === serdeId);
    assert.equal(serdeSess.steps, 2);
    // Step 1 fast ($0.40) + Step 2 standard ($0.20) = $0.60
    assert.equal(Number(serdeSess.costUsd.toFixed(6)), 0.6);
  } finally {
    if (prevClaudeRoots === undefined) delete process.env.TOKEN_METER_CLAUDE_ROOTS;
    else process.env.TOKEN_METER_CLAUDE_ROOTS = prevClaudeRoots;
    h.cleanup();
  }
});
