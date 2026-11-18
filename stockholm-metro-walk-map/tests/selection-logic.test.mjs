// Selection logic tests (pure functions shared with the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paths, readJson, MetroSelection as S, MetroConfig } from '../scripts/lib/common.mjs';

const haveNet = fs.existsSync(paths.stations);
const net = haveNet ? readJson(paths.stations) : { stations: [] };
const id = (name) => net.stations.find((s) => s.name === name).id;
const sel = (lines) => S.resolveSelection(net, { lines }).stationIds;

const toy = {
  stations: [
    { id: 'A', name: 'Alpha', lines: ['blue'] },
    { id: 'B', name: 'Bravo', lines: ['blue', 'green'] },
    { id: 'C', name: 'Charlie', lines: ['green'] },
    { id: 'D', name: 'Östra Dee-torget', lines: ['red'] }
  ]
};

test('line selection selects every station on the line', () => {
  assert.deepEqual(S.resolveSelection(toy, { lines: ['blue'] }).stationIds, ['A', 'B']);
});

test('multi-line selection deduplicates interchange stations', () => {
  const r = S.resolveSelection(toy, { lines: new Set(['blue', 'green']) });
  assert.deepEqual(r.stationIds, ['A', 'B', 'C']);
  assert.ok(r.exactLineSelection);
});

test('station overrides add and remove individual stations', () => {
  const r = S.resolveSelection(toy, { lines: ['blue'], overrides: { B: false, D: true } });
  assert.deepEqual(r.stationIds, ['A', 'D']);
  assert.deepEqual(r.added, ['D']);
  assert.deepEqual(r.removed, ['B']);
  assert.equal(r.exactLineSelection, false);
});

test('toggleStation flips state and drops redundant overrides', () => {
  let state = { lines: ['blue'], overrides: {} };
  state.overrides = S.toggleStation(toy, state, 'A');
  assert.deepEqual(state.overrides, { A: false });
  state.overrides = S.toggleStation(toy, state, 'A');
  assert.deepEqual(state.overrides, {});
  state.overrides = S.toggleStation(toy, state, 'C');
  assert.deepEqual(state.overrides, { C: true });
});

test('pruneOverrides removes overrides made redundant by a line change', () => {
  const state = { lines: ['blue', 'green'], overrides: { C: true, A: false } };
  assert.deepEqual(S.pruneOverrides(toy, state), { A: false });
});

test('summary text', () => {
  assert.equal(S.summaryText({ lineCount: 3, stationCount: 58, minutes: [5, 10] }), '3 lines selected · 58 unique stations · 5- and 10-minute coverage enabled');
  assert.equal(S.summaryText({ lineCount: 1, stationCount: 1, minutes: [5] }), '1 line selected · 1 unique station · 5-minute coverage enabled');
  assert.equal(S.summaryText({ lineCount: 0, stationCount: 0, minutes: [] }), '0 lines selected · 0 unique stations · no walking-time coverage shown');
  assert.match(S.summaryText({ lineCount: 1, stationCount: 2, minutes: [5], added: 1, removed: 2 }), /1 added, 2 removed manually$/);
});

test('search ignores diacritics, case and hyphens', () => {
  assert.equal(S.searchStations(toy, 'ostra dee')[0].id, 'D');
  assert.deepEqual(S.searchStations(toy, '   '), []);
});

// ------------------------------------------------------------ real network
test('select all / clear all on the real network', { skip: !haveNet && 'run npm run data' }, () => {
  const all = sel(MetroConfig.LINES.map((l) => l.id));
  assert.equal(all.length, net.stations.length);
  assert.equal(new Set(all).size, all.length);
  assert.equal(sel([]).length, 0);
});

test('real network: interchanges are counted once', { skip: !haveNet && 'run npm run data' }, () => {
  const n = (lines) => sel(lines).length;
  const shared = (a, b) => net.stations.filter((s) => s.lines.includes(a) && s.lines.includes(b)).map((s) => s.name).sort();
  // Known interchanges between colour lines.
  assert.deepEqual(shared('red', 'green'), ['Gamla stan', 'Slussen', 'T-Centralen']);
  assert.deepEqual(shared('blue', 'green'), ['Fridhemsplan', 'T-Centralen']);
  assert.deepEqual(shared('blue', 'red'), ['T-Centralen']);
  assert.equal(n(['red', 'green']), n(['red']) + n(['green']) - 3);
  assert.equal(n(['blue', 'green']), n(['blue']) + n(['green']) - 2);
  // Inclusion–exclusion over all three lines (T-Centralen is on all three).
  assert.equal(n(['blue', 'red', 'green']), n(['blue']) + n(['red']) + n(['green']) - 3 - 2 - 1 + 1);
  assert.ok(sel(['blue', 'red', 'green']).includes(id('T-Centralen')));
});

test('real network: manual add/remove on top of a line selection', { skip: !haveNet && 'run npm run data' }, () => {
  const base = sel(['blue']);
  const r = S.resolveSelection(net, { lines: ['blue'], overrides: { [id('Slussen')]: true, [id('Akalla')]: false } });
  assert.equal(r.stationIds.length, base.length);
  assert.ok(r.stationIds.includes(id('Slussen')) && !r.stationIds.includes(id('Akalla')));
});

test('real network search handles Swedish letters', { skip: !haveNet && 'run npm run data' }, () => {
  assert.equal(S.searchStations(net, 'ostermalmstorg')[0].name, 'Östermalmstorg');
  assert.equal(S.searchStations(net, 't centralen')[0].name, 'T-Centralen');
  assert.equal(S.searchStations(net, 'mörby')[0].name, 'Mörby centrum');
});
