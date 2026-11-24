import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildReport, exportDailyCsv, localDateKey } from '../core/report.mjs';
import { syncAllSources } from '../core/sync.mjs';
import { createApiController } from '../server/api.mjs';
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

test('v2.0.4 performance & switching: cached localDateKey matches Intl across DST transitions and API noSync/LRU cache invalidates cleanly', () => {
  // 1. Verify hourly-cached localDateKey matches fresh Intl.DateTimeFormat across tricky DST & half/quarter-hour zones
  const zones = [
    'UTC',
    'Asia/Shanghai',
    'Asia/Kathmandu',
    'America/New_York',
    'America/Havana',
    'America/Sao_Paulo',
    'Australia/Lord_Howe',
  ];
  const sampleTimestamps = [
    Date.UTC(2026, 2, 8, 4, 59, 59), // US/Cuba spring forward window
    Date.UTC(2026, 2, 8, 5, 0, 0),
    Date.UTC(2026, 2, 8, 6, 30, 0),
    Date.UTC(2026, 2, 8, 7, 1, 0),
    Date.UTC(2026, 10, 1, 3, 59, 59), // US/Cuba fall back window
    Date.UTC(2026, 10, 1, 4, 30, 0),
    Date.UTC(2026, 10, 1, 5, 0, 0),
    Date.UTC(2026, 10, 1, 5, 30, 0),
    Date.UTC(2026, 10, 1, 6, 0, 1),
    Date.UTC(2026, 3, 4, 15, 0, 0), // Lord Howe fall back window
    Date.UTC(2026, 3, 4, 15, 30, 0),
    Date.UTC(2026, 3, 4, 16, 0, 0),
    Date.UTC(2026, 10, 23, 18, 14, 59), // Kathmandu UTC+05:45 midnight boundary
    Date.UTC(2026, 10, 23, 18, 15, 0),
    Date.UTC(2026, 10, 23, 18, 45, 0),
    Date.UTC(2026, 10, 23, 15, 59, 59), // Shanghai UTC+08:00 midnight boundary
    Date.UTC(2026, 10, 23, 16, 0, 0),
  ];
  for (const tz of zones) {
    const refFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const ts of sampleTimestamps) {
      assert.equal(localDateKey(ts, tz), refFmt.format(ts), `mismatch for ${tz} at ${new Date(ts).toISOString()}`);
    }
  }

  // 2. Verify API noSync switching, LRU report caching, ETag fast path, and immediate cache invalidation on prefs/ledger updates
  const h = createTestEnv('atm-apicache-');
  try {
    const nowIso = new Date().toISOString();
    const agFile = h.mkAgTranscript('ag-switch-1');
    writeFileSync(
      agFile,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        model: 'gemini-4-neon',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
      }) + '\n',
      'utf-8',
    );
    const ccFile = h.mkClaudeTranscript('proj-a', 'cc-switch-1');
    writeFileSync(
      ccFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: nowIso,
        sessionId: 'cc-switch-1',
        message: {
          id: 'msg_sw_1',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 50_000, cache_read_input_tokens: 0, output_tokens: 5_000 },
        },
      }) + '\n',
      'utf-8',
    );
    const codexFile = h.mkCodexRollout(
      '2026/11/24',
      'rollout-2026-11-24T01-00-00-66666666-6666-6666-6666-666666666666.jsonl',
    );
    writeFileSync(
      codexFile,
      [
        JSON.stringify({ timestamp: nowIso, type: 'session_meta', payload: { id: '66666666-6666-6666-6666-666666666666' } }),
        JSON.stringify({ timestamp: nowIso, type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }),
        JSON.stringify({
          timestamp: nowIso,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 80_000, cached_input_tokens: 0, output_tokens: 8_000 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const api = createApiController({ dataDir: h.dataDir, defaultAgent: 'antigravity' });
    // noSync=1 before any sync should NOT run syncAllSources (syncedAt stays 0)
    const preSync = api.handleReport({ days: '7', agent: 'antigravity', tz: 'UTC', noSync: '1' });
    assert.equal(preSync.syncedAt, 0);
    assert.equal(preSync.period.steps, 0);

    // Force sync populates all 3 agents
    const agRep = api.handleReport({ days: '7', agent: 'antigravity', tz: 'UTC', force: '1' });
    assert.ok(agRep.syncedAt > 0);
    assert.deepEqual(agRep.availableAgents, ['antigravity', 'claude-code', 'codex']);
    assert.equal(agRep.period.steps, 1);

    // Switch to Claude Code and Codex with noSync=1 cleanly
    const ccRep = api.handleReport({ days: '7', agent: 'claude-code', tz: 'UTC', noSync: '1' });
    assert.equal(ccRep.agentFilter, 'claude-code');
    assert.equal(ccRep.period.steps, 1);
    assert.equal(ccRep.sessions[0].sessionId, 'cc-switch-1');

    const codexRep = api.handleReport({ days: '7', agent: 'codex', tz: 'UTC', noSync: '1' });
    assert.equal(codexRep.agentFilter, 'codex');
    assert.equal(codexRep.period.steps, 1);
    assert.equal(codexRep.sessions[0].sessionId, '66666666-6666-6666-6666-666666666666');

    // ETag fast-path returns unchanged=true cleanly
    const unchanged = api.handleReport({ days: '7', agent: 'codex', tz: 'UTC', noSync: '1', etag: codexRep.etag });
    assert.equal(unchanged.unchanged, true);

    // Saving prefs immediately invalidates cached report and ETag
    api.handleSavePrefs({ currency: 'CNY' });
    const afterPrefs = api.handleReport({ days: '7', agent: 'codex', tz: 'UTC', noSync: '1', etag: codexRep.etag });
    assert.equal(afterPrefs.unchanged, undefined);
    assert.equal(afterPrefs.prefs.currency, 'CNY');
  } finally {
    h.cleanup();
  }
});

test('v2.1.0 red-team guards: UTC-midnight ETag bust in non-UTC tz, same-mtime/same-size/diff-ino prefs bust, and sidecar fetch DataCloneError strip', async () => {
  const h = createTestEnv('atm-rt210-');
  const origDateNow = Date.now;
  try {
    const api = createApiController({ dataDir: h.dataDir, defaultAgent: 'antigravity' });

    // 1. Cross UTC midnight (2026-11-30T23:59:59Z -> 2026-12-01T00:00:01Z) while America/Los_Angeles local date is still 2026-11-30
    Date.now = () => Date.UTC(2026, 10, 30, 23, 59, 59);
    const beforeUtc = api.handleReport({ days: '7', agent: 'antigravity', tz: 'America/Los_Angeles', noSync: '1' });
    const carbonBefore = beforeUtc.officialRateCard.find((r) => r.prefix === 'gemini-4-carbon');
    assert.equal(carbonBefore.input, 2.0);

    Date.now = () => Date.UTC(2026, 11, 1, 0, 0, 1);
    const afterUtc = api.handleReport({
      days: '7',
      agent: 'antigravity',
      tz: 'America/Los_Angeles',
      noSync: '1',
      etag: beforeUtc.etag,
    });
    assert.equal(afterUtc.unchanged, undefined, 'ETag must bust when UTC day flips official rate card');
    assert.notEqual(afterUtc.etag, beforeUtc.etag);
    const carbonAfter = afterUtc.officialRateCard.find((r) => r.prefix === 'gemini-4-carbon');
    assert.equal(carbonAfter.input, 4.0);
    Date.now = origDateNow;

    // 2. External atomic overwrite of prefs.json with IDENTICAL mtimeMs and byte size, differing only by inode
    const prefsFile = join(h.dataDir, 'prefs.json');
    writeFileSync(prefsFile, '{"version":2,"currency":"USD","cnyRate":7.25}\n', 'utf-8');
    const st1 = statSync(prefsFile);
    const rUsd = api.handleReport({ days: '7', agent: 'antigravity', tz: 'UTC', noSync: '1' });
    assert.equal(rUsd.prefs.currency, 'USD');

    const tmpPrefs = join(h.dataDir, 'prefs.swap.tmp');
    writeFileSync(tmpPrefs, '{"version":2,"currency":"CNY","cnyRate":7.25}\n', 'utf-8');
    utimesSync(tmpPrefs, st1.atime, st1.mtime);
    renameSync(tmpPrefs, prefsFile);
    const st2 = statSync(prefsFile);
    assert.equal(st2.size, st1.size);

    const rCny = api.handleReport({ days: '7', agent: 'antigravity', tz: 'UTC', noSync: '1', etag: rUsd.etag });
    assert.equal(rCny.unchanged, undefined, 'same-size/same-mtime diff-ino prefs rewrite must bust ETag');
    assert.equal(rCny.prefs.currency, 'CNY');

    // 3. Sidecar HostBridge.fetch must strip AbortSignal before calling window.sidecar.fetch (preventing DataCloneError)
    const appJs = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf-8');
    let fetchCalls = 0;
    let sawSignalOnSidecar = false;
    let liveTextVal = 'Live';
    const mkEl = (id) => ({
      id,
      className: '',
      textContent: id === 'live-text' ? liveTextVal : '',
      innerHTML: '',
      title: '',
      value: '',
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener() {},
      querySelectorAll() {
        return [];
      },
      remove() {},
    });
    const elCache = new Map();
    const getEl = (id) => {
      if (!elCache.has(id)) elCache.set(id, mkEl(id));
      return elCache.get(id);
    };
    const sandbox = {
      console: { error() {}, log() {} },
      location: { search: '' },
      URLSearchParams,
      AbortController,
      setTimeout: (fn, ms) => (ms >= 5000 ? 1 : setTimeout(fn, ms)),
      clearTimeout,
      Intl,
      MutationObserver: class {
        observe() {}
      },
      getComputedStyle: () => ({ color: 'rgb(255, 255, 255)' }),
      document: {
        documentElement: { dataset: {}, appendChild() {} },
        body: { appendChild() {} },
        createElement: () => mkEl('probe'),
        getElementById: getEl,
        querySelectorAll: () => [],
      },
      window: {
        __ATM_CONFIG__: { defaultAgent: 'antigravity', lockedAgent: null },
        sidecar: {
          conversationId: '',
          fetch: async (_path, opts = {}) => {
            fetchCalls += 1;
            if ('signal' in opts && opts.signal !== undefined) {
              sawSignalOnSidecar = true;
              const err = new Error('AbortSignal could not be cloned');
              err.name = 'DataCloneError';
              throw err;
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                etag: 'e1',
                agentFilter: 'antigravity',
                availableAgents: ['antigravity', 'claude-code', 'codex'],
                prefs: { currency: 'USD', cnyRate: 7.25 },
                todayDate: '2026-11-24',
                rangeDays: 7,
                today: { costUsd: 0 },
                period: {
                  costUsd: 0,
                  avgDailyCostUsd: 0,
                  activeDays: 0,
                  input: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  output: 0,
                  total: 0,
                  cacheHitRate: 0,
                  cacheSavedUsd: 0,
                  unpricedSteps: 0,
                },
                allTime: { costUsd: 0, total: 0, totalSessions: 0 },
                agents: [],
                daily: [],
                models: [],
                sessions: [],
              }),
            };
          },
        },
      },
    };
    runInNewContext(appJs, sandbox);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(fetchCalls >= 1, 'boot should call window.sidecar.fetch');
    assert.equal(sawSignalOnSidecar, false, 'HostBridge.fetch must not pass AbortSignal to window.sidecar.fetch');
    assert.equal(getEl('live-text').textContent, 'Live');
  } finally {
    Date.now = origDateNow;
    h.cleanup();
  }
});

