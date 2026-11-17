// Data and network correctness tests. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paths, readJson, TubeConfig, TubeGeometry } from '../scripts/lib/common.mjs';
import { parseCsv, parseStationsCsv, parseStationTable, parseLines } from '../scripts/lib/csv.mjs';
import { readFirstSheet } from '../scripts/lib/xlsx.mjs';
import { osgbToWgs84 } from '../scripts/lib/osgb.mjs';
import { nameKey, baseNameKey } from '../scripts/lib/names.mjs';

const stations = readJson(paths.stations).stations;
const edgesDoc = readJson(paths.edges);
const join = readJson(paths.joinReport);
const byName = (n) => stations.find((s) => s.name === n);
const lineAdj = (lineId) => {
  const adj = new Map();
  for (const e of edgesDoc.edges) {
    if (!e.lines.some((l) => l.line === lineId)) continue;
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
      if (!adj.has(x)) adj.set(x, new Set());
      adj.get(x).add(y);
    }
  }
  return adj;
};
const nameOf = (id) => stations.find((s) => s.id === id).name;
const hasEdge = (line, a, b) => edgesDoc.edges.some((e) => e.lines.some((l) => l.line === line) &&
  ((nameOf(e.a) === a && nameOf(e.b) === b) || (nameOf(e.a) === b && nameOf(e.b) === a)));

// ------------------------------------------------------------- colours
test('line colours match TfL Colour standard Issue 11 RGB values (sections 5 and 3)', () => {
  const expected = {
    bakerloo: [178, 99, 0], central: [220, 36, 31], circle: [255, 200, 10], district: [0, 125, 50],
    'hammersmith-city': [245, 137, 166], jubilee: [131, 141, 147], metropolitan: [155, 0, 88],
    northern: [0, 0, 0], piccadilly: [0, 25, 168], victoria: [3, 155, 229], 'waterloo-city': [118, 208, 189],
    elizabeth: [96, 57, 158] // section 3 "Mode colours"
  };
  assert.equal(TubeConfig.LINES.length, 12);
  assert.equal(TubeConfig.LINES.filter((l) => l.mode === 'tube').length, 11);
  assert.equal(TubeConfig.LINE_BY_ID.elizabeth.mode, 'elizabeth-line');
  for (const l of TubeConfig.LINES) {
    assert.deepEqual([...l.rgb], expected[l.id], l.name);
    assert.equal(l.colour, '#' + expected[l.id].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  assert.equal(TubeConfig.LINE_BY_ID.circle.colour, '#FFC80A');
  assert.equal(TubeConfig.LINE_BY_ID['hammersmith-city'].colour, '#F589A6');
});

test('colours are defined only in the central config (no hard-coded line hex in app code)', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  for (const l of TubeConfig.LINES) {
    if (l.id === 'northern') continue; // #000000 is too generic to check
    assert.ok(!app.toUpperCase().includes(l.colour), `${l.name} colour hard-coded in app.js`);
  }
});

// ------------------------------------------------------------- CSV parsing
test('CSV parser handles quotes, embedded commas, escaped quotes, CRLF and BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","He said ""hi""",3\r\nplain,,\n');
  assert.deepEqual(rows.map((r) => r.cells), [['a', 'b', 'c'], ['x, y', 'He said "hi"', '3'], ['plain', '', '']]);
  assert.throws(() => parseCsv('a,"unterminated\n'), /Unterminated/);
});

test('LINES field splits into canonical ids and keeps "Hammersmith & City" whole', () => {
  assert.deepEqual(parseLines('District, Hammersmith & City, Central').ids, ['district', 'hammersmith-city', 'central']);
  assert.deepEqual(parseLines('  Waterloo & City ,Northern').ids, ['waterloo-city', 'northern']);
  assert.deepEqual(parseLines('Overground').unknown, ['Overground']);
  assert.deepEqual(parseLines('Central, Jubilee, Elizabeth line').ids, ['central', 'jubilee', 'elizabeth']);
});

test('station CSV: malformed rows are reported, valid names keep punctuation', () => {
  const csv = 'NAME,Longitude,Latitude,LINES,OBJECTID\n' +
    '"St. John\'s Wood",-0.174,51.535,Jubilee,1\n' +
    'Bad Row,abc,51.5,Central,2\n' +
    'Harrow-on-the-Hill,-0.336,51.579,"Metropolitan",x\n';
  const { records, issues } = parseStationsCsv(csv);
  assert.equal(records[0].name, "St. John's Wood");
  assert.ok(issues.some((i) => i.type === 'malformed-row' && i.objectId === '2'));
  assert.ok(issues.some((i) => i.type === 'malformed-row' && /OBJECTID/.test(i.problems.join())));
  assert.throws(() => parseStationsCsv('NAME,Longitude\nx,1\n'), /missing required column/);
});

