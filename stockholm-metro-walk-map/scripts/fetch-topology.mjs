#!/usr/bin/env node
// Step 1: download the authoritative network data.
//
//  a) SL static GTFS ("GTFS Regional", operator sl) from Trafiklab/Samtrafiken:
//       GET https://opendata.samtrafiken.se/gtfs/sl/sl.zip?key=$TRAFIKLAB_API_KEY
//     Licence CC0 1.0. The key is read from the environment / .env only and
//     never written to disk or logs. The full archive is kept in
//     data/raw/gtfs-sl/sl.zip (git-ignored: ~100 MB); a verbatim subset of the
//     metro rows is written to data/raw/gtfs-sl/metro/ (committed), together
//     with a manifest (URL, retrieval time, HTTP validators, SHA-256, licence).
//     The download is skipped while sl.zip exists (Bronze keys allow only 50
//     calls a month); pass --refresh to re-download (conditional GET).
//
//  b) OpenStreetMap metro stations via the Overpass API (reference only, used
//     to cross-check station names and positions; railsmaps.com shows the
//     same OpenStreetMap data). ODbL. Failure here is not fatal.
//
// Topology is derived ONLY from GTFS stop sequences (stop_times per trip, both
// directions). Coordinates are never used to order or connect stations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { paths, writeJson, readJson, rel, MetroConfig, parseArgs, USER_AGENT, fail } from './lib/common.mjs';
import { openZip } from './lib/zip.mjs';
import { parseCsvLine, tableFromText, toCsv } from './lib/gtfs.mjs';
import { fetchJsonWithRetry } from './lib/http.mjs';

const args = parseArgs(process.argv.slice(2));
const GTFS_URL = 'https://opendata.samtrafiken.se/gtfs/sl/sl.zip';
const LICENCE = {
  name: 'CC0 1.0 Universal (Public Domain Dedication)',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  terms: 'https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/',
  attribution: 'Timetable data: SL via Trafiklab.se / Samtrafiken (GTFS Regional, CC0 1.0)'
};
fs.mkdirSync(paths.gtfsMetro, { recursive: true });
const oldManifest = readJson(paths.topologyManifest, null);

