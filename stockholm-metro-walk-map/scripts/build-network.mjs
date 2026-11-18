#!/usr/bin/env node
// Step 3: group operator stop records into physical stations and build the
// line graph from the operator's stop sequences.
//
// Inputs : data/stations.clean.json, data/raw/gtfs-sl/metro/patterns.json,
//          data/station-aliases.json, data/topology-overrides.json
// Outputs: data/stations.json        physical stations
//          data/network-edges.json   adjacent station pairs per line/route + graph stats
//          data/topology.geojson     one LineString per (edge, line) for GIS use
//          data/join-report.json     how every record was matched or why not
//          public/data/network.js    compact browser bundle
//
// Station identity. A GTFS platform joins a station only by
//   (a) its parent_station ID (operator ID match), or
//   (b) a documented alias (data/station-aliases.json), or
//   (c) an equal normalised name (only for platforms without a parent, and
//       between parent stations that the operator split into several records),
// and in every case the two points must be within MAX_JOIN_M. Similar names
// alone never merge records. The OpenStreetMap reference is joined to the
// stations by the same rules but never creates or merges stations.
//
// Topology. Edges come ONLY from consecutive stops of the GTFS trip patterns
// (every distinct sequence, both directions). Coordinates are never used to
// order or connect stations; they are only used to confirm record joins and
// to flag implausibly long edges in validation.
import path from 'node:path';
import { paths, readJson, writeJson, writeBrowserData, rel, MetroConfig, MetroGeometry, fail } from './lib/common.mjs';
import { nameKey } from './lib/names.mjs';

let clean, aliasCfg, overrides, patternsDoc, manifest;
try {
  clean = readJson(paths.stationsClean);
  aliasCfg = readJson(paths.aliases);
  overrides = readJson(paths.overrides);
  patternsDoc = readJson(path.join(paths.gtfsMetro, 'patterns.json'));
  manifest = readJson(paths.topologyManifest, null);
} catch (err) {
  fail(err.message, 'Run "npm run fetch-topology && npm run prepare-stations" first.');
}
const MAX_JOIN_M = aliasCfg.maxJoinDistanceM || 500;
const dist = (a, b) => MetroGeometry.haversineM([a.lon, a.lat], [b.lon, b.lat]);
const lineOrder = (ids) => [...new Set(ids)].filter((l) => MetroConfig.LINE_BY_ID[l]).sort((p, q) => MetroConfig.LINE_BY_ID[p].order - MetroConfig.LINE_BY_ID[q].order);

// ------------------------------------------------------------ union-find
const parentOf = new Map();
const find = (x) => { while (parentOf.get(x) !== x) { parentOf.set(x, parentOf.get(parentOf.get(x))); x = parentOf.get(x); } return x; };
const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parentOf.set(ra, rb); };
const recs = new Map(); // key -> record
clean.parents.forEach((p) => { const k = `s:${p.stopId}`; recs.set(k, { ...p, kind: 'parent' }); parentOf.set(k, k); });
clean.platforms.forEach((p) => { const k = `p:${p.stopId}`; recs.set(k, { ...p, kind: 'platform' }); parentOf.set(k, k); });