test('original Underground CSV still parses without issues', () => {
  const { records, issues } = parseStationsCsv(fs.readFileSync(paths.csv, 'utf8'));
  assert.equal(records.length, 273);
  assert.equal(issues.length, 0);
});

test('station workbook (xlsx, British National Grid) parses and converts to WGS84', () => {
  const rows = readFirstSheet(paths.xlsx);
  assert.deepEqual(rows[0].slice(0, 5), ['X', 'Y', 'OBJECTID', 'NAME', 'LINES']);
  const { records, issues, coordinateSystem } = parseStationTable(rows[0], rows.slice(1).map((cells, i) => ({ line: i + 2, cells })), { toWgs84: osgbToWgs84 });
  assert.match(coordinateSystem, /27700/);
  assert.equal(records.length, 302);
  assert.equal(issues.length, 0);
  assert.equal(records.filter((r) => r.lines.includes('elizabeth')).length, 42); // incl. both Paddington records
  // The converted coordinates reproduce the original WGS84 CSV for all 273 shared records.
  const old = new Map(parseStationsCsv(fs.readFileSync(paths.csv, 'utf8')).records.map((r) => [r.objectId, r]));
  let compared = 0;
  for (const r of records) {
    const o = old.get(r.objectId);
    if (!o) continue;
    compared++;
    assert.ok(TubeGeometry.haversineM([r.lon, r.lat], [o.lon, o.lat]) < 0.5, r.name);
  }
  assert.equal(compared, 273);
});

test('OSGB conversion is plausible for a known point (Reading station)', () => {
  const [lon, lat] = osgbToWgs84(471454.5635, 173862.6427);
  assert.ok(TubeGeometry.haversineM([lon, lat], [-0.9719, 51.4588]) < 120, `${lon},${lat}`);
});

test('every station record and every TfL stop joins; no conflicting merges', () => {
  assert.equal(join.csvRecordCount, 302);
  assert.equal(join.unmatchedCsv.length, 0, JSON.stringify(join.unmatchedCsv));
  assert.equal(join.topologyStopsWithoutCsv.length, 0, JSON.stringify(join.topologyStopsWithoutCsv));
  assert.equal(join.groupNameConflicts.length, 0);
});

test('name keys normalise punctuation but keep qualifiers', () => {
  assert.equal(nameKey("St. Paul's Underground Station"), nameKey("St. Paul's"));
  assert.equal(nameKey('Paddington (H&C Line)-Underground'), 'paddington (h and c line)');
  assert.notEqual(nameKey('Edgware Road (Circle Line)'), nameKey('Edgware Road (Bakerloo)'));
  assert.equal(baseNameKey('Edgware Road (Bakerloo)'), 'edgware road');
});

// ------------------------------------------------------- special stations
test('duplicate Paddington records collapse to one physical station; H&C Paddington stays separate', () => {
  const pads = stations.filter((s) => /^Paddington/.test(s.name));
  assert.equal(pads.length, 2);
  const main = byName('Paddington');
  assert.equal(main.duplicateRecords.length, 1);
  assert.deepEqual(main.lines, ['bakerloo', 'circle', 'district', 'elizabeth']);
  // Underground, Elizabeth line core and National Rail terminus stops are one station.
  assert.deepEqual(main.stopIds, ['910GPADTLL', '910GPADTON', '940GZZLUPAC']);
  assert.deepEqual(byName('Paddington (H&C Line)').lines, ['circle', 'hammersmith-city']);
});

test('Edgware Road, Hammersmith and Shepherd\'s Bush stations are not merged', () => {
  assert.notEqual(byName('Edgware Road (Circle Line)').id, byName('Edgware Road (Bakerloo)').id);
  assert.notEqual(byName('Hammersmith (Dist&Picc Line)').id, byName('Hammersmith (H&C Line)').id);
  assert.notEqual(byName("Shepherd's Bush").id, byName("Shepherd's Bush Market").id);
  assert.equal(byName('Heathrow Terminals 2 & 3').id, '940GZZLUHRC');
  assert.equal(stations.length, 301);
  assert.equal(stations.filter((s) => s.modes.includes('tube')).length, 272);
  assert.equal(stations.filter((s) => s.modes.includes('elizabeth-line')).length, 41);
});

