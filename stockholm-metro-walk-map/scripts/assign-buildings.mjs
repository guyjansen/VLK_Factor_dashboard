#!/usr/bin/env node
// Assign every located property to the walking areas it lies in.
// For each property and each station, the smallest contour (300/600 s) whose
// FULL-PRECISION isochrone contains the property point is recorded (fresh
// point-in-polygon tests). A property is "within N min" of a selection of
// stations when any selected station's N-minute area contains it, which is
// the same as lying inside their union.
//
// In the analysis: located properties (building / street / area precision).
// Not in the analysis: excluded (Borås) and unlocated properties; they are
// listed with the reason and never counted in shares.
//
// Inputs : data/buildings.clean.json (geocoded), data/building-sizes.json,
//          data/stations.json, data/isochrones.geojson
// Outputs: data/buildings.json, data/buildings.geojson, public/data/buildings.js
import { paths, readJson, writeJson, writeBrowserData, rel, MetroConfig, MetroGeometry as G, fail } from './lib/common.mjs';

let doc, stationsDoc, iso, sizesDoc;
try {
  doc = readJson(paths.buildingsClean);
  stationsDoc = readJson(paths.stations);
  iso = readJson(paths.isochrones);
  sizesDoc = readJson(paths.buildingSizes);
} catch (err) {
  fail(err.message, 'Run "npm run buildings:prepare && npm run buildings:geocode && npm run buildings:sizes" and the isochrone pipeline first.');
}
if (!doc.geocodedAt) fail('buildings are not geocoded yet', 'Run "npm run buildings:geocode".');
const stations = stationsDoc.stations.filter((s) => s.lines.length);
const byId = new Map(stations.map((s) => [s.id, s]));
const polys = [];
for (const f of iso.features) {
  const p = G.toPolygons(f.geometry);
  if (p.length && byId.has(f.properties.stationId)) polys.push({ stationId: f.properties.stationId, seconds: f.properties.seconds, polygons: p, bbox: G.bbox(p) });
}
const MAX = Math.max(...MetroConfig.CONTOUR_SECONDS);

const out = [];
for (const b of doc.buildings) {
  const sqm = sizesDoc.sizes[b.id];
  const located = Number.isFinite(b.lon) && Number.isFinite(b.lat);
  const rec = {
    ...b,
    sqm: Number.isFinite(sqm) ? sqm : null,
    inAnalysis: located && !b.excluded,
    notInAnalysisReason: b.excluded ? b.excludedReason : located ? null : `Not located (${b.geocode?.note || 'no geocode'})`,
    stations: {}, bestSeconds: null, bestSecondsByLine: {}, nearestStation: null
  };
  if (located) {
    const pt = [b.lon, b.lat];
    for (const p of polys) {
      if (pt[0] < p.bbox[0] || pt[0] > p.bbox[2] || pt[1] < p.bbox[1] || pt[1] > p.bbox[3]) continue;
      if (!G.pointInPolygons(pt, p.polygons)) continue;
      const cur = rec.stations[p.stationId];
      if (cur === undefined || p.seconds < cur) rec.stations[p.stationId] = p.seconds;
    }
    const secs = Object.values(rec.stations);
    rec.bestSeconds = secs.length ? Math.min(...secs) : null;
    for (const l of MetroConfig.LINES) {
      const v = Object.entries(rec.stations).filter(([sid]) => byId.get(sid).lines.includes(l.id)).map(([, s]) => s);
      rec.bestSecondsByLine[l.id] = v.length ? Math.min(...v) : null;
    }
    let best = null;
    for (const s of stations) {
      const d = G.haversineM(pt, [s.lon, s.lat]);
      if (!best || d < best.distanceM) best = { id: s.id, name: s.name, distanceM: Math.round(d), lines: s.lines };
    }
    rec.nearestStation = best;
  }
  out.push(rec);
}

const meta = {
  generatedAt: new Date().toISOString(),
  source: doc.source,
  statusRule: doc.statusRule,
  yearRule: doc.yearRule,
  geocoder: doc.geocoder,
  geocodedAt: doc.geocodedAt,
  precisionCounts: out.reduce((m, b) => ((m[b.geocode.precision] = (m[b.geocode.precision] || 0) + 1), m), {}),
  sizes: { source: sizesDoc.meta.source, column: sizesDoc.meta.column, unit: 'sqm', known: Object.keys(sizesDoc.sizes).length, unknown: sizesDoc.unknown.map((u) => u.id), note: sizesDoc.meta.note },
  isochrones: { providers: iso.metadata?.providers, generatedBetween: iso.metadata?.isochronesGeneratedBetween },
  notInAnalysis: out.filter((b) => !b.inAnalysis).map((b) => ({ id: b.id, name: b.name, reason: b.notInAnalysisReason })),
  method: 'Point-in-polygon of the geocoded property point against each station\'s full-precision 300/600 s (5/10 min) pedestrian isochrones.',
  caveat: 'Property positions come from geocoding street addresses; street- and area-level matches can be off by a few hundred metres.'
};
writeJson(paths.buildings, { meta, buildings: out });
writeJson(paths.buildingsGeojson, {
  type: 'FeatureCollection', metadata: meta,
  features: out.filter((b) => b.inAnalysis).map((b) => ({
    type: 'Feature',
    properties: { id: b.id, company: b.company, status: b.status, classification: b.classification, name: b.name, constructionYear: b.constructionYear, yearBuilt: b.yearBuilt, sqm: b.sqm, propertyType: b.propertyType, address: b.street, geocodePrecision: b.geocode.precision, bestWalkMinutes: b.bestSeconds ? b.bestSeconds / 60 : null, nearestStation: b.nearestStation?.name, nearestStationM: b.nearestStation?.distanceM },
    geometry: { type: 'Point', coordinates: [b.lon, b.lat] }
  }))
});
const r6 = (v) => Math.round(v * 1e6) / 1e6;
writeBrowserData(paths.publicBuildings, 'METRO_BUILDINGS', {
  meta,
  buildings: out.map((b) => ({
    id: b.id, company: b.company, status: b.status, classification: b.classification, name: b.name, street: b.street, area: b.area,
    propertyType: b.propertyType, constructionYear: b.constructionYear, yearBuilt: b.yearBuilt, lon: b.lon == null ? null : r6(b.lon), lat: b.lat == null ? null : r6(b.lat),
    precision: b.geocode.precision, geocoded: b.geocode.displayName, stations: b.stations, nearest: b.nearestStation, sqm: b.sqm,
    inAnalysis: b.inAnalysis, notInAnalysisReason: b.notInAnalysisReason
  }))
});

const inA = out.filter((b) => b.inAnalysis);
console.log(`Properties: ${out.length}; in analysis: ${inA.length}; not in analysis: ${out.length - inA.length} (${meta.notInAnalysis.map((x) => x.id).join(', ')})`);
for (const c of MetroConfig.COMPANIES) {
  for (const status of [null, ...MetroConfig.STATUSES]) {
    const bs = inA.filter((b) => b.company === c.name && (!status || b.status === status));
    const share = (sec) => `${bs.filter((b) => b.bestSeconds && b.bestSeconds <= sec).length}/${bs.length}`;
    console.log(`  ${c.name} ${(status || 'All').padEnd(11)} ≤5 min ${share(300).padEnd(7)} ≤10 min ${share(MAX)}`);
  }
}
console.log(`Wrote ${rel(paths.buildings)}, ${rel(paths.buildingsGeojson)}, ${rel(paths.publicBuildings)}`);
