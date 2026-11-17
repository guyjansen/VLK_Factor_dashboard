#!/usr/bin/env node
// Small Express server:
//  - serves the static app in public/ with security and cache headers
//  - GET  /api/health         liveness + data status
//  - GET  /api/config         which optional server features are enabled
//  - POST /api/isochrone      {stationId} -> 300/600 s isochrones for a KNOWN
//                             station, computed server-side (keys never reach
//                             the browser), cached on disk, rate limited.
// The browser normally uses the precomputed data in public/data and works
// without this API; it is only used to fill gaps on demand.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, paths, readJson } from '../scripts/lib/common.mjs';
import { createProvider } from '../scripts/lib/providers/index.mjs';
import { computeStation, readCached } from '../scripts/lib/isochrone-store.mjs';
import { createRateLimiter } from '../scripts/lib/http.mjs';

const PORT = Number(process.env.PORT) || 8080;
const ON_DEMAND = String(process.env.ENABLE_ON_DEMAND_ISOCHRONES).toLowerCase() === 'true';
const PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE) || 10;
const PROD = process.env.NODE_ENV === 'production';

let stations = new Map();
function loadStations() {
  try {
    stations = new Map(readJson(paths.stations).stations.map((s) => [s.id, s]));
  } catch (err) {
    console.warn(`WARNING: ${err.message}. Run "npm run data". /api/isochrone is disabled until then.`);
  }
}
loadStations();

let provider = null;
let providerError = null;
if (ON_DEMAND) {
  try {
    provider = createProvider();
    if (provider.requiresKey && !process.env.ORS_API_KEY) throw new Error('ORS_API_KEY is not set');
  } catch (err) {
    providerError = err.message;
    provider = null;
    console.warn(`WARNING: on-demand isochrones disabled: ${err.message}`);
  }
}
const providerQueue = provider ? createRateLimiter(Number(process.env.ISOCHRONE_MIN_INTERVAL_MS) || provider.defaultMinIntervalMs) : null;

// --- minimal fixed-window rate limiter per client IP (no dependency) -------
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const entry = hits.get(key);
  if (!entry || now - entry.start > 60000) hits.set(key, { start: now, count: 1 });
  else if (++entry.count > PER_MINUTE) {
    res.set('Retry-After', String(Math.ceil((entry.start + 60000 - now) / 1000)));
    return res.status(429).json({ error: 'rate-limit', message: `Too many requests: limit is ${PER_MINUTE} per minute. Try again shortly.` });
  }
  next();
}
setInterval(() => { const cut = Date.now() - 60000; for (const [k, v] of hits) if (v.start < cut) hits.delete(k); }, 60000).unref();

const inFlight = new Map(); // stationId -> Promise (coalesce duplicate requests)

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://tiles.openfreemap.org",
      "connect-src 'self' https://tiles.openfreemap.org",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'"
    ].join('; ')
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stations: stations.size,
    precomputed: {
      network: fs.existsSync(paths.publicNetwork),
      isochrones: fs.existsSync(paths.publicIsochrones),
      coverage: fs.existsSync(paths.publicCoverage)
    }
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    onDemandIsochrones: !!provider,
    provider: provider ? { id: provider.id, name: provider.name, profile: provider.profile, attribution: provider.attribution } : null,
    reason: provider ? null : (ON_DEMAND ? providerError : 'disabled (set ENABLE_ON_DEMAND_ISOCHRONES=true)')
  });
});

app.post('/api/isochrone', express.json({ limit: '2kb' }), rateLimit, async (req, res) => {
  const stationId = String(req.body?.stationId || '');
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(stationId)) return res.status(400).json({ error: 'bad-request', message: 'stationId is required.' });
  const station = stations.get(stationId);
  if (!station) return res.status(404).json({ error: 'unknown-station', message: 'Unknown station id.' });

  const cached = readCached(stationId);
  if (!provider) {
    if (cached) return res.json({ cached: true, record: cached });
    return res.status(503).json({ error: 'unavailable', message: `On-demand isochrones are not enabled on this server (${ON_DEMAND ? providerError : 'ENABLE_ON_DEMAND_ISOCHRONES is not true'}).` });
  }
  try {
    if (!inFlight.has(stationId)) {
      inFlight.set(stationId, (async () => {
        try {
          // computeStation returns the cached record when inputs are unchanged.
          const probe = readCached(stationId);
          if (probe && probe.provider === provider.id) return { record: probe, fromCache: true };
          return await providerQueue(() => computeStation(provider, station, { fetchOpts: { retries: 3 } }));
        } finally {
          inFlight.delete(stationId);
        }
      })());
    }
    const { record, fromCache } = await inFlight.get(stationId);
    res.json({ cached: fromCache, record });
  } catch (err) {
    const map = { auth: [502, 'The routing provider rejected the server API key.'], quota: [503, 'The routing provider quota is exhausted. Try again later.'], 'rate-limit': [503, 'The routing provider is rate limiting requests. Try again shortly.'], network: [502, 'Could not reach the routing provider.'], timeout: [504, 'The routing provider timed out.'] };
    const [status, message] = map[err.code] || [502, 'Isochrone generation failed.'];
    console.error(`isochrone ${stationId}: ${err.message}`);
    res.status(status).json({ error: err.code || 'failed', message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not-found' }));

app.use(express.static(path.join(ROOT, 'public'), {
  index: 'index.html',
  maxAge: PROD ? '1h' : 0,
  setHeaders(res, file) {
    if (/[\\/]vendor[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=604800');
  }
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(err.status || 500).json({ error: 'server-error', message: err.expose ? err.message : 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Tube walk map on http://localhost:${PORT}`);
  console.log(`On-demand isochrones: ${provider ? `enabled (${provider.name})` : 'disabled'}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