const links = [];
const rejectedLinks = [];
function link(a, b, method) {
  const A = recs.get(a), B = recs.get(b);
  const d = Math.round(dist(A, B));
  if (d > MAX_JOIN_M) { rejectedLinks.push({ a: A.stopId, aName: A.name, b: B.stopId, bName: B.name, method, distanceM: d, reason: `farther than ${MAX_JOIN_M} m` }); return; }
  links.push({ a: A.stopId, aName: A.name, b: B.stopId, bName: B.name, method, distanceM: d });
  unite(a, b);
}
// (a) platform -> parent by operator ID
for (const p of clean.platforms) if (p.parentStation && recs.has(`s:${p.parentStation}`)) link(`p:${p.stopId}`, `s:${p.parentStation}`, 'parent-station-id');
// (b) documented aliases (stop id pairs)
const aliasesApplied = [];
for (const a of aliasCfg.aliases || []) {
  const ka = recs.has(`s:${a.stopId}`) ? `s:${a.stopId}` : `p:${a.stopId}`;
  const kb = recs.has(`s:${a.sameAs}`) ? `s:${a.sameAs}` : `p:${a.sameAs}`;
  if (!recs.has(ka) || !recs.has(kb)) continue;
  link(ka, kb, 'documented-alias');
  aliasesApplied.push(a);
}
const unusedAliases = (aliasCfg.aliases || []).filter((a) => !aliasesApplied.includes(a));
// (c) equal normalised names: parent stations split by the operator, and platforms without a parent
const parentList = clean.parents;
for (let i = 0; i < parentList.length; i++) {
  for (let j = i + 1; j < parentList.length; j++) {
    if (nameKey(parentList[i].name) === nameKey(parentList[j].name)) link(`s:${parentList[i].stopId}`, `s:${parentList[j].stopId}`, 'equal-name');
  }
}
for (const p of clean.platforms.filter((x) => !x.parentStation)) {
  const cands = parentList.filter((s) => nameKey(s.name) === nameKey(p.name));
  cands.forEach((s) => link(`p:${p.stopId}`, `s:${s.stopId}`, 'equal-name'));
}

// --------------------------------------------------------------- stations
const groups = new Map();
for (const k of recs.keys()) {
  const r = find(k);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(recs.get(k));
}
const stations = [];
const stopToStation = new Map();
const nameConflicts = [];
const separatedSameName = [];
for (const members of groups.values()) {
  const ps = members.filter((m) => m.kind === 'parent');
  const pl = members.filter((m) => m.kind === 'platform');
  if (!pl.length) continue; // a parent without metro platforms (should not happen)
  const names = [...new Set(members.map((m) => nameKey(m.name)))];
  if (names.length > 1 && !members.some((m) => (aliasCfg.aliases || []).some((a) => a.stopId === m.stopId || a.sameAs === m.stopId))) {
    nameConflicts.push({ records: members.map((m) => `${m.kind} ${m.stopId} ${m.name}`) });
  }
  const anchor = ps.slice().sort((a, b) => a.stopId.localeCompare(b.stopId))[0] || pl.slice().sort((a, b) => a.stopId.localeCompare(b.stopId))[0];
  // Coordinate: the operator's parent-station coordinate (mean of them when the
  // operator split one station into several parent records); a centroid, not an entrance.
  const coordSrc = ps.length ? ps : pl;
  const lon = coordSrc.reduce((s, m) => s + m.lon, 0) / coordSrc.length;
  const lat = coordSrc.reduce((s, m) => s + m.lat, 0) / coordSrc.length;
  const routes = [...new Set(pl.flatMap((p) => p.routes))].sort((a, b) => Number(a) - Number(b));
  const lines = lineOrder(pl.flatMap((p) => p.lines));
  const st = {
    id: `SL${anchor.stopId}`,
    name: (ps[0] || anchor).name,
    lon, lat,
    coordinateSource: ps.length > 1 ? `mean of ${ps.length} GTFS parent stations` : ps.length ? 'GTFS parent station' : 'GTFS platform (no parent station)',
    parentStopIds: ps.map((m) => m.stopId).sort(),
    platformStopIds: pl.map((m) => m.stopId).sort(),
    routes, lines,
    interchange: lines.length > 1,
    joinMethods: [...new Set(links.filter((l) => members.some((m) => m.stopId === l.a) || members.some((m) => m.stopId === l.b)).map((l) => l.method))].sort(),
    note: (aliasCfg.notes || {})[anchor.stopId] || null
  };
  pl.forEach((p) => stopToStation.set(p.stopId, st.id));
  stations.push(st);
}
// Same-name stations that stayed separate because they are too far apart.
const byKey = new Map();
stations.forEach((s) => { const k = nameKey(s.name); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); });
for (const [, g] of byKey) if (g.length > 1) separatedSameName.push(g.map((s) => ({ id: s.id, name: s.name, lon: s.lon, lat: s.lat })));
stations.sort((p, q) => p.name.localeCompare(q.name, 'sv') || p.id.localeCompare(q.id));
const stationById = new Map(stations.map((s) => [s.id, s]));

