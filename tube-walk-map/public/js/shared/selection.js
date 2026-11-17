/*
 * Pure selection logic (no DOM, no map): which stations are selected for a
 * given set of lines plus per-station manual overrides. Shared by the browser
 * app and the tests.
 *
 * Rules
 *  - A station is selected by default when it serves ANY selected line.
 *  - overrides[stationId] === true  forces it on (even if none of its lines is selected).
 *  - overrides[stationId] === false forces it off.
 *  - Station ids are unique physical stations (NaPTAN hub ids), so an
 *    interchange served by several selected lines is counted once.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TubeSelection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toSet(x) {
    if (x instanceof Set) return x;
    return new Set(x || []);
  }

  function defaultSelected(station, lineSet) {
    for (var i = 0; i < station.lines.length; i++) if (lineSet.has(station.lines[i])) return true;
    return false;
  }

  /**
   * @param {{stations: Array<{id:string, lines:string[]}>}} network
   * @param {{lines: Iterable<string>, overrides?: Object<string, boolean>}} state
   * @returns {{stationIds: string[], added: string[], removed: string[], exactLineSelection: boolean}}
   */
  function resolveSelection(network, state) {
    var lineSet = toSet(state.lines);
    var overrides = state.overrides || {};
    var ids = [];
    var added = [];
    var removed = [];
    for (var i = 0; i < network.stations.length; i++) {
      var s = network.stations[i];
      var def = defaultSelected(s, lineSet);
      var ov = Object.prototype.hasOwnProperty.call(overrides, s.id) ? overrides[s.id] : undefined;
      var sel = ov === undefined ? def : ov;
      if (sel) ids.push(s.id);
      if (ov === true && !def) added.push(s.id);
      if (ov === false && def) removed.push(s.id);
    }
    return {
      stationIds: ids,
      added: added,
      removed: removed,
      exactLineSelection: added.length === 0 && removed.length === 0
    };
  }

  function isStationSelected(station, state) {
    var overrides = state.overrides || {};
    if (Object.prototype.hasOwnProperty.call(overrides, station.id)) return overrides[station.id];
    return defaultSelected(station, toSet(state.lines));
  }

  /**
   * Toggle a station and return NEW overrides. Overrides that merely restate
   * the line-derived default are removed so the state stays minimal.
   */
  function toggleStation(network, state, stationId) {
    var station = null;
    for (var i = 0; i < network.stations.length; i++) if (network.stations[i].id === stationId) { station = network.stations[i]; break; }
    if (!station) return Object.assign({}, state.overrides || {});
    var next = Object.assign({}, state.overrides || {});
    var current = isStationSelected(station, state);
    var def = defaultSelected(station, toSet(state.lines));
    if (!current === def) delete next[stationId];
    else next[stationId] = !current;
    return next;
  }

  /** Drop overrides that became redundant after a line selection change. */
  function pruneOverrides(network, state) {
    var lineSet = toSet(state.lines);
    var next = {};
    var byId = {};
    network.stations.forEach(function (s) { byId[s.id] = s; });
    Object.keys(state.overrides || {}).forEach(function (id) {
      var s = byId[id];
      if (!s) return;
      if (state.overrides[id] !== defaultSelected(s, lineSet)) next[id] = state.overrides[id];
    });
    return next;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function joinList(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /**
   * "3 lines selected · 58 unique stations · 5-minute coverage enabled"
   * @param {{lineCount:number, stationCount:number, minutes:number[], added?:number, removed?:number}} o
   */
  function summaryText(o) {
    var parts = [plural(o.lineCount, 'line', 'lines') + ' selected', plural(o.stationCount, 'unique station', 'unique stations')];
    var mins = (o.minutes || []).slice().sort(function (a, b) { return a - b; });
    if (!mins.length) parts.push('no walking-time coverage shown');
    else if (mins.length === 1) parts.push(mins[0] + '-minute coverage enabled');
    else parts.push(joinList(mins.map(function (m, i) { return i === mins.length - 1 ? m + '-minute' : m + '-'; })) + ' coverage enabled');
    var manual = [];
    if (o.added) manual.push(o.added + ' added');
    if (o.removed) manual.push(o.removed + ' removed');
    if (manual.length) parts.push(manual.join(', ') + ' manually');
    return parts.join(' · ');
  }

  /** Normalise text for search: lower-case, strip accents/punctuation, & -> and. */
  function normaliseForSearch(s) {
    return String(s || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[’'.]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Rank stations by name match: prefix matches first, then substring. */
  function searchStations(network, query, limit) {
    var q = normaliseForSearch(query);
    if (!q) return [];
    var prefix = [], contains = [];
    network.stations.forEach(function (s) {
      var n = normaliseForSearch(s.name);
      if (n.indexOf(q) === 0 || n.split(' ').some(function (w) { return w.indexOf(q) === 0; })) prefix.push(s);
      else if (n.indexOf(q) !== -1) contains.push(s);
    });
    var cmp = function (a, b) { return a.name.localeCompare(b.name, 'en-GB'); };
    return prefix.sort(cmp).concat(contains.sort(cmp)).slice(0, limit || 20);
  }

  return {
    resolveSelection: resolveSelection,
    isStationSelected: isStationSelected,
    toggleStation: toggleStation,
    pruneOverrides: pruneOverrides,
    summaryText: summaryText,
    normaliseForSearch: normaliseForSearch,
    searchStations: searchStations
  };
});
