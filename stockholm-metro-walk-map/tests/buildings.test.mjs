// Portfolio tests: parsing, address handling, geocode sanity, size join,
// fresh point-in-polygon checks, report verification and browser-script syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, paths, readJson, MetroConfig as C, MetroGeometry as G } from '../scripts/lib/common.mjs';
import { expandStreet, parseAddress, yearBuilt } from '../scripts/lib/address.mjs';

const clean = readJson(paths.buildingsClean);
const byId = Object.fromEntries(clean.buildings.map((b) => [b.id, b]));
const haveAssigned = fs.existsSync(paths.buildings);

// ------------------------------------------------------------------ parsing
test('workbook parsing: counts per company, status and classification', () => {
  const bs = clean.buildings;
  assert.equal(bs.length, 99);
  assert.ok(bs.every((b) => b.company === 'Fabege'));
  const count = (f) => bs.filter(f).length;
  assert.equal(count((b) => b.classification === 'Investment'), 66);
  assert.equal(count((b) => b.classification === 'Development'), 14);
  assert.equal(count((b) => b.classification === 'Land & project'), 19);
  // Standing = Investment; Development = Development + Land & project (user decision).
  assert.ok(bs.every((b) => b.status === (b.classification === 'Investment' ? 'Standing' : 'Development')));
  assert.equal(count((b) => !b.excluded && b.status === 'Standing'), 64);
  assert.equal(count((b) => !b.excluded && b.status === 'Development'), 33);
  assert.deepEqual(bs.filter((b) => b.excluded).map((b) => b.area), ['Borås', 'Borås']);
  assert.equal(new Set(bs.map((b) => b.id)).size, 99);
  assert.deepEqual(clean.issues.filter((i) => i.type !== 'area-sum-mismatch'), []);
});

test('abbreviated Swedish street names are expanded, full names kept', () => {
  assert.equal(expandStreet('Döbelnsg').street, 'Döbelnsgatan');
  assert.equal(expandStreet('Svetsarv').street, 'Svetsarvägen');
  assert.equal(expandStreet('Gamla Brog').street, 'Gamla Brogatan');
  assert.equal(expandStreet('Birger Jarlsg').street, 'Birger Jarlsgatan');
  for (const full of ['Råsta strandväg', 'Hammarby Fabriksväg', 'Hammarby Kaj', 'Hammarby Allé', 'Gustav III:s boulevard', 'Garvis Carlssons gata', 'Mathildatorget', 'Frösundaleden', 'Glödlampsgränd']) {
    assert.equal(expandStreet(full).street, full);
  }
});

test('address parsing keeps every street and listed house number', () => {
  assert.deepEqual(parseAddress('Döbelnsg 20, 24, Kungstensg 21–23, Rådmansg 40, 42, Tuleg 7 A–B 13').map((a) => [a.street, a.numbers]),
    [['Döbelnsgatan', ['20', '24']], ['Kungstensgatan', ['21']], ['Rådmansgatan', ['40', '42']], ['Tulegatan', ['7A']]]);
  assert.deepEqual(parseAddress('Hammarby Kaj 12, Hammarby Kaj 14–18').map((a) => [a.street, a.numbers]), [['Hammarby Kaj', ['12', '14']]]);
  assert.deepEqual(parseAddress('Malmskillnadsg 47 A, B').map((a) => a.numbers), [['47A']]);
  assert.deepEqual(parseAddress('Kungsbroplan 3, etc.').map((a) => a.street), ['Kungsbroplan']);
  assert.deepEqual(parseAddress('Glasfibergatan 6–14 and others').map((a) => [a.street, a.number]), [['Glasfibergatan', '6']]);
  assert.deepEqual(parseAddress('Gustav III:s boulevard').map((a) => [a.street, a.number]), [['Gustav III:s boulevard', null]]);
  assert.deepEqual(parseAddress(null), []);
});

test('construction year: latest year is used, blank stays unknown', () => {
  assert.equal(yearBuilt('1902/2002'), 2002);
  assert.equal(yearBuilt('1904/1929'), 1929);
  assert.equal(yearBuilt('1963'), 1963);
  assert.equal(yearBuilt(1963), 1963);
  assert.equal(yearBuilt(null), null);
  assert.equal(yearBuilt(''), null);
  assert.equal(byId['FAB-SIC-01'].yearBuilt, 2002);
  assert.equal(byId['FAB-SIC-17'].yearBuilt, 1881);
  assert.equal(clean.buildings.filter((b) => b.yearBuilt == null).length, 14);
  for (const b of clean.buildings) if (b.yearBuilt != null) assert.ok(b.yearBuilt >= 1800 && b.yearBuilt <= 2026, b.id);
});

// ---------------------------------------------------------------- geocoding
test('every property has a recorded geocode precision; counts are reported', () => {
  const allowed = ['building', 'street', 'area', 'unlocated', 'excluded'];
  for (const b of clean.buildings) assert.ok(allowed.includes(b.geocode?.precision), b.id);
  const tally = clean.buildings.reduce((m, b) => ((m[b.geocode.precision] = (m[b.geocode.precision] || 0) + 1), m), {});
  assert.deepEqual(clean.geocodePrecisionCounts, tally);
  assert.equal(tally.excluded, 2);
  assert.ok(tally.building >= 60, JSON.stringify(tally));
});

