#!/usr/bin/env node
// Step 4: generate pedestrian-network isochrones (MetroConfig.CONTOUR_SECONDS,
// currently 300 and 600 s) for each
// physical station through a routing engine (Valhalla by default).
//
// Usage:
//   node scripts/generate-isochrones.mjs                 # all stations (resumes; cached ones are skipped)
//   node scripts/generate-isochrones.mjs --line green     # one line
//   node scripts/generate-isochrones.mjs --station Slussen       (id or exact name)
//   node scripts/generate-isochrones.mjs --force         # recompute even if cached
//   node scripts/generate-isochrones.mjs --provider openrouteservice
//   node scripts/generate-isochrones.mjs --assemble-only # just rebuild combined outputs from cache
//   node scripts/generate-isochrones.mjs --limit 10      # at most N provider requests this run
//
// Outputs:
//   data/isochrones/<stationId>.json   per-station cache with provenance
//   data/isochrones/_failures.json     stations that failed in the last run
//   data/isochrones.geojson            full-precision analysis copy (all stations)
//   public/data/isochrones.js          simplified display copy for the browser
import fs from 'node:fs';
import { paths, readJson, writeJson, writeBrowserData, rel, parseArgs, MetroConfig, MetroGeometry } from './lib/common.mjs';
import { createProvider } from './lib/providers/index.mjs';
import { computeStation, readCached, isCacheValid } from './lib/isochrone-store.mjs';
import { createRateLimiter } from './lib/http.mjs';

const args = parseArgs(process.argv.slice(2));
let stationsDoc;
try { stationsDoc = readJson(paths.stations); } catch (err) {
  console.error(`ERROR: ${err.message}\nRun "npm run data" first.`);
  process.exit(1);
}
const all = stationsDoc.stations.filter((s) => !s.unmatched);

let targets = all;
if (args.line) {
  const lines = String(args.line).split(',');
  const bad = lines.filter((l) => !MetroConfig.LINE_BY_ID[l]);
  if (bad.length) { console.error(`Unknown line id(s): ${bad.join(', ')}. Valid: ${MetroConfig.LINES.map((l) => l.id).join(', ')}`); process.exit(1); }
  targets = all.filter((s) => s.lines.some((l) => lines.includes(l)));
}
if (args.station) {
  const wanted = String(args.station).split(',').map((x) => x.trim().toLowerCase());
  targets = all.filter((s) => wanted.includes(s.id.toLowerCase()) || wanted.includes(s.name.toLowerCase()));
  if (!targets.length) { console.error(`No station matches "${args.station}"`); process.exit(1); }
}

if (!args['assemble-only']) {
  let provider;
  try { provider = createProvider(args.provider); } catch (err) { console.error(`ERROR: ${err.message}`); process.exit(1); }
  if (provider.requiresKey && provider.id === 'openrouteservice' && !process.env.ORS_API_KEY) {
    console.error('ERROR: ORS_API_KEY is not set. Copy .env.example to .env and add your openrouteservice key, or use --provider valhalla.');
    process.exit(1);
  }
  const minInterval = Number(process.env.ISOCHRONE_MIN_INTERVAL_MS) || provider.defaultMinIntervalMs;
  const limit = createRateLimiter(minInterval);
  const maxRequests = args.limit ? Number(args.limit) : Infinity;
  console.log(`Provider: ${provider.name} · profile ${provider.profile} · ${targets.length} station(s) · min interval ${minInterval} ms`);

  const failures = [];
  let requested = 0, cached = 0, done = 0;
  let stopReason = null;
  for (const s of targets) {
    done++;
    const params = provider.parameters(MetroConfig.CONTOUR_SECONDS.slice(), MetroConfig.WALKING_SPEED_MPS);
    if (!args.force && isCacheValid(readCached(s.id), provider.id, params, { lon: s.lon, lat: s.lat })) { cached++; continue; }
    if (requested >= maxRequests) { stopReason = `--limit ${maxRequests} reached`; break; }
    try {
      requested++;
      await limit(() => computeStation(provider, s, {
        force: !!args.force, // otherwise only contours missing from the cache are requested
        fetchOpts: { retries: 5, onRetry: ({ attempt, delay, error }) => console.warn(`    retry ${attempt} for ${s.name} in ${Math.round(delay)} ms (${error.code})`) }
      }));
      console.log(`  [${done}/${targets.length}] ${s.name} ✓`);
    } catch (err) {
      failures.push({ stationId: s.id, name: s.name, error: err.message, code: err.code || null, at: new Date().toISOString() });
      console.error(`  [${done}/${targets.length}] ${s.name} ✗ ${err.code ? `(${err.code}) ` : ''}${err.message.slice(0, 200)}`);
      if (err.code === 'auth' || err.code === 'quota') { stopReason = err.code === 'auth' ? 'provider rejected the API key' : 'provider quota exhausted'; break; }
    }
  }
  writeJson(paths.isoFailures, { provider: provider.id, at: new Date().toISOString(), stopReason, failures });
  console.log(`\nRequested ${requested}, reused ${cached} cached, failed ${failures.length}${stopReason ? ` — stopped early: ${stopReason}` : ''}.`);
  if (failures.length) console.log(`Failed stations listed in ${rel(paths.isoFailures)}. Re-run the same command to retry only those (completed stations are cached).`);
}

