// Data validation: colours, station identity, topology against reality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, paths, readJson, MetroConfig as C } from '../scripts/lib/common.mjs';

const haveNet = fs.existsSync(paths.edges);
const skip = !haveNet && 'run npm run fetch-topology && npm run data';
const stations = haveNet ? readJson(paths.stations).stations : [];
const edgesDoc = haveNet ? readJson(paths.edges) : { edges: [], lines: {} };
const join = haveNet ? readJson(paths.joinReport) : null;
const byName = (n) => stations.filter((s) => s.name === n);
const one = (n) => { const m = byName(n); assert.equal(m.length, 1, `exactly one station called ${n} (found ${m.length})`); return m[0]; };

// ------------------------------------------------------------------ colours
test('line colours equal SL\'s official screen colours', () => {
  const official = readJson(paths.colourManifest).extracted;
  const css = fs.readFileSync(path.join(path.dirname(paths.colourManifest), 'sl-se-stylesheet.css'), 'utf8');
  for (const l of C.LINES) {
    const hex = official[l.cssToken];
    assert.ok(css.includes(`${l.cssToken}:${hex}`), `${l.cssToken} in archived stylesheet`);
    assert.equal(l.colour, hex.toUpperCase(), l.id);
    assert.deepEqual([...l.rgb], [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), l.id);
  }
  assert.deepEqual(C.LINES.map((l) => l.rgb.join(',')), ['0,125,184', '215,29,36', '20,133,65']);
});

test('colours are defined only in the shared config', () => {
  const colours = [...C.LINES.map((l) => l.colour), ...C.CONTOURS.flatMap((c) => [c.fill, c.outline]), ...C.COMPANIES.flatMap((c) => [c.colour, c.developmentColour])];
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'vendor', 'data', 'raw', 'dist', 'reports', '.git'].includes(e.name)) walk(p); }
      else if (/\.(m?js|css|html|py)$/.test(e.name) && !p.endsWith(path.join('shared', 'config.js'))) files.push(p);
    }
  })(ROOT);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').toUpperCase();
    for (const c of colours) assert.ok(!text.includes(c.toUpperCase()), `${path.relative(ROOT, f)} hard-codes ${c}`);
  }
});

