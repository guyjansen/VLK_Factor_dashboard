#!/usr/bin/env node
// Step 3: join the authoritative TfL topology (Underground + Elizabeth line)
// to the supplied station table.
//
// Inputs : data/stations.clean.json, data/raw/tfl/<line>-<dir>.json,
//          data/station-aliases.json, data/topology-overrides.json
// Outputs: data/stations.json        canonical physical stations
//          data/network-edges.json   adjacent station pairs per line (+ per-line graph stats)
//          data/topology.geojson     one LineString per (edge, line) for GIS use
//          data/join-report.json     how every CSV record / TfL stop was matched
//          public/data/network.js    compact browser bundle
//
// Stations are physical stations: an interchange such as Liverpool Street
// (Underground + Elizabeth line, three TfL stop ids) is one station.
//
// Edges come ONLY from consecutive stops in TfL stopPointSequences (both
// directions). Branch sequences overlap at their junction station, so
// branches join without any inferred connections. Coordinates are never used
// to order or connect stations; they are used only to confirm name matches.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJson, writeBrowserData, rel, TubeConfig, TubeGeometry } from './lib/common.mjs';
import { nameKey, baseNameKey, stripTflSuffix } from './lib/names.mjs';

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

let clean, aliasCfg, overrides, manifest;
try {
  clean = readJson(paths.stationsClean);
  aliasCfg = readJson(paths.aliases);
  overrides = readJson(paths.overrides);
  manifest = readJson(paths.topologyManifest, null);
} catch (err) {
  fail(`${err.message}\nRun "npm run prepare-stations" (and "npm run fetch-topology" if data/raw/tfl is empty).`);
}
const MAX_JOIN_M = aliasCfg.maxJoinDistanceM || 500;

// ---------------------------------------------------------------- topology
const stops = new Map(); // stopId -> {id, name, lat, lon, hubId, lines:Set}
const sequences = []; // {line, dir, branchId, stopIds}
const overridesApplied = [];
const rawSummary = [];

for (const line of TubeConfig.LINES) {
  const tflMode = TubeConfig.MODES.find((m) => m.id === line.mode).tflMode;
  for (const dir of ['outbound', 'inbound']) {
    const file = path.join(paths.rawTfl, `${line.id}-${dir}.json`);
    if (!fs.existsSync(file)) fail(`missing topology file ${rel(file)}. Run "npm run fetch-topology".`);
    const json = readJson(file);
    if (json.lineId !== line.id) fail(`${rel(file)} contains line "${json.lineId}", expected "${line.id}"`);
    rawSummary.push({ line: line.id, direction: dir, sequences: json.stopPointSequences.length, orderedRoutes: (json.orderedLineRoutes || []).map((r) => r.name.replace(/\s*&harr;\s*/g, ' ↔ ')) });
    for (const seq of json.stopPointSequences) {
      let pts = seq.stopPoint.filter((p) => (p.modes || []).includes(tflMode) || (tflMode === 'tube' && p.stopType === 'NaptanMetroStation'));
      for (const ov of overrides.removeStops || []) {
        if (ov.line !== line.id) continue;
        const before = pts.length;
        pts = pts.filter((p) => p.id !== ov.stopId);
        if (pts.length !== before) overridesApplied.push({ ...ov, direction: dir, branchId: seq.branchId });
      }
      for (const p of pts) {
        if (!stops.has(p.id)) stops.set(p.id, { id: p.id, name: stripTflSuffix(p.name), rawName: p.name, lat: p.lat, lon: p.lon, hubId: p.topMostParentId || null, lines: new Set() });
        stops.get(p.id).lines.add(line.id);
      }
      sequences.push({ line: line.id, dir, branchId: seq.branchId, stopIds: pts.map((p) => p.id) });
    }
  }
}
const unusedOverrides = (overrides.removeStops || []).filter((ov) => !overridesApplied.some((a) => a.line === ov.line && a.stopId === ov.stopId));