// ------------------------------------------------------- OSM cross-check
let osmCheck = { status: 'not-available', note: 'data/raw/osm/metro-stations.json missing (Overpass unreachable or skipped).' };
if (clean.osm) {
  const inService = clean.osm.records.filter((r) => r.status === 'in-service');
  const matches = [];
  const unmatchedOsm = [];
  for (const o of inService) {
    const alias = (aliasCfg.osmAliases || []).find((a) => a.osmName === o.name);
    const key = nameKey(alias ? alias.stationName : o.name);
    const cand = stations.filter((s) => nameKey(s.name) === key).map((s) => ({ s, d: dist(s, o) })).sort((a, b) => a.d - b.d)[0];
    if (cand && cand.d <= MAX_JOIN_M) matches.push({ osm: o.osm, osmName: o.name, stationId: cand.s.id, name: cand.s.name, distanceM: Math.round(cand.d), method: alias ? 'documented-alias' : 'equal-name' });
    else unmatchedOsm.push({ osm: o.osm, name: o.name, lon: o.lon, lat: o.lat, nearestSameName: cand ? { id: cand.s.id, distanceM: Math.round(cand.d) } : null });
  }
  const matchedIds = new Set(matches.map((m) => m.stationId));
  const stationsWithoutOsm = stations.filter((s) => !matchedIds.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
  const ds = matches.map((m) => m.distanceM).sort((a, b) => a - b);
  osmCheck = {
    status: 'checked', dataTimestamp: clean.osm.dataTimestamp, osmInService: inService.length,
    matched: matches.length, stationsMatched: matchedIds.size, unmatchedOsm, stationsWithoutOsm,
    distanceM: ds.length ? { median: ds[Math.floor(ds.length / 2)], max: ds[ds.length - 1] } : null,
    notInService: clean.osm.records.filter((r) => r.status !== 'in-service').map((r) => ({ osm: r.osm, name: r.name })),
    matches
  };
}

// ------------------------------------------------------------------ edges
const removeEdges = overrides.removeEdges || [];
const addEdges = overrides.addEdges || [];
const overridesApplied = [];
const edgeMap = new Map();
function addEdge(a, b, line, route, info) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const key = `${x}|${y}`;
  if (!edgeMap.has(key)) edgeMap.set(key, { a: x, b: y, byLine: new Map() });
  const e = edgeMap.get(key);
  if (!e.byLine.has(line)) e.byLine.set(line, { routes: new Set(), directions: new Set(), patterns: new Set(), trips: 0 });
  const L = e.byLine.get(line);
  L.routes.add(route); if (info.directionId !== undefined) L.directions.add(info.directionId); if (info.pattern) L.patterns.add(info.pattern); L.trips += info.trips || 0;
}
const unmappedStops = new Set();
for (const p of patternsDoc.patterns) {
  const line = MetroConfig.LINE_ID_BY_ROUTE[p.route];
  if (!line) continue;
  // Consecutive PASSENGER calls: pass-through stops (see prepare-stations) are skipped.
  const ids = p.stopIds.filter((s, i) => p.passenger[i]).map((s) => { const id = stopToStation.get(s); if (!id) unmappedStops.add(s); return id; });
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = ids[i], b = ids[i + 1];
    if (!a || !b || a === b) continue;
    const ov = removeEdges.find((r) => r.line === line && ((r.a === stationById.get(a).name && r.b === stationById.get(b).name) || (r.b === stationById.get(a).name && r.a === stationById.get(b).name)));
    if (ov) { overridesApplied.push({ type: 'removeEdge', ...ov, pattern: p.id }); continue; }
    addEdge(a, b, line, p.route, { directionId: p.directionId, pattern: p.id, trips: p.trips });
  }
}
for (const ov of addEdges) {
  const A = stations.find((s) => s.name === ov.a), B = stations.find((s) => s.name === ov.b);
  if (A && B) { addEdge(A.id, B.id, ov.line, ov.route, { pattern: 'override' }); overridesApplied.push({ type: 'addEdge', ...ov }); }
}
const unusedOverrides = [...removeEdges.filter((r) => !overridesApplied.some((a) => a.type === 'removeEdge' && a.a === r.a && a.b === r.b && a.line === r.line)), ...addEdges.filter((r) => !overridesApplied.some((a) => a.type === 'addEdge' && a.a === r.a && a.b === r.b))];
for (const o of [...removeEdges, ...addEdges]) if (!o.reason) fail(`topology override without a reason: ${JSON.stringify(o)}`);

