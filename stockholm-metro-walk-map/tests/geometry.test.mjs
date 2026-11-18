// Geometry tests: union correctness, invalid input handling, simplification,
// and checks that generated isochrones are network-shaped, not buffers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paths, readJson, MetroGeometry as G, MetroConfig, polygonClipping as pc } from '../scripts/lib/common.mjs';

const square = (x, y, s) => ({ type: 'Polygon', coordinates: [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]] });

test('union of two overlapping squares is one polygon with the correct area', () => {
  const r = G.unionGeometries([square(0, 0, 0.01), square(0.005, 0, 0.01)], pc);
  assert.equal(r.polygons.length, 1);
  const a = G.areaM2(r.polygons);
  const single = G.areaM2(square(0, 0, 0.01));
  assert.ok(Math.abs(a / single - 1.5) < 0.01, `ratio ${a / single}`);
});

test('union keeps disjoint parts and preserves holes', () => {
  const ring = { type: 'Polygon', coordinates: [
    [[0, 0], [0.03, 0], [0.03, 0.03], [0, 0.03], [0, 0]],
    [[0.01, 0.01], [0.01, 0.02], [0.02, 0.02], [0.02, 0.01], [0.01, 0.01]]
  ] };
  const r = G.unionGeometries([ring, square(1, 1, 0.01)], pc);
  assert.equal(r.polygons.length, 2);
  const withHole = r.polygons.find((p) => p.length === 2);
  assert.ok(withHole, 'hole preserved');
});

test('union area is between the largest input and the sum of inputs', () => {
  const geoms = [square(0, 0, 0.01), square(0.004, 0.004, 0.01), square(0.02, 0, 0.005)];
  const areas = geoms.map((g) => G.areaM2(g));
  const u = G.areaM2(G.unionGeometries(geoms, pc).polygons);
  assert.ok(u >= Math.max(...areas) && u <= areas.reduce((s, v) => s + v, 0));
});

test('invalid geometries are cleaned or skipped, never crash the union', () => {
  const bad = [
    null,
    { type: 'Point', coordinates: [0, 0] },
    { type: 'Polygon', coordinates: [[[0, 0], [NaN, 1], [1, 1]]] },          // too few valid points
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] },    // zero area
    { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]]] } // unclosed but valid
  ];
  const r = G.unionGeometries(bad, pc);
  assert.equal(r.skipped, 4);
  assert.equal(r.polygons.length, 1);
  assert.equal(G.toPolygons({ type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0.01, 0], [0.01, 0.01], [0, 0]]] })[0][0].length, 4);
});

test('self-overlapping MultiPolygon input is resolved by union', () => {
  const mp = { type: 'MultiPolygon', coordinates: [square(0, 0, 0.01).coordinates, square(0.005, 0.005, 0.01).coordinates] };
  const r = G.unionGeometries([mp], pc);
  assert.equal(r.polygons.length, 1);
});