// -------------------------------------------------------------- CSV join
// One physical station can have several TfL stop records: for example
// Paddington has the Underground stop (940GZZLUPAC), the Elizabeth line core
// stop (910GPADTLL) and the National Rail terminus stop used by some
// Elizabeth line trains (910GPADTON). Records and stops are linked when
//   - the record's ATCOCODE is that stop's id, or
//   - a documented alias says so, or
//   - the normalised names are equal, or (only if unambiguous) equal after
//     dropping parenthetical qualifiers ("Stratford (London)" -> "Stratford"),
// AND the two points are within MAX_JOIN_M metres. Linked records and stops
// are then grouped (union-find); each group is one physical station.
const stopList = [...stops.values()];
const records = clean.records;
const dist = (r, s) => TubeGeometry.haversineM([r.lon, r.lat], [s.lon, s.lat]);
const links = []; // {record, stop, method, distanceM}
const linked = new Set();
function link(r, s, method) {
  const key = `${r.objectId}|${s.id}`;
  if (linked.has(key)) return;
  linked.add(key);
  links.push({ record: r, stop: s, method, distanceM: Math.round(dist(r, s)) });
}
for (const r of records) {
  const near = stopList.filter((s) => dist(r, s) <= MAX_JOIN_M);
  if (r.atcoCode && stops.has(r.atcoCode) && dist(r, stops.get(r.atcoCode)) <= MAX_JOIN_M) link(r, stops.get(r.atcoCode), 'atco-code');
  for (const a of (aliasCfg.aliases || []).filter((x) => x.csvName === r.name)) {
    if (stops.has(a.stopId) && dist(r, stops.get(a.stopId)) <= MAX_JOIN_M) link(r, stops.get(a.stopId), 'alias');
  }
  const exact = near.filter((s) => nameKey(s.name) === nameKey(r.name));
  exact.forEach((s) => link(r, s, 'exact-name'));
  if (!exact.length) {
    const base = near.filter((s) => baseNameKey(s.name) === baseNameKey(r.name));
    if (base.length === 1) link(r, base[0], 'base-name');
  }
}
// Stop-centric pass for stops whose TfL name carries a qualifier the record
// lacks, e.g. "Stratford (London) Rail Station" vs record "Stratford".
for (const s of stopList) {
  if (links.some((l) => l.stop === s)) continue;
  const near = records.filter((r) => dist(r, s) <= MAX_JOIN_M);
  const exact = near.filter((r) => nameKey(r.name) === nameKey(s.name)).sort((p, q) => dist(p, s) - dist(q, s));
  if (exact.length) { link(exact[0], s, 'exact-name'); continue; }
  const base = near.filter((r) => baseNameKey(r.name) === baseNameKey(s.name));
  const distinct = new Set(base.map((r) => nameKey(r.name)));
  if (base.length && distinct.size === 1) link(base.sort((p, q) => dist(p, s) - dist(q, s))[0], s, 'base-name');
}

// Union-find over records ("r:<objectId>") and stops ("s:<stopId>").
const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
records.forEach((r) => parent.set(`r:${r.objectId}`, `r:${r.objectId}`));
stopList.forEach((s) => parent.set(`s:${s.id}`, `s:${s.id}`));
links.forEach((l) => union(`r:${l.record.objectId}`, `s:${l.stop.id}`));
const groups = new Map();
for (const key of parent.keys()) {
  const root = find(key);
  if (!groups.has(root)) groups.set(root, { records: [], stops: [] });
  if (key.startsWith('r:')) groups.get(root).records.push(records.find((r) => `r:${r.objectId}` === key));
  else groups.get(root).stops.push(stops.get(key.slice(2)));
}

