// Selection logic tests (pure functions shared with the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paths, readJson, MetroSelection as S, MetroConfig } from '../scripts/lib/common.mjs';

const net = readJson(paths.stations); // {stations:[{id, name, lines}]}
const id = (name) => net.stations.find((s) => s.name === name).id;

const toy = {
  stations: [
    { id: 'A', name: 'Alpha', lines: ['victoria'] },
    { id: 'B', name: 'Bravo', lines: ['victoria', 'northern'] },
    { id: 'C', name: 'Charlie', lines: ['northern'] },
    { id: 'D', name: "St. Dee's & Co", lines: ['central'] }
  ]
};

test('line selection selects every station on the line', () => {
  const r = S.resolveSelection(toy, { lines: ['victoria'] });
  assert.deepEqual(r.stationIds, ['A', 'B']);
  assert.equal(r.exactLineSelection, true);
});

test('multi-line selection deduplicates interchange stations', () => {
  const r = S.resolveSelection(toy, { lines: new Set(['victoria', 'northern']) });
  assert.deepEqual(r.stationIds, ['A', 'B', 'C']);
});

test('station overrides add and remove individual stations', () => {
  const r = S.resolveSelection(toy, { lines: ['victoria'], overrides: { B: false, D: true } });
  assert.deepEqual(r.stationIds, ['A', 'D']);
  assert.deepEqual(r.added, ['D']);
  assert.deepEqual(r.removed, ['B']);
  assert.equal(r.exactLineSelection, false);
});

test('toggleStation flips state and drops redundant overrides', () => {
  let state = { lines: ['victoria'], overrides: {} };
  state.overrides = S.toggleStation(toy, state, 'A');
  assert.deepEqual(state.overrides, { A: false });
  state.overrides = S.toggleStation(toy, state, 'A');
  assert.deepEqual(state.overrides, {});
  state.overrides = S.toggleStation(toy, state, 'C');
  assert.deepEqual(state.overrides, { C: true });
});

test('pruneOverrides removes overrides made redundant by a line change', () => {
  const pruned = S.pruneOverrides(toy, { lines: ['northern'], overrides: { C: true, A: false } });
  assert.deepEqual(pruned, {}); // C now on via Northern; A already off without Victoria
});

test('select all / clear all on the real network', () => {
  const all = S.resolveSelection(net, { lines: MetroConfig.LINES.map((l) => l.id) });
  assert.equal(all.stationIds.length, 301);
  const tubeOnly = S.resolveSelection(net, { lines: MetroConfig.LINES.filter((l) => l.mode === 'tube').map((l) => l.id) });
  assert.equal(tubeOnly.stationIds.length, 272);
  assert.equal(new Set(all.stationIds).size, all.stationIds.length);
  assert.equal(S.resolveSelection(net, { lines: [] }).stationIds.length, 0);
});

test('real network: Victoria + Northern counts shared stations once', () => {
  const v = S.resolveSelection(net, { lines: ['victoria'] }).stationIds.length;
  const n = S.resolveSelection(net, { lines: ['northern'] }).stationIds.length;
  const both = S.resolveSelection(net, { lines: ['victoria', 'northern'] }).stationIds;
  const shared = ['Euston', 'Warren Street', 'Stockwell', "King's Cross St. Pancras", 'Oxford Circus'] // Oxford Circus is not Northern
    .filter((nm) => { const s = net.stations.find((x) => x.name === nm); return s.lines.includes('victoria') && s.lines.includes('northern'); });
  assert.equal(both.length, v + n - shared.length);
  assert.ok(both.includes(id('Euston')));
});

test('real network: Elizabeth + Central counts shared stations once', () => {
  const e = S.resolveSelection(net, { lines: ['elizabeth'] }).stationIds.length;
  const c = S.resolveSelection(net, { lines: ['central'] }).stationIds.length;
  const both = S.resolveSelection(net, { lines: ['elizabeth', 'central'] }).stationIds.length;
  // Shared: Ealing Broadway, Bond Street, Tottenham Court Road, Liverpool Street, Stratford.
  assert.equal(e, 41);
  assert.equal(both, e + c - 5);
});

test('summary text', () => {
  assert.equal(S.summaryText({ lineCount: 3, stationCount: 58, minutes: [5] }), '3 lines selected · 58 unique stations · 5-minute coverage enabled');
  assert.equal(S.summaryText({ lineCount: 1, stationCount: 1, minutes: [5, 10] }), '1 line selected · 1 unique station · 5- and 10-minute coverage enabled');
  assert.equal(S.summaryText({ lineCount: 0, stationCount: 0, minutes: [] }), '0 lines selected · 0 unique stations · no walking-time coverage shown');
  assert.match(S.summaryText({ lineCount: 1, stationCount: 2, minutes: [2], added: 1, removed: 2 }), /1 added, 2 removed manually$/);
});

test('search is punctuation- and ampersand-insensitive', () => {
  assert.equal(S.searchStations(toy, 'st dees and co')[0].id, 'D');
  assert.equal(S.searchStations(net, 'kings cross')[0].name, "King's Cross St. Pancras");
  assert.equal(S.searchStations(net, 'elephant &')[0].name, 'Elephant & Castle');
  assert.equal(S.searchStations(net, 'harrow on the hill')[0].name, 'Harrow-on-the-Hill');
  assert.deepEqual(S.searchStations(net, '   '), []);
});
