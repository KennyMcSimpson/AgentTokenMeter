import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnabledAgentIds, normalizeAgentId } from '../adapters/index.mjs';
import { getDataDir, savePrefs } from '../core/pricing.mjs';
import { buildReport, exportDailyCsv, normalizeAgentFilter } from '../core/report.mjs';
import { syncAllSources } from '../core/sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UI_DIR = resolve(__dirname, '..', 'ui');

export function createApiController({
  dataDir = null,
  syncIntervalMs = 4_000,
  defaultAgent = 'all',
  lockedAgent = '',
} = {}) {
  let lastSyncAt = 0;
  let lastSyncError = '';

  const enabledIds = getEnabledAgentIds();
  const resolvedLocked =
    normalizeAgentId(lockedAgent) || (enabledIds.length === 1 ? enabledIds[0] : '');
  const allowedAgents = resolvedLocked ? [resolvedLocked] : enabledIds;
  const allowedSet = new Set(allowedAgents);
  const rawDefault = normalizeAgentFilter(defaultAgent);
  const resolvedDefault = resolvedLocked
    ? resolvedLocked
    : rawDefault === 'all' || allowedSet.has(rawDefault)
      ? rawDefault
      : allowedAgents[0] || 'all';

  const resolveDir = () => dataDir || getDataDir();
  const resolveSyncAgents = () => (resolvedLocked ? [resolvedLocked] : null);
  const resolveEffectiveAgent = (raw) => {
    if (resolvedLocked) return resolvedLocked;
    if (raw === undefined || raw === '') return resolvedDefault;
    const requested = normalizeAgentFilter(raw);
    if (requested === 'all' || allowedSet.has(requested)) return requested;
    return resolvedDefault;
  };

  function runSync({ force = false, full = false, throwOnError = false } = {}) {
    const now = Date.now();
    if (!force && !full && now - lastSyncAt < syncIntervalMs) {
      return null;
    }
    try {
      const res = syncAllSources({
        forceFullRescan: full,
        agents: resolveSyncAgents(),
        dataDir: resolveDir(),
      });
      lastSyncAt = Date.now();
      lastSyncError = '';
      return res;
    } catch (err) {
      lastSyncError = err?.message || String(err);
      if (throwOnError) throw err;
      return null;
    }
  }

  function getHtml({ injectPreload = false } = {}) {
    let html = readFileSync(join(UI_DIR, 'index.html'), 'utf-8');
    const hostCfg = JSON.stringify({
      defaultAgent: resolvedDefault,
      lockedAgent: resolvedLocked || null,
    }).replace(/</g, '\\u003c');
    html = html.replace('<!-- HOST_CONFIG -->', () => `<script>window.__ATM_CONFIG__=${hostCfg};</script>`);
    if (injectPreload) {
      html = html.replace('<!-- HOST_PRELOAD -->', () => '<script src="/preload.js"></script>');
    }
    return html;
  }

  function getCss() {
    return readFileSync(join(UI_DIR, 'styles.css'), 'utf-8');
  }

  function getJs() {
    return readFileSync(join(UI_DIR, 'app.js'), 'utf-8');
  }

  function handleReport(params = {}, defaultActiveSessionId = '') {
    const force = params.force === '1' || params.force === 'true';
    runSync({ force, full: false, throwOnError: false });

    const days = params.days !== undefined && params.days !== '' ? Number(params.days) : 7;
    const tz = typeof params.tz === 'string' && params.tz.trim() ? params.tz.trim() : undefined;
    const agent = resolveEffectiveAgent(params.agent);
    const activeSessionId =
      (typeof params.sessionId === 'string' && params.sessionId) ||
      (typeof params.conversationId === 'string' && params.conversationId) ||
      defaultActiveSessionId ||
      '';

    const report = buildReport({
      dataDir: resolveDir(),
      rangeDays: Number.isFinite(days) ? days : 7,
      timeZone: tz,
      agent,
      allowedAgents,
      activeSessionId,
    });

    const etag = `${report.etag}|lk=${resolvedLocked}|se=${lastSyncError ? '1' : '0'}`;
    if (params.etag && params.etag === etag) {
      return { unchanged: true, etag, syncedAt: lastSyncAt, syncError: lastSyncError || null };
    }
    return {
      ...report,
      defaultAgent: resolvedDefault,
      lockedAgent: resolvedLocked || null,
      etag,
      syncedAt: lastSyncAt,
      syncError: lastSyncError || null,
    };
  }

  function handleExportCsv(params = {}) {
    runSync({ force: false, full: false, throwOnError: false });
    const days = params.days !== undefined && params.days !== '' ? Number(params.days) : 30;
    const tz = typeof params.tz === 'string' && params.tz.trim() ? params.tz.trim() : undefined;
    const agent = resolveEffectiveAgent(params.agent);

    const report = buildReport({
      dataDir: resolveDir(),
      rangeDays: Number.isFinite(days) ? days : 30,
      timeZone: tz,
      agent,
      allowedAgents,
    });
    const csv = exportDailyCsv(report);
    const suffix = agent === 'all' ? '' : `-${agent}`;
    return {
      csv,
      filename: `agent-token-meter-${report.todayDate}${suffix}.csv`,
    };
  }

  function handleSavePrefs(body = {}) {
    const saved = savePrefs(body || {}, resolveDir());
    return { ok: true, prefs: saved };
  }

  function handleSync(body = {}) {
    const full = Boolean(body?.full);
    const res = runSync({ force: true, full, throwOnError: true });
    return { ok: true, ...res, syncedAt: lastSyncAt };
  }

  return {
    runSync,
    getHtml,
    getCss,
    getJs,
    handleReport,
    handleExportCsv,
    handleSavePrefs,
    handleSync,
    getStatus: () => ({
      lastSyncAt,
      lastSyncError,
      defaultAgent: resolvedDefault,
      lockedAgent: resolvedLocked || null,
    }),
  };
}
