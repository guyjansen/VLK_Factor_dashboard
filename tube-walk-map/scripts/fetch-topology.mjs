#!/usr/bin/env node
// Step 2: download authoritative London Underground topology from the TfL
// Unified API (Route Sequence endpoint) for every tube line, both directions.
//
//   GET https://api.tfl.gov.uk/Line/Mode/tube
//   GET https://api.tfl.gov.uk/Line/{lineId}/Route/Sequence/{outbound|inbound}
//
// Raw responses are stored unchanged in data/raw/tfl/ together with a
// manifest (URLs, retrieval time, licence) so the build is reproducible
// offline. If the API is unreachable, previously downloaded files are kept
// and the script exits non-zero only when no usable copy exists.
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson, rel, TubeConfig, parseArgs, sleep } from './lib/common.mjs';
import { fetchJsonWithRetry } from './lib/http.mjs';

const API = 'https://api.tfl.gov.uk';
const args = parseArgs(process.argv.slice(2));
const appKey = process.env.TFL_APP_KEY || '';
const withKey = (u) => (appKey ? `${u}${u.includes('?') ? '&' : '?'}app_key=${encodeURIComponent(appKey)}` : u);
const redact = (u) => u.replace(/app_key=[^&]+/, 'app_key=REDACTED');

const LICENCE = {
  name: 'Transport for London open data terms (Powered by TfL Open Data)',
  url: 'https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service',
  attribution: 'Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and Geomni UK Map data © and database rights [2019].'
};

fs.mkdirSync(paths.rawTfl, { recursive: true });
const opts = {
  headers: { Accept: 'application/json', 'User-Agent': 'tube-walk-map/1.0 (topology preprocessing)' },
  retries: 4,
  onRetry: ({ attempt, delay, error }) => console.warn(`  retry ${attempt} in ${Math.round(delay)} ms (${error.code}: ${error.message.slice(0, 120)})`)
};

const manifest = { source: 'TfL Unified API', baseUrl: API, licence: LICENCE, retrievedAt: new Date().toISOString(), files: [], failures: [] };

let lineIds = TubeConfig.LINES.map((l) => l.id);
try {
  const lines = await fetchJsonWithRetry(withKey(`${API}/Line/Mode/tube`), opts);
  const apiIds = lines.map((l) => l.id).sort();
  const missing = lineIds.filter((id) => !apiIds.includes(id));
  const extra = apiIds.filter((id) => !lineIds.includes(id));
  if (missing.length || extra.length) {
    console.warn(`WARNING: TfL tube lines differ from configuration. missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    manifest.lineIdMismatch = { missing, extra };
  }
  manifest.apiLineIds = apiIds;
} catch (err) {
  console.warn(`WARNING: could not list tube lines (${err.message}); using configured line ids.`);
  manifest.failures.push({ url: `${API}/Line/Mode/tube`, error: err.message });
}

const only = args.line ? String(args.line).split(',') : null;
for (const id of lineIds.filter((x) => !only || only.includes(x))) {
  for (const dir of ['outbound', 'inbound']) {
    const url = `${API}/Line/${id}/Route/Sequence/${dir}`;
    const file = path.join(paths.rawTfl, `${id}-${dir}.json`);
    process.stdout.write(`Fetching ${id} ${dir} ... `);
    try {
      const json = await fetchJsonWithRetry(withKey(url), opts);
      if (!Array.isArray(json.stopPointSequences) || !json.stopPointSequences.length) throw new Error('response has no stopPointSequences');
      writeJson(file, json);
      manifest.files.push({ line: id, direction: dir, url: redact(url), file: rel(file), retrievedAt: new Date().toISOString() });
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${err.message}`);
      manifest.failures.push({ line: id, direction: dir, url: redact(url), error: err.message, cachedCopy: fs.existsSync(file) });
    }
    await sleep(1300); // anonymous TfL API limit is 50 requests/minute
  }
}

// Merge with any previous manifest entries for files we did not refresh.
const previous = fs.existsSync(paths.topologyManifest) ? JSON.parse(fs.readFileSync(paths.topologyManifest, 'utf8')) : null;
if (previous?.files) {
  for (const f of previous.files) {
    if (!manifest.files.some((x) => x.line === f.line && x.direction === f.direction)) manifest.files.push(f);
  }
}
writeJson(paths.topologyManifest, manifest);

const unusable = manifest.failures.filter((f) => f.line && !f.cachedCopy);
if (unusable.length) {
  console.error(`\nERROR: topology retrieval failed with no cached copy for: ${unusable.map((f) => `${f.line}/${f.direction}`).join(', ')}`);
  console.error('Check network access to api.tfl.gov.uk (or set TFL_APP_KEY), then re-run: npm run fetch-topology');
  process.exit(2);
}
if (manifest.failures.length) console.warn(`\nCompleted with ${manifest.failures.length} failure(s); cached copies were kept.`);
console.log(`Wrote ${rel(paths.topologyManifest)}`);
