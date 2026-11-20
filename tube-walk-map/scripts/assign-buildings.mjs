#!/usr/bin/env node
// Assign every geocoded office building to the walking areas it lies in.
// For each building and each station, the smallest contour (300/600 s) whose
// full-precision isochrone contains the building point is recorded. A
// building is "within N min" of a selection of stations when any selected
// station's N-minute area contains it, which is the same as lying inside
// their union.
//
// Inputs : data/buildings.clean.json (geocoded), data/stations.json, data/isochrones.geojson
// Outputs: data/buildings.json, data/buildings.geojson, public/data/buildings.js
import { paths, readJson, writeJson, writeBrowserData, rel, TubeConfig, TubeGeometry as G } from './lib/common.mjs';

let doc, stationsDoc, iso;
try {
  doc = readJson(paths.buildingsClean);
  stationsDoc = readJson(paths.stations);
  iso = readJson(paths.isochrones);
} catch (err) {
  console.error(`ERROR: ${err.message}\nRun "npm run buildings:prepare && npm run buildings:geocode" and the isochrone pipeline first.`);
  process.exit(1);
}
const sizesDoc = readJson(paths.buildingSizes, null); // optional: floor areas (npm run buildings:sizes)
const stations = stationsDoc.stations.filter((s) => s.lines.length);
const byId = new Map(stations.map((s) => [s.id, s]));
const polys = []; // {stationId, seconds, polygons, bbox}
for (const f of iso.features) {
  const p = G.toPolygons(f.geometry);
  if (p.length && byId.has(f.properties.stationId)) polys.push({ stationId: f.properties.stationId, seconds: f.properties.seconds, polygons: p, bbox: G.bbox(p) });
}

const out = [];
for (const b of doc.buildings.filter((x) => !x.superseded)) { // superseded: replaced by a JV sheet
  const sqm = sizesDoc?.sizes?.[b.id];
  const rec = { ...b, sqm: Number.isFinite(sqm) ? sqm : null, stations: {}, bestSeconds: null, nearestStation: null };
  if (Number.isFinite(b.lon) && Number.isFinite(b.lat)) {
    const pt = [b.lon, b.lat];
    for (const p of polys) {
      if (pt[0] < p.bbox[0] || pt[0] > p.bbox[2] || pt[1] < p.bbox[1] || pt[1] > p.bbox[3]) continue;
      if (!G.pointInPolygons(pt, p.polygons)) continue;
      const cur = rec.stations[p.stationId];
      if (cur === undefined || p.seconds < cur) rec.stations[p.stationId] = p.seconds;
    }
    const secs = Object.values(rec.stations);
    rec.bestSeconds = secs.length ? Math.min(...secs) : null;
    let best = null;
    for (const s of stations) {
      const d = G.haversineM(pt, [s.lon, s.lat]);
      if (!best || d < best.distanceM) best = { id: s.id, name: s.name, distanceM: Math.round(d) };
    }
    rec.nearestStation = best;
  }
  out.push(rec);
}

const meta = {
  generatedAt: new Date().toISOString(),
  source: doc.source,
  geocoder: doc.geocoder,
  geocodedAt: doc.geocodedAt,
  sizes: sizesDoc ? { source: sizesDoc.meta.source, unit: 'sqm', known: Object.keys(sizesDoc.sizes).length, unknown: sizesDoc.unknown, note: sizesDoc.meta.note } : null,
  isochrones: { providers: iso.metadata?.providers, generatedBetween: iso.metadata?.isochronesGeneratedBetween },
  method: 'Point-in-polygon of the geocoded building point against each station\'s full-precision 300/600 s (5/10 min) pedestrian isochrones.',
  caveat: 'Building positions come from geocoding street addresses; street-level matches can be off by a few hundred metres.'
};
writeJson(paths.buildings, { meta, buildings: out });
writeJson(paths.buildingsGeojson, {
  type: 'FeatureCollection', metadata: meta,
  features: out.filter((b) => b.lon != null).map((b) => ({
    type: 'Feature',
    properties: { id: b.id, company: b.company, status: b.status, name: b.name, sqm: b.sqm, propertyKey: b.propertyKey, propertyType: b.propertyType, street: b.street, geocodePrecision: b.geocode.precision, bestWalkMinutes: b.bestSeconds ? b.bestSeconds / 60 : null, nearestStation: b.nearestStation?.name, nearestStationM: b.nearestStation?.distanceM },
    geometry: { type: 'Point', coordinates: [b.lon, b.lat] }
  }))
});
const r6 = (v) => Math.round(v * 1e6) / 1e6;
writeBrowserData(paths.publicBuildings, 'TUBE_BUILDINGS', {
  meta,
  buildings: out.map((b) => ({
    id: b.id, company: b.company, status: b.status, name: b.name, street: b.street, propertyType: b.propertyType, propertyKey: b.propertyKey,
    lon: b.lon == null ? null : r6(b.lon), lat: b.lat == null ? null : r6(b.lat),
    precision: b.geocode.precision, geocoded: b.geocode.displayName, stations: b.stations, nearest: b.nearestStation, sqm: b.sqm
  }))
});

const located = out.filter((b) => b.lon != null);
console.log(`Buildings: ${out.length}, located: ${located.length}, not found: ${out.length - located.length}`);
for (const c of TubeConfig.COMPANIES) {
  const bs = located.filter((b) => b.company === c.name);
  const pct = (sec) => `${Math.round((100 * bs.filter((b) => b.bestSeconds && b.bestSeconds <= sec).length) / (bs.length || 1))}%`;
  console.log(`  ${c.name.padEnd(24)} ${String(bs.length).padStart(3)} located · ≤5 min ${pct(300)} · ≤10 min ${pct(600)}`);
}
console.log(`Wrote ${rel(paths.buildings)}, ${rel(paths.buildingsGeojson)}, ${rel(paths.publicBuildings)}`);
