#!/usr/bin/env node
// Step 4 (and again after isochrones): write data/validation-report.json and
// print a summary. Exit code 1 if any ERROR-level check fails.
//
// Network checks
//  - every line (and every route) is one connected component, without cycles
//    (each SL metro colour line is a tree: branches, no loops)
//  - no edge longer than the plausible maximum for the mode
//  - every station on a line has a track connection; every pattern stop maps
//  - no station groups records with different names; no unused overrides/aliases
//  - OpenStreetMap cross-check (warnings): unmatched stations both ways
// Isochrone checks (when generated)
//  - valid geometry, every station present
//  - nested by threshold (true geometric difference, not just area)
//  - within the physical maximum radius (seconds × 1.4 m/s + snapping tolerance)
//  - irregular: not circle-like (radial coefficient of variation)
import { paths, readJson, writeJson, rel, MetroConfig, MetroGeometry as G, polygonClipping } from './lib/common.mjs';

let stationsDoc, edgesDoc, join;
try {
  stationsDoc = readJson(paths.stations);
  edgesDoc = readJson(paths.edges);
  join = readJson(paths.joinReport);
} catch (err) {
  console.error(`ERROR: ${err.message}\nRun "npm run prepare-stations && npm run build-network" first.`);
  process.exit(1);
}
const iso = readJson(paths.isochrones, null);
const failuresDoc = readJson(paths.isoFailures, null);

const errors = [];
const warnings = [];
// Longest real inter-station gap on the Stockholm metro: Hallonbergen–Kista,
// about 3.5 km straight line (trains pass the never-opened Kymlinge station
// in between). Every other gap is under 2.3 km (Tekniska högskolan–
// Universitetet). 4 km still catches a wrong join across the city.
const MAX_EDGE_M = { metro: 4000 };
const SNAP_TOLERANCE_M = 150; // origin snapping + polygon grid of the routing engine

const disconnected = [];
const cyclic = [];
for (const [lineId, s] of Object.entries(edgesDoc.lines)) {
  const name = MetroConfig.LINE_BY_ID[lineId].name;
  if (s.components.length !== 1) { disconnected.push({ line: lineId, components: s.components }); errors.push(`${name} has ${s.components.length} disconnected segments`); }
  if (s.cycles !== 0) { cyclic.push({ line: lineId, cycles: s.cycles }); errors.push(`${name} graph contains ${s.cycles} cycle(s): a skip-stop or wrong edge (fix with a reviewed override)`); }
  for (const [route, r] of Object.entries(s.routes)) {
    if (r.components.length !== 1) { disconnected.push({ line: lineId, route, components: r.components }); errors.push(`route ${route} has ${r.components.length} disconnected segments`); }
    if (r.cycles !== 0) errors.push(`route ${route} graph contains ${r.cycles} cycle(s)`);
  }
}
const edgeLimit = (e) => Math.min(...e.lines.map((l) => MAX_EDGE_M[MetroConfig.LINE_BY_ID[l.line].mode]));
const longEdges = edgesDoc.edges.filter((e) => e.lengthM > edgeLimit(e)).map((e) => ({ a: e.aName, b: e.bName, lengthM: e.lengthM, limitM: edgeLimit(e), lines: e.lines.map((l) => l.line) }));
if (longEdges.length) errors.push(`${longEdges.length} edge(s) longer than the plausible maximum for their mode`);
if (join.nameConflicts.length) errors.push(`${join.nameConflicts.length} station group(s) join records with different names`);
if (join.unmappedPatternStops.length) errors.push(`${join.unmappedPatternStops.length} pattern stop(s) not mapped to a station`);
if (join.unusedOverrides.length) errors.push(`${join.unusedOverrides.length} topology override(s) no longer apply — the operator data changed; review data/topology-overrides.json`);
if (join.unusedAliases.length) errors.push(`${join.unusedAliases.length} station alias(es) no longer apply; review data/station-aliases.json`);
const stationsWithoutEdges = stationsDoc.stations.filter((st) => st.lines.length && !edgesDoc.edges.some((e) => e.a === st.id || e.b === st.id)).map((s) => s.name);
if (stationsWithoutEdges.length) errors.push(`${stationsWithoutEdges.length} station(s) on a line but with no track connection`);
if (join.rejectedLinks.length) warnings.push(`${join.rejectedLinks.length} candidate record link(s) rejected for distance (kept separate)`);
if (join.orphanPlatforms.length) warnings.push(`${join.orphanPlatforms.length} platform(s) without a parent station`);
const osm = join.osmCrossCheck;
if (osm.status !== 'checked') warnings.push('OpenStreetMap cross-check not available (reference data missing)');
else {
  if (osm.unmatchedOsm.length) warnings.push(`${osm.unmatchedOsm.length} OpenStreetMap station(s) without an operator match`);
  if (osm.stationsWithoutOsm.length) warnings.push(`${osm.stationsWithoutOsm.length} station(s) without an OpenStreetMap match`);
}