test('interchange stations list every line they serve', () => {
  assert.deepEqual(byName("King's Cross St. Pancras").lines, ['circle', 'hammersmith-city', 'metropolitan', 'northern', 'piccadilly', 'victoria']);
  assert.deepEqual(byName('Bank').lines, ['central', 'northern', 'waterloo-city']);
  assert.deepEqual(byName('Baker Street').lines, ['bakerloo', 'circle', 'hammersmith-city', 'jubilee', 'metropolitan']);
  assert.ok(byName('Edgware Road (Circle Line)').lines.includes('district'));
  assert.deepEqual(byName('Liverpool Street').lines, ['central', 'circle', 'hammersmith-city', 'metropolitan', 'elizabeth']);
  assert.deepEqual(byName('Whitechapel').lines, ['district', 'hammersmith-city', 'elizabeth']);
  assert.deepEqual(byName('Stratford').lines, ['central', 'jubilee', 'elizabeth']);
  assert.deepEqual(byName('Reading').lines, ['elizabeth']);
});

// ------------------------------------------------------------ topology
test('every line is a single connected network', () => {
  for (const l of TubeConfig.LINES) {
    assert.equal(edgesDoc.lines[l.id].components.length, 1, `${l.name} is disconnected`);
  }
});

test('termini match the real network (branches represented)', () => {
  const expected = {
    bakerloo: ['Elephant & Castle', 'Harrow & Wealdstone'],
    central: ['Ealing Broadway', 'Epping', 'West Ruislip'], // Hainault loop closes via Woodford
    circle: ['Hammersmith (H&C Line)'],                      // spiral: loop + Hammersmith tail
    district: ['Ealing Broadway', 'Edgware Road (Circle Line)', 'Kensington (Olympia)', 'Richmond', 'Upminster', 'Wimbledon'],
    'hammersmith-city': ['Barking', 'Hammersmith (H&C Line)'],
    jubilee: ['Stanmore', 'Stratford'],
    metropolitan: ['Aldgate', 'Amersham', 'Chesham', 'Uxbridge', 'Watford'],
    northern: ['Battersea Power Station', 'Edgware', 'High Barnet', 'Mill Hill East', 'Morden'],
    piccadilly: ['Cockfosters', 'Heathrow Terminal 5', 'Uxbridge'], // T4 is on a loop
    victoria: ['Brixton', 'Walthamstow Central'],
    'waterloo-city': ['Bank', 'Waterloo'],
    elizabeth: ['Abbey Wood', 'Heathrow Terminal 4', 'Heathrow Terminal 5', 'Reading', 'Shenfield']
  };
  for (const [id, termini] of Object.entries(expected)) {
    assert.deepEqual(edgesDoc.lines[id].termini.map((t) => t.name).sort(), termini.slice().sort(), id);
  }
});

test('known branch junctions and adjacencies are present', () => {
  // Northern: both central branches and the Battersea extension.
  assert.ok(hasEdge('northern', 'Euston', 'Camden Town'));           // Bank branch
  assert.ok(hasEdge('northern', 'Euston', 'Mornington Crescent'));   // Charing Cross branch
  assert.ok(hasEdge('northern', 'Kennington', 'Nine Elms'));
  assert.ok(hasEdge('northern', 'Finchley Central', 'Mill Hill East'));
  // Metropolitan: fast section and branches; no stop at Willesden Green.
  assert.ok(hasEdge('metropolitan', 'Finchley Road', 'Wembley Park'));
  assert.ok(!byName('Willesden Green').lines.includes('metropolitan'));
  assert.ok(hasEdge('metropolitan', 'Chalfont & Latimer', 'Chesham'));
  assert.ok(hasEdge('metropolitan', 'Moor Park', 'Croxley'));
  // District branches at Earl's Court and Turnham Green.
  assert.equal(lineAdj('district').get(byName("Earl's Court").id).size, 5);
  assert.ok(hasEdge('district', 'Turnham Green', 'Gunnersbury'));
  // Central Hainault loop.
  assert.ok(hasEdge('central', 'Woodford', 'Roding Valley'));
  assert.ok(hasEdge('central', 'Leytonstone', 'Wanstead'));
  // Piccadilly Heathrow loop.
  assert.ok(hasEdge('piccadilly', 'Hatton Cross', 'Heathrow Terminal 4'));
  assert.ok(hasEdge('piccadilly', 'Heathrow Terminal 4', 'Heathrow Terminals 2 & 3'));
  assert.ok(hasEdge('piccadilly', 'Heathrow Terminals 2 & 3', 'Heathrow Terminal 5'));
  // Circle and H&C share the Paddington (H&C Line) - Hammersmith section.
  const shared = edgesDoc.edges.find((e) => [nameOf(e.a), nameOf(e.b)].sort().join('|') === ['Goldhawk Road', 'Hammersmith (H&C Line)'].sort().join('|'));
  assert.deepEqual(shared.lines.map((l) => l.line), ['circle', 'hammersmith-city']);
  // Elizabeth line: central tunnel, both eastern branches, both western branches.
  assert.ok(hasEdge('elizabeth', 'Paddington', 'Bond Street'));
  assert.ok(hasEdge('elizabeth', 'Whitechapel', 'Canary Wharf'));
  assert.ok(hasEdge('elizabeth', 'Whitechapel', 'Stratford'));
  // Eastern branches split at Whitechapel only (no direct Liverpool Street - Stratford link).
  assert.ok(!hasEdge('elizabeth', 'Liverpool Street', 'Stratford'));
  assert.ok(!hasEdge('elizabeth', 'Liverpool Street', 'Canary Wharf'));
  assert.equal(lineAdj('elizabeth').get(byName('Whitechapel').id).size, 3); // Liverpool Street, Stratford, Canary Wharf
  assert.equal(lineAdj('elizabeth').get(byName('Liverpool Street').id).size, 2);
  assert.ok(hasEdge('elizabeth', 'Hayes & Harlington', 'Heathrow Terminals 2 & 3'));
  assert.ok(hasEdge('elizabeth', 'Hayes & Harlington', 'West Drayton'));
  assert.ok(hasEdge('elizabeth', 'Acton Main Line', 'Paddington'));
  // Heathrow tracks shared with the Piccadilly line are drawn side by side.
  const t5 = edgesDoc.edges.find((e) => [nameOf(e.a), nameOf(e.b)].sort().join('|') === 'Heathrow Terminal 5|Heathrow Terminals 2 & 3');
  assert.deepEqual(t5.lines.map((l) => l.line), ['piccadilly', 'elizabeth']);
});

