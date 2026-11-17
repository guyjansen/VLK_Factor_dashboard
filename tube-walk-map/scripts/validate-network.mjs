#!/usr/bin/env node
// Step 6: write data/validation-report.json and print a summary.
// Exit code 1 if any ERROR-level check fails (warnings do not fail the run).
//
// Checks
//  - CSV parse issues, unmatched stations (both directions), duplicate
//    names/coordinates and how they were resolved, line-name mismatches
//  - every line forms one connected graph; termini and junctions listed
//  - no implausibly long edges (would indicate a wrong join "cutting across London")
//  - every station on a line is connected to that line
//  - topology overrides were all applied
//  - isochrones (if generated): missing/failed stations, invalid geometry,
//    1 ⊆ 2 ⊆ 5 minute nesting by area, and a circularity check that would
//    flag buffer-like shapes
import { paths, readJson, writeJson, rel, TubeConfig, TubeGeometry } from './lib/common.mjs';

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
// Longest real gaps: Underground Finchley Road–Wembley Park ~7.1 km;
// Elizabeth line Maidenhead–Twyford ~10.9 km (outer main-line section).
const MAX_EDGE_M = { tube: 8000, 'elizabeth-line': 12000 };

// Connectivity / plausibility per line
const disconnected = [];
for (const [lineId, s] of Object.entries(edgesDoc.lines)) {
  if (s.components.length !== 1) {
    disconnected.push({ line: lineId, components: s.components });
    errors.push(`${TubeConfig.LINE_BY_ID[lineId].name} line has ${s.components.length} disconnected segments`);
  }
}
const edgeLimit = (e) => Math.min(...e.lines.map((l) => MAX_EDGE_M[TubeConfig.LINE_BY_ID[l.line].mode]));
const longEdges = edgesDoc.edges.filter((e) => e.lengthM > edgeLimit(e)).map((e) => ({ a: e.aName, b: e.bName, lengthM: e.lengthM, limitM: edgeLimit(e), lines: e.lines.map((l) => l.line) }));
if (longEdges.length) errors.push(`${longEdges.length} edge(s) longer than the plausible maximum for their mode`);
if (join.groupNameConflicts?.length) errors.push(`${join.groupNameConflicts.length} station group(s) join records with different names`);

const stationsWithoutEdges = stationsDoc.stations.filter((st) => st.lines.length && !edgesDoc.edges.some((e) => e.a === st.id || e.b === st.id)).map((s) => s.name);
if (stationsWithoutEdges.length) errors.push(`${stationsWithoutEdges.length} station(s) on a line but with no track connection`);

if (join.unusedOverrides?.length) errors.push(`${join.unusedOverrides.length} topology override(s) did not apply — TfL data may have changed`);
if (join.unmatchedCsv.length) warnings.push(`${join.unmatchedCsv.length} CSV station(s) without a topology match`);
if (join.topologyStopsWithoutCsv.length) warnings.push(`${join.topologyStopsWithoutCsv.length} TfL stop(s) without a CSV match (drawn at TfL coordinates)`);
if (join.lineMismatches.length) warnings.push(`${join.lineMismatches.length} station(s) whose CSV LINES differ from TfL topology (topology is used)`);
if (join.csvIssues.length) warnings.push(`${join.csvIssues.length} CSV parse issue(s)`);

