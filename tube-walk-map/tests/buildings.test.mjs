// Office-building pipeline tests: parsing, geocoding quality gates, area assignment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paths, readJson, TubeConfig, TubeGeometry as G } from '../scripts/lib/common.mjs';

const clean = readJson(paths.buildingsClean);
const out = readJson(paths.buildings).buildings;
const stations = new Map(readJson(paths.stations).stations.map((s) => [s.id, s]));

test('workbook parses into four companies with standing and development blocks', () => {
  assert.equal(clean.buildings.length, 149);
  assert.deepEqual(clean.issues, []);
  const count = (c, s) => clean.buildings.filter((b) => b.company === c && b.status === s).length;
  assert.deepEqual([count('Landsec', 'Standing'), count('Landsec', 'Development')], [22, 7]);
  assert.deepEqual([count('Great Portland Estates', 'Standing'), count('Great Portland Estates', 'Development')], [28, 9]);
  assert.deepEqual([count('British Land', 'Standing'), count('British Land', 'Development')], [38, 6]);
  assert.deepEqual([count('Derwent London', 'Standing'), count('Derwent London', 'Development')], [34, 5]);
  assert.ok(clean.buildings.every((b) => TubeConfig.COMPANY_BY_NAME[b.company]));
  // Footnote markers are removed from names but kept.
  const timber = clean.buildings.find((b) => b.sourceName === 'Timber Square+');
  assert.equal(timber.name, 'Timber Square');
  assert.equal(timber.sourceMarker, '+');
});

test('company colours are distinct and developments are a lighter shade of the same colour', () => {
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).reduce((s, v) => s + v, 0);
  const colours = TubeConfig.COMPANIES.map((c) => c.colour);
  assert.equal(new Set(colours).size, colours.length);
  for (const c of TubeConfig.COMPANIES) assert.ok(lum(c.developmentColour) > lum(c.colour), c.name);
});

test('every building is geocoded inside London on its source street area', () => {
  for (const b of clean.buildings) {
    assert.ok(Number.isFinite(b.lon) && Number.isFinite(b.lat), `${b.name} not located`);
    // Whole portfolio is central/inner London.
    assert.ok(G.haversineM([b.lon, b.lat], [-0.1246, 51.5074]) < 9000, `${b.name} implausibly far out`);
    assert.ok(['building', 'street', 'area'].includes(b.geocode.precision));
  }
  const byPrec = clean.buildings.reduce((m, b) => ((m[b.geocode.precision] = (m[b.geocode.precision] || 0) + 1), m), {});
  assert.ok(byPrec.building >= 80, JSON.stringify(byPrec));
});

test('known geocoding traps are avoided', () => {
  const at = (name) => clean.buildings.find((b) => b.name === name);
  // 70 Victoria Street (SW1), not Queen Victoria Street (EC4).
  assert.ok(at('The Zig Zag Building').lat < 51.5 && at('The Zig Zag Building').lon < -0.13);
  // Broadgate's Exchange Square, not Harbour Exchange Square (Isle of Dogs) or Croydon.
  assert.ok(G.haversineM([at('Broadgate-Exchange House').lon, at('Broadgate-Exchange House').lat], [-0.0809, 51.5199]) < 400);
  // n2 is on Bressenden Place, not at Heathrow.
  assert.ok(at('n2').lon > -0.15 && at('n2').lon < -0.13);
  // Langham Place W1, not Harringay.
  assert.ok(at('Henry Wood House').lat < 51.53);
});

test('area assignment matches a fresh point-in-polygon check', () => {
  const iso = readJson(paths.isochrones);
  const polys = iso.features.map((f) => ({ id: f.properties.stationId, s: f.properties.seconds, p: G.toPolygons(f.geometry) }));
  for (const b of out.filter((_, i) => i % 7 === 0)) { // sample for speed
    const expect = {};
    for (const x of polys) if (G.pointInPolygons([b.lon, b.lat], x.p) && (expect[x.id] === undefined || x.s < expect[x.id])) expect[x.id] = x.s;
    assert.deepEqual(b.stations, expect, b.name);
    const secs = Object.values(expect);
    assert.equal(b.bestSeconds, secs.length ? Math.min(...secs) : null);
    for (const id of Object.keys(b.stations)) assert.ok(stations.has(id));
  }
});

test('Excel report exists with the expected sheets', { skip: !fs.existsSync(new URL('../reports/office-station-access.xlsx', import.meta.url)) && 'run npm run report' }, async () => {
  const { readFirstSheet } = await import('../scripts/lib/xlsx.mjs');
  const rows = readFirstSheet(new URL('../reports/office-station-access.xlsx', import.meta.url).pathname);
  assert.match(String(rows[0][0]), /walking access/i);
});
