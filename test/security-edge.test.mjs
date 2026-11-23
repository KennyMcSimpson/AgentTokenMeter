import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { installTarget, uninstallTarget } from '../bin/installer.mjs';
import { readJsonlDelta } from '../core/jsonl-reader.mjs';
import { buildReport } from '../core/report.mjs';
import { compactEventsPreservingArchived } from '../core/store.mjs';
import { syncAllSources, syncSingleSource } from '../core/sync.mjs';
import { startDashboardServer } from '../server/http.mjs';
import { createTestEnv } from './helpers.mjs';

function rawHttpRequest({ host = '127.0.0.1', port, method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('HTTP security & DoS guards: DNS rebinding 403, malformed Host 400, >64KB 413, extreme days clamped', async () => {
  const h = createTestEnv('atm-sec-http-');
  let srv = null;
  try {
    srv = await startDashboardServer({ host: '127.0.0.1', port: 0, dataDir: h.dataDir });

    // DNS Rebinding via foreign Host header MUST be blocked with 403
    const rebind = await rawHttpRequest({
      port: srv.port,
      path: '/api/report?days=1',
      headers: { Host: `evil.com:${srv.port}` },
    });
    assert.equal(rebind.status, 403);

    // Malformed Host header MUST return 400 (never 500)
    const badHost = await rawHttpRequest({
      port: srv.port,
      path: '/api/report',
      headers: { Host: 'bad host name' },
    });
    assert.equal(badHost.status, 400);

    // Oversized POST body (>64KB) MUST return clean HTTP 413 (not ECONNRESET)
    const bigBody = JSON.stringify({ pad: 'x'.repeat(80 * 1024) });
    const tooLarge = await rawHttpRequest({
      port: srv.port,
      method: 'POST',
      path: '/api/prefs',
      headers: {
        Host: `127.0.0.1:${srv.port}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bigBody),
      },
      body: bigBody,
    });
    assert.equal(tooLarge.status, 413);

    // Extreme rangeDays must neither OOM nor 500
    const hugeDays = await rawHttpRequest({
      port: srv.port,
      path: '/api/report?days=1000000000000000&tz=UTC',
      headers: { Host: `127.0.0.1:${srv.port}` },
    });
    assert.equal(hugeDays.status, 200);
    const rep = JSON.parse(hugeDays.body);
    assert.ok(rep.rangeDays <= 3650);
    assert.ok(rep.daily.length <= 366);
  } finally {
    if (srv) await srv.close();
    h.cleanup();
  }
});

test('Codex edge cases: omitted reasoning_output_tokens does not false-reset; last_token_usage-only duplicates deduplicated', () => {
  const h = createTestEnv('atm-sec-codex-');
  try {
    const rollout = h.mkCodexRollout('2026/11/22', 'rollout-2026-11-22T10-00-00-edge-1.jsonl');
    writeFileSync(
      rollout,
      [
        JSON.stringify({ timestamp: '2026-11-22T10:00:00Z', type: 'session_meta', payload: { id: 'edge-1', model: 'gpt-5.3-codex' } }),
        // Turn 1 includes reasoning_output_tokens = 600 (total 102,000)
        JSON.stringify({
          timestamp: '2026-11-22T10:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 2_000, reasoning_output_tokens: 600 },
            },
          },
        }),
        // Turn 2 advances totals to 122,500 but omits reasoning_output_tokens (must NOT trigger false reset!)
        JSON.stringify({
          timestamp: '2026-11-22T10:00:15Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 120_000, cached_input_tokens: 95_000, output_tokens: 2_500 },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const lastOnly = h.mkCodexRollout('2026/11/22', 'rollout-2026-11-22T11-00-00-edge-2.jsonl');
    writeFileSync(
      lastOnly,
      [
        JSON.stringify({ timestamp: '2026-11-22T11:00:00Z', type: 'session_meta', payload: { id: 'edge-2', model: 'gpt-5.3-codex' } }),
        JSON.stringify({
          timestamp: '2026-11-22T11:00:05Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 1_000 } } },
        }),
        // Duplicate refresh snapshot 1 second later -> must be skipped
        JSON.stringify({
          timestamp: '2026-11-22T11:00:06Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 1_000 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const resetRollout = h.mkCodexRollout('2026/11/22', 'rollout-2026-11-22T12-00-00-edge-3.jsonl');
    writeFileSync(
      resetRollout,
      [
        JSON.stringify({ timestamp: '2026-11-22T12:00:00Z', type: 'session_meta', payload: { id: 'edge-3', model: 'gpt-5.3-codex' } }),
        // Turn 1: in=100k, cr=80k (uncached=20k), out=2k, r=600
        JSON.stringify({
          timestamp: '2026-11-22T12:00:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 2_000, reasoning_output_tokens: 600 } },
          },
        }),
        // Turn 2: genuine counter reset with omitted cr/r -> must start at 0 (uncached=10k, cr=0, out=500, r=0)
        JSON.stringify({
          timestamp: '2026-11-22T12:01:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 10_000, output_tokens: 500 } },
          },
        }),
        // Turn 3: advances to in=60k, cr=50k, out=1k -> delta inTotal=50k, cr=50k (uncached=0), out=500
        JSON.stringify({
          timestamp: '2026-11-22T12:02:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 60_000, cached_input_tokens: 50_000, output_tokens: 1_000 } },
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    syncAllSources({ dataDir: h.dataDir });
    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    const s1 = rep.sessions.find((s) => s.sessionId === 'edge-1');
    const s2 = rep.sessions.find((s) => s.sessionId === 'edge-2');
    const s3 = rep.sessions.find((s) => s.sessionId === 'edge-3');
    assert.equal(s1.total, 122_500); // NOT 224,500
    assert.equal(s2.total, 51_000); // NOT 102,000
    assert.equal(s3.input, 30_000); // 20k + 10k + 0 (NOT 70k)
    assert.equal(s3.cacheRead, 130_000); // 80k + 0 + 50k (NOT 90k)
    assert.equal(s3.reasoning, 600); // 600 + 0 + 0 (NOT 1100)
    assert.equal(s3.output, 3_000); // 2000 + 500 + 500
  } finally {
    h.cleanup();
  }
});

test('Claude Code hook edge cases: custom dir + file-history-snapshot / >4KB first line + subagent session_id isolation', () => {
  const h = createTestEnv('atm-sec-cc-');
  try {
    // Custom directory path that does NOT contain `/.claude/projects/`
    const customFile = join(h.claudeProjectsDir, 'custom-ws', 'main-sess.jsonl');
    mkdirSync(join(h.claudeProjectsDir, 'custom-ws'), { recursive: true });
    writeFileSync(
      customFile,
      [
        JSON.stringify({ type: 'file-history-snapshot', messageId: 'snap1', snapshot: { pad: 'a'.repeat(5000) } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'main-sess',
          requestId: 'req_1',
          timestamp: '2026-11-22T08:00:00Z',
          message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 200 } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const subFile = h.mkClaudeTranscript('custom-ws', 'main-sess', 'agent-sub1');
    writeFileSync(
      subFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'main-sess',
        isSidechain: true,
        requestId: 'req_sub',
        timestamp: '2026-11-22T08:01:00Z',
        message: { id: 'msg_sub', model: 'claude-haiku-4-5', usage: { input_tokens: 10_000, output_tokens: 1_000 } },
      }) + '\n',
      'utf-8',
    );

    // Invoke universal hook with custom path AND subagent path carrying parent session_id
    assert.equal(h.runHook({ session_id: 'main-sess', transcript_path: customFile }).trim(), '{}');
    assert.equal(h.runHook({ session_id: 'main-sess', transcript_path: subFile }).trim(), '{}');

    // Subsequent full scan must NOT double-count subagent under two different session IDs
    syncAllSources({ dataDir: h.dataDir });
    const rep = buildReport({ dataDir: h.dataDir, rangeDays: 0, timeZone: 'UTC' });
    assert.equal(rep.allTime.totalEvents, 2);
    assert.equal(rep.period.total, 12_200);
  } finally {
    h.cleanup();
  }
});

test('Windows slash/case cursor unification, in-place shrink reset, cross-month compaction, invalid ts guard, and future-date consistency', () => {
  const h = createTestEnv('atm-sec-store-');
  try {
    // 1. Mixed slashes / casing on the same file must NOT split cursors.json
    const f = h.mkCodexRollout('2026/11/22', 'rollout-2026-11-22T12-00-00-winpath.jsonl');
    writeFileSync(
      f,
      [
        JSON.stringify({ timestamp: '2026-11-22T12:00:00Z', type: 'session_meta', payload: { id: 'winpath', model: 'gpt-6-luna' } }),
        JSON.stringify({
          timestamp: '2026-11-22T12:00:05Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10_000, cached_input_tokens: 5_000, output_tokens: 500 } } },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const altPath = process.platform === 'win32' ? f.replace(/\\/g, '/').toLowerCase() : f;
    syncSingleSource(altPath, { agent: 'codex', dataDir: h.dataDir });
    syncAllSources({ dataDir: h.dataDir });
    const cursors = JSON.parse(readFileSync(join(h.dataDir, 'cursors.json'), 'utf-8'));
    assert.equal(Object.keys(cursors.files).length, 1);

    // 2. In-place truncation where offset <= newSize < prevSize MUST reset and read new lines
    const shrinkFile = join(h.root, 'shrink.jsonl');
    const lineA = JSON.stringify({ step: 1, pad: 'x'.repeat(80) }) + '\n';
    const tornTail = '{"step":2,"pad":"' + 'y'.repeat(120);
    writeFileSync(shrinkFile, lineA + tornTail, 'utf-8');
    const firstRead = readJsonlDelta(shrinkFile, null, false);
    assert.equal(firstRead.records.length, 1);
    const prevCursor = {
      size: firstRead.stat.size,
      mtimeMs: firstRead.stat.mtimeMs,
      ino: firstRead.stat.ino,
      offset: firstRead.newOffset,
    };
    // Truncate in-place to a new shorter size still >= prevCursor.offset
    const replacement = JSON.stringify({ step: 99, pad: 'z'.repeat(130) }) + '\n';
    assert.ok(replacement.length >= prevCursor.offset && replacement.length < prevCursor.size);
    writeFileSync(shrinkFile, replacement, 'utf-8');
    const secondRead = readJsonlDelta(shrinkFile, prevCursor, false);
    assert.equal(secondRead.reset, true);
    assert.equal(secondRead.records.length, 1);
    assert.equal(secondRead.records[0].obj.step, 99);

    // 3. Cross-month LWW compaction removes orphaned empty old month file + ignores out-of-range ts
    const evDir = join(h.dataDir, 'events');
    mkdirSync(evDir, { recursive: true });
    writeFileSync(
      join(evDir, '2026-10.jsonl'),
      [
        JSON.stringify({ a: 'claude-code', c: 's1', e: 'm1:r1', ts: Date.parse('2026-10-31T23:59:59Z'), m: 'claude-sonnet-4-6', in: 100, out: 10 }),
        JSON.stringify({ a: 'claude-code', c: 'bad', e: 'bad1', ts: 1e16, m: 'claude-sonnet-4-6', in: 100, out: 10 }),
      ].join('\n') + '\n',
      'utf-8',
    );
    compactEventsPreservingArchived(h.dataDir, [
      { a: 'claude-code', c: 's1', e: 'm1:r1', ts: Date.parse('2026-11-01T00:00:01Z'), m: 'claude-sonnet-4-6', in: 100, out: 500 },
    ]);
    assert.equal(existsSync(join(evDir, '2026-10.jsonl')), false);

    // 4. Future-dated event does not break bounded period vs daily reconciliation
    appendFileSync(
      join(evDir, '2099-01.jsonl'),
      JSON.stringify({ a: 'codex', c: 'fut', e: 'tc:1', ts: Date.parse('2099-01-01T00:00:00Z'), m: 'gpt-6-luna', in: 1000, out: 100 }) + '\n',
      'utf-8',
    );
    const bounded = buildReport({ dataDir: h.dataDir, rangeDays: 7, timeZone: 'UTC' });
    const sumDaily = bounded.daily.reduce((s, d) => s + d.total, 0);
    assert.equal(bounded.period.total, sumDaily);
  } finally {
    h.cleanup();
  }
});

test('Installer non-standard repo dir idempotency, same-group third-party hook preservation, and CLI boolean flags', () => {
  const h = createTestEnv('atm-sec-inst-');
  try {
    const customRepo = join(h.root, 'my-custom-folder');
    const ccSettings = join(h.claudeDir, 'settings.json');
    writeFileSync(
      ccSettings,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '*',
              hooks: [
                { type: 'command', command: 'echo keep-me-alive' },
                { type: 'command', command: `node "${join(customRepo, 'hooks', 'record.mjs')}"`, timeout: 10 },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );

    // Uninstall must remove ONLY our hook inside the shared group, preserving `echo keep-me-alive`
    const un = uninstallTarget('claude', { repoRoot: customRepo });
    assert.equal(un.changed, true);
    const afterUn = JSON.parse(readFileSync(ccSettings, 'utf-8'));
    assert.equal(afterUn.hooks.Stop.length, 1);
    assert.equal(afterUn.hooks.Stop[0].hooks.length, 1);
    assert.equal(afterUn.hooks.Stop[0].hooks[0].command, 'echo keep-me-alive');

    // Non-standard folder name install twice -> idempotent + cleanly uninstallable
    installTarget('codex', { repoRoot: customRepo });
    installTarget('codex', { repoRoot: customRepo });
    const codexHooks = JSON.parse(readFileSync(join(h.codexDir, 'hooks.json'), 'utf-8'));
    assert.equal(codexHooks.hooks.Stop.length, 1);
    const unCodex = uninstallTarget('codex', { repoRoot: customRepo });
    assert.equal(unCodex.changed, true);

    // CLI boolean flag before positional arg must NOT swallow `codex`
    const dryOut = JSON.parse(h.runCli('install', '--dry-run', 'codex'));
    assert.equal(dryOut.ok, true);
    assert.equal(dryOut.dryRun, true);
    assert.equal(dryOut.target, 'codex-hooks');

    // Single-agent summary must NOT print `--- By Agent ---`
    const sumOut = h.runCli('summary', '--days', '0', '--agent', 'claude-code', '--no-sync');
    assert.equal(sumOut.includes('--- By Agent ---'), false);
  } finally {
    h.cleanup();
  }
});