test('geocodes are plausible: inside Stockholm county, on the source street, near the centre', () => {
  for (const b of clean.buildings.filter((x) => x.lon != null)) {
    assert.ok(b.lon > 17.55 && b.lon < 18.75 && b.lat > 58.95 && b.lat < 59.65, `${b.id} outside the county box`);
    assert.ok(G.haversineM([b.lon, b.lat], C.CITY_CENTRE) < 30000, `${b.id} too far from the centre`);
    if (b.geocode.method === 'address' || b.geocode.method === 'street') {
      const streets = b.addresses.map((a) => a.street.toLowerCase());
      assert.ok(streets.includes(String(b.geocode.road).toLowerCase()), `${b.id} on ${b.geocode.road}`);
    }
  }
  const inner = clean.buildings.filter((b) => b.region === 'Stockholm inner city');
  for (const b of inner) assert.ok(G.haversineM([b.lon, b.lat], C.CITY_CENTRE) < 4000, `${b.id} inner-city property far from the centre`);
});

test('known geocoding traps are handled', () => {
  const d = (a, b) => G.haversineM([byId[a].lon, byId[a].lat], [byId[b].lon, byId[b].lat]);
  // "Enlundavägen" is a typo for Englundavägen (Solna Business Park).
  assert.equal(byId['FAB-SOL-33'].geocode.road, 'Englundavägen');
  assert.ok(d('FAB-SOL-33', 'FAB-SOL-32') < 300);
  // Sveavägen 149 sits between 143–147 and 159, not 500 m south.
  assert.ok(d('FAB-SIC-10', 'FAB-SIC-11') < 300 && d('FAB-SIC-10', 'FAB-SIC-12') < 300);
  // Malmskillnadsgatan 47 is in the same block as Luntmakargatan 18.
  assert.ok(d('FAB-SIC-20', 'FAB-SIC-19') < 300);
  // Long Kolonnvägen: No. 24 next to No. 22 (Arenastaden), 57–59 next to 43–55 (Ulriksdal).
  assert.ok(d('FAB-SOL-12', 'FAB-SOL-15') < 300 && d('FAB-SOL-44', 'FAB-SOL-43') < 300);
  // Haga Norra properties are in Haga Norra / Hagalund, not in Skytteholm or Ulriksdal.
  for (const id of ['FAB-SOL-36', 'FAB-SOL-37', 'FAB-SOL-41']) assert.ok(d(id, 'FAB-SOL-35') < 700, id);
  // A municipality is never accepted as an "area" location.
  assert.equal(byId['FAB-OTH-01'].geocode.precision, 'unlocated');
  const ov = readJson(paths.geocodeReview);
  assert.deepEqual(ov.unusedOverrides, []);
});

// -------------------------------------------------------------------- sizes
test('floor areas join by asset ID with a name check; 0 or blank is unknown', () => {
  const sizes = readJson(paths.buildingSizes);
  assert.equal(Object.keys(sizes.sizes).length + sizes.unknown.length, 99);
  assert.ok(Object.values(sizes.sizes).every((v) => v > 0));
  for (const u of sizes.unknown) assert.ok(!(u.id in sizes.sizes));
  assert.equal(sizes.sizes['FAB-SOL-13'], 72234); // Pyramiden 4
  assert.ok(sizes.unknown.some((u) => u.id === 'FAB-SIC-05')); // Bocken 46: 0 in source
  for (const [id, v] of Object.entries(sizes.sizes)) assert.equal(v, byId[id].totalLettableSqmSource, id);
});

// ------------------------------------------------- assignment & statistics
test('fresh point-in-polygon checks reproduce every assignment', { skip: !haveAssigned && 'run npm run buildings' }, () => {
  const iso = readJson(paths.isochrones);
  const bdoc = readJson(paths.buildings);
  const polys = iso.features.map((f) => ({ id: f.properties.stationId, sec: f.properties.seconds, p: G.toPolygons(f.geometry) }));
  for (const b of bdoc.buildings) {
    if (!b.inAnalysis) { assert.deepEqual(b.stations, {}); continue; }
    const fresh = {};
    for (const x of polys) if (G.pointInPolygons([b.lon, b.lat], x.p)) fresh[x.id] = Math.min(fresh[x.id] ?? Infinity, x.sec);
    assert.deepEqual(fresh, b.stations, b.id);
  }
  // Not-in-analysis properties: Borås (2) and unlocated.
  assert.deepEqual(bdoc.buildings.filter((b) => !b.inAnalysis).map((b) => b.id).sort(), ['FAB-OTH-01', 'FAB-OTH-03', 'FAB-OTH-04']);
});

test('Excel report recalculates without errors and matches the pipeline', { skip: !fs.existsSync(path.join(ROOT, 'reports', 'report-verification.json')) && 'run npm run report' }, () => {
  const v = readJson(path.join(ROOT, 'reports', 'report-verification.json'));
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.formulaErrors, []);
  assert.deepEqual(v.mismatches, []);
  assert.ok(v.checkedCells > 50 && v.totalFormulas > 100);
});

// ------------------------------------------------------------ browser code
test('all browser scripts and generated data files parse', () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'public'));
  assert.ok(files.length >= 6);
  for (const f of files) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }), path.relative(ROOT, f));
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(app), 'app.js must not assign innerHTML');
});
