#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../core/fs-utils.mjs';
import { supportsZstd } from '../core/jsonl-reader.mjs';
import { getDataDir, listOfficialRateCard, loadPrefs, savePrefs } from '../core/pricing.mjs';
import { buildReport, exportDailyCsv, normalizeAgentFilter } from '../core/report.mjs';
import { syncAllSources, syncSingleSource } from '../core/sync.mjs';
import { startDashboardServer } from '../server/http.mjs';
import { installTarget, uninstallTarget } from './installer.mjs';

const BOOLEAN_FLAGS = new Set(['json', 'no-sync', 'full', 'dry-run', 'force', 'help', 'all', 'only']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtMoney(usd, prefs) {
  const isCny = prefs.currency === 'CNY';
  const sym = isCny ? '¥' : '$';
  const val = (Number(usd) || 0) * (isCny ? prefs.cnyRate : 1);
  const sign = val < 0 ? '-' : '';
  const abs = Math.abs(val);
  if (abs >= 1) return `${sign}${sym}${abs.toFixed(2)}`;
  if (abs >= 0.01) return `${sign}${sym}${abs.toFixed(3)}`;
  if (abs === 0) return `${sym}0.00`;
  return `${sign}${sym}${abs.toFixed(4)}`;
}

function fmtPct(ratio) {
  return `${((Number(ratio) || 0) * 100).toFixed(1)}%`;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cols) => cols.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function recentUtcMonths(nowMs = Date.now()) {
  const cur = new Date(nowMs);
  const curMonth = cur.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - 1, 1));
  const prevMonth = prev.toISOString().slice(0, 7);
  return [prevMonth, curMonth];
}