// ------------------------------------------------------------- isochrones
let isochroneChecks = { status: 'not-generated' };
if (iso) {
  const byStation = new Map();
  const invalid = [];
  for (const f of iso.features) {
    const p = f.properties;
    if (!G.isValidPolygonal(f.geometry)) invalid.push({ stationId: p.stationId, seconds: p.seconds });
    if (!byStation.has(p.stationId)) byStation.set(p.stationId, {});
    byStation.get(p.stationId)[p.seconds] = f.geometry;
  }
  const onLines = stationsDoc.stations.filter((s) => s.lines.length);
  const missing = onLines.filter((s) => !byStation.has(s.id) || MetroConfig.CONTOUR_SECONDS.some((sec) => !byStation.get(s.id)[sec])).map((s) => ({ stationId: s.id, name: s.name }));
  const nestingViolations = [];
  const circular = [];
  const tooLarge = [];
  const cvs = [];
  const maxRatio = {};
  for (const s of onLines) {
    const g = byStation.get(s.id);
    if (!g) continue;
    const secs = MetroConfig.CONTOUR_SECONDS;
    for (let i = 1; i < secs.length; i++) {
      if (!g[secs[i - 1]] || !g[secs[i]]) continue;
      const inner = G.toPolygons(g[secs[i - 1]]), outer = G.toPolygons(g[secs[i]]);
      let outside = 0;
      try { outside = G.areaM2(polygonClipping.difference(inner, outer)); } catch { outside = NaN; }
      const share = outside / G.areaM2(inner);
      if (!(share < 0.005)) nestingViolations.push({ name: s.name, inner: secs[i - 1], outer: secs[i], shareOutside: Number(share.toFixed(4)) });
    }
    for (const sec of secs) {
      if (!g[sec]) continue;
      const st = G.radialStats(g[sec], [s.lon, s.lat]);
      if (!st) continue;
      const limit = sec * MetroConfig.WALKING_SPEED_MPS + SNAP_TOLERANCE_M;
      maxRatio[sec] = Math.max(maxRatio[sec] || 0, st.max / (sec * MetroConfig.WALKING_SPEED_MPS));
      if (st.max > limit) tooLarge.push({ name: s.name, seconds: sec, maxRadiusM: Math.round(st.max), limitM: Math.round(limit) });
      if (sec === secs[0]) {
        cvs.push(st.cv);
        if (st.cv < 0.05 && st.n > 12) circular.push({ name: s.name, cv: Number(st.cv.toFixed(3)) });
      }
    }
  }
  if (invalid.length) errors.push(`${invalid.length} invalid isochrone geometries`);
  if (circular.length) errors.push(`${circular.length} isochrone(s) look like circular buffers`);
  if (tooLarge.length) errors.push(`${tooLarge.length} isochrone(s) reach beyond the physical maximum (seconds × 1.4 m/s + ${SNAP_TOLERANCE_M} m)`);
  if (nestingViolations.length) errors.push(`${nestingViolations.length} station(s) where a shorter contour is not inside the longer one`);
  if (missing.length) warnings.push(`${missing.length} station(s) have no (complete) isochrones yet`);
  if (failuresDoc?.failures?.length) warnings.push(`${failuresDoc.failures.length} station(s) failed in the last isochrone run`);
  cvs.sort((x, y) => x - y);
  isochroneChecks = {
    status: missing.length ? 'partial' : 'complete',
    providers: iso.metadata?.providers, parameters: iso.metadata?.parameters,
    generatedBetween: iso.metadata?.isochronesGeneratedBetween,
    stationsWithIsochrones: byStation.size,
    missing, lastRunFailures: failuresDoc?.failures || [], invalidGeometries: invalid,
    nestingViolations, circularLooking: circular, beyondPhysicalMaximum: tooLarge,
    maxReachOverStraightLineLimit: Object.fromEntries(Object.entries(maxRatio).map(([k, v]) => [k, Number(v.toFixed(3))])),
    radialCoefficientOfVariation: cvs.length ? { min: +cvs[0].toFixed(3), median: +cvs[Math.floor(cvs.length / 2)].toFixed(3), max: +cvs[cvs.length - 1].toFixed(3) } : null
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  status: errors.length ? 'errors' : warnings.length ? 'warnings' : 'ok',
  errors, warnings,
  summary: {
    platformRecords: join.counts.platforms, parentStationRecords: join.counts.parents,
    physicalStations: stationsDoc.stations.length,
    interchanges: stationsDoc.stations.filter((s) => s.interchange).map((s) => s.name),
    edges: edgesDoc.edges.length,
    sharedEdges: edgesDoc.edges.filter((e) => e.lines.length > 1).map((e) => `${e.aName}–${e.bName}`)
  },
  unmatchedRecords: {
    orphanPlatforms: join.orphanPlatforms,
    passThroughStopsExcluded: join.nonPassengerStops,
    rejectedLinks: join.rejectedLinks,
    unmappedPatternStops: join.unmappedPatternStops,
    osmStationsWithoutOperatorMatch: osm.status === 'checked' ? osm.unmatchedOsm : null,
    stationsWithoutOsmMatch: osm.status === 'checked' ? osm.stationsWithoutOsm : null
  },
  duplicates: {
    stationsWithSeveralParentRecords: stationsDoc.stations.filter((s) => s.parentStopIds.length > 1).map((s) => ({ name: s.name, parentStopIds: s.parentStopIds })),
    sameNameKeptSeparate: join.separatedSameName,
    nameConflicts: join.nameConflicts,
    note: 'Operator records are merged only by parent_station ID, a documented alias or an equal normalised name, and only within the join distance.'
  },
  lineNameMismatches: osm.status === 'checked' ? osm.unmatchedOsm.filter((u) => u.nearestSameName === null) : null,
  overridesApplied: join.overridesApplied,
  unusedOverrides: join.unusedOverrides,
  aliasesApplied: join.aliasesApplied,
  osmCrossCheck: osm.status === 'checked' ? { dataTimestamp: osm.dataTimestamp, osmInService: osm.osmInService, stationsMatched: osm.stationsMatched, distanceM: osm.distanceM, notInService: osm.notInService } : osm,
  network: {
    disconnectedSegments: disconnected, cycles: cyclic, longEdges, stationsWithoutEdges,
    lines: Object.fromEntries(Object.entries(edgesDoc.lines).map(([id, s]) => [id, {
      name: MetroConfig.LINE_BY_ID[id].name, stations: s.stationCount, edges: s.edgeCount, components: s.components.length,
      termini: s.termini, junctions: s.junctions.map((j) => `${j.name} (${j.degree})`),
      routes: Object.fromEntries(Object.entries(s.routes).map(([r, x]) => [r, { stations: x.stationCount, termini: x.termini }]))
    }]))
  },
  isochrones: isochroneChecks
};
writeJson(paths.validation, report);
console.log(`Validation: ${report.status.toUpperCase()}`);
errors.forEach((e) => console.log(`  ERROR   ${e}`));
warnings.forEach((w) => console.log(`  warning ${w}`));
console.log(`Wrote ${rel(paths.validation)}`);
if (errors.length) process.exitCode = 1;