test('walking-area and company colours do not clash with line colours', () => {
  const dist = (a, b) => Math.hypot(...[1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
  for (const l of C.LINES) {
    for (const c of C.CONTOURS) assert.ok(dist(l.colour, c.fill) > 120, `${c.label} vs ${l.name}`);
    for (const c of C.COMPANIES) assert.ok(dist(l.colour, c.colour) > 120, `${c.name} vs ${l.name}`);
  }
  assert.deepEqual(C.CONTOUR_SECONDS, [300, 600]);
  assert.equal(C.WALKING_SPEED_MPS, 1.4);
});

// --------------------------------------------------------------- sources
test('topology comes from the stored GTFS download with a manifest', { skip }, () => {
  const m = readJson(paths.topologyManifest);
  assert.match(m.url, /opendata\.samtrafiken\.se\/gtfs\/sl\/sl\.zip\?key=REDACTED$/);
  assert.ok(m.retrievedAt && m.archive.sha256.length === 64);
  assert.match(m.licence.name, /CC0/);
  const routes = m.metroSubset.routes.map((r) => r.shortName).sort((a, b) => a - b);
  for (const r of Object.keys(C.LINE_ID_BY_ROUTE)) assert.ok(routes.includes(r), `route ${r} in feed`);
  // The key never reaches the repository.
  for (const f of fs.readdirSync(paths.gtfsMetro)) assert.ok(!/key=(?!REDACTED)\w/.test(fs.readFileSync(path.join(paths.gtfsMetro, f), 'utf8')), f);
});

test('every edge is a consecutive pair in an operator stop pattern (no inferred connections)', { skip }, () => {
  const { patterns } = readJson(path.join(paths.gtfsMetro, 'patterns.json'));
  const stopTo = new Map();
  stations.forEach((s) => s.platformStopIds.forEach((p) => stopTo.set(p, s.id)));
  const pairs = new Set();
  for (const p of patterns) for (let i = 0; i + 1 < p.stopIds.length; i++) {
    const a = stopTo.get(p.stopIds[i]), b = stopTo.get(p.stopIds[i + 1]);
    pairs.add(`${a}|${b}|${C.LINE_ID_BY_ROUTE[p.route]}`); pairs.add(`${b}|${a}|${C.LINE_ID_BY_ROUTE[p.route]}`);
  }
  const removed = readJson(paths.overrides).addEdges || [];
  for (const e of edgesDoc.edges) for (const l of e.lines) {
    const added = removed.some((o) => o.line === l.line && [o.a, o.b].sort().join() === [e.aName, e.bName].sort().join());
    assert.ok(added || pairs.has(`${e.a}|${e.b}|${l.line}`), `${e.aName}–${e.bName} (${l.line})`);
  }
});

// --------------------------------------------------------------- stations
test('every operator record joins a station; no merges of conflicting names', { skip }, () => {
  assert.deepEqual(join.unmappedPatternStops, []);
  assert.deepEqual(join.nameConflicts, []);
  assert.deepEqual(join.unusedAliases, []);
  const mapped = new Set(stations.flatMap((s) => s.platformStopIds));
  const clean = readJson(paths.stationsClean);
  for (const p of clean.platforms) assert.ok(mapped.has(p.stopId), `platform ${p.stopId} ${p.name}`);
  for (const l of join.links) assert.ok(l.distanceM <= join.maxJoinDistanceM, `${l.aName}–${l.bName}`);
  assert.equal(new Set(stations.map((s) => s.id)).size, stations.length);
});

test('physical stations: 100 metro stations, interchanges merged once', { skip }, () => {
  assert.equal(stations.length, 100);
  assert.deepEqual(one('T-Centralen').lines, ['blue', 'red', 'green']);
  assert.deepEqual(one('Fridhemsplan').lines, ['blue', 'green']);
  assert.deepEqual(one('Slussen').lines, ['red', 'green']);
  assert.deepEqual(one('Gamla stan').lines, ['red', 'green']);
  assert.deepEqual(stations.filter((s) => s.interchange).map((s) => s.name).sort(), ['Fridhemsplan', 'Gamla stan', 'Slussen', 'T-Centralen']);
});

test('known separate complexes with similar names stay separate', { skip }, () => {
  const pairs = [['Rådhuset', 'Rådmansgatan'], ['Hallonbergen', 'Hallunda'], ['Alby', 'Alvik'], ['Solna centrum', 'Solna strand'],
    ['Stadshagen', 'Stadion'], ['Skarpnäck', 'Skärmarbrink'], ['Hagsätra', 'Hägerstensåsen'], ['Mälarhöjden', 'Mariatorget'],
    ['Tekniska högskolan', 'Telefonplan'], ['Västra skogen', 'Västertorp'], ['Kista', 'Kungsträdgården']];
  for (const [a, b] of pairs) assert.notEqual(one(a).id, one(b).id, `${a} / ${b}`);
});

// ------------------------------------------------------------------ network
const expectLine = {
  blue: { termini: ['Akalla', 'Hjulsta', 'Kungsträdgården'], junctions: ['Västra skogen'] },
  red: { termini: ['Fruängen', 'Mörby centrum', 'Norsborg', 'Ropsten'], junctions: ['Liljeholmen', 'Östermalmstorg'] },
  green: { termini: ['Farsta strand', 'Hagsätra', 'Hässelby strand', 'Skarpnäck'], junctions: ['Gullmarsplan', 'Skärmarbrink'] }
};
// Route termini as given in the brief: Hjulsta / Akalla ↔ Kungsträdgården; Norsborg ↔ Ropsten,
// Fruängen ↔ Mörby centrum; Åkeshov ↔ Skarpnäck, Alvik ↔ Farsta strand, Hässelby strand ↔ Hagsätra.
const expectRoute = {
  10: ['Hjulsta', 'Kungsträdgården'], 11: ['Akalla', 'Kungsträdgården'],
  13: ['Norsborg', 'Ropsten'], 14: ['Fruängen', 'Mörby centrum'],
  17: ['Skarpnäck', 'Åkeshov'], 18: ['Alvik', 'Farsta strand'], 19: ['Hagsätra', 'Hässelby strand']
};
const sv = (a) => a.slice().sort((x, y) => x.localeCompare(y, 'sv'));

for (const l of C.LINES) {
  test(`${l.name}: one connected tree with the real termini and branch junctions`, { skip }, () => {
    const s = edgesDoc.lines[l.id];
    assert.equal(s.components.length, 1, 'connected');
    assert.equal(s.cycles, 0, 'no cycles');
    assert.deepEqual(sv(s.termini), sv(expectLine[l.id].termini));
    assert.deepEqual(sv(s.junctions.map((j) => j.name)), sv(expectLine[l.id].junctions));
    for (const r of l.routes) {
      const rs = s.routes[r];
      assert.equal(rs.components.length, 1, `route ${r} connected`);
      assert.deepEqual(sv(rs.termini), sv(expectRoute[r]), `route ${r} termini`);
    }
  });
}

test('red and green share track Slussen–Gamla stan–T-Centralen (drawn side by side)', { skip }, () => {
  const shared = edgesDoc.edges.filter((e) => e.lines.length > 1).map((e) => [e.aName, e.bName].sort().join('–')).sort();
  assert.deepEqual(shared, ['Gamla stan–Slussen', 'Gamla stan–T-Centralen']);
  for (const e of edgesDoc.edges.filter((x) => x.lines.length > 1)) assert.deepEqual(e.lines.map((x) => x.line), ['red', 'green']);
});

test('no implausibly long edges; validation report has no errors', { skip }, () => {
  for (const e of edgesDoc.edges) assert.ok(e.lengthM < 3500, `${e.aName}–${e.bName} ${e.lengthM} m`);
  const v = readJson(paths.validation);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.unusedOverrides, []);
});