const lineOrder = (ids) => [...ids].sort((p, q) => TubeConfig.LINE_BY_ID[p].order - TubeConfig.LINE_BY_ID[q].order);
const modeOf = (lineIds) => [...new Set(lineIds.map((l) => TubeConfig.LINE_BY_ID[l].mode))];
// Prefer the Underground NaPTAN id as the station id (stable across runs and
// keeps existing isochrone caches valid); Elizabeth-only stations use theirs.
const preferredStop = (ss) => ss.slice().sort((p, q) => (q.id.startsWith('940G') - p.id.startsWith('940G')) || p.id.localeCompare(q.id))[0];

const stations = [];
const stopToStation = new Map();
const duplicateResolutions = [];
const lineMismatches = [];
const groupNameConflicts = [];
const unmatchedCsv = [];
const topologyStopsWithoutCsv = [];
for (const g of groups.values()) {
  if (!g.stops.length) {
    const r = g.records[0];
    unmatchedCsv.push({ objectId: r.objectId, name: r.name, lon: r.lon, lat: r.lat, csvLines: r.lines });
    stations.push({
      id: `CSV-${r.objectId}`, hubId: null, stopIds: [], name: r.name, tflName: null, lon: r.lon, lat: r.lat, tflLon: null, tflLat: null,
      coordinateSource: 'csv', objectId: r.objectId, joinMethod: 'none', joinDistanceM: null,
      lines: lineOrder(r.lines), modes: modeOf(r.lines), csvLines: lineOrder(r.lines), interchange: r.lines.length > 1,
      duplicateRecords: [], note: 'No matching TfL topology stop: drawn as a station but not connected to any line.', unmatched: true
    });
    continue;
  }
  const main = preferredStop(g.stops);
  const recs = g.records.slice().sort((p, q) => dist(p, main) - dist(q, main));
  const canonical = recs[0] || null;
  if (!canonical) topologyStopsWithoutCsv.push(...g.stops.map((s) => ({ stopId: s.id, name: s.name, lines: lineOrder(s.lines) })));
  if (new Set(recs.map((r) => nameKey(r.name))).size > 1) groupNameConflicts.push({ stops: g.stops.map((s) => s.id), records: recs.map((r) => `${r.objectId} ${r.name}`) });
  const topoLines = lineOrder(new Set(g.stops.flatMap((s) => [...s.lines])));
  const how = canonical ? links.filter((l) => l.record === canonical) : [];
  const st = {
    id: main.id,
    hubId: main.hubId,
    stopIds: g.stops.map((s) => s.id).sort(),
    name: canonical ? canonical.name : main.name,
    tflName: main.name,
    lon: canonical ? canonical.lon : main.lon,
    lat: canonical ? canonical.lat : main.lat,
    tflLon: main.lon,
    tflLat: main.lat,
    coordinateSource: canonical ? 'station-table' : 'tfl',
    objectId: canonical ? canonical.objectId : null,
    atcoCode: canonical ? canonical.atcoCode : null,
    network: canonical ? canonical.network : null,
    joinMethod: how.map((l) => l.method).filter((v, i, a) => a.indexOf(v) === i).join('+') || 'none',
    joinDistanceM: how.length ? Math.max(...how.map((l) => l.distanceM)) : null,
    lines: topoLines,
    modes: modeOf(topoLines),
    csvLines: canonical ? lineOrder(canonical.lines) : [],
    interchange: topoLines.length > 1,
    duplicateRecords: recs.slice(1).map((r) => ({ objectId: r.objectId, name: r.name, lon: r.lon, lat: r.lat, distanceFromCanonicalM: Math.round(TubeGeometry.haversineM([r.lon, r.lat], [canonical.lon, canonical.lat])) })),
    note: g.stops.map((s) => aliasCfg.notes?.[s.id]).filter(Boolean).join(' ') || null
  };
  g.stops.forEach((s) => stopToStation.set(s.id, st.id));
  if (st.duplicateRecords.length) duplicateResolutions.push({ stationId: st.id, name: st.name, canonicalObjectId: st.objectId, duplicates: st.duplicateRecords });
  if (canonical) {
    const missingInCsv = topoLines.filter((l) => !st.csvLines.includes(l));
    const extraInCsv = st.csvLines.filter((l) => !topoLines.includes(l));
    if (missingInCsv.length || extraInCsv.length) {
      lineMismatches.push({ stationId: st.id, name: st.name, objectId: st.objectId, topologyLines: topoLines, csvLines: st.csvLines, missingInCsv, extraInCsv });
    }
  }
  stations.push(st);
}
stations.sort((p, q) => p.name.localeCompare(q.name, 'en-GB') || p.id.localeCompare(q.id));
const stationById = new Map(stations.map((s) => [s.id, s]));