// --------------------------------------------------------------- download
async function download() {
  const key = process.env.TRAFIKLAB_API_KEY || '';
  if (!key) {
    fail('TRAFIKLAB_API_KEY is not set and data/raw/gtfs-sl/sl.zip does not exist.',
      'Get a free "GTFS Regional" key at https://www.trafiklab.se/ and put it in .env (see .env.example) or the environment.');
  }
  const headers = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate' };
  if (fs.existsSync(paths.gtfsZip) && oldManifest?.http?.etag) headers['If-None-Match'] = oldManifest.http.etag;
  if (fs.existsSync(paths.gtfsZip) && oldManifest?.http?.lastModified) headers['If-Modified-Since'] = oldManifest.http.lastModified;
  console.log(`Downloading ${GTFS_URL} (key redacted)…`);
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${GTFS_URL}?key=${encodeURIComponent(key)}`, { headers, signal: AbortSignal.timeout(600000) });
    } catch (err) {
      if (attempt >= 3) fail(`could not reach opendata.samtrafiken.se: ${err.cause?.code || err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    break;
  }
  if (res.status === 304) { console.log('  not modified since the last download; keeping data/raw/gtfs-sl/sl.zip'); return { http: oldManifest.http, retrievedAt: oldManifest.retrievedAt, notModifiedCheckedAt: new Date().toISOString() }; }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300).replace(key, 'REDACTED');
    fail(`GTFS download failed: HTTP ${res.status} ${body}`, res.status === 401 || res.status === 403 ? 'Check TRAFIKLAB_API_KEY (it must be a "GTFS Regional" key).' : res.status === 429 ? 'Trafiklab quota exceeded; try later.' : undefined);
  }
  const tmp = `${paths.gtfsZip}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, paths.gtfsZip);
  return { http: { status: res.status, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), contentType: res.headers.get('content-type') }, retrievedAt: new Date().toISOString() };
}

let dl;
if (!fs.existsSync(paths.gtfsZip) || args.refresh) dl = await download();
else {
  console.log(`Using the cached ${rel(paths.gtfsZip)} (pass --refresh to download again).`);
  dl = { http: oldManifest?.http || null, retrievedAt: oldManifest?.retrievedAt || fs.statSync(paths.gtfsZip).mtime.toISOString() };
}

// ---------------------------------------------------------- metro subset
const zipBuf = fs.readFileSync(paths.gtfsZip);
const sha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');
const zip = openZip(paths.gtfsZip);
for (const f of ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt']) if (!zip.has(f)) fail(`GTFS archive lacks ${f}`);

const routesAll = tableFromText(zip.readText('routes.txt'));
const metroTypes = new Set(MetroConfig.MODES.flatMap((m) => m.gtfsRouteTypes));
const metroRoutes = routesAll.filter((r) => metroTypes.has(r.route_type));
const configured = new Set(Object.keys(MetroConfig.LINE_ID_BY_ROUTE));
const unknownMetro = metroRoutes.filter((r) => !configured.has(r.route_short_name));
const missingRoutes = [...configured].filter((n) => !metroRoutes.some((r) => r.route_short_name === n));
if (!metroRoutes.length) fail(`no metro routes (route_type ${[...metroTypes].join('/')}) in routes.txt`);
if (missingRoutes.length) fail(`configured metro routes not in the GTFS feed: ${missingRoutes.join(', ')}`);
const routeIds = new Set(metroRoutes.filter((r) => configured.has(r.route_short_name)).map((r) => r.route_id));
const routeById = new Map(metroRoutes.map((r) => [r.route_id, r]));
console.log(`Metro routes: ${metroRoutes.map((r) => `${r.route_short_name} (${r.route_id})`).join(', ')}`);
if (unknownMetro.length) console.warn(`  warning: metro route(s) not in the configuration, ignored: ${unknownMetro.map((r) => r.route_short_name || r.route_id).join(', ')}`);

// trips
const trips = new Map();
let tripHeader = null;
for await (const line of zip.lines('trips.txt')) {
  if (!tripHeader) { tripHeader = parseCsvLine(line.replace(/^﻿/, '')); continue; }
  if (!line) continue;
  const c = parseCsvLine(line);
  const t = Object.fromEntries(tripHeader.map((h, i) => [h, c[i] ?? '']));
  if (routeIds.has(t.route_id)) trips.set(t.trip_id, t);
}
console.log(`Metro trips: ${trips.size}`);

// stop_times (streamed: the full table is several hundred MB)
const seqs = new Map(); // trip_id -> [[seq, stop_id, row]]
let stHeader = null, idx = null, stRows = 0;
for await (const line of zip.lines('stop_times.txt')) {
  if (!stHeader) { stHeader = parseCsvLine(line.replace(/^﻿/, '')); idx = Object.fromEntries(stHeader.map((h, i) => [h, i])); continue; }
  if (!line) continue;
  stRows++;
  // Cheap prefilter on the trip id before a full parse.
  const comma = line.indexOf(',');
  const firstField = line.slice(0, comma).replace(/^"|"$/g, '');
  const c = idx.trip_id === 0 ? (trips.has(firstField) ? parseCsvLine(line) : null) : parseCsvLine(line);
  if (!c) continue;
  const tripId = c[idx.trip_id];
  if (!trips.has(tripId)) continue;
  if (!seqs.has(tripId)) seqs.set(tripId, []);
  seqs.get(tripId).push([Number(c[idx.stop_sequence]), c[idx.stop_id], c]);
}
console.log(`stop_times rows scanned: ${stRows.toLocaleString('en-GB')}; metro trips with stop times: ${seqs.size}`);

// service days per service_id (calendar_dates and/or calendar)
const serviceDays = new Map();
if (zip.has('calendar_dates.txt')) {
  for (const r of tableFromText(zip.readText('calendar_dates.txt'))) {
    if (r.exception_type !== '1') continue;
    if (!serviceDays.has(r.service_id)) serviceDays.set(r.service_id, new Set());
    serviceDays.get(r.service_id).add(r.date);
  }
}

// distinct stop patterns per route and direction
const patterns = new Map();
for (const [tripId, rows] of seqs) {
  rows.sort((a, b) => a[0] - b[0]);
  const t = trips.get(tripId);
  const stopIds = rows.map((r) => r[1]);
  const key = `${t.route_id}|${t.direction_id}|${stopIds.join('>')}`;
  if (!patterns.has(key)) patterns.set(key, { routeId: t.route_id, route: routeById.get(t.route_id).route_short_name, directionId: t.direction_id, stopIds, trips: 0, headsigns: new Set(), serviceIds: new Set(), exampleTripId: tripId, passenger: stopIds.map(() => false) });
  const p = patterns.get(key);
  p.trips++;
  // GTFS pickup_type / drop_off_type 1 = no boarding / no alighting. A stop
  // where neither is ever allowed (in any trip of the pattern) is passed
  // through without serving passengers (e.g. the never-opened Kymlinge).
  rows.forEach((r, i) => { if (r[2][idx.pickup_type] !== '1' || r[2][idx.drop_off_type] !== '1') p.passenger[i] = true; });
  if (t.trip_headsign) p.headsigns.add(t.trip_headsign);
  p.serviceIds.add(t.service_id);
}
const patternList = [...patterns.values()].map((p, i) => {
  const days = new Set();
  p.serviceIds.forEach((s) => (serviceDays.get(s) || []).forEach((d) => days.add(d)));
  const sortedDays = [...days].sort();
  return {
    id: `P${String(i + 1).padStart(3, '0')}`, route: p.route, routeId: p.routeId, directionId: p.directionId,
    trips: p.trips, serviceDays: days.size, firstDay: sortedDays[0] || null, lastDay: sortedDays[sortedDays.length - 1] || null,
    headsigns: [...p.headsigns].sort(), exampleTripId: p.exampleTripId, stopIds: p.stopIds, passenger: p.passenger
  };
}).sort((a, b) => a.route.localeCompare(b.route) || a.directionId.localeCompare(b.directionId) || b.trips - a.trips);
console.log(`Distinct stop patterns: ${patternList.length}`);

// stops: used platforms, their parent stations and every child of those parents
const stopsAll = tableFromText(zip.readText('stops.txt'));
const used = new Set(patternList.flatMap((p) => p.stopIds));
const parents = new Set(stopsAll.filter((s) => used.has(s.stop_id) && s.parent_station).map((s) => s.parent_station));
const keepStops = stopsAll.filter((s) => used.has(s.stop_id) || parents.has(s.stop_id) || parents.has(s.parent_station));
const missingStops = [...used].filter((id) => !stopsAll.some((s) => s.stop_id === id));
if (missingStops.length) fail(`stop_times reference ${missingStops.length} stop id(s) not in stops.txt: ${missingStops.slice(0, 5).join(', ')}`);

// Write the verbatim subset (columns as in the feed).
const cols = (rows) => Object.keys(rows[0] || {});
const write = (name, rows) => fs.writeFileSync(path.join(paths.gtfsMetro, name), toCsv(rows, cols(rows)));
write('routes.txt', metroRoutes);
write('stops.txt', keepStops);
const repTrips = patternList.map((p) => trips.get(p.exampleTripId));
write('trips.txt', repTrips);
const stRowsOut = patternList.flatMap((p) => seqs.get(p.exampleTripId).map((r) => Object.fromEntries(stHeader.map((h, i) => [h, r[2][i] ?? '']))));
write('stop_times.txt', stRowsOut);
for (const f of ['agency.txt', 'feed_info.txt']) if (zip.has(f)) fs.writeFileSync(path.join(paths.gtfsMetro, f), zip.readText(f));
writeJson(path.join(paths.gtfsMetro, 'patterns.json'), {
  note: 'Distinct stop sequences of all metro trips in the feed (one row per route, direction and exact sequence), with how many trips and service days use each. passenger[i] is true when any trip of the pattern allows boarding or alighting at stopIds[i] (GTFS pickup_type/drop_off_type not both 1). trips.txt / stop_times.txt in this folder hold one verbatim example trip per pattern.',
  patterns: patternList
});

const feedInfo = zip.has('feed_info.txt') ? tableFromText(zip.readText('feed_info.txt'))[0] || null : null;
const manifest = {
  source: 'SL static GTFS (GTFS Regional, operator "sl") published by Samtrafiken via Trafiklab',
  url: `${GTFS_URL}?key=REDACTED`,
  documentation: 'https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/',
  overview: 'https://www.trafiklab.se/api/netex-datasets/overview/',
  licence: LICENCE,
  retrievedAt: dl.retrievedAt,
  lastCheckedAt: dl.notModifiedCheckedAt || dl.retrievedAt,
  http: dl.http,
  archive: { file: rel(paths.gtfsZip), bytes: zipBuf.length, sha256, entries: zip.names.map((n) => ({ name: n, bytes: zip.size(n) })), committed: false },
  feedInfo,
  metroSubset: {
    folder: rel(paths.gtfsMetro),
    routeTypes: [...metroTypes],
    routes: metroRoutes.map((r) => ({ routeId: r.route_id, shortName: r.route_short_name, longName: r.route_long_name, type: r.route_type, colour: r.route_color || null })),
    trips: trips.size, patterns: patternList.length, stops: keepStops.length,
    note: 'Verbatim rows from the archive: all metro routes, the stops they use with their parent stations and sibling stops, and one example trip (with its stop_times) per distinct stop pattern.'
  },
  ignoredMetroRoutes: unknownMetro.map((r) => r.route_short_name || r.route_id)
};
writeJson(paths.topologyManifest, manifest);
console.log(`Wrote ${rel(paths.gtfsMetro)}/ and ${rel(paths.topologyManifest)} (archive sha256 ${sha256.slice(0, 12)}…)`);

// ------------------------------------------------- OpenStreetMap reference
async function fetchOsm() {
  const query = `[out:json][timeout:90];