test('v2.1.0 red-team round-2 regressions: tier badges gated on applied official multipliers and legacy v1 AG parentSessionId chain', () => {
  const h = createTestEnv('atm-sync-rt2-');
  const prevLegacyEnv = process.env.TOKEN_METER_LEGACY_AG_DIR;
  try {
    // 1. P2-1: Custom override, unsupported provider (Google fast, Anthropic flex), and unpriced models
    //    MUST NOT increment fastSteps/flexSteps or surface misleading tierNote badges.
    mkdirSync(join(h.dataDir, 'events'), { recursive: true });
    writeFileSync(
      join(h.dataDir, 'pricing.override.json'),
      JSON.stringify({
        models: {
          'gpt-6.2-sol': {
            provider: 'openai',
            input: 3,
            cacheRead: 0.3,
            cacheWrite5m: 3,
            cacheWrite1h: 3,
            output: 12,
          },
        },
      }),
      'utf-8',
    );
    writeFileSync(
      join(h.dataDir, 'events', '2026-11.jsonl'),
      [
        // Custom override OpenAI model with st: 'fast' -> 1x custom ($3/M), fastSteps MUST be 0
        JSON.stringify({ a: 'codex', c: 's-custom', e: '1', ts: Date.parse('2026-11-23T10:00:00Z'), m: 'gpt-6.2-sol', k: 'T', in: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 0, r: 0, st: 'fast' }),
        // Google model with st: 'fast' -> no official Google fast multiplier, fastSteps MUST be 0
        JSON.stringify({ a: 'antigravity', c: 's-goog', e: '1', ts: Date.parse('2026-11-23T10:01:00Z'), m: 'gemini-4-neon-high', k: 'P', in: 100_000, cr: 0, cw5: 0, cw1h: 0, out: 0, r: 0, st: 'fast' }),
        // Unpriced model with st: 'fast' -> fastSteps MUST be 0
        JSON.stringify({ a: 'codex', c: 's-unp', e: '1', ts: Date.parse('2026-11-23T10:02:00Z'), m: 'mystery-model-x', k: 'T', in: 100_000, cr: 0, cw5: 0, cw1h: 0, out: 0, r: 0, st: 'fast' }),
        // Anthropic model with st: 'flex' -> Anthropic has no flex multiplier, flexSteps MUST be 0
        JSON.stringify({ a: 'claude-code', c: 's-anth-flex', e: '1', ts: Date.parse('2026-11-23T10:03:00Z'), m: 'claude-opus-5', k: 'M', in: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 0, r: 0, st: 'flex' }),
        // Control: Anthropic model with st: 'fast' + geo: 'us' -> 2x * 1.1x = 2.2x ($5 * 2.2 = $11), fastSteps MUST be 1
        JSON.stringify({ a: 'claude-code', c: 's-anth-fast', e: '1', ts: Date.parse('2026-11-23T10:04:00Z'), m: 'claude-opus-5', k: 'M', in: 1_000_000, cr: 0, cw5: 0, cw1h: 0, out: 0, r: 0, st: 'fast', geo: 'us' }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const repTier = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    const mCustom = repTier.models.find((m) => m.model === 'gpt-6.2-sol');
    assert.equal(mCustom.fastSteps, 0);
    assert.equal(mCustom.flexSteps, 0);
    assert.equal(mCustom.tierNote.includes('fast 2x'), false);
    assert.equal(Number(mCustom.costUsd.toFixed(6)), 3);

    const mGoog = repTier.models.find((m) => m.model === 'gemini-4-neon-high');
    assert.equal(mGoog.fastSteps, 0);
    assert.equal(mGoog.tierNote.includes('fast 2x'), false);

    const mUnp = repTier.models.find((m) => m.model === 'mystery-model-x');
    assert.equal(mUnp.fastSteps, 0);
    assert.equal(mUnp.costUsd, 0);

    const mAnth = repTier.models.find((m) => m.model === 'claude-opus-5');
    assert.equal(mAnth.flexSteps, 0);
    assert.equal(mAnth.fastSteps, 1);
    assert.equal(mAnth.tierNote.includes('flex 0.5x'), false);
    assert.equal(mAnth.tierNote.includes('fast 2x'), true);
    // $5 (flex ignored -> 1x) + $11 (fast 2x * US 1.1x) = $16.00
    assert.equal(Number(mAnth.costUsd.toFixed(6)), 16);

    // 2. P2-3a: Legacy v1 AG import MUST copy zero-token parent metadata chain so child `unknown` events inherit model
    const hLeg = createTestEnv('atm-sync-legchain-');
    try {
      const legacyDir = join(hLeg.root, 'legacy-v1');
      mkdirSync(join(legacyDir, 'events'), { recursive: true });
      writeFileSync(
        join(legacyDir, 'events', '2026-11.jsonl'),
        JSON.stringify({
          c: 'ag-leg-child',
          i: 2,
          ts: Date.parse('2026-11-18T12:00:00Z'),
          m: 'unknown',
          k: 'P',
          in: 20_000,
          cr: 0,
          out: 2_000,
        }) + '\n',
        'utf-8',
      );
      writeFileSync(
        join(legacyDir, 'cursors.json'),
        JSON.stringify({
          version: 1,
          files: {},
          sessions: {
            'ag-leg-parent': {
              convId: 'ag-leg-parent',
              app: 'antigravity',
              title: 'Zero-token Legacy Parent',
              lastModel: 'gemini-4-carbon-high',
              firstTs: Date.parse('2026-11-18T11:55:00Z'),
              lastTs: Date.parse('2026-11-18T11:55:00Z'),
            },
            'ag-leg-child': {
              convId: 'ag-leg-child',
              app: 'antigravity',
              parentSessionId: 'ag-leg-parent',
              title: 'Legacy Child Subagent',
              lastModel: 'unknown',
              firstTs: Date.parse('2026-11-18T12:00:00Z'),
              lastTs: Date.parse('2026-11-18T12:00:00Z'),
            },
          },
        }),
        'utf-8',
      );
      process.env.TOKEN_METER_LEGACY_AG_DIR = legacyDir;

      const legSync = syncAllSources({ dataDir: hLeg.dataDir });
      assert.equal(legSync.legacyImported, 1);

      const repLeg = buildReport({ dataDir: hLeg.dataDir, rangeDays: 0, agent: 'antigravity', timeZone: 'UTC' });
      assert.equal(repLeg.period.steps, 1);
      assert.equal(repLeg.period.unpricedSteps, 0);
      assert.equal(repLeg.sessions[0].sessionId, 'ag-leg-child');
      assert.equal(repLeg.sessions[0].primaryModel, 'gemini-4-carbon-high');
    } finally {
      hLeg.cleanup();
    }
  } finally {
    if (prevLegacyEnv === undefined) delete process.env.TOKEN_METER_LEGACY_AG_DIR;
    else process.env.TOKEN_METER_LEGACY_AG_DIR = prevLegacyEnv;
    h.cleanup();
  }
});