// -------------------------------------------------------------- edges
// Consecutive stops in each TfL sequence, mapped to physical stations.
const edgeMap = new Map();
for (const seq of sequences) {
  for (let i = 0; i + 1 < seq.stopIds.length; i++) {
    const a = stopToStation.get(seq.stopIds[i]), b = stopToStation.get(seq.stopIds[i + 1]);
    if (!a || !b || a === b) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { a: x, b: y, byLine: new Map() });
    const e = edgeMap.get(key);
    if (!e.byLine.has(seq.line)) e.byLine.set(seq.line, { directions: new Set(), branchIds: new Set() });
    e.byLine.get(seq.line).directions.add(seq.dir);
    e.byLine.get(seq.line).branchIds.add(`${seq.dir}:${seq.branchId}`);
  }
}
const edges = [...edgeMap.values()].map((e) => {
  const lines = [...e.byLine].map(([line, v]) => ({ line, directions: [...v.directions].sort(), branchIds: [...v.branchIds].sort() }))
    .sort((p, q) => TubeConfig.LINE_BY_ID[p.line].order - TubeConfig.LINE_BY_ID[q.line].order);
  const A = stationById.get(e.a), B = stationById.get(e.b);
  return { a: e.a, b: e.b, lines, aName: A.name, bName: B.name, lengthM: Math.round(TubeGeometry.haversineM([A.lon, A.lat], [B.lon, B.lat])) };
}).sort((p, q) => (p.a + p.b).localeCompare(q.a + q.b));

// Per-line graph stats: stations, termini (degree 1), junctions (degree >= 3), components.
const lineStats = {};
for (const line of TubeConfig.LINES) {
  const adj = new Map();
  for (const e of edges) {
    if (!e.lines.some((l) => l.line === line.id)) continue;
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
    components.push(comp.sort());
  }
  const name = (id) => stationById.get(id)?.name || id;
  lineStats[line.id] = {
    stationCount: adj.size,
    edgeCount: edges.filter((e) => e.lines.some((l) => l.line === line.id)).length,
    termini: [...adj].filter(([, n]) => n.size === 1).map(([id]) => ({ id, name: name(id) })).sort((p, q) => p.name.localeCompare(q.name)),
    junctions: [...adj].filter(([, n]) => n.size >= 3).map(([id, n]) => ({ id, name: name(id), degree: n.size })).sort((p, q) => p.name.localeCompare(q.name)),
    components: components.map((c) => ({ size: c.length, stations: c.map(name) })),
    singleDirectionEdges: edges.filter((e) => e.lines.some((l) => l.line === line.id && l.directions.length === 1))
      .map((e) => ({ a: name(e.a), b: name(e.b), direction: e.lines.find((l) => l.line === line.id).directions[0] }))
  };
}

// ------------------------------------------------------------- outputs
const generatedAt = new Date().toISOString();
const meta = {
  generatedAt,
  topology: {
    source: 'TfL Unified API — /Line/{id}/Route/Sequence/{outbound|inbound} (London Underground lines and the Elizabeth line)',
    url: 'https://api.tfl.gov.uk/',
    retrievedAt: manifest?.retrievedAt || null,
    licence: manifest?.licence || { attribution: 'Powered by TfL Open Data' }
  },
  stations: { source: clean.source, coordinateSystem: clean.coordinateSystem || 'WGS84', records: clean.recordCount },
  overridesApplied: overridesApplied.length
};