// Isochrone checks
let isochroneChecks = { status: 'not-generated' };
if (iso) {
  const byStation = new Map();
  const invalid = [];
  for (const f of iso.features) {
    const p = f.properties;
    if (!TubeGeometry.isValidPolygonal(f.geometry)) invalid.push({ stationId: p.stationId, seconds: p.seconds });
    if (!byStation.has(p.stationId)) byStation.set(p.stationId, {});
    byStation.get(p.stationId)[p.seconds] = f.geometry;
  }
  const stationsOnLines = stationsDoc.stations.filter((s) => s.lines.length && !s.unmatched);
  const missing = stationsOnLines.filter((s) => !byStation.has(s.id)).map((s) => ({ stationId: s.id, name: s.name }));
  const nestingViolations = [];
  const circular = [];
  const tooLarge = [];
  const cvs = [];
  for (const s of stationsOnLines) {
    const g = byStation.get(s.id);
    if (!g) continue;
    const a = TubeConfig.CONTOUR_SECONDS.map((sec) => (g[sec] ? TubeGeometry.areaM2(g[sec]) : NaN));
    if (!a.every((v, i) => i === 0 || a[i - 1] <= v * 1.001)) nestingViolations.push({ name: s.name, areasM2: a.map(Math.round) });
    const st = g[300] && TubeGeometry.radialStats(g[300], [s.lon, s.lat]);
    if (st) {
      cvs.push(st.cv);
      if (st.cv < 0.05 && st.n > 12) circular.push({ name: s.name, cv: Number(st.cv.toFixed(3)) });
      // Max straight-line reach at 1.4 m/s in 300 s is 420 m; allow for the
      // routing grid and snapping tolerance.
      if (st.max > 420 * 1.6) tooLarge.push({ name: s.name, maxRadiusM: Math.round(st.max) });
    }
  }
  if (invalid.length) errors.push(`${invalid.length} invalid isochrone geometries`);
  if (circular.length) errors.push(`${circular.length} isochrone(s) look like circular buffers`);
  if (missing.length) warnings.push(`${missing.length} station(s) have no isochrones yet`);
  if (nestingViolations.length) warnings.push(`${nestingViolations.length} station(s) where a shorter contour has a larger area than a longer one`);
  if (tooLarge.length) warnings.push(`${tooLarge.length} isochrone(s) extend unusually far (> 672 m) from the station coordinate`);
  if (failuresDoc?.failures?.length) warnings.push(`${failuresDoc.failures.length} station(s) failed in the last isochrone run`);
  cvs.sort((x, y) => x - y);
  isochroneChecks = {
    status: missing.length ? 'partial' : 'complete',
    providers: iso.metadata?.providers,
    parameters: iso.metadata?.parameters,
    generatedBetween: iso.metadata?.isochronesGeneratedBetween,
    stationsWithIsochrones: byStation.size,
    missing,
    lastRunFailures: failuresDoc?.failures || [],
    invalidGeometries: invalid,
    nestingViolations,
    circularLooking: circular,
    unusuallyLarge: tooLarge,
    radialCoefficientOfVariation: cvs.length ? { min: +cvs[0].toFixed(3), median: +cvs[Math.floor(cvs.length / 2)].toFixed(3), max: +cvs[cvs.length - 1].toFixed(3) } : null
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  status: errors.length ? 'errors' : warnings.length ? 'warnings' : 'ok',
  errors,
  warnings,
  summary: {
    stationRecords: join.csvRecordCount,
    physicalStations: stationsDoc.stations.length,
    byMode: Object.fromEntries(TubeConfig.MODES.map((m) => [m.id, stationsDoc.stations.filter((s) => (s.modes || []).includes(m.id)).length])),
    tflStopsJoined: join.matches.length,
    interchanges: stationsDoc.stations.filter((s) => s.interchange).length,
    edges: edgesDoc.edges.length,
    sharedEdges: edgesDoc.edges.filter((e) => e.lines.length > 1).length
  },
  unmatchedStations: {
    csvStationsWithoutTopologyMatch: join.unmatchedCsv,
    topologyStopsWithoutCsvMatch: join.topologyStopsWithoutCsv,
    nonExactMatches: join.matches.filter((m) => !['exact-name', 'atco-code'].includes(m.method)),
    stationsWithSeveralTflStops: stationsDoc.stations.filter((s) => (s.stopIds || []).length > 1).map((s) => ({ name: s.name, stopIds: s.stopIds }))
  },
  duplicates: {
    duplicateNames: join.csvDuplicates.duplicateNames,
    duplicateCoordinates: join.csvDuplicates.duplicateCoordinates,
    recordsWithin200m: join.csvDuplicates.nearDuplicates,
    duplicateObjectIds: join.csvDuplicates.duplicateObjectIds,
    resolution: join.duplicateResolutions,
    nameConflicts: join.groupNameConflicts || [],
    note: 'Records and TfL stops are merged only when the ATCO code, or both the name and the location, match. Edgware Road, Hammersmith, Paddington (H&C Line) and Shepherd\'s Bush / Shepherd\'s Bush Market stay as separate stations; Underground and Elizabeth line platforms of the same station (e.g. Liverpool Street) are one station.'
  },
  lineNameMismatches: join.lineMismatches,
  csvParseIssues: join.csvIssues,
  topologyOverridesApplied: join.overridesApplied,
  unusedTopologyOverrides: join.unusedOverrides,
  network: {
    disconnectedSegments: disconnected,
    longEdges,
    stationsWithoutEdges,
    lines: Object.fromEntries(Object.entries(edgesDoc.lines).map(([id, s]) => [id, {
      name: TubeConfig.LINE_BY_ID[id].name,
      stations: s.stationCount, edges: s.edgeCount, components: s.components.length,
      termini: s.termini.map((t) => t.name), junctions: s.junctions.map((j) => `${j.name} (${j.degree})`),
      singleDirectionEdges: s.singleDirectionEdges
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