test('no edge cuts across London (no implausibly long links from wrong ordering)', () => {
  const isTube = (e) => e.lines.some((l) => TubeConfig.LINE_BY_ID[l.line].mode === 'tube');
  const longestTube = Math.max(...edgesDoc.edges.filter(isTube).map((e) => e.lengthM));
  assert.ok(longestTube < 8000, `longest Underground edge ${longestTube} m`);
  const longestEliz = Math.max(...edgesDoc.edges.filter((e) => !isTube(e)).map((e) => e.lengthM));
  assert.ok(longestEliz < 12000, `longest Elizabeth line edge ${longestEliz} m`); // Maidenhead–Twyford ~10.9 km
  // Each edge joins stations that are adjacent in TfL route sequences, so a
  // line's edge count must be close to its station count (tree + a few loops).
  for (const l of TubeConfig.LINES) {
    const s = edgesDoc.lines[l.id];
    assert.ok(s.edgeCount >= s.stationCount - 1 && s.edgeCount <= s.stationCount + 2, `${l.name}: ${s.edgeCount} edges for ${s.stationCount} stations`);
  }
});

test('edge endpoints exist and every station on a line has a track connection', () => {
  const ids = new Set(stations.map((s) => s.id));
  for (const e of edgesDoc.edges) { assert.ok(ids.has(e.a)); assert.ok(ids.has(e.b)); }
  for (const s of stations) {
    for (const l of s.lines) assert.ok(lineAdj(l).has(s.id), `${s.name} not connected on ${l}`);
  }
});

test('validation report exists and has no errors', () => {
  const report = readJson(paths.validation);
  assert.deepEqual(report.errors, []);
  for (const key of ['unmatchedStations', 'duplicates', 'lineNameMismatches', 'network', 'isochrones']) assert.ok(key in report, key);
  assert.ok(Array.isArray(report.network.disconnectedSegments));
});

test('station coordinates are WGS84 within the London region (Reading to Shenfield)', () => {
  for (const s of stations) {
    assert.ok(s.lon > -1.0 && s.lon < 0.35 && s.lat > 51.38 && s.lat < 51.72, s.name);
  }
  // CSV coordinate stays within the join tolerance of the TfL coordinate.
  for (const s of stations) assert.ok(TubeGeometry.haversineM([s.lon, s.lat], [s.tflLon, s.tflLat]) <= 500, s.name);
});

test('browser scripts are syntactically valid', async () => {
  const vm = await import('node:vm');
  for (const f of ['public/js/app.js', 'public/js/union-worker.js', 'public/js/shared/config.js', 'public/js/shared/geometry.js', 'public/js/shared/selection.js']) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), { filename: f }), f);
  }
});