const edges = [...edgeMap.values()].map((e) => {
  const lines = [...e.byLine].map(([line, v]) => ({ line, routes: [...v.routes].sort((a, b) => Number(a) - Number(b)), directions: [...v.directions].sort(), patterns: [...v.patterns].sort(), trips: v.trips }))
    .sort((p, q) => MetroConfig.LINE_BY_ID[p.line].order - MetroConfig.LINE_BY_ID[q.line].order);
  const A = stationById.get(e.a), B = stationById.get(e.b);
  return { a: e.a, b: e.b, aName: A.name, bName: B.name, lines, lengthM: Math.round(dist(A, B)) };
}).sort((p, q) => (p.a + p.b).localeCompare(q.a + q.b));

// ----------------------------------------------------- per-line graph stats
function graphStats(filter) {
  const adj = new Map();
  for (const e of edges) {
    if (!filter(e)) continue;
    if (!adj.has(e.a)) adj.set(e.a, new Set());
    if (!adj.has(e.b)) adj.set(e.b, new Set());
    adj.get(e.a).add(e.b); adj.get(e.b).add(e.a);
  }
  const seen = new Set();
  const components = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = []; const q = [start]; seen.add(start);
    while (q.length) { const n = q.pop(); comp.push(n); for (const m of adj.get(n)) if (!seen.has(m)) { seen.add(m); q.push(m); } }
    components.push(comp);
  }
  const name = (id) => stationById.get(id)?.name || id;
  const edgeCount = edges.filter(filter).length;
  return {
    stationCount: adj.size,
    edgeCount,
    cycles: edgeCount - (adj.size - components.length), // 0 for a tree (every SL metro line is a tree)
    termini: [...adj].filter(([, n]) => n.size === 1).map(([id]) => name(id)).sort((a, b) => a.localeCompare(b, 'sv')),
    junctions: [...adj].filter(([, n]) => n.size >= 3).map(([id, n]) => ({ name: name(id), degree: n.size })).sort((a, b) => a.name.localeCompare(b.name, 'sv')),
    components: components.map((c) => ({ size: c.length, stations: c.map(name).sort((a, b) => a.localeCompare(b, 'sv')) }))
  };
}
const lineStats = {};
for (const l of MetroConfig.LINES) lineStats[l.id] = { ...graphStats((e) => e.lines.some((x) => x.line === l.id)), routes: {} };
for (const l of MetroConfig.LINES) for (const r of l.routes) lineStats[l.id].routes[r] = graphStats((e) => e.lines.some((x) => x.line === l.id && x.routes.includes(r)));

