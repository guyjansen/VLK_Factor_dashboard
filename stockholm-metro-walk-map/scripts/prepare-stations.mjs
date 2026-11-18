#!/usr/bin/env node
// Step 2: read the station records from the operator's GTFS metro subset
// (data/raw/gtfs-sl/metro/) and the OpenStreetMap reference
// (data/raw/osm/metro-stations.json, optional) and write them, validated and
// normalised, to data/stations.clean.json.
//
// GTFS records
//   - platform stops (location_type 0/empty) that metro trips actually call at,
//     with the routes and colour lines serving them (from the stop patterns)
//   - their parent stations (location_type 1)
// OSM records: subway stations (railway=station + station=subway, or
//   public_transport=station + subway=yes) inside Stockholm county.
//
// Coordinates are WGS84 in both sources; no conversion is needed.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJson, rel, MetroConfig, fail } from './lib/common.mjs';
import { readTable } from './lib/gtfs.mjs';
import { nameKey } from './lib/names.mjs';

const dir = paths.gtfsMetro;
if (!fs.existsSync(path.join(dir, 'patterns.json'))) fail(`missing ${rel(dir)}/patterns.json`, 'Run "npm run fetch-topology" first.');
const stopsRows = readTable(path.join(dir, 'stops.txt'));
const routes = readTable(path.join(dir, 'routes.txt'));
const { patterns } = readJson(path.join(dir, 'patterns.json'));
const routeShort = new Map(routes.map((r) => [r.route_id, r.route_short_name]));

const issues = [];
const inBox = (lon, lat) => lon > 17.3 && lon < 18.9 && lat > 58.9 && lat < 59.9;
const byId = new Map();
for (const s of stopsRows) {
  const lon = Number(s.stop_lon), lat = Number(s.stop_lat);
  const rec = {
    stopId: s.stop_id, name: (s.stop_name || '').replace(/\s+/g, ' ').trim(), lon, lat,
    locationType: s.location_type || '0', parentStation: s.parent_station || null, platformCode: s.platform_code || null
  };
  if (!rec.name) issues.push({ type: 'empty-name', stopId: rec.stopId });
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inBox(lon, lat)) { issues.push({ type: 'bad-coordinate', stopId: rec.stopId, name: rec.name, lon: s.stop_lon, lat: s.stop_lat }); continue; }
  byId.set(rec.stopId, rec);
}

// Routes / lines that call at each platform (from the trip patterns).
const platformRoutes = new Map();
for (const p of patterns) {
  const route = p.route || routeShort.get(p.routeId);
  for (const id of p.stopIds) {
    if (!platformRoutes.has(id)) platformRoutes.set(id, new Set());
    platformRoutes.get(id).add(route);
  }
}
const lineOfRoute = (r) => MetroConfig.LINE_ID_BY_ROUTE[r];
const platforms = [...platformRoutes.keys()].map((id) => {
  const rec = byId.get(id);
  if (!rec) fail(`pattern stop ${id} has no usable stops.txt record`);
  const routesHere = [...platformRoutes.get(id)].sort();
  return { ...rec, routes: routesHere, lines: [...new Set(routesHere.map(lineOfRoute))].filter(Boolean) };
});
const parentIds = new Set(platforms.map((p) => p.parentStation).filter(Boolean));
const parents = [...parentIds].map((id) => {
  const rec = byId.get(id);
  if (!rec) { issues.push({ type: 'missing-parent-station', stopId: id }); return null; }
  if (rec.locationType !== '1') issues.push({ type: 'parent-not-location-type-1', stopId: id, name: rec.name, locationType: rec.locationType });
  return rec;
}).filter(Boolean);
const orphanPlatforms = platforms.filter((p) => !p.parentStation).map((p) => ({ stopId: p.stopId, name: p.name }));
const entrances = stopsRows.filter((s) => s.location_type === '2' && parentIds.has(s.parent_station)).length;

// OpenStreetMap reference (optional).
let osm = null;
if (fs.existsSync(paths.osmStations)) {
  const doc = readJson(paths.osmStations);
  const recs = [];
  for (const e of doc.elements) {
    if (!e.name || !Number.isFinite(e.lon) || !Number.isFinite(e.lat)) { issues.push({ type: 'osm-unusable', osm: e.osm, name: e.name }); continue; }
    // Disused / planned / under-construction stations are not part of today's network.
    if (Object.keys(e.tags || {}).some((k) => /^(disused|construction|proposed)/.test(k)) || /construction|proposed|disused/.test(e.tags?.railway || '')) { recs.push({ ...e, status: 'not-in-service' }); continue; }
    recs.push({ ...e, status: 'in-service' });
  }
  osm = { dataTimestamp: doc.osm3sTimestamp, records: recs };
}

// Name clashes within GTFS parents (same key, far apart) are reported: they
// must stay separate stations unless an alias says otherwise.
const keyGroups = new Map();
parents.forEach((p) => { const k = nameKey(p.name); if (!keyGroups.has(k)) keyGroups.set(k, []); keyGroups.get(k).push(p); });

writeJson(paths.stationsClean, {
  source: { gtfs: rel(paths.gtfsMetro), osm: osm ? rel(paths.osmStations) : null },
  coordinateSystem: 'WGS84 (EPSG:4326) in both sources; no conversion applied',
  preparedAt: new Date().toISOString(),
  counts: { platforms: platforms.length, parents: parents.length, orphanPlatforms: orphanPlatforms.length, entrancesInFeed: entrances, osm: osm ? osm.records.length : null },
  platforms, parents, orphanPlatforms,
  osm,
  sameNameParents: [...keyGroups.values()].filter((g) => g.length > 1).map((g) => g.map((p) => ({ stopId: p.stopId, name: p.name }))),
  issues
});
console.log(`GTFS: ${platforms.length} metro platform stop(s) in ${parents.length} parent station(s); ${orphanPlatforms.length} without parent; ${entrances} entrance record(s) in the feed.`);
console.log(`OSM reference: ${osm ? `${osm.records.filter((r) => r.status === 'in-service').length} in service, ${osm.records.filter((r) => r.status !== 'in-service').length} not in service` : 'not available'}`);
if (issues.length) console.log(`Issues: ${JSON.stringify(issues).slice(0, 500)}`);
console.log(`Wrote ${rel(paths.stationsClean)}`);
