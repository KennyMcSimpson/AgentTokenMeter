import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { installTarget, uninstallTarget } from '../bin/installer.mjs';
import { syncAllSources, syncSingleSource } from '../core/sync.mjs';
import { startDashboardServer } from '../server/http.mjs';
import { CLI_SCRIPT, createTestEnv } from './helpers.mjs';

test('Standalone HTTP dashboard server: assets, API endpoints, ETag, agent filter, and cross-origin protection', async () => {
  const h = createTestEnv('atm-http-');
  let srv = null;
  try {
    const codexFile = h.mkCodexRollout('2026/11/22', 'rollout-2026-11-22T09-00-00-srv-1.jsonl');
    writeFileSync(
      codexFile,
      [
        JSON.stringify({ timestamp: '2026-11-22T09:00:00Z', type: 'session_meta', payload: { id: 'srv-1', model: 'gpt-5.3-codex' } }),
        JSON.stringify({
          timestamp: '2026-11-22T09:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 2_000, reasoning_output_tokens: 500 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    srv = await startDashboardServer({ host: '127.0.0.1', port: 0, dataDir: h.dataDir });

    const htmlRes = await fetch(`${srv.url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('AgentTokenMeter'));
    assert.ok(!html.includes('/preload.js'), 'Standalone HTML must not request Antigravity /preload.js');

    const healthRes = await fetch(`${srv.url}/healthz`);
    assert.equal(healthRes.status, 200);

    const repRes = await fetch(`${srv.url}/api/report?days=0&agent=codex&tz=UTC`);
    assert.equal(repRes.status, 200);
    const rep = await repRes.json();
    assert.equal(rep.allTime.totalEvents, 1);
    assert.equal(rep.period.input, 10_000);
    assert.equal(rep.period.cacheRead, 40_000);

    // ETag unchanged shortcut
    const etagRes = await fetch(`${srv.url}/api/report?days=0&agent=codex&tz=UTC&etag=${encodeURIComponent(rep.etag)}`);
    const etagJson = await etagRes.json();
    assert.equal(etagJson.unchanged, true);

    // Prefs update + CSV export
    const prefRes = await fetch(`${srv.url}/api/prefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'CNY', cnyRate: 7.2 }),
    });
    assert.equal(prefRes.status, 200);
    const csvRes = await fetch(`${srv.url}/api/export.csv?days=0&agent=codex&tz=UTC`);
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('est_cost_cny'));

    // Security: reject cross-origin browser requests and invalid JSON
    const evilRes = await fetch(`${srv.url}/api/report`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evilRes.status, 403);

    const badJson = await fetch(`${srv.url}/api/prefs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    assert.equal(badJson.status, 400);
  } finally {
    if (srv) await srv.close();
    h.cleanup();
  }
});

test('CLI commands: summary, pricing, set-currency, export, and statusline', () => {
  const h = createTestEnv('atm-cli-');
  try {
    const ccFile = h.mkClaudeTranscript('proj-x', 'cli-sess-1');
    writeFileSync(
      ccFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'cli-sess-1',
        requestId: 'r1',
        timestamp: new Date().toISOString(),
        message: {
          id: 'm1',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10_000, cache_read_input_tokens: 90_000, output_tokens: 2_000 },
        },
      }) + '\n',
      'utf-8',
    );

    const summaryJson = JSON.parse(h.runCli('summary', '--days', '0', '--json'));
    assert.equal(summaryJson.allTime.totalEvents, 1);

    const pricingOut = h.runCli('pricing');
    assert.ok(pricingOut.includes('Gemini 4 Neon'));
    assert.ok(pricingOut.includes('Claude Opus 4.6'));
    assert.ok(pricingOut.includes('GPT-5.3 Codex'));

    const statusOut = h.runCli('statusline', '--agent', 'claude-code', '--no-sync');
    assert.ok(statusOut.startsWith('CC Today:'));
    assert.ok(statusOut.includes('Cache 90.0%'));

    h.runCli('set-currency', 'CNY', '--rate', '7.1');
    const csvOut = h.runCli('export', '--days', '7', '--no-sync');
    assert.ok(csvOut.includes('est_cost_cny'));
  } finally {
    h.cleanup();
  }
});

test('Installer & uninstaller: dry-run, idempotency, preserving third-party hooks, and Codex strict schema', () => {
  const h = createTestEnv('atm-inst-');
  try {
    const ccSettings = join(h.claudeDir, 'settings.json');
    writeFileSync(
      ccSettings,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
        },
        statusLine: { type: 'command', command: 'echo existing-status' },
      }),
      'utf-8',
    );

    // Dry-run must not mutate file
    const dry = installTarget('claude', { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(JSON.parse(readFileSync(ccSettings, 'utf-8')).hooks.Stop, undefined);

    // Install claude hooks twice -> idempotent, preserves SessionStart and theme
    installTarget('claude');
    installTarget('claude');
    const afterCc = JSON.parse(readFileSync(ccSettings, 'utf-8'));
    assert.equal(afterCc.theme, 'dark');
    assert.equal(afterCc.hooks.SessionStart.length, 1);
    assert.equal(afterCc.hooks.Stop.length, 1);
    assert.equal(afterCc.hooks.SubagentStop.length, 1);

    // Refuses to overwrite third-party statusLine without --force
    assert.throws(() => installTarget('statusline'), /Existing Claude Code statusLine/);
    installTarget('statusline', { force: true });
    const ccStatusCmd = JSON.parse(readFileSync(ccSettings, 'utf-8')).statusLine.command;
    assert.ok(ccStatusCmd.includes('statusline --agent claude-code'));

    // Optional --all flag sets combined mode on statusLine
    installTarget('statusline', { force: true, allAgents: true });
    assert.ok(JSON.parse(readFileSync(ccSettings, 'utf-8')).statusLine.command.includes('statusline --agent all'));

    // Codex hooks: top-level MUST only contain `hooks` (deny_unknown_fields) and include commandWindows
    const codexHooksPath = join(h.codexDir, 'hooks.json');
    assert.equal(existsSync(codexHooksPath), false);
    installTarget('codex');
    installTarget('codex');
    const afterCodex = JSON.parse(readFileSync(codexHooksPath, 'utf-8'));
    assert.deepEqual(Object.keys(afterCodex), ['hooks']);
    assert.equal(afterCodex.hooks.Stop.length, 1);
    assert.ok(afterCodex.hooks.Stop[0].hooks[0].commandWindows.includes('cmd.exe --%'));

    // Uninstall removes only our entries, preserving user hooks
    uninstallTarget('claude');
    uninstallTarget('statusline');
    uninstallTarget('codex');
    const finalCc = JSON.parse(readFileSync(ccSettings, 'utf-8'));
    assert.equal(finalCc.hooks.SessionStart.length, 1);
    assert.equal(finalCc.hooks.Stop, undefined);
    assert.equal(finalCc.statusLine, undefined);
    const finalCodex = JSON.parse(readFileSync(codexHooksPath, 'utf-8'));
    assert.deepEqual(finalCodex, { hooks: {} });
  } finally {
    h.cleanup();
  }
});

test('Single-agent isolation on pre-populated shared ledger: lockedAgent, TOKEN_METER_AGENTS allowlist, syncSingleSource block, and --only fail-closed', async () => {
  const h = createTestEnv('atm-isolation-');
  let srvLocked = null;
  let srvAllowlist = null;
  let srvHostDefault = null;
  try {
    // Seed logs for ALL THREE agents and pre-populate the shared ledger first!
    const nowIso = new Date().toISOString();
    const agFile = h.mkAgTranscript('ag-iso-1');
    writeFileSync(
      agFile,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: nowIso,
        model: 'gemini-4-neon-xhigh',
        input_tokens: 10_000,
        cache_read_tokens: 0,
        output_tokens: 1_000,
      }) + '\n',
      'utf-8',
    );

    const ccFile = h.mkClaudeTranscript('proj-iso', 'cc-iso-1');
    writeFileSync(
      ccFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'cc-iso-1',
        requestId: 'r_iso',
        timestamp: nowIso,
        message: {
          id: 'm_iso',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 2_000 },
        },
      }) + '\n',
      'utf-8',
    );

    const cxFile = h.mkCodexRollout('2026/11/23', 'rollout-2026-11-23T12-00-00-cx-iso-1.jsonl');
    writeFileSync(
      cxFile,
      [
        JSON.stringify({ timestamp: nowIso, type: 'session_meta', payload: { id: 'cx-iso-1', model: 'gpt-5.3-codex' } }),
        JSON.stringify({
          timestamp: nowIso,
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30_000, cached_input_tokens: 0, output_tokens: 3_000 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    // Pre-populate shared ledger with all 3 agents before testing isolation
    syncAllSources({ dataDir: h.dataDir });

    // 1. Strict single-agent locked server on shared ledger:
    // MUST NOT leak Antigravity or Codex in `availableAgents`, `agents[]`, `sessions`, or CSV even when ?agent=all
    srvLocked = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: h.dataDir,
      defaultAgent: 'claude-code',
      lockedAgent: 'claude-code',
    });
    const lockedHtml = await (await fetch(`${srvLocked.url}/`)).text();
    assert.ok(lockedHtml.includes('"lockedAgent":"claude-code"'));
    assert.ok(lockedHtml.includes('"defaultAgent":"claude-code"'));

    const lockedRep = await (await fetch(`${srvLocked.url}/api/report?days=0&agent=all&tz=UTC`)).json();
    assert.equal(lockedRep.agentFilter, 'claude-code');
    assert.equal(lockedRep.lockedAgent, 'claude-code');
    assert.deepEqual(lockedRep.availableAgents, ['claude-code']);
    assert.deepEqual(lockedRep.agents.map((a) => a.agent), ['claude-code']);
    assert.equal(lockedRep.allTime.totalEvents, 1);
    assert.equal(lockedRep.sessions[0].agent, 'claude-code');

    const lockedCsv = await (await fetch(`${srvLocked.url}/api/export.csv?days=0&agent=all&tz=UTC`)).text();
    assert.ok(lockedCsv.includes(',claude-code,'));
    assert.ok(!lockedCsv.includes(',all,'));

    await srvLocked.close();
    srvLocked = null;

    // 2. Multi-agent allowlist (`TOKEN_METER_AGENTS=antigravity,codex`) on shared ledger:
    // MUST block claude-code across ?agent=claude-code, ?agent=all, CSV, and syncSingleSource
    process.env.TOKEN_METER_AGENTS = 'antigravity,codex';
    srvAllowlist = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: h.dataDir,
      defaultAgent: 'all',
    });
    const alAll = await (await fetch(`${srvAllowlist.url}/api/report?days=0&agent=all&tz=UTC`)).json();
    assert.deepEqual(alAll.availableAgents, ['antigravity', 'codex']);
    assert.equal(alAll.allTime.totalEvents, 2);

    const alBlocked = await (await fetch(`${srvAllowlist.url}/api/report?days=0&agent=claude-code&tz=UTC`)).json();
    assert.equal(alBlocked.agentFilter, 'all');
    assert.equal(alBlocked.sessions.some((s) => s.agent === 'claude-code'), false);

    const alBlockedCsv = await (await fetch(`${srvAllowlist.url}/api/export.csv?days=0&agent=claude-code&tz=UTC`)).text();
    assert.ok(!alBlockedCsv.includes(',claude-code,'));

    // Single-file hook sync for disabled agent must be rejected (0 added, 0 scanned)
    const blockedSync = syncSingleSource(ccFile, { agent: 'claude-code', dataDir: h.dataDir });
    assert.equal(blockedSync.added, 0);
    assert.equal(blockedSync.scanned, 0);

    await srvAllowlist.close();
    srvAllowlist = null;
    delete process.env.TOKEN_METER_AGENTS;

    // 3. Host-default server (like Antigravity sidecar: defaultAgent='antigravity', unlocked):
    // Defaults to showing antigravity alone, while reporting all availableAgents so UI switcher activates
    srvHostDefault = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: h.dataDir,
      defaultAgent: 'antigravity',
    });
    const hostRep = await (await fetch(`${srvHostDefault.url}/api/report?days=0&tz=UTC`)).json();
    assert.equal(hostRep.agentFilter, 'antigravity');
    assert.equal(hostRep.defaultAgent, 'antigravity');
    assert.equal(hostRep.lockedAgent, null);
    assert.deepEqual(hostRep.availableAgents, ['antigravity', 'claude-code', 'codex']);
    assert.equal(hostRep.allTime.totalEvents, 1);
    assert.equal(hostRep.sessions[0].agent, 'antigravity');

    const allRep = await (await fetch(`${srvHostDefault.url}/api/report?days=0&agent=all&tz=UTC`)).json();
    assert.equal(allRep.allTime.totalEvents, 3);

    // 4. CLI summary with TOKEN_METER_AGENTS=antigravity reading the SAME pre-populated shared ledger
    const summaryRaw = JSON.parse(
      execFileSync(process.execPath, [CLI_SCRIPT, 'summary', '--days', '0', '--json'], {
        env: { ...h.env, TOKEN_METER_AGENTS: 'antigravity' },
        encoding: 'utf-8',
      }),
    );
    assert.equal(summaryRaw.agentFilter, 'antigravity');
    assert.deepEqual(summaryRaw.availableAgents, ['antigravity']);
    assert.equal(summaryRaw.allTime.totalEvents, 1);

    // 5. `serve --only` without a valid specific `--agent` MUST fail closed (non-zero exit)
    assert.throws(
      () => execFileSync(process.execPath, [CLI_SCRIPT, 'serve', '--only'], { env: h.env, stdio: 'pipe' }),
      /requires a specific --agent/,
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [CLI_SCRIPT, 'serve', '--agent', 'claudecode', '--only'], {
          env: h.env,
          stdio: 'pipe',
        }),
      /requires a specific --agent/,
    );
  } finally {
    delete process.env.TOKEN_METER_AGENTS;
    if (srvLocked) await srvLocked.close();
    if (srvAllowlist) await srvAllowlist.close();
    if (srvHostDefault) await srvHostDefault.close();
    h.cleanup();
  }
});
