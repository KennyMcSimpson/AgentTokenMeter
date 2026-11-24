import { Response, SidecarApp } from 'sidecar_sdk';
import { getDataDir } from '../../core/pricing.mjs';
import { createApiController } from '../../server/api.mjs';

const api = createApiController({
  defaultAgent: process.env.TOKEN_METER_DEFAULT_AGENT || 'antigravity',
});

const app = new SidecarApp();

app.page('/', () => api.getHtml({ injectPreload: true }));

app.api(
  '/styles.css',
  () => new Response(api.getCss(), { contentType: 'text/css; charset=utf-8' }),
  'GET',
);

app.api(
  '/app.js',
  () => new Response(api.getJs(), { contentType: 'application/javascript; charset=utf-8' }),
  'GET',
);

app.api(
  '/api/report',
  (data) => api.handleReport(data || {}, app.config?.conversationId || ''),
  'GET',
);

app.api(
  '/api/export.csv',
  (data) => {
    const { csv, filename } = api.handleExportCsv(data || {});
    return new Response(csv, {
      contentType: 'text/csv; charset=utf-8',
      headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
    });
  },
  'GET',
);

app.api('/api/prefs', (data) => api.handleSavePrefs(data || {}), 'POST');

app.api('/api/sync', (data) => api.handleSync(data || {}), 'POST');

// Start listening immediately so host startup never times out on large initial backfills;
// run an incremental warmup sync right after binding if no client request already triggered one.
app.run().then(() => {
  setTimeout(() => {
    const initRes = api.runSync({ force: false, full: false, throwOnError: false });
    const st = api.getStatus();
    console.log(
      `[agent_token_meter] ready: dataDir=${getDataDir()}`,
      initRes
        ? `sources=${initRes.totalSources} added=${initRes.added}`
        : st.lastSyncError
          ? `syncError=${st.lastSyncError}`
          : 'sync=cached',
    );
  }, 100);
});