area["name"="Stockholms län"]["admin_level"="4"]->.a;
(
  nwr["railway"="station"]["station"="subway"](area.a);
  nwr["public_transport"="station"]["subway"="yes"](area.a);
);
out center tags;`;
  const url = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter');
  const json = await fetchJsonWithRetry(url, {
    method: 'POST', headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`, retries: 3, timeoutMs: 120000
  });
  const elements = (json.elements || []).map((e) => ({
    osm: `${e.type}/${e.id}`, name: e.tags?.name || null, lon: e.lon ?? e.center?.lon, lat: e.lat ?? e.center?.lat,
    tags: Object.fromEntries(Object.entries(e.tags || {}).filter(([k]) => /^(name|railway|station|public_transport|subway|network|operator|ref|line|colour|wikidata|disused|construction|proposed)/.test(k)))
  }));
  writeJson(paths.osmStations, { osm3sTimestamp: json.osm3s?.timestamp_osm_base || null, elements });
  writeJson(paths.osmManifest, {
    source: 'OpenStreetMap via the Overpass API (the same data railsmaps.com uses for its Stockholm metro station map)',
    url, query, retrievedAt: new Date().toISOString(), dataTimestamp: json.osm3s?.timestamp_osm_base || null,
    licence: { name: 'Open Database License (ODbL) 1.0', url: 'https://www.openstreetmap.org/copyright', attribution: '© OpenStreetMap contributors' },
    elements: elements.length, use: 'Reference only: cross-check of station names and positions (never topology).'
  });
  console.log(`OSM reference: ${elements.length} station element(s) -> ${rel(paths.osmStations)}`);
}
if (args['skip-osm']) console.log('OSM reference: skipped (--skip-osm).');
else if (fs.existsSync(paths.osmStations) && !args.refresh) console.log(`OSM reference: using cached ${rel(paths.osmStations)}.`);
else {
  try { await fetchOsm(); } catch (err) {
    console.warn(`warning: OSM reference not fetched (${err.message.slice(0, 160)}). Station cross-check will be reported as unavailable.`);
  }
}
