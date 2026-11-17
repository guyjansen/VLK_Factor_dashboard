#!/usr/bin/env node
// Step 3: join the authoritative TfL topology to the supplied station CSV.
//
// Inputs : data/stations.clean.json, data/raw/tfl/<line>-<dir>.json,
//          data/station-aliases.json, data/topology-overrides.json
// Outputs: data/stations.json        canonical physical stations
//          data/network-edges.json   adjacent station pairs per line (+ per-line graph stats)
//          data/topology.geojson     one LineString per (edge, line) for GIS use
//          data/join-report.json     how every CSV record / TfL stop was matched
//          public/data/network.js    compact browser bundle
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
const lineEdges = new Map(); // lineId -> Map(edgeKey -> {a,b,directions:Set,branchIds:Set})
const overridesApplied = [];
const rawSummary = [];

for (const line of TubeConfig.LINES) {
  const edges = new Map();
  lineEdges.set(line.id, edges);
  for (const dir of ['outbound', 'inbound']) {
    const file = path.join(paths.rawTfl, `${line.id}-${dir}.json`);
    if (!fs.existsSync(file)) fail(`missing topology file ${rel(file)}. Run "npm run fetch-topology".`);
    const json = readJson(file);
    if (json.lineId !== line.id) fail(`${rel(file)} contains line "${json.lineId}", expected "${line.id}"`);
    rawSummary.push({ line: line.id, direction: dir, sequences: json.stopPointSequences.length, orderedRoutes: (json.orderedLineRoutes || []).map((r) => r.name.replace(/\s*&harr;\s*/g, ' ↔ ')) });
    for (const seq of json.stopPointSequences) {
      let pts = seq.stopPoint.filter((p) => (p.modes || []).includes('tube') || p.stopType === 'NaptanMetroStation');
      for (const ov of overrides.removeStops || []) {
        if (ov.line !== line.id) continue;
        const before = pts.length;
        pts = pts.filter((p) => p.id !== ov.stopId);
        if (pts.length !== before) overridesApplied.push({ ...ov, direction: dir, branchId: seq.branchId });
      }
      for (const p of pts) {
        if (!stops.has(p.id)) stops.set(p.id, { id: p.id, name: stripTflSuffix(p.name), lat: p.lat, lon: p.lon, hubId: p.topMostParentId || null, lines: new Set() });
        stops.get(p.id).lines.add(line.id);
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i].id, b = pts[i + 1].id;
        if (a === b) continue;
        const [x, y] = a < b ? [a, b] : [b, a];
        const key = `${x}|${y}`;
        if (!edges.has(key)) edges.set(key, { a: x, b: y, directions: new Set(), branchIds: new Set() });
        edges.get(key).directions.add(dir);
        edges.get(key).branchIds.add(`${dir}:${seq.branchId}`);
      }
    }
  }
}
const unusedOverrides = (overrides.removeStops || []).filter((ov) => !overridesApplied.some((a) => a.line === ov.line && a.stopId === ov.stopId));

// -------------------------------------------------------------- CSV join
const stopList = [...stops.values()];
const matches = []; // {record, stopId, method, distanceM}
const unmatchedCsv = [];
for (const r of clean.records) {
  const here = [r.lon, r.lat];
  const dist = (s) => TubeGeometry.haversineM(here, [s.lon, s.lat]);
  let found = null;
  const alias = (aliasCfg.aliases || []).find((a) => a.csvName === r.name);
  if (alias && stops.has(alias.stopId)) {
    const s = stops.get(alias.stopId);
    if (dist(s) <= MAX_JOIN_M) found = { stopId: s.id, method: 'alias', distanceM: dist(s), reason: alias.reason };
  }
  if (!found) {
    const exact = stopList.filter((s) => nameKey(s.name) === nameKey(r.name) && dist(s) <= MAX_JOIN_M);
    if (exact.length) {
      exact.sort((p, q) => dist(p) - dist(q));
      found = { stopId: exact[0].id, method: 'exact-name', distanceM: dist(exact[0]) };
    }
  }
  if (!found) {
    // Same name ignoring parenthetical qualifiers, e.g. CSV "Shepherd's Bush"
    // vs TfL "Shepherd's Bush (Central)". Only accepted if unambiguous.
    const base = stopList.filter((s) => baseNameKey(s.name) === baseNameKey(r.name) && dist(s) <= MAX_JOIN_M);
    if (base.length === 1) found = { stopId: base[0].id, method: 'base-name', distanceM: dist(base[0]) };
  }
  if (found) matches.push({ record: r, ...found, distanceM: Math.round(found.distanceM) });
  else unmatchedCsv.push({ objectId: r.objectId, name: r.name, lon: r.lon, lat: r.lat, csvLines: r.lines });
}

// Group CSV records per stop; nearest record becomes canonical, others are duplicates.
const byStop = new Map();
for (const m of matches) {
  if (!byStop.has(m.stopId)) byStop.set(m.stopId, []);
  byStop.get(m.stopId).push(m);
}
const lineOrder = (ids) => [...ids].sort((p, q) => TubeConfig.LINE_BY_ID[p].order - TubeConfig.LINE_BY_ID[q].order);