// ------------------------------------------------- assemble combined outputs
const features = [];
const display = {};
const provenance = { providers: new Set(), profiles: new Set(), parameters: null, earliest: null, latest: null };
const missing = [];
for (const s of all) {
  const rec = readCached(s.id);
  if (!rec) { missing.push({ stationId: s.id, name: s.name }); continue; }
  provenance.providers.add(rec.providerName || rec.provider);
  provenance.profiles.add(rec.profile);
  provenance.parameters = rec.parameters;
  if (!provenance.earliest || rec.generatedAt < provenance.earliest) provenance.earliest = rec.generatedAt;
  if (!provenance.latest || rec.generatedAt > provenance.latest) provenance.latest = rec.generatedAt;
  const g = {};
  for (const f of rec.features) {
    if (!MetroConfig.CONTOUR_SECONDS.includes(f.properties.seconds)) continue; // e.g. retired 60/120 s contours
    features.push({
      type: 'Feature',
      properties: { ...f.properties, provider: rec.provider, profile: rec.profile, generatedAt: rec.generatedAt },
      geometry: f.geometry
    });
    // ~1.5 m tolerance; full-precision copy stays in data/isochrones.geojson.
    const simp = MetroGeometry.simplifyGeometry(f.geometry, 0.000015, 5);
    if (simp) g[f.properties.seconds] = simp;
  }
  display[s.id] = { g, at: rec.generatedAt };
}
const failuresDoc = readJson(paths.isoFailures, { failures: [] });
const meta = {
  generatedAt: new Date().toISOString(),
  providers: [...provenance.providers],
  profiles: [...provenance.profiles],
  parameters: provenance.parameters,
  isochronesGeneratedBetween: [provenance.earliest, provenance.latest],
  stationCount: Object.keys(display).length,
  totalStations: all.length,
  missing,
  failures: failuresDoc.failures || [],
  originNote: 'Isochrones start at the operator parent-station coordinate (a centroid), not at individual entrances.',
  attribution: provenance.providers.size ? [...provenance.providers].map((p) => /openrouteservice/i.test(p)
    ? 'openrouteservice © HeiGIT, OpenStreetMap data © OpenStreetMap contributors (ODbL)'
    : 'Valhalla routing (FOSSGIS e.V. public instance), OpenStreetMap data © OpenStreetMap contributors (ODbL)') : []
};
writeJson(paths.isochrones, { type: 'FeatureCollection', metadata: meta, features }, false);
writeBrowserData(paths.publicIsochrones, 'METRO_ISOCHRONES', { meta, stations: display });
const size = (f) => fs.existsSync(f) ? `${(fs.statSync(f).size / 1024).toFixed(0)} KB` : '-';
console.log(`Assembled ${Object.keys(display).length}/${all.length} stations (${missing.length} missing).`);
console.log(`Wrote ${rel(paths.isochrones)} (${size(paths.isochrones)}), ${rel(paths.publicIsochrones)} (${size(paths.publicIsochrones)})`);