function cmdSummary(flags) {
  const dataDir = getDataDir();
  const agent = normalizeAgentFilter(flags.agent);
  if (!flags['no-sync']) {
    syncAllSources({ dataDir, agents: agent === 'all' ? null : [agent] });
  }
  const days = flags.days !== undefined ? Number(flags.days) : 7;
  const prefs = loadPrefs(dataDir);
  const report = buildReport({
    dataDir,
    rangeDays: Number.isFinite(days) ? days : 7,
    agent,
    timeZone: typeof flags.tz === 'string' ? flags.tz : undefined,
    activeSessionId: typeof flags.session === 'string' ? flags.session : typeof flags.conv === 'string' ? flags.conv : '',
    prefs,
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const label =
    report.rangeDays === 0 ? 'All Time' : report.rangeDays === 1 ? 'Today' : `Last ${report.rangeDays} Days`;
  const scope = report.agentFilter === 'all' ? 'All Agents' : report.agentFilter;
  console.log(`=== Agent Token Meter (${scope} · ${label} · ${report.todayDate} ${report.timeZone}) ===\n`);

  console.log(
    `Today (${report.todayDate}): ${fmtCompact(report.today.total)} tok (${report.today.steps} steps) | ` +
      `In ${fmtCompact(report.today.input)} · CacheR ${fmtCompact(report.today.cacheRead)} (${fmtPct(report.today.cacheHitRate)})` +
      (report.today.cacheWrite > 0 ? ` · CacheW ${fmtCompact(report.today.cacheWrite)}` : '') +
      ` · Out ${fmtCompact(report.today.output)} | Eq. Cost ${fmtMoney(report.today.costUsd, prefs)}`,
  );
  console.log(
    `Period (${label}): ${fmtCompact(report.period.total)} tok (${report.period.steps} steps, ${report.period.activeDays} active days) | ` +
      `Cache ${fmtPct(report.period.cacheHitRate)} | Eq. Cost ${fmtMoney(report.period.costUsd, prefs)} ` +
      `(avg ${fmtMoney(report.period.avgDailyCostUsd, prefs)}/active day)`,
  );
  console.log(
    `All Time (${scope}): ${fmtCompact(report.allTime.total)} tok across ${report.allTime.totalSessions} sessions (${fmtNum(report.allTime.totalEvents)} steps) | ` +
      `Eq. Cost ${fmtMoney(report.allTime.costUsd, prefs)}`,
  );
  if (report.period.unpricedSteps > 0) {
    console.log(
      `Note: ${report.period.unpricedSteps} step(s) used unlisted models (marked unpriced; add custom rates in pricing.override.json).`,
    );
  }
  if (!supportsZstd() && (report.agentFilter === 'all' || report.agentFilter === 'codex')) {
    console.log(
      `Note: Node.js ${process.version} lacks built-in zstd decompression; compressed Codex .jsonl.zst archives were skipped (requires Node.js >=22.15.0).`,
    );
  }

  if (report.agentFilter === 'all') {
    const activeAgents = report.agents.filter((a) => a.steps > 0);
    if (activeAgents.length > 0) {
      console.log('\n--- By Agent ---');
      printTable(
        ['Agent', 'Sessions', 'Steps', 'Total Tokens', 'Cache %', `Eq. Cost (${prefs.currency})`, 'Share'],
        activeAgents.map((a) => [
          a.label,
          fmtNum(a.sessions),
          fmtNum(a.steps),
          fmtCompact(a.total),
          fmtPct(a.cacheHitRate),
          fmtMoney(a.costUsd, prefs),
          `${a.costSharePct.toFixed(1)}%`,
        ]),
      );
    }
  }

  console.log('\n--- Daily Breakdown ---');
  const activeDaily = [...report.daily].reverse().filter((d) => d.steps > 0 || report.rangeDays <= 14);
  const showCw = report.period.cacheWrite > 0;
  printTable(
    showCw
      ? ['Date', 'Steps', 'Input', 'CacheR', 'CacheW', 'Output', 'Cache %', `Cost (${prefs.currency})`]
      : ['Date', 'Steps', 'Input', 'CacheR', 'Output', 'Cache %', `Cost (${prefs.currency})`],
    activeDaily.map((d) =>
      showCw
        ? [
            d.date,
            fmtNum(d.steps),
            fmtCompact(d.input),
            fmtCompact(d.cacheRead),
            fmtCompact(d.cacheWrite),
            fmtCompact(d.output),
            fmtPct(d.cacheHitRate),
            fmtMoney(d.costUsd, prefs),
          ]
        : [
            d.date,
            fmtNum(d.steps),
            fmtCompact(d.input),
            fmtCompact(d.cacheRead),
            fmtCompact(d.output),
            fmtPct(d.cacheHitRate),
            fmtMoney(d.costUsd, prefs),
          ],
    ),
  );

  if (report.models.length > 0) {
    console.log('\n--- By Model ---');
    printTable(
      ['Provider', 'Model', 'Steps', 'Input', 'CacheR', 'CacheW', 'Output', `Cost (${prefs.currency})`, 'Status'],
      report.models.map((m) => [
        m.provider,
        m.model,
        fmtNum(m.steps),
        fmtCompact(m.input),
        fmtCompact(m.cacheRead),
        fmtCompact(m.cacheWrite),
        fmtCompact(m.output),
        m.matchType === 'unpriced' ? '—' : fmtMoney(m.costUsd, prefs),
        m.matchType,
      ]),
    );
  }

  if (report.sessions.length > 0) {
    console.log('\n--- Top Sessions ---');
    printTable(
      ['Agent', 'Session', 'Model', 'Steps', 'Tokens', `Cost (${prefs.currency})`, 'Title'],
      report.sessions.slice(0, 10).map((s) => [
        s.agentLabel,
        s.sessionId.slice(0, 12),
        s.primaryModel,
        fmtNum(s.steps),
        fmtCompact(s.total),
        fmtMoney(s.costUsd, prefs),
        s.title || '(untitled)',
      ]),
    );
  }
}

function cmdSync(flags) {
  const dataDir = getDataDir();
  const full = Boolean(flags.full);
  const agent = normalizeAgentFilter(flags.agent);
  const res = syncAllSources({
    forceFullRescan: full,
    agents: agent === 'all' ? null : [agent],
    dataDir,
  });
  console.log(JSON.stringify({ ok: true, full, dataDir, ...res }, null, 2));
}

function cmdPricing() {
  const rows = listOfficialRateCard();
  console.log('Official Multi-Provider API Pricing (USD per 1M tokens):\n');
  printTable(
    ['Provider', 'Model Family', 'Prefix', 'In', 'CacheR', 'CW 5m', 'CW 1h', 'Out', 'Notes'],
    rows.map((r) => [
      r.provider,
      r.family,
      r.prefix,
      `$${r.input}`,
      `$${r.cacheRead}`,
      `$${r.cacheWrite5m}`,
      `$${r.cacheWrite1h}`,
      `$${r.output}`,
      r.tierNote,
    ]),
  );
}

function cmdSetCurrency(pos, flags) {
  const code = String(pos[1] || '').toUpperCase();
  if (code !== 'USD' && code !== 'CNY') {
    console.error('Usage: token-meter set-currency <USD|CNY> [--rate 7.25]');
    process.exit(1);
  }
  const patch = { currency: code };
  if (flags.rate !== undefined) patch.cnyRate = Number(flags.rate);
  const saved = savePrefs(patch, getDataDir());
  console.log(JSON.stringify({ ok: true, prefs: saved }));
}

function cmdExport(flags) {
  const dataDir = getDataDir();
  const agent = normalizeAgentFilter(flags.agent);
  if (!flags['no-sync']) {
    syncAllSources({ dataDir, agents: agent === 'all' ? null : [agent] });
  }
  const days = flags.days !== undefined ? Number(flags.days) : 30;
  const report = buildReport({
    dataDir,
    rangeDays: Number.isFinite(days) ? days : 30,
    agent,
    timeZone: typeof flags.tz === 'string' ? flags.tz : undefined,
  });
  const csv = exportDailyCsv(report);
  if (flags.out && typeof flags.out === 'string') {
    atomicWriteFile(flags.out, csv);
    console.log(`Exported ${report.daily.length} rows to ${flags.out}`);
  } else {
    process.stdout.write(csv);
  }
}

function readOptionalStatuslinePayload() {
  if (process.stdin.isTTY) return null;
  try {
    const raw = readFileSync(0, 'utf-8').slice(0, 65_536).trim();
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Fast, low-latency single-line HUD for Claude Code `statusLine`.
 * - If piped JSON contains `transcript_path`, syncs ONLY that single file with a short lock timeout.
 * - If the ledger lock is busy, degrades gracefully to reading existing persisted stats.
 * - Reads only the current & previous UTC month files to keep Today queries fast.
 */
function cmdStatusline(flags) {
  const dataDir = getDataDir();
  const agent = normalizeAgentFilter(flags.agent || 'all');
  try {
    const stdinPayload = readOptionalStatuslinePayload();
    if (!flags['no-sync']) {
      try {
        const singlePath =
          typeof stdinPayload?.transcript_path === 'string'
            ? stdinPayload.transcript_path
            : typeof stdinPayload?.transcriptPath === 'string'
              ? stdinPayload.transcriptPath
              : '';
        if (singlePath) {
          syncSingleSource(singlePath, {
            agent: agent === 'all' ? '' : agent,
            sessionId: typeof stdinPayload?.session_id === 'string' ? stdinPayload.session_id : '',
            dataDir,
            lockWaitMs: 300,
          });
        } else {
          syncAllSources({
            dataDir,
            agents: agent === 'all' ? null : [agent],
            lockWaitMs: 300,
          });
        }
      } catch {
        // Never stall terminal statusLine if another hook holds the lock
      }
    }
    const prefs = loadPrefs(dataDir);
    const report = buildReport({
      dataDir,
      rangeDays: 1,
      agent,
      prefs,
      months: recentUtcMonths(),
    });
    const t = report.today;
    const scope = agent === 'all' ? 'TM' : agent === 'claude-code' ? 'CC' : agent === 'codex' ? 'Codex' : 'AG';
    process.stdout.write(
      `${scope} Today: ${fmtCompact(t.total)} tok · ${fmtMoney(t.costUsd, prefs)} · Cache ${fmtPct(t.cacheHitRate)}\n`,
    );
  } catch {
    process.stdout.write('TM: --\n');
  }
}

async function cmdServe(flags) {
  const port = flags.port !== undefined ? Number(flags.port) : 3456;
  const host = typeof flags.host === 'string' && flags.host.trim() ? flags.host.trim() : '127.0.0.1';
  const defaultAgent = normalizeAgentFilter(flags.agent || 'all');
  if (flags.only && defaultAgent === 'all') {
    throw new Error('--only requires a specific --agent (antigravity | claude-code | codex)');
  }
  const lockedAgent = flags.only ? defaultAgent : '';
  const srv = await startDashboardServer({
    port: Number.isFinite(port) ? port : 3456,
    host,
    defaultAgent,
    lockedAgent,
  });
  console.log(`[agent-token-meter] Dashboard running at ${srv.url}`);
  console.log(
    `[agent-token-meter] Scope: ${lockedAgent ? `${lockedAgent} (locked single-agent mode)` : `default=${defaultAgent}`}`,
  );
  console.log(`[agent-token-meter] Data directory: ${getDataDir()}`);
  console.log('[agent-token-meter] Press Ctrl+C to stop.');
}

function cmdInstall(pos, flags, uninstall = false) {
  const target = String(pos[1] || '').trim().toLowerCase();
  if (!target) {
    console.error(
      `Usage: token-meter ${uninstall ? 'uninstall' : 'install'} <claude|statusline|codex> [--dry-run] [--force] [--all]`,
    );
    process.exit(1);
  }
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);
  const allAgents = Boolean(flags.all);
  const res = uninstall
    ? uninstallTarget(target, { dryRun })
    : installTarget(target, { dryRun, force, allAgents });
  console.log(JSON.stringify({ ok: true, ...res }, null, 2));
}

function printHelp() {
  console.log(`Agent Token Meter — Unified token & cost tracker for Antigravity, Claude Code & Codex

Usage:
  node bin/token-meter.mjs summary [--days 7] [--agent all|antigravity|claude-code|codex] [--json] [--no-sync]
  node bin/token-meter.mjs sync [--full] [--agent all|antigravity|claude-code|codex]
  node bin/token-meter.mjs serve [--port 3456] [--host 127.0.0.1] [--agent all|antigravity|claude-code|codex] [--only]
  node bin/token-meter.mjs statusline [--agent all|claude-code|codex|antigravity] [--no-sync]
  node bin/token-meter.mjs pricing
  node bin/token-meter.mjs set-currency <USD|CNY> [--rate 7.25]
  node bin/token-meter.mjs export [--days 30] [--agent all|...] [--out usage.csv]
  node bin/token-meter.mjs install <claude|statusline|codex> [--dry-run] [--force] [--all]
  node bin/token-meter.mjs uninstall <claude|statusline|codex> [--dry-run]
`);
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = flags.help ? 'help' : pos[0] || 'summary';

try {
  switch (cmd) {
    case 'summary':
      cmdSummary(flags);
      break;
    case 'sync':
      cmdSync(flags);
      break;
    case 'pricing':
      cmdPricing();
      break;
    case 'set-currency':
      cmdSetCurrency(pos, flags);
      break;
    case 'export':
      cmdExport(flags);
      break;
    case 'statusline':
      cmdStatusline(flags);
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    case 'install':
      cmdInstall(pos, flags, false);
      break;
    case 'uninstall':
      cmdInstall(pos, flags, true);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err?.message || err}`);
  process.exit(1);
}