const stations = [];
const duplicateResolutions = [];
const lineMismatches = [];
for (const s of stopList) {
  const group = (byStop.get(s.id) || []).sort((p, q) => p.distanceM - q.distanceM);
  const canonical = group[0];
  const topoLines = lineOrder(s.lines);
  const st = {
    id: s.id,
    hubId: s.hubId,
    name: canonical ? canonical.record.name : s.name,
    tflName: s.name,
    lon: canonical ? canonical.record.lon : s.lon,
    lat: canonical ? canonical.record.lat : s.lat,
    tflLon: s.lon,
    tflLat: s.lat,
    coordinateSource: canonical ? 'csv' : 'tfl',
    objectId: canonical ? canonical.record.objectId : null,
    joinMethod: canonical ? canonical.method : 'none',
    joinDistanceM: canonical ? canonical.distanceM : null,
    lines: topoLines,
    csvLines: canonical ? lineOrder(canonical.record.lines) : [],
    interchange: topoLines.length > 1,
    duplicateRecords: group.slice(1).map((m) => ({ objectId: m.record.objectId, name: m.record.name, lon: m.record.lon, lat: m.record.lat, distanceFromCanonicalM: Math.round(TubeGeometry.haversineM([m.record.lon, m.record.lat], [canonical.record.lon, canonical.record.lat])) })),
    note: aliasCfg.notes?.[s.id] || null
  };
  if (st.duplicateRecords.length) duplicateResolutions.push({ stopId: s.id, name: st.name, canonicalObjectId: st.objectId, duplicates: st.duplicateRecords });
  if (canonical) {
    const missingInCsv = topoLines.filter((l) => !st.csvLines.includes(l));
    const extraInCsv = st.csvLines.filter((l) => !topoLines.includes(l));
    if (missingInCsv.length || extraInCsv.length) {
      lineMismatches.push({ stopId: s.id, name: st.name, objectId: st.objectId, topologyLines: topoLines, csvLines: st.csvLines, missingInCsv, extraInCsv });
    }
  }
  stations.push(st);
}
// CSV stations with no topology match are still shown (with CSV lines) but flagged.
for (const u of unmatchedCsv) {
  stations.push({
    id: `CSV-${u.objectId}`, hubId: null, name: u.name, tflName: null, lon: u.lon, lat: u.lat, tflLon: null, tflLat: null,
    coordinateSource: 'csv', objectId: u.objectId, joinMethod: 'none', joinDistanceM: null,
    lines: lineOrder(u.csvLines), csvLines: lineOrder(u.csvLines), interchange: u.csvLines.length > 1,
    duplicateRecords: [], note: 'No matching TfL topology stop: drawn as a station but not connected to any line.', unmatched: true
  });
}
stations.sort((p, q) => p.name.localeCompare(q.name, 'en-GB') || p.id.localeCompare(q.id));
const stationById = new Map(stations.map((s) => [s.id, s]));

// -------------------------------------------------------------- edges
const edgeMap = new Map();
for (const [lineId, edges] of lineEdges) {
  for (const e of edges.values()) {
    const key = `${e.a}|${e.b}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { a: e.a, b: e.b, lines: [] });
    edgeMap.get(key).lines.push({ line: lineId, directions: [...e.directions].sort(), branchIds: [...e.branchIds].sort() });
  }
}
const edges = [...edgeMap.values()].map((e) => {
  e.lines.sort((p, q) => TubeConfig.LINE_BY_ID[p.line].order - TubeConfig.LINE_BY_ID[q.line].order);
  const A = stationById.get(e.a), B = stationById.get(e.b);
  return { ...e, aName: A.name, bName: B.name, lengthM: Math.round(TubeGeometry.haversineM([A.lon, A.lat], [B.lon, B.lat])) };
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
    source: 'TfL Unified API — /Line/{id}/Route/Sequence/{outbound|inbound}',
    url: 'https://api.tfl.gov.uk/',
    retrievedAt: manifest?.retrievedAt || null,
    licence: manifest?.licence || { attribution: 'Powered by TfL Open Data' }
  },
  stations: { source: rel(paths.csv), records: clean.recordCount },
  overridesApplied: overridesApplied.length
};

writeJson(paths.stations, { meta, stations });
writeJson(paths.edges, { meta, edges, lines: lineStats });
writeJson(paths.joinReport, {
  generatedAt,
  maxJoinDistanceM: MAX_JOIN_M,
  matches: matches.map((m) => ({ objectId: m.record.objectId, csvName: m.record.name, stopId: m.stopId, tflName: stops.get(m.stopId).name, method: m.method, distanceM: m.distanceM })),
  unmatchedCsv,
  topologyStopsWithoutCsv: stopList.filter((s) => !byStop.has(s.id)).map((s) => ({ stopId: s.id, name: s.name, lines: lineOrder(s.lines) })),
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
    id: s.id, name: s.name, lon: r6(s.lon), lat: r6(s.lat), lines: s.lines, csvLines: s.csvLines,
    objectId: s.objectId, coordinateSource: s.coordinateSource,
    duplicateRecords: s.duplicateRecords.map((d) => ({ objectId: d.objectId, lon: r6(d.lon), lat: r6(d.lat), distanceFromCanonicalM: d.distanceFromCanonicalM })),
    note: s.note, unmatched: !!s.unmatched
  })),
  edges: edges.map((e) => ({ a: e.a, b: e.b, lines: e.lines.map((l) => l.line) }))
});

console.log(`Topology stops: ${stops.size}; CSV records: ${clean.recordCount}; matched: ${matches.length}; unmatched CSV: ${unmatchedCsv.length}`);
console.log(`Physical stations: ${stations.length}; edges: ${edges.length}; overrides applied: ${overridesApplied.length}`);
for (const l of TubeConfig.LINES) {
  const s = lineStats[l.id];
  console.log(`  ${l.name.padEnd(19)} ${String(s.stationCount).padStart(3)} stations, ${String(s.edgeCount).padStart(3)} edges, ${s.components.length} component(s), termini: ${s.termini.map((t) => t.name).join(', ')}`);
}
console.log(`Wrote ${[paths.stations, paths.edges, paths.topology, paths.joinReport, paths.publicNetwork].map(rel).join(', ')}`);
