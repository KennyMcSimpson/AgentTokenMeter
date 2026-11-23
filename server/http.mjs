import { createServer } from 'node:http';
import { createApiController } from './api.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizeHostname(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

/**
 * Strictly parse HTTP Host header. Returns `{ hostname }` or null if malformed.
 */
function parseHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
  try {
    const u = new URL(`http://${trimmed}`);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return { hostname: normalizeHostname(u.hostname) };
  } catch {
    return null;
  }
}

function isAllowedHostname(hostname, bindHost) {
  const norm = normalizeHostname(hostname);
  if (!norm) return false;
  if (LOOPBACK_HOSTS.has(norm)) return true;
  const normBind = normalizeHostname(bindHost);
  return Boolean(normBind && normBind !== '0.0.0.0' && normBind !== '::' && norm === normBind);
}

function isAllowedOrigin(origin, allowedHostname, bindHost) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const originHost = normalizeHostname(u.hostname);
    return isAllowedHostname(originHost, bindHost) || (Boolean(allowedHostname) && originHost === allowedHostname);
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Start zero-dependency local HTTP dashboard server bound to loopback (127.0.0.1 by default).
 * Enforces Host-header validation (DNS rebinding protection) and same-host/loopback Origin checks.
 */
export function startDashboardServer({
  host = '127.0.0.1',
  port = 3456,
  dataDir = null,
  defaultAgent = 'all',
  lockedAgent = '',
  syncOnStart = true,
} = {}) {
  const api = createApiController({ dataDir, defaultAgent, lockedAgent });
  if (syncOnStart) {
    api.runSync({ force: true, full: false, throwOnError: false });
  }

  const server = createServer(async (req, res) => {
    try {
      const rawHost = req.headers.host;
      let validatedHost = normalizeHostname(host);
      if (rawHost !== undefined) {
        const parsedHost = parseHostHeader(rawHost);
        if (!parsedHost) {
          sendJson(res, 400, { error: 'Malformed Host header' });
          return;
        }
        if (!isAllowedHostname(parsedHost.hostname, host)) {
          sendJson(res, 403, { error: 'Forbidden Host header' });
          return;
        }
        validatedHost = parsedHost.hostname;
      }

      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin, validatedHost, host)) {
        sendJson(res, 403, { error: 'Forbidden cross-origin request' });
        return;
      }

      let url;
      try {
        url = new URL(req.url || '/', `http://${rawHost || `${host}:${port}`}`);
      } catch {
        sendJson(res, 400, { error: 'Malformed request URL' });
        return;
      }

      const pathname = url.pathname;
      const params = Object.fromEntries(url.searchParams.entries());

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(api.getHtml({ injectPreload: false }));
        return;
      }

      if (req.method === 'GET' && pathname === '/styles.css') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(api.getCss());
        return;
      }

      if (req.method === 'GET' && pathname === '/app.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(api.getJs());
        return;
      }

      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true, ...api.getStatus() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/report') {
        sendJson(res, 200, api.handleReport(params));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/export.csv') {
        const { csv, filename } = api.handleExportCsv(params);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(csv);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/prefs') {
        const body = await readJsonBody(req);
        sendJson(res, 200, api.handleSavePrefs(body));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/sync') {
        const body = await readJsonBody(req);
        sendJson(res, 200, api.handleSync(body));
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      const extra = status === 413 ? { Connection: 'close' } : {};
      sendJson(res, status, { error: err?.message || 'Internal server error' }, extra);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const actualHost = host.includes(':') ? `[${host}]` : host;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${actualHost}:${actualPort}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