writeJson(paths.stations, { meta, stations });
writeJson(paths.edges, { meta, edges, lines: lineStats });
writeJson(paths.joinReport, {
  generatedAt,
  maxJoinDistanceM: MAX_JOIN_M,
  csvRecordCount: records.length,
  matches: links.map((m) => ({ objectId: m.record.objectId, csvName: m.record.name, stopId: m.stop.id, tflName: m.stop.rawName, stationId: stopToStation.get(m.stop.id), method: m.method, distanceM: m.distanceM })),
  unmatchedCsv,
  topologyStopsWithoutCsv,
  groupNameConflicts,
  duplicateResolutions,
  lineMismatches,
  overridesApplied,
  unusedOverrides,
  rawSummary,
  csvIssues: clean.issues,
  csvDuplicates: clean.duplicates
});

const topology = {
  type: 'FeatureCollection',
  metadata: meta,
  features: edges.flatMap((e) => {
    const A = stationById.get(e.a), B = stationById.get(e.b);
    return e.lines.map((l, i) => ({
      type: 'Feature',
      properties: {
        line: l.line, lineName: TubeConfig.LINE_BY_ID[l.line].name, colour: TubeConfig.LINE_BY_ID[l.line].colour,
        from: e.a, to: e.b, fromName: A.name, toName: B.name, directions: l.directions.join(','),
        sharedBy: e.lines.length, slot: i - (e.lines.length - 1) / 2, lengthM: e.lengthM
      },
      geometry: { type: 'LineString', coordinates: [[A.lon, A.lat], [B.lon, B.lat]] }
    }));
  })
};
writeJson(paths.topology, topology);

const r6 = (v) => Math.round(v * 1e6) / 1e6;
writeBrowserData(paths.publicNetwork, 'TUBE_NETWORK', {
  meta,
  lines: TubeConfig.LINES.map((l) => ({
    id: l.id,
    stationIds: stations.filter((s) => s.lines.includes(l.id)).map((s) => s.id),
    termini: lineStats[l.id].termini.map((t) => t.id)
  })),
  stations: stations.map((s) => ({
    id: s.id, name: s.name, lon: r6(s.lon), lat: r6(s.lat), lines: s.lines, modes: s.modes, csvLines: s.csvLines, stopIds: s.stopIds,
    objectId: s.objectId, coordinateSource: s.coordinateSource,
    duplicateRecords: s.duplicateRecords.map((d) => ({ objectId: d.objectId, lon: r6(d.lon), lat: r6(d.lat), distanceFromCanonicalM: d.distanceFromCanonicalM })),
    note: s.note, unmatched: !!s.unmatched
  })),
  edges: edges.map((e) => ({ a: e.a, b: e.b, lines: e.lines.map((l) => l.line) }))
});

console.log(`Topology stops: ${stops.size}; station records: ${clean.recordCount}; record-stop links: ${links.length}; unmatched records: ${unmatchedCsv.length}; unmatched stops: ${topologyStopsWithoutCsv.length}; name conflicts: ${groupNameConflicts.length}`);
console.log(`Physical stations: ${stations.length}; edges: ${edges.length}; overrides applied: ${overridesApplied.length}`);
for (const l of TubeConfig.LINES) {
  const s = lineStats[l.id];
  console.log(`  ${l.name.padEnd(19)} ${String(s.stationCount).padStart(3)} stations, ${String(s.edgeCount).padStart(3)} edges, ${s.components.length} component(s), termini: ${s.termini.map((t) => t.name).join(', ')}`);
}
console.log(`Wrote ${[paths.stations, paths.edges, paths.topology, paths.joinReport, paths.publicNetwork].map(rel).join(', ')}`);
