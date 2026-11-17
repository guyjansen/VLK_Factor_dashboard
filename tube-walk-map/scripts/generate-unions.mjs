#!/usr/bin/env node
// Step 5: true geometric unions of station isochrones, per time threshold,
// for every line and for the whole network. Uses the full-precision
// isochrones; each physical station (NaPTAN id) contributes exactly once.
//
// Outputs: data/coverage-unions.geojson (analysis copy, full precision)
//          public/data/coverage.js      (simplified display copy)
import { paths, readJson, writeJson, writeBrowserData, rel, TubeConfig, TubeGeometry, polygonClipping } from './lib/common.mjs';
import fs from 'node:fs';

let iso, stationsDoc;
try {
  iso = readJson(paths.isochrones);
  stationsDoc = readJson(paths.stations);
} catch (err) {
  console.error(`ERROR: ${err.message}\nRun "npm run isochrones" first.`);
  process.exit(1);
}

// stationId -> seconds -> geometry
const byStation = new Map();
for (const f of iso.features) {
  const { stationId, seconds } = f.properties;
  if (!byStation.has(stationId)) byStation.set(stationId, {});
  byStation.get(stationId)[seconds] = f.geometry;
}

const scopes = [
  ...TubeConfig.LINES.map((l) => ({ scope: 'line', id: l.id, name: l.name, stations: stationsDoc.stations.filter((s) => s.lines.includes(l.id)) })),
  { scope: 'all', id: 'all', name: 'All Underground lines', stations: stationsDoc.stations.filter((s) => s.lines.length) }
];

const features = [];
const display = { lines: {}, all: {} };
const t0 = Date.now();
for (const sc of scopes) {
  const ids = [...new Set(sc.stations.map((s) => s.id))]; // dedupe (interchanges counted once)
  const withIso = ids.filter((id) => byStation.has(id));
  for (const seconds of TubeConfig.CONTOUR_SECONDS) {
    const geoms = withIso.map((id) => byStation.get(id)[seconds]).filter(Boolean);
    const { polygons, skipped } = TubeGeometry.unionGeometries(geoms, polygonClipping);
    const geometry = TubeGeometry.toGeometry(polygons);
    if (!geometry) continue;
    const props = {
      scope: sc.scope, id: sc.id, name: sc.name, seconds, minutes: seconds / 60,
      stationCount: ids.length, stationsWithIsochrone: withIso.length, skippedInvalid: skipped,
      areaKm2: Number((TubeGeometry.areaM2(polygons) / 1e6).toFixed(3)), parts: polygons.length
    };
    features.push({ type: 'Feature', properties: props, geometry });
    const simp = TubeGeometry.simplifyGeometry(geometry, 0.00002, 5);
    const target = sc.scope === 'all' ? display.all : (display.lines[sc.id] ||= {});
    target[seconds] = { geometry: simp, areaKm2: props.areaKm2, stationsWithIsochrone: withIso.length, stationCount: ids.length };
  }
  process.stdout.write(`  ${sc.name.padEnd(22)} ${withIso.length}/${ids.length} stations\n`);
}

const meta = {
  generatedAt: new Date().toISOString(),
  method: 'polygon-clipping union (sweep-line) of full-precision station isochrones; one polygon set per threshold',
  isochrones: { providers: iso.metadata?.providers, generatedBetween: iso.metadata?.isochronesGeneratedBetween, parameters: iso.metadata?.parameters }
};
writeJson(paths.unions, { type: 'FeatureCollection', metadata: meta, features }, false);
writeBrowserData(paths.publicCoverage, 'TUBE_COVERAGE', { meta, ...display });
const size = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`Unions computed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const s of TubeConfig.CONTOUR_SECONDS) {
  const f = features.find((x) => x.properties.scope === 'all' && x.properties.seconds === s);
  if (f) console.log(`  all lines, ${s / 60} min: ${f.properties.areaKm2} km² in ${f.properties.parts} part(s)`);
}
console.log(`Wrote ${rel(paths.unions)} (${size(paths.unions)}), ${rel(paths.publicCoverage)} (${size(paths.publicCoverage)})`);