test('Douglas-Peucker simplification keeps rings valid and closed', () => {
  const pts = [];
  for (let i = 0; i <= 64; i++) { const t = (i / 64) * 2 * Math.PI; pts.push([Math.cos(t) * 0.01, Math.sin(t) * 0.01 + (i % 2) * 1e-7]); }
  pts[pts.length - 1] = pts[0];
  const s = G.simplifyGeometry({ type: 'Polygon', coordinates: [pts] }, 0.0005, 5);
  const ring = s.coordinates[0];
  assert.ok(ring.length < pts.length && ring.length >= 4);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

test('haversine distance is correct (T-Centralen to Slussen ~ 1.3 km)', () => {
  const d = G.haversineM([18.0596, 59.3313], [18.0717, 59.3195]);
  assert.ok(d > 1300 && d < 1600, String(d));
});

test('radialStats distinguishes a circle from an irregular shape', () => {
  const k = Math.cos(59.3 * Math.PI / 180); // keeps the shape round in metres
  const ring = (n, radius) => {
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = (i / n) * 2 * Math.PI; const r = radius(i); pts.push([18 + Math.cos(t) * r, 59.3 + Math.sin(t) * r * k]); }
    pts[pts.length - 1] = pts[0];
    return { type: 'Polygon', coordinates: [pts] };
  };
  assert.ok(G.radialStats(ring(72, () => 0.006), [18, 59.3]).cv < 0.01);
  assert.ok(G.radialStats(ring(40, (i) => (i % 2 ? 0.006 : 0.002)), [18, 59.3]).cv > 0.3);
});

// ----------------------------------------------- generated isochrone checks
const haveIso = fs.existsSync(paths.isochrones);

test('isochrones come from a pedestrian routing engine with recorded provenance', { skip: !haveIso && 'run npm run isochrones' }, () => {
  const iso = readJson(paths.isochrones);
  assert.ok(iso.metadata.providers.length >= 1);
  for (const f of fs.readdirSync(paths.isoDir).filter((n) => /^SL.*\.json$/.test(n))) {
    const rec = readJson(`${paths.isoDir}/${f}`);
    assert.ok(['valhalla', 'openrouteservice'].includes(rec.provider), f);
    assert.ok(['pedestrian', 'foot-walking'].includes(rec.profile), f);
    assert.ok(rec.generatedAt && rec.parameters && rec.paramsHash, f);
    assert.deepEqual(rec.features.map((x) => x.properties.seconds), [300, 600]);
  }
});

test('isochrones are not circular buffers and are nested 5 ⊆ 10 minutes', { skip: !haveIso && 'run npm run isochrones' }, () => {
  const iso = readJson(paths.isochrones);
  const stations = readJson(paths.stations).stations;
  const by = new Map();
  for (const f of iso.features) {
    if (!by.has(f.properties.stationId)) by.set(f.properties.stationId, {});
    by.get(f.properties.stationId)[f.properties.seconds] = f.geometry;
  }
  let irregular = 0;
  for (const s of stations) {
    const g = by.get(s.id);
    if (!g) continue;
    for (const sec of MetroConfig.CONTOUR_SECONDS) assert.ok(G.isValidPolygonal(g[sec]), `${s.name} ${sec}`);
    const [a5, a10] = [g[300], g[600]].map((x) => G.areaM2(x));
    assert.ok(a5 <= a10 * 1.001, `${s.name} nesting ${a5} ${a10}`);
    // A walk at ~1.4 m/s can never exceed 420 m (5 min) or 840 m (10 min) in a straight line.
    assert.ok(a5 < Math.PI * 420 * 420 * 1.15, `${s.name} 5-min area too large: ${a5}`);
    assert.ok(a10 < Math.PI * 840 * 840 * 1.15, `${s.name} 10-min area too large: ${a10}`);
    const st = G.radialStats(g[300], [s.lon, s.lat]);
    if (st.cv > 0.08) irregular++;
  }
  // Network isochrones are irregular; buffers would have cv ~ 0.
  assert.ok(irregular / by.size > 0.9, `only ${irregular}/${by.size} irregular`);
});

test('precomputed unions equal fresh unions and dedupe interchanges', { skip: !fs.existsSync(paths.unions) && 'run npm run unions' }, () => {
  const unions = readJson(paths.unions);
  const iso = readJson(paths.isochrones);
  const stations = readJson(paths.stations).stations;
  for (const l of MetroConfig.LINES) {
    for (const sec of MetroConfig.CONTOUR_SECONDS) {
      const ids = stations.filter((s) => s.lines.includes(l.id)).map((s) => s.id);
      const geoms = iso.features.filter((f) => f.properties.seconds === sec && ids.includes(f.properties.stationId)).map((f) => f.geometry);
      assert.equal(geoms.length, ids.length, `${l.id} ${sec}`);
      const freshPolys = G.unionGeometries(geoms, pc).polygons;
      const pre = unions.features.find((f) => f.properties.id === l.id && f.properties.seconds === sec);
      assert.equal(pre.properties.stationCount, ids.length);
      // Same area and (near) zero symmetric difference.
      const prePolys = G.toPolygons(pre.geometry);
      const fresh = G.areaM2(freshPolys);
      assert.ok(Math.abs(pre.properties.areaKm2 * 1e6 - fresh) / fresh < 0.001, `${l.id} ${sec} area`);
      const xor = G.areaM2(pc.xor(prePolys, freshPolys));
      assert.ok(xor / fresh < 0.001, `${l.id} ${sec} symmetric difference ${xor}`);
      assert.ok(fresh <= geoms.reduce((s, g) => s + G.areaM2(g), 0));
    }
  }
  // All-network union counts each physical station once.
  const all = unions.features.filter((f) => f.properties.scope === 'all');
  assert.equal(all.length, MetroConfig.CONTOUR_SECONDS.length);
  assert.equal(all[0].properties.stationCount, stations.filter((s) => s.lines.length).length);
});