// ----------------------------------------------------------------- outputs
const generatedAt = new Date().toISOString();
const meta = {
  generatedAt,
  topology: {
    source: 'SL static GTFS (GTFS Regional) via Trafiklab / Samtrafiken: stop sequences of all metro trips',
    url: manifest?.url || null,
    retrievedAt: manifest?.retrievedAt || null,
    feedVersion: manifest?.feedInfo?.feed_version || null,
    feedValidity: manifest?.feedInfo ? [manifest.feedInfo.feed_start_date, manifest.feedInfo.feed_end_date] : null,
    licence: manifest?.licence || { name: 'CC0 1.0' },
    patterns: patternsDoc.patterns.length
  },
  colours: readJson(paths.colourManifest, null) ? { source: 'sl.se design-system stylesheet (--color-metro-*)', retrievedAt: readJson(paths.colourManifest).retrievedAt } : null,
  overridesApplied: overridesApplied.length
};
writeJson(paths.stations, { meta, stations });
writeJson(paths.edges, { meta, edges, lines: lineStats });
writeJson(paths.joinReport, {
  generatedAt, maxJoinDistanceM: MAX_JOIN_M,
  counts: { platforms: clean.platforms.length, parents: clean.parents.length, stations: stations.length, links: links.length },
  links, rejectedLinks, nameConflicts, separatedSameName,
  unmappedPatternStops: [...unmappedStops],
  orphanPlatforms: clean.orphanPlatforms,
  nonPassengerStops: clean.nonPassengerStops,
  aliasesApplied, unusedAliases,
  overridesApplied, unusedOverrides,
  osmCrossCheck: osmCheck,
  prepareIssues: clean.issues
});
writeJson(paths.topology, {
  type: 'FeatureCollection', metadata: meta,
  features: edges.flatMap((e) => {
    const A = stationById.get(e.a), B = stationById.get(e.b);
    return e.lines.map((l, i) => ({
      type: 'Feature',
      properties: { line: l.line, lineName: MetroConfig.LINE_BY_ID[l.line].name, colour: MetroConfig.LINE_BY_ID[l.line].colour, routes: l.routes.join(','), from: e.a, to: e.b, fromName: A.name, toName: B.name, sharedBy: e.lines.length, slot: i - (e.lines.length - 1) / 2, lengthM: e.lengthM },
      geometry: { type: 'LineString', coordinates: [[A.lon, A.lat], [B.lon, B.lat]] }
    }));
  })
});
const r6 = (v) => Math.round(v * 1e6) / 1e6;
writeBrowserData(paths.publicNetwork, 'METRO_NETWORK', {
  meta,
  lines: MetroConfig.LINES.map((l) => ({ id: l.id, stationIds: stations.filter((s) => s.lines.includes(l.id)).map((s) => s.id), termini: lineStats[l.id].termini })),
  stations: stations.map((s) => ({ id: s.id, name: s.name, lon: r6(s.lon), lat: r6(s.lat), lines: s.lines, routes: s.routes, parentStopIds: s.parentStopIds, platformCount: s.platformStopIds.length, coordinateSource: s.coordinateSource, note: s.note })),
  edges: edges.map((e) => ({ a: e.a, b: e.b, lines: e.lines.map((l) => l.line), routes: e.lines.map((l) => l.routes) }))
});

console.log(`Records: ${clean.platforms.length} platforms, ${clean.parents.length} parents -> ${stations.length} physical stations (${links.length} links, ${rejectedLinks.length} rejected, ${nameConflicts.length} name conflicts)`);
console.log(`Edges: ${edges.length} (${edges.filter((e) => e.lines.length > 1).length} shared by two lines); overrides applied ${overridesApplied.length}, unused ${unusedOverrides.length}`);
for (const l of MetroConfig.LINES) {
  const s = lineStats[l.id];
  console.log(`  ${l.name.padEnd(10)} ${String(s.stationCount).padStart(3)} stations, ${s.edgeCount} edges, ${s.components.length} component(s), ${s.cycles} cycle(s); termini: ${s.termini.join(', ')}; junctions: ${s.junctions.map((j) => j.name).join(', ')}`);
}
console.log(`OSM cross-check: ${osmCheck.status}${osmCheck.status === 'checked' ? ` — ${osmCheck.stationsMatched}/${stations.length} stations matched, ${osmCheck.unmatchedOsm.length} OSM record(s) unmatched` : ''}`);
console.log(`Wrote ${[paths.stations, paths.edges, paths.topology, paths.joinReport, paths.publicNetwork].map(rel).join(', ')}`);
