/*
 * Tube walk map: browser application.
 * Classic script (no modules) so it also runs from file://.
 * All text from data is inserted with textContent / DOM APIs, never innerHTML.
 */
(function () {
  'use strict';

  var C = window.TubeConfig;
  var G = window.TubeGeometry;
  var S = window.TubeSelection;
  var APP = window.TUBE_APP_CONFIG || {};
  var IS_FILE = location.protocol === 'file:';

  // ------------------------------------------------------------------ utils
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'className') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.keys(v).forEach(function (p) { n.style.setProperty(p, v[p]); });
      else n.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function debounce(fn, ms) {
    var t;
    return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }
  function fmtDate(iso) {
    if (!iso) return 'unknown';
    var d = new Date(iso);
    if (isNaN(d)) return 'unknown';
    return d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  }
  function fmtCoord(lat, lon) {
    return Math.abs(lat).toFixed(5) + '° ' + (lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(lon).toFixed(5) + '° ' + (lon >= 0 ? 'E' : 'W');
  }
  function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // --------------------------------------------------------------- messages
  var Messages = (function () {
    var box = $('messages');
    var shown = {};
    function show(kind, text, key) {
      if (key && shown[key]) return;
      var label = { error: 'Error', warning: 'Warning', info: 'Note' }[kind] || 'Note';
      var item = el('div', { className: 'message ' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
        el('p', null, [el('span', { className: 'msg-kind', text: label + ': ' }), text]),
        el('button', { className: 'btn btn-small', type: 'button', 'aria-label': 'Dismiss message', text: '×', onclick: function () { item.remove(); if (key) delete shown[key]; } })
      ]);
      if (key) shown[key] = item;
      box.appendChild(item);
      if (kind === 'info') setTimeout(function () { item.remove(); if (key) delete shown[key]; }, 8000);
    }
    return { error: function (t, k) { show('error', t, k); }, warning: function (t, k) { show('warning', t, k); }, info: function (t, k) { show('info', t, k); } };
  })();

  // ----------------------------------------------------------- preconditions
  if (!C || !G || !S) { document.body.textContent = 'Application scripts failed to load.'; return; }
  if (!window.maplibregl) {
    Messages.error('The map library is missing. Run "npm install" (it copies MapLibre into public/vendor) and reload.');
    $('summary').textContent = 'Map library unavailable.';
    return;
  }
  if (!window.TUBE_NETWORK || !Array.isArray(window.TUBE_NETWORK.stations)) {
    Messages.error('Station and line data (public/data/network.js) is missing or invalid. Run "npm run data" and reload.');
    $('summary').textContent = 'Network data unavailable.';
    return;
  }

  // ------------------------------------------------------------------ data
  var NET = (function prepare(raw) {
    var stations = raw.stations.filter(function (s) {
      return s && typeof s.id === 'string' && isFinite(s.lon) && isFinite(s.lat) && Array.isArray(s.lines);
    }).map(function (s) {
      return Object.assign({}, s, { lines: s.lines.filter(function (l) { return C.LINE_BY_ID[l]; }) });
    });
    if (stations.length !== raw.stations.length) {
      Messages.warning((raw.stations.length - stations.length) + ' malformed station record(s) were skipped.');
    }
    var byId = {};
    stations.forEach(function (s) { byId[s.id] = s; });
    var lineStations = {};
    C.LINES.forEach(function (l) { lineStations[l.id] = []; });
    stations.forEach(function (s) { s.lines.forEach(function (l) { lineStations[l].push(s); }); });
    Object.keys(lineStations).forEach(function (l) { lineStations[l].sort(function (a, b) { return a.name.localeCompare(b.name, 'en-GB'); }); });

    var routeFeatures = [];
    (raw.edges || []).forEach(function (e) {
      var a = byId[e.a], b = byId[e.b];
      if (!a || !b) return;
      var n = e.lines.length;
      e.lines.forEach(function (lineId, i) {
        var line = C.LINE_BY_ID[lineId];
        if (!line) return;
        routeFeatures.push({
          type: 'Feature',
          properties: { line: lineId, colour: line.colour, slot: i - (n - 1) / 2, shared: n, from: a.name, to: b.name },
          geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }
        });
      });
    });
    return { meta: raw.meta || {}, stations: stations, byId: byId, lineStations: lineStations, routes: { type: 'FeatureCollection', features: routeFeatures } };
  })(window.TUBE_NETWORK);

  var ISO = { status: 'loading', meta: null, stations: {}, augmented: false };
  var BLD = { status: 'loading', meta: null, list: [], byId: {} };
  var COVERAGE = null;

  // ------------------------------------------------------------------ state
  function initialLines() {
    if (Array.isArray(APP.initialLines)) return APP.initialLines.filter(function (l) { return C.LINE_BY_ID[l]; });
    return C.LINES.map(function (l) { return l.id; });
  }
  function initialContours() {
    var c = Array.isArray(APP.initialContours) ? APP.initialContours : C.CONTOUR_SECONDS;
    return c.filter(function (s) { return C.CONTOUR_SECONDS.indexOf(s) !== -1; });
  }
  var state = {
    lines: new Set(initialLines()),
    overrides: {},
    contours: new Set(initialContours()),
    mode: 'union',
    opacity: 0.45,
    showRoutes: true,
    showContext: true,
    showStations: true,
    showBuildings: true,
    companies: new Set(C.COMPANIES.map(function (c) { return c.name; })),
    statuses: new Set(['Standing', 'Development'])
  };
  var selection = S.resolveSelection(NET, state);
  var selectedSet = new Set(selection.stationIds);

  // ------------------------------------------------------------------ theme
  var themePref = storageGet('tube-walk-theme') || 'auto';
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function effectiveTheme() { return themePref === 'auto' ? (mql && mql.matches ? 'dark' : 'light') : themePref; }
  function applyThemeAttr() {
    document.documentElement.setAttribute('data-theme', effectiveTheme());
    var label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[themePref];
    $('theme-label').textContent = label;
    $('theme-toggle').setAttribute('aria-label', 'Colour theme: ' + (themePref === 'auto' ? 'automatic' : themePref) + '. Activate to change.');
  }
  applyThemeAttr();

  var BASEMAPS = Object.assign({}, C.BASEMAPS, APP.basemaps || {});
  function fallbackStyle() {
    return {
      version: 8,
      name: 'fallback-plain',
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': effectiveTheme() === 'dark' ? '#1b1f24' : '#eef0f2' } }]
    };
  }

  // -------------------------------------------------------------------- map
  var map = new maplibregl.Map({
    container: 'map',
    style: BASEMAPS[effectiveTheme()],
    bounds: C.LONDON_BOUNDS,
    fitBoundsOptions: { padding: 16 },
    maxBounds: [[-1.4, 51.0], [1.0, 52.0]],
    minZoom: 8,
    maxZoom: 18,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    keyboard: true
  });
  map.touchZoomRotate.disableRotation();

  var styleOk = false;
  var usingFallback = false;
  var tileErrors = 0;
  function useFallbackStyle(reason) {
    if (usingFallback) return;
    usingFallback = true;
    Messages.warning('Basemap tiles are unavailable (' + reason + '). Lines, stations and walking areas are still shown on a plain background.', 'basemap');
    map.setStyle(fallbackStyle());
  }
  var styleTimer = setTimeout(function () { if (!styleOk) useFallbackStyle('timed out loading the map style'); }, 10000);
  map.on('error', function (e) {
    var err = e && e.error;
    var msg = err && (err.message || err.status) ? String(err.message || err.status) : 'unknown error';
    // Style document failed to load (network / HTTP error) -> plain fallback.
    if (!styleOk && !usingFallback && !e.sourceId && err && (err.status || /fetch|network|style|load|json/i.test(err.message || ''))) { useFallbackStyle(msg); return; }
    if (e.sourceId && !/^(routes|stations|coverage|iso-individual|highlight)$/.test(e.sourceId)) {
      tileErrors++;
      if (tileErrors === 5) Messages.warning('Some basemap tiles failed to load. The basemap may be incomplete; line and station data are unaffected.', 'tiles');
      return;
    }
    if (window.console) console.error(err || e);
  });

  // Custom "fit to selection" map control (IControl interface).
  var fitControl = {
    onAdd: function () {
      this._c = el('div', { className: 'maplibregl-ctrl maplibregl-ctrl-group fit-ctrl' }, [
        el('button', { type: 'button', title: 'Fit to selection', 'aria-label': 'Fit map to selection', text: '⤢', onclick: function () { fitToSelection(); } })
      ]);
      return this._c;
    },
    onRemove: function () { this._c.remove(); }
  };
  var attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: attributionHtml() });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(fitControl, 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
  map.addControl(attribution, 'bottom-right');

  function attributionHtml() {
    var parts = ['Underground & Elizabeth line data: Powered by TfL Open Data', 'Line colours: TfL Colour standard'];
    var providers = ISO.meta && ISO.meta.providers && ISO.meta.providers.length ? ISO.meta.providers : null;
    parts.push('Walking areas: ' + (providers ? providers.map(escapeHtml).join(', ') : 'pedestrian routing') + ', <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>');
    parts.push('Unofficial; not endorsed by TfL');
    return parts;
  }


  var LINE_W = ['interpolate', ['linear'], ['zoom'], 9, 1.6, 12, 3, 15, 6, 18, 9];
  function offsetExpr() {
    return ['interpolate', ['linear'], ['zoom'],
      9, ['*', ['get', 'slot'], 1.7],
      12, ['*', ['get', 'slot'], 3.2],
      15, ['*', ['get', 'slot'], 6.4],
      18, ['*', ['get', 'slot'], 9.6]];
  }

  // Insert walking areas above every basemap fill/line layer but below the
  // basemap's labels: the first symbol layer after the last non-symbol layer.
  function firstSymbolLayer() {
    var layers = map.getStyle().layers || [];
    var lastNonSymbol = -1;
    for (var i = 0; i < layers.length; i++) if (layers[i].type !== 'symbol') lastNonSymbol = i;
    for (var j = lastNonSymbol + 1; j < layers.length; j++) if (layers[j].type === 'symbol') return layers[j].id;
    return undefined;
  }

  function addAppLayers() {
    if (map.getSource('routes')) return;
    var dark = effectiveTheme() === 'dark';
    var beforeLabels = firstSymbolLayer();
    var empty = { type: 'FeatureCollection', features: [] };

    map.addSource('coverage', { type: 'geojson', data: empty });
    map.addSource('iso-individual', { type: 'geojson', data: empty });
    map.addSource('routes', { type: 'geojson', data: NET.routes });
    map.addSource('stations', { type: 'geojson', data: stationsGeoJSON(), promoteId: 'id' });
    map.addSource('highlight', { type: 'geojson', data: empty });

    // Walking areas: 5 min first, then 2, then 1 (nested order).
    C.CONTOURS.slice().reverse().forEach(function (c) {
      ['coverage', 'iso-individual'].forEach(function (src) {
        var pre = src === 'coverage' ? 'cov' : 'ind';
        map.addLayer({
          id: pre + '-fill-' + c.seconds, type: 'fill', source: src,
          filter: ['==', ['get', 'seconds'], c.seconds],
          paint: { 'fill-color': c.fill, 'fill-opacity': src === 'coverage' ? state.opacity : state.opacity * 0.45 }
        }, beforeLabels);
        var linePaint = { 'line-color': dark ? '#c8efe6' : c.outline, 'line-width': src === 'coverage' ? 1.4 : 0.8, 'line-opacity': 0.9 };
        if (c.dash) linePaint['line-dasharray'] = c.dash;
        map.addLayer({ id: pre + '-line-' + c.seconds, type: 'line', source: src, filter: ['==', ['get', 'seconds'], c.seconds], paint: linePaint }, beforeLabels);
      });
    });

    map.addLayer({
      id: 'routes-context', type: 'line', source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'colour'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 15, 3], 'line-opacity': 0.22, 'line-offset': offsetExpr() }
    });
    map.addLayer({
      id: 'routes-casing', type: 'line', source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#f2f2f2' : '#2b2f36',
        'line-opacity': dark ? 0.85 : 0.55,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.8, 12, 4.6, 15, 8, 18, 11.5],
        'line-offset': offsetExpr()
      }
    });
    map.addLayer({
      id: 'routes', type: 'line', source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'colour'], 'line-width': LINE_W, 'line-offset': offsetExpr() }
    });

    // Office buildings: below stations so stations stay clickable.
    map.addSource('buildings', { type: 'geojson', data: buildingsGeoJSON(), promoteId: 'id' });
    map.addLayer({
      id: 'buildings', type: 'circle', source: 'buildings',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 5.5, 16, 8, 18, 10],
        'circle-color': ['get', 'colour'],
        'circle-stroke-color': dark ? '#ffffff' : '#1a1d21',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 1.4],
        'circle-opacity': ['case', ['boolean', ['feature-state', 'outside'], false], 0.35, 1],
        'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'outside'], false], 0.35, 1]
      }
    });

    map.addLayer({
      id: 'stations', type: 'circle', source: 'stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          9, ['case', ['boolean', ['feature-state', 'selected'], false], ['case', ['get', 'interchange'], 3.6, 2.6], 1.6],
          13, ['case', ['boolean', ['feature-state', 'selected'], false], ['case', ['get', 'interchange'], 7, 5], 3],
          17, ['case', ['boolean', ['feature-state', 'selected'], false], ['case', ['get', 'interchange'], 11, 8], 5]],
        'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', dark ? '#5b636e' : '#c9ced6'],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#111418', dark ? '#9aa3ad' : '#6b7280'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], ['case', ['get', 'interchange'], 2.5, 1.8], 1]
      }
    });
    map.addLayer({
      id: 'highlight', type: 'circle', source: 'highlight',
      paint: { 'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffb000', 'circle-stroke-width': 3 }
    });
    if (map.getStyle().glyphs) {
      map.addLayer({
        id: 'station-labels', type: 'symbol', source: 'stations', minzoom: 12.5,
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12,
          'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true
        },
        paint: { 'text-color': dark ? '#eef0f2' : '#1a1d21', 'text-halo-color': dark ? '#121417' : '#ffffff', 'text-halo-width': 1.5 }
      });
    }

    applySelectionToMap(true);
    applyLayerVisibility();
    applyBuildings();
    renderCoverage(lastCoverage);
    renderIndividual();
  }

  function stationsGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: NET.stations.map(function (s) {
        return { type: 'Feature', id: s.id, properties: { id: s.id, name: s.name, interchange: s.lines.length > 1 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } };
      })
    };
  }

  map.on('style.load', function () {
    styleOk = true;
    clearTimeout(styleTimer);
    addAppLayers();
  });

  // ------------------------------------------------------- selection → map
  var prevSelected = new Set();
  function applySelectionToMap(force) {
    if (!map.getSource('stations')) return;
    NET.stations.forEach(function (s) {
      var sel = selectedSet.has(s.id);
      if (force || sel !== prevSelected.has(s.id)) map.setFeatureState({ source: 'stations', id: s.id }, { selected: sel });
    });
    prevSelected = new Set(selectedSet);
    var lines = Array.from(state.lines);
    map.setFilter('routes', ['in', ['get', 'line'], ['literal', lines]]);
    map.setFilter('routes-casing', ['in', ['get', 'line'], ['literal', lines]]);
    map.setFilter('routes-context', ['!', ['in', ['get', 'line'], ['literal', lines]]]);
  }

  function setVis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }
  function applyLayerVisibility() {
    setVis('routes', state.showRoutes);
    setVis('routes-casing', state.showRoutes);
    setVis('routes-context', state.showRoutes && state.showContext);
    setVis('stations', state.showStations);
    setVis('station-labels', state.showStations);
    C.CONTOURS.forEach(function (c) {
      var on = state.contours.has(c.seconds);
      setVis('cov-fill-' + c.seconds, on && state.mode === 'union');
      setVis('cov-line-' + c.seconds, on && state.mode === 'union');
      setVis('ind-fill-' + c.seconds, on && state.mode === 'individual');
      setVis('ind-line-' + c.seconds, on && state.mode === 'individual');
      if (map.getLayer('cov-fill-' + c.seconds)) {
        map.setPaintProperty('cov-fill-' + c.seconds, 'fill-opacity', state.opacity);
        map.setPaintProperty('ind-fill-' + c.seconds, 'fill-opacity', state.opacity * 0.45);
      }
    });
  }

  // ---------------------------------------------------------- coverage/union
  var unionCache = new Map(); // key -> {seconds -> {geometry, areaM2, skipped}}
  var lastCoverage = null;    // {seconds -> result}
  var worker = null;
  // Single-file builds have no separate worker script; unions then run on the main thread.
  var workerBroken = IS_FILE || !!window.TUBE_SINGLE_FILE || typeof Worker === 'undefined';
  var jobSeq = 0;
  var pending = null;         // {jobId, resolve, reject}
  var busyTimer = null;

  function getWorker() {
    if (workerBroken) return null;
    if (!worker) {
      try {
        worker = new Worker('js/union-worker.js');
        worker.onmessage = function (e) {
          if (!pending || e.data.jobId !== pending.jobId) return; // stale result
          var p = pending; pending = null;
          if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.results);
        };
        worker.onerror = function (e) {
          workerBroken = true;
          if (worker) worker.terminate();
          worker = null;
          if (pending) { var p = pending; pending = null; p.reject(new Error('Worker failed: ' + (e.message || 'unknown'))); }
        };
      } catch (err) {
        workerBroken = true;
        worker = null;
      }
    }
    return worker;
  }

  function runUnion(groups) {
    // Cancel any in-flight job: terminate the worker so the CPU is freed.
    if (pending) {
      pending.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      pending = null;
      if (worker) { worker.terminate(); worker = null; }
    }
    var w = getWorker();
    var jobId = ++jobSeq;
    if (w) {
      return new Promise(function (resolve, reject) {
        pending = { jobId: jobId, resolve: resolve, reject: reject };
        w.postMessage({ jobId: jobId, groups: groups });
      }).catch(function (err) {
        if (err.cancelled || !workerBroken) throw err;
        return mainThreadUnion(groups, jobId);
      });
    }
    return mainThreadUnion(groups, jobId);
  }
  function mainThreadUnion(groups, jobId) {
    // Fallback when Workers are unavailable (e.g. file://). Yields once so the
    // busy indicator can paint first.
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (jobId !== jobSeq) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
        try {
          resolve(groups.map(function (g) {
            var r = G.unionGeometries(g.geoms, window.polygonClipping);
            return { seconds: g.seconds, geometry: G.toGeometry(r.polygons), areaM2: G.areaM2(r.polygons), skipped: r.skipped };
          }));
        } catch (err) { reject(err); }
      }, 30);
    });
  }

  function stationGeom(id, seconds) {
    var s = ISO.stations[id];
    return s && s.g ? s.g[seconds] || null : null;
  }

  var updateCoverage = debounce(function () {
    if (ISO.status !== 'ready') { renderStats(); return; }
    renderIndividual();
    if (state.mode !== 'union') { renderStats(); return; }
    var wanted = Array.from(state.contours).sort(function (a, b) { return a - b; });
    if (!wanted.length || !selection.stationIds.length) { lastCoverage = {}; renderCoverage(lastCoverage); renderStats(); return; }

    var key = selection.stationIds.join(',');
    var cached = unionCache.get(key) || {};
    var todo = wanted.filter(function (s) { return !cached[s]; });
    if (!todo.length) { lastCoverage = cached; renderCoverage(cached); renderStats(); return; }

    var lines = Array.from(state.lines);
    var fast = COVERAGE && !ISO.augmented && selection.exactLineSelection && lines.length > 0;
    var groups = [];
    todo.forEach(function (seconds) {
      if (fast && lines.length === C.LINES.length && COVERAGE.all && COVERAGE.all[seconds]) {
        cached[seconds] = { geometry: COVERAGE.all[seconds].geometry, areaM2: COVERAGE.all[seconds].areaKm2 * 1e6, skipped: 0, precomputed: true };
      } else if (fast && lines.length === 1 && COVERAGE.lines[lines[0]] && COVERAGE.lines[lines[0]][seconds]) {
        var c = COVERAGE.lines[lines[0]][seconds];
        cached[seconds] = { geometry: c.geometry, areaM2: c.areaKm2 * 1e6, skipped: 0, precomputed: true };
      } else if (fast && lines.every(function (l) { return COVERAGE.lines[l] && COVERAGE.lines[l][seconds]; })) {
        // Union of precomputed per-line unions: few, large polygons — fast.
        groups.push({ seconds: seconds, geoms: lines.map(function (l) { return COVERAGE.lines[l][seconds].geometry; }) });
      } else {
        groups.push({ seconds: seconds, geoms: selection.stationIds.map(function (id) { return stationGeom(id, seconds); }).filter(Boolean) });
      }
    });
    if (!groups.length) { unionCache.set(key, cached); lastCoverage = cached; renderCoverage(cached); renderStats(); return; }

    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () { $('busy').hidden = false; }, 150);
    runUnion(groups).then(function (results) {
      results.forEach(function (r) {
        cached[r.seconds] = r;
        if (r.skipped) Messages.warning(r.skipped + ' invalid walking-area geometr' + (r.skipped === 1 ? 'y was' : 'ies were') + ' skipped in the ' + (r.seconds / 60) + '-minute union.', 'skipped-' + r.seconds);
      });
      unionCache.set(key, cached);
      if (unionCache.size > 40) unionCache.delete(unionCache.keys().next().value);
      if (key === selection.stationIds.join(',')) { lastCoverage = cached; renderCoverage(cached); renderStats(); }
    }).catch(function (err) {
      if (err.cancelled) return;
      Messages.error('Could not combine walking areas: ' + err.message);
    }).then(function () {
      clearTimeout(busyTimer);
      if (!pending) $('busy').hidden = true;
    });
  }, 120);

  function renderCoverage(cov) {
    var src = map.getSource && map.getSource('coverage');
    if (!src || !cov) return;
    var features = [];
    C.CONTOURS.forEach(function (c) {
      var r = cov[c.seconds];
      if (r && r.geometry && state.contours.has(c.seconds)) features.push({ type: 'Feature', properties: { seconds: c.seconds }, geometry: r.geometry });
    });
    src.setData({ type: 'FeatureCollection', features: features });
  }

  function renderIndividual() {
    var src = map.getSource && map.getSource('iso-individual');
    if (!src) return;
    if (state.mode !== 'individual' || ISO.status !== 'ready') { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    var features = [];
    selection.stationIds.forEach(function (id) {
      var s = NET.byId[id];
      C.CONTOURS.forEach(function (c) {
        if (!state.contours.has(c.seconds)) return;
        var g = stationGeom(id, c.seconds);
        if (g) features.push({ type: 'Feature', properties: { seconds: c.seconds, stationId: id, name: s.name }, geometry: g });
      });
    });
    src.setData({ type: 'FeatureCollection', features: features });
  }

  function renderStats() {
    var dl = $('coverage-stats');
    dl.textContent = '';
    var status = $('iso-status');
    if (ISO.status === 'loading') { status.textContent = 'Loading walking areas…'; return; }
    if (ISO.status === 'error') { status.textContent = 'Walking areas unavailable. Stations and lines are still shown.'; return; }
    var missing = selection.stationIds.filter(function (id) { return !ISO.stations[id]; });
    status.textContent = missing.length
      ? missing.length + ' selected station' + (missing.length === 1 ? ' has' : 's have') + ' no walking area yet and ' + (missing.length === 1 ? 'is' : 'are') + ' not included.'
      : '';
    if (state.mode !== 'union') {
      dl.appendChild(el('dt', { text: 'Display' }));
      dl.appendChild(el('dd', { text: 'Individual station areas (overlapping, not combined)' }));
      return;
    }
    C.CONTOURS.forEach(function (c) {
      if (!state.contours.has(c.seconds)) return;
      var r = lastCoverage && lastCoverage[c.seconds];
      dl.appendChild(el('dt', { text: c.label }));
      dl.appendChild(el('dd', { text: r ? (r.areaM2 / 1e6).toFixed(2) + ' km² combined' : (selection.stationIds.length ? 'calculating…' : '—') }));
    });
  }

  // --------------------------------------------------------- office buildings
  function companyOf(name) { return C.COMPANY_BY_NAME[name] || { colour: '#666666', developmentColour: '#aaaaaa', name: name }; }
  function buildingColour(b) { var c = companyOf(b.company); return b.status === 'Development' ? c.developmentColour : c.colour; }

  function buildingsGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: BLD.list.filter(function (b) { return b.lon != null; }).map(function (b) {
        return { type: 'Feature', id: b.id, properties: { id: b.id, company: b.company, status: b.status, colour: buildingColour(b) }, geometry: { type: 'Point', coordinates: [b.lon, b.lat] } };
      })
    };
  }

  /** Smallest walking time (s) from any SELECTED station, or null if > 5 min. */
  function buildingBand(b) {
    var best = null;
    for (var id in b.stations) {
      if (!Object.prototype.hasOwnProperty.call(b.stations, id) || !selectedSet.has(id) || !ISO.stations[id]) continue;
      if (best === null || b.stations[id] < best) best = b.stations[id];
    }
    return best;
  }
  function maxContour() { var m = 0; state.contours.forEach(function (s) { if (s > m) m = s; }); return m; }

  var prevOutside = {};
  function applyBuildings() {
    if (!map.getLayer || !map.getLayer('buildings')) return;
    var companies = Array.from(state.companies), statuses = Array.from(state.statuses);
    map.setFilter('buildings', ['all', ['in', ['get', 'company'], ['literal', companies]], ['in', ['get', 'status'], ['literal', statuses]]]);
    setVis('buildings', state.showBuildings);
    var limit = maxContour();
    BLD.list.forEach(function (b) {
      if (b.lon == null) return;
      var band = buildingBand(b);
      // Dim buildings outside the largest enabled walking time of the selection.
      var outside = ISO.status === 'ready' && limit > 0 && !(band !== null && band <= limit);
      if (prevOutside[b.id] !== outside) { map.setFeatureState({ source: 'buildings', id: b.id }, { outside: outside }); prevOutside[b.id] = outside; }
    });
  }

  function pct(n, d) { return d ? Math.round((100 * n) / d) + '%' : '–'; }

  function renderBuildingStats() {
    var box = $('building-stats');
    if (!box) return;
    box.textContent = '';
    if (BLD.status === 'loading') { box.appendChild(el('p', { className: 'hint', text: 'Loading buildings…' })); return; }
    if (BLD.status === 'error') { box.appendChild(el('p', { className: 'hint', text: 'Building data unavailable.' })); return; }
    if (ISO.status !== 'ready') { box.appendChild(el('p', { className: 'hint', text: 'Waiting for walking areas…' })); return; }
    var secs = Array.from(state.contours).sort(function (a, b) { return a - b; });
    if (!secs.length) { box.appendChild(el('p', { className: 'hint', text: 'Turn on a walking-time contour to see how many buildings it covers.' })); return; }
    var table = el('table', { className: 'bstats' });
    table.appendChild(el('caption', { text: 'Share of each company’s buildings within walking distance of the ' + selection.stationIds.length + ' selected stations' }));
    table.appendChild(el('thead', null, [el('tr', null, [
      el('th', { scope: 'col', text: 'Company' }), el('th', { scope: 'col', text: 'Walk' }),
      el('th', { scope: 'col', text: 'All', title: 'All buildings (standing + development)' }),
      el('th', { scope: 'col', text: 'Standing' }), el('th', { scope: 'col', text: 'Develop.', title: 'Developments' })
    ])]));
    var tbody = el('tbody');
    C.COMPANIES.forEach(function (c) {
      if (!state.companies.has(c.name)) return;
      var bs = BLD.list.filter(function (b) { return b.company === c.name && b.lon != null; });
      var st = bs.filter(function (b) { return b.status === 'Standing'; });
      var dv = bs.filter(function (b) { return b.status === 'Development'; });
      secs.forEach(function (sec, i) {
        var within = function (arr) { return arr.filter(function (b) { var x = buildingBand(b); return x !== null && x <= sec; }).length; };
        var a = within(bs), w = within(st), d = within(dv);
        var cells = [];
        if (i === 0) cells.push(el('th', { scope: 'rowgroup', rowspan: String(secs.length), className: 'bstats-company' }, [
          el('span', { className: 'dot', 'aria-hidden': 'true', style: { '--c': c.colour } }), c.name,
          el('span', { className: 'bstats-n', text: bs.length + ' buildings (' + dv.length + ' dev.)' })
        ]));
        cells.push(el('td', { text: '≤ ' + sec / 60 + ' min' }));
        cells.push(el('td', { text: pct(a, bs.length), title: a + ' of ' + bs.length }));
        cells.push(el('td', { text: pct(w, st.length), title: w + ' of ' + st.length }));
        cells.push(el('td', { text: pct(d, dv.length), title: d + ' of ' + dv.length }));
        tbody.appendChild(el('tr', { className: i === 0 ? 'group-start' : null }, cells));
      });
    });
    table.appendChild(tbody);
    box.appendChild(table);
    box.appendChild(el('p', { className: 'hint', text: 'A building counts as within N minutes when it lies inside the N-minute walking area of any selected station. Percentages are cumulative (≤ 5 min includes ≤ 1 min). Hover a percentage for counts.' }));
  }

  function buildCompanyList() {
    var ul = $('company-list');
    C.COMPANIES.forEach(function (c) {
      var id = 'company-' + c.id;
      var input = el('input', { type: 'checkbox', id: id });
      input.checked = state.companies.has(c.name);
      input.addEventListener('change', function () {
        if (input.checked) state.companies.add(c.name); else state.companies.delete(c.name);
        applyBuildings(); renderBuildingStats(); buildLegend();
      });
      var n = BLD.list.filter(function (b) { return b.company === c.name; }).length;
      ul.appendChild(el('li', { className: 'line-row' }, [input, el('label', { for: id }, [
        el('span', { className: 'dot', 'aria-hidden': 'true', style: { '--c': c.colour } }),
        el('span', { className: 'dot', 'aria-hidden': 'true', style: { '--c': c.developmentColour } }),
        el('span', { className: 'line-name', text: c.name }),
        el('span', { className: 'count', text: n ? n + ' buildings' : '' })
      ])]));
    });
  }

  function openBuildingPopup(id) {
    var b = BLD.byId[id];
    if (!b) return;
    hoverPopup.remove();
    var c = companyOf(b.company);
    var band = buildingBand(b);
    var near = [];
    Object.keys(b.stations).forEach(function (sid) {
      if (selectedSet.has(sid) && ISO.stations[sid]) near.push({ name: NET.byId[sid] ? NET.byId[sid].name : sid, sec: b.stations[sid] });
    });
    near.sort(function (x, y) { return x.sec - y.sec || x.name.localeCompare(y.name); });
    var walk = band === null ? 'More than 5 minutes from every selected station' : 'Within ' + band / 60 + ' min of a selected station';
    var dl = el('dl', null, [
      el('dt', { text: 'Company' }), el('dd', { text: b.company }),
      el('dt', { text: 'Status' }), el('dd', { text: b.status === 'Development' ? 'Development (pipeline)' : 'Standing asset' }),
      el('dt', { text: 'Type' }), el('dd', { text: b.propertyType || '—' }),
      el('dt', { text: 'Address' }), el('dd', { text: b.street || '—' }),
      el('dt', { text: 'Walk' }), el('dd', { text: walk }),
      el('dt', { text: 'Stations' }), el('dd', { text: near.length ? near.map(function (x) { return x.name + ' (' + x.sec / 60 + ' min)'; }).join(', ') : '—' }),
      el('dt', { text: 'Nearest' }), el('dd', { text: b.nearest ? b.nearest.name + ', ' + b.nearest.distanceM + ' m straight line' : '—' }),
      el('dt', { text: 'Located' }), el('dd', { text: { building: 'Building-level match', street: 'Street-level match (approximate)', area: 'Area-level match (approximate)' }[b.precision] || b.precision })
    ]);
    var body = el('div', { className: 'popup' }, [
      el('h3', null, [el('span', { className: 'dot', 'aria-hidden': 'true', style: { '--c': buildingColour(b) } }), b.name]),
      dl,
      b.geocoded ? el('p', { className: 'note', text: 'Geocoded as: ' + b.geocoded }) : null
    ]);
    if (infoPopup) infoPopup.remove();
    infoPopup = new maplibregl.Popup({ offset: 10, maxWidth: '320px', focusAfterOpen: true }).setLngLat([b.lon, b.lat]).setDOMContent(body).addTo(map);
    void c;
  }

  function loadBuildings() {
    loadScript('data/buildings.js').then(function () {
      var d = window.TUBE_BUILDINGS;
      if (!d || !Array.isArray(d.buildings)) throw new Error('public/data/buildings.js is not valid building data');
      BLD.list = d.buildings.filter(function (b) { return b && b.id && b.company; });
      BLD.list.forEach(function (b) { b.stations = b.stations || {}; BLD.byId[b.id] = b; });
      BLD.meta = d.meta;
      BLD.status = 'ready';
      var unlocated = BLD.list.filter(function (b) { return b.lon == null; }).length;
      if (unlocated) Messages.warning(unlocated + ' building(s) could not be geocoded and are not shown.', 'bld-unlocated');
    }).catch(function (err) {
      BLD.status = 'error';
      Messages.warning('Office building data could not be loaded (' + err.message + '). Run "npm run buildings".', 'bld-load');
    }).then(function () {
      buildCompanyList();
      var src = map.getSource && map.getSource('buildings');
      if (src) src.setData(buildingsGeoJSON());
      prevOutside = {};
      applyBuildings();
      renderBuildingStats();
      buildLegend();
    });
  }

  // ------------------------------------------------------------------- panel
  var lineInputs = {};
  var stationInputs = {}; // id -> [inputs]
  function buildLineList() {
    var list = $('line-list');
    C.LINES.forEach(function (line) {
      var inputId = 'line-' + line.id;
      var listId = 'stations-' + line.id;
      var input = el('input', { type: 'checkbox', id: inputId });
      input.addEventListener('change', function () { setLine(line.id, input.checked); });
      lineInputs[line.id] = input;
      var stations = NET.lineStations[line.id];
      var ul = el('ul', { className: 'station-list', id: listId, hidden: true, 'aria-label': line.name + ' line stations' });
      var built = false;
      var expand = el('button', {
        className: 'expand', type: 'button', 'aria-expanded': 'false', 'aria-controls': listId,
        'aria-label': 'Show ' + line.name + ' line stations'
      }, [el('span', { className: 'chev', 'aria-hidden': 'true', text: '▸' })]);
      expand.addEventListener('click', function () {
        var open = expand.getAttribute('aria-expanded') !== 'true';
        if (open && !built) { stations.forEach(function (s) { ul.appendChild(stationRow(s, 'l-' + line.id)); }); built = true; syncStationInputs(); }
        expand.setAttribute('aria-expanded', String(open));
        expand.setAttribute('aria-label', (open ? 'Hide ' : 'Show ') + line.name + ' line stations');
        ul.hidden = !open;
      });
      list.appendChild(el('li', { className: 'line-item' }, [
        el('div', { className: 'line-row' }, [
          input,
          el('label', { for: inputId }, [
            el('span', { className: 'swatch', 'aria-hidden': 'true', style: { '--c': line.colour } }),
            el('span', { className: 'line-name', text: line.name }),
            el('span', { className: 'count', text: stations.length + ' stations' })
          ]),
          expand
        ]),
        ul
      ]));
    });
  }

  function lineSwatches(s) {
    return el('span', { className: 'mini-swatches', 'aria-hidden': 'true' }, s.lines.map(function (l) {
      return el('span', { style: { '--c': C.LINE_BY_ID[l].colour } });
    }));
  }

  function stationRow(s, prefix) {
    var id = 'st-' + prefix + '-' + s.id;
    var input = el('input', { type: 'checkbox', id: id });
    input.dataset.stationId = s.id;
    input.addEventListener('change', function () { toggleStation(s.id); });
    (stationInputs[s.id] = stationInputs[s.id] || []).push(input);
    var lineNames = s.lines.map(function (l) { return C.LINE_BY_ID[l].name; }).join(', ');
    return el('li', { className: 'station-row' }, [
      input,
      el('label', { for: id, title: lineNames }, [s.name, s.lines.length > 1 ? el('span', { className: 'visually-hidden', text: ' (interchange: ' + lineNames + ')' }) : null]),
      s.lines.length > 1 ? el('span', { className: 'tag', text: s.lines.length + ' lines', 'aria-hidden': 'true' }) : null,
      el('button', { className: 'icon-btn', type: 'button', 'aria-label': 'Show ' + s.name + ' on the map', title: 'Show on map', text: '⌖', onclick: function () { focusStation(s.id); } })
    ]);
  }

  function syncStationInputs() {
    Object.keys(stationInputs).forEach(function (id) {
      var on = selectedSet.has(id);
      stationInputs[id] = stationInputs[id].filter(function (inp) { return inp.isConnected; });
      stationInputs[id].forEach(function (inp) { inp.checked = on; });
    });
  }

  function buildContourToggles() {
    var box = $('contour-toggles');
    C.CONTOURS.forEach(function (c) {
      var input = el('input', { type: 'checkbox', id: 'contour-' + c.seconds, value: String(c.seconds) });
      input.checked = state.contours.has(c.seconds);
      input.addEventListener('change', function () {
        if (input.checked) state.contours.add(c.seconds); else state.contours.delete(c.seconds);
        onStateChange({ coverage: true });
      });
      box.appendChild(el('label', { className: 'toggle', for: 'contour-' + c.seconds }, [input, contourIcon(c), c.label]));
    });
  }

  function contourIcon(c) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'contour-icon');
    svg.setAttribute('viewBox', '0 0 30 16');
    svg.setAttribute('aria-hidden', 'true');
    var r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', '1.5'); r.setAttribute('y', '1.5'); r.setAttribute('width', '27'); r.setAttribute('height', '13'); r.setAttribute('rx', '3');
    r.setAttribute('fill', c.fill); r.setAttribute('fill-opacity', '0.75');
    r.setAttribute('stroke', c.outline); r.setAttribute('stroke-width', '2');
    if (c.dash) r.setAttribute('stroke-dasharray', c.dash.map(function (d) { return d * 2; }).join(' '));
    svg.appendChild(r);
    return svg;
  }

  function buildLegend() {
    var ul = $('legend');
    ul.textContent = '';
    C.CONTOURS.forEach(function (c) {
      var patt = c.dash ? (c.dash[0] > 2 ? 'dashed outline' : 'dotted outline') : 'solid outline';
      ul.appendChild(el('li', null, [contourIcon(c), c.label + ' walk (' + patt + ')']));
    });
    ul.appendChild(el('li', null, [el('span', { className: 'station-symbol', 'aria-hidden': 'true' }), 'Selected station']));
    ul.appendChild(el('li', null, [el('span', { className: 'station-symbol interchange', 'aria-hidden': 'true' }), 'Selected interchange']));
    ul.appendChild(el('li', null, [el('span', { className: 'station-symbol unselected', 'aria-hidden': 'true' }), 'Station not selected']));
    if (BLD.status === 'ready') {
      ul.appendChild(el('li', null, [el('strong', { text: 'Office buildings (dark = standing, light = development)' })]));
      C.COMPANIES.forEach(function (c) {
        if (!state.companies.has(c.name)) return;
        ul.appendChild(el('li', null, [
          el('span', { className: 'dot', 'aria-hidden': 'true', style: { '--c': c.colour } }),
          el('span', { className: 'dot', 'aria-hidden': 'true', style: { '--c': c.developmentColour } }),
          c.name + ' — standing / development'
        ]));
      });
      ul.appendChild(el('li', null, [el('span', { className: 'dot faded', 'aria-hidden': 'true', style: { '--c': '#888888' } }), 'Faded: outside the selected walking times']));
    }
    var sel = C.LINES.filter(function (l) { return state.lines.has(l.id); });
    ul.appendChild(el('li', null, [el('strong', { text: 'Selected lines' + (sel.length ? '' : ': none') })]));
    sel.forEach(function (l) {
      ul.appendChild(el('li', null, [el('span', { className: 'swatch', 'aria-hidden': 'true', style: { '--c': l.colour } }), l.name]));
    });
  }

  function renderSummary() {
    $('summary').textContent = S.summaryText({
      lineCount: state.lines.size,
      stationCount: selection.stationIds.length,
      minutes: Array.from(state.contours).map(function (s) { return s / 60; }),
      added: selection.added.length,
      removed: selection.removed.length
    });
  }

  function syncPanel() {
    C.LINES.forEach(function (l) {
      var inp = lineInputs[l.id];
      inp.checked = state.lines.has(l.id);
      // Mixed state only for manual changes: a selected line with stations
      // removed by hand, or an unselected line with stations added by hand.
      // (Sharing an interchange with another selected line does not count.)
      var manual = state.lines.has(l.id) ? selection.removed : selection.added;
      inp.indeterminate = NET.lineStations[l.id].some(function (s) { return manual.indexOf(s.id) !== -1; });
    });
    syncStationInputs();
    renderSummary();
    buildLegend();
    renderStats();
  }

  // ----------------------------------------------------------------- actions
  function onStateChange(opts) {
    selection = S.resolveSelection(NET, state);
    selectedSet = new Set(selection.stationIds);
    if (map.getSource('stations')) { applySelectionToMap(false); applyLayerVisibility(); applyBuildings(); }
    syncPanel();
    renderBuildingStats();
    if (opts && opts.coverage === false) return;
    if (lastCoverage) renderCoverage(lastCoverage);
    updateCoverage();
  }
  function setLine(id, on) {
    if (on) state.lines.add(id); else state.lines.delete(id);
    state.overrides = S.pruneOverrides(NET, state);
    onStateChange();
  }
  function toggleStation(id) {
    state.overrides = S.toggleStation(NET, state, id);
    onStateChange();
  }
  function selectAll() { state.lines = new Set(C.LINES.map(function (l) { return l.id; })); state.overrides = {}; onStateChange(); }
  function clearAll() { state.lines = new Set(); state.overrides = {}; onStateChange(); }
  function reset() {
    state.lines = new Set(initialLines());
    state.overrides = {};
    state.contours = new Set(initialContours());
    state.mode = 'union';
    state.opacity = 0.45;
    state.showRoutes = state.showContext = state.showStations = state.showBuildings = true;
    state.companies = new Set(C.COMPANIES.map(function (c) { return c.name; }));
    state.statuses = new Set(['Standing', 'Development']);
    C.COMPANIES.forEach(function (c) { var i = $('company-' + c.id); if (i) i.checked = true; });
    $('show-buildings').checked = $('show-standing').checked = $('show-developments').checked = true;
    C.CONTOURS.forEach(function (c) { $('contour-' + c.seconds).checked = state.contours.has(c.seconds); });
    document.querySelector('input[name="mode"][value="union"]').checked = true;
    $('opacity').value = '45'; $('opacity-value').textContent = '45%';
    $('show-routes').checked = $('show-context').checked = $('show-stations').checked = true;
    $('station-search').value = ''; $('search-results').textContent = '';
    closePopups();
    setHighlight(null);
    onStateChange();
    map.fitBounds(C.LONDON_BOUNDS, { padding: fitPadding() });
  }

  function fitPadding() {
    var p = { top: 50, right: 50, bottom: 50, left: 50 };
    var panel = $('panel');
    if (window.innerWidth <= 760 && !document.body.classList.contains('panel-collapsed')) p.bottom = Math.min(panel.offsetHeight + 20, window.innerHeight * 0.6);
    return p;
  }
  function fitToSelection() {
    var pts = selection.stationIds.map(function (id) { var s = NET.byId[id]; return [s.lon, s.lat]; });
    if (!pts.length) { map.fitBounds(C.LONDON_BOUNDS, { padding: fitPadding() }); Messages.info('Nothing is selected, so the map shows all of London.', 'fit-empty'); return; }
    var b = G.bbox(pts);
    var pad = state.contours.size ? 0.0065 : 0.002; // keep 5-minute areas in view
    map.fitBounds([[b[0] - pad, b[1] - pad * 0.62], [b[2] + pad, b[3] + pad * 0.62]], { padding: fitPadding(), maxZoom: 16, duration: 0 });
  }

  // ---------------------------------------------------------- popups & focus
  var hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tooltip', offset: 10 });
  var infoPopup = null;
  function closePopups() { hoverPopup.remove(); if (infoPopup) { infoPopup.remove(); infoPopup = null; } }

  function setHighlight(id) {
    var src = map.getSource && map.getSource('highlight');
    if (!src) return;
    var s = id && NET.byId[id];
    src.setData({ type: 'FeatureCollection', features: s ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }] : [] });
  }

  function focusStation(id) {
    var s = NET.byId[id];
    if (!s) return;
    map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 15), duration: 0 });
    setHighlight(id);
    openStationPopup(id);
  }

  function lineChips(s) {
    return el('ul', { className: 'line-chips', 'aria-label': 'Lines' }, s.lines.map(function (l) {
      var line = C.LINE_BY_ID[l];
      return el('li', null, [el('span', { className: 'swatch', 'aria-hidden': 'true', style: { '--c': line.colour, width: '16px' } }), line.name]);
    }));
  }

  function openStationPopup(id) {
    var s = NET.byId[id];
    if (!s) return;
    hoverPopup.remove();
    var iso = ISO.stations[id];
    var selected = selectedSet.has(id);
    var walk;
    if (ISO.status === 'loading') walk = 'Loading…';
    else if (ISO.status === 'error') walk = 'Walking-area data unavailable';
    else if (iso) walk = 'Available (1, 2 and 5 min), generated ' + fmtDate(iso.at);
    else walk = 'Not generated yet';
    var dl = el('dl', null, [
      el('dt', { text: 'Coordinates' }), el('dd', { text: fmtCoord(s.lat, s.lon) }),
      el('dt', { text: 'Walking area' }), el('dd', { text: walk }),
      el('dt', { text: 'In coverage' }), el('dd', { text: selected ? (iso ? 'Yes' : 'Selected, but no walking area') : 'No (not selected)' }),
      el('dt', { text: 'Station ID' }), el('dd', { text: s.id + (s.objectId != null ? ' · CSV OBJECTID ' + s.objectId : '') })
    ]);
    var notes = [];
    var missing = s.lines.filter(function (l) { return s.csvLines.indexOf(l) === -1; });
    var extra = s.csvLines.filter(function (l) { return s.lines.indexOf(l) === -1; });
    if (missing.length || extra.length) {
      notes.push('Source CSV lists ' + (s.csvLines.map(function (l) { return C.LINE_BY_ID[l].name; }).join(', ') || 'no lines') + '; TfL topology is used.');
    }
    if (s.duplicateRecords && s.duplicateRecords.length) notes.push('Duplicate CSV record(s) merged: OBJECTID ' + s.duplicateRecords.map(function (d) { return d.objectId; }).join(', ') + '.');
    if (s.note) notes.push(s.note);
    if (s.unmatched) notes.push('Not found in TfL topology: drawn as a station but not connected to any line.');

    var toggle = el('button', { className: 'btn', type: 'button', text: selected ? 'Remove from selection' : 'Add to selection' });
    toggle.addEventListener('click', function () { toggleStation(id); openStationPopup(id); });
    var actions = el('div', { className: 'btn-row' }, [toggle]);
    if (!iso && ISO.status === 'ready' && serverConfig && serverConfig.onDemandIsochrones) {
      var gen = el('button', { className: 'btn', type: 'button', text: 'Generate walking area' });
      gen.addEventListener('click', function () { generateOnDemand(id, gen); });
      actions.appendChild(gen);
    }
    var body = el('div', { className: 'popup' }, [el('h3', { text: s.name }), lineChips(s), dl, actions]
      .concat(notes.map(function (n) { return el('p', { className: 'note', text: n }); })));
    if (infoPopup) infoPopup.remove();
    infoPopup = new maplibregl.Popup({ offset: 12, maxWidth: '300px', focusAfterOpen: true }).setLngLat([s.lon, s.lat]).setDOMContent(body).addTo(map);
    infoPopup.on('close', function () { setHighlight(null); });
  }

  function areaPopup(lngLat) {
    // Which selected stations' walking areas contain this point?
    var pt = [lngLat.lng, lngLat.lat];
    var rows = [];
    C.CONTOURS.forEach(function (c) {
      if (!state.contours.has(c.seconds)) return;
      var names = [];
      selection.stationIds.forEach(function (id) {
        var g = stationGeom(id, c.seconds);
        if (!g) return;
        var b = g._bbox || (g._bbox = G.bbox(g.coordinates));
        if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) return;
        if (G.pointInPolygons(pt, G.toPolygons(g))) names.push(NET.byId[id].name);
      });
      if (names.length) rows.push({ c: c, names: names });
    });
    if (!rows.length) return false;
    var body = el('div', { className: 'popup' }, [el('h3', { text: 'Walking time from here' })].concat(rows.map(function (r) {
      return el('p', { className: 'note', text: 'Within ' + r.c.label + ' of: ' + r.names.join(', ') });
    })));
    if (infoPopup) infoPopup.remove();
    infoPopup = new maplibregl.Popup({ offset: 6, maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(body).addTo(map);
    return true;
  }

  map.on('mousemove', 'stations', function (e) {
    var f = e.features && e.features[0];
    if (!f) return;
    map.getCanvas().style.cursor = 'pointer';
    var s = NET.byId[f.properties.id];
    var lines = s.lines.map(function (l) { return C.LINE_BY_ID[l].name; }).join(', ');
    hoverPopup.setLngLat([s.lon, s.lat]).setDOMContent(el('div', null, [s.name, el('br'), el('span', { style: { 'font-weight': '400' }, text: lines })])).addTo(map);
  });
  map.on('mouseleave', 'stations', function () { map.getCanvas().style.cursor = ''; hoverPopup.remove(); });
  map.on('mousemove', 'buildings', function (e) {
    if (map.queryRenderedFeatures(e.point, { layers: ['stations'] }).length) return;
    var f = e.features && e.features[0];
    var b = f && BLD.byId[f.properties.id];
    if (!b) return;
    map.getCanvas().style.cursor = 'pointer';
    hoverPopup.setLngLat([b.lon, b.lat]).setDOMContent(el('div', null, [b.name, el('br'), el('span', { style: { 'font-weight': '400' }, text: b.company + (b.status === 'Development' ? ' · development' : '') })])).addTo(map);
  });
  map.on('mouseleave', 'buildings', function () { map.getCanvas().style.cursor = ''; hoverPopup.remove(); });
  map.on('click', function (e) {
    var hits = map.getLayer('stations') ? map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['stations'] }) : [];
    if (hits.length && state.showStations) { setHighlight(hits[0].properties.id); openStationPopup(hits[0].properties.id); return; }
    var bh = map.getLayer('buildings') && state.showBuildings ? map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: ['buildings'] }) : [];
    if (bh.length) { openBuildingPopup(bh[0].properties.id); return; }
    if (ISO.status === 'ready' && state.contours.size) areaPopup(e.lngLat);
  });

  // ------------------------------------------------------------- search box
  function renderSearch() {
    var q = $('station-search').value;
    var ul = $('search-results');
    ul.textContent = '';
    if (!q.trim()) return;
    var results = S.searchStations(NET, q, 12);
    if (!results.length) { ul.appendChild(el('li', { className: 'hint', text: 'No station matches “' + q + '”.' })); return; }
    results.forEach(function (s) {
      var row = stationRow(s, 'search');
      var label = row.querySelector('label');
      var btn = el('button', { className: 'result-name', type: 'button', 'aria-label': 'Show ' + s.name + ' on the map' }, [s.name, lineSwatches(s)]);
      btn.addEventListener('click', function () { focusStation(s.id); });
      label.classList.add('visually-hidden');
      label.textContent = 'Include ' + s.name + ' in selection';
      row.insertBefore(btn, row.querySelector('.tag') || row.querySelector('.icon-btn'));
      row.querySelector('.icon-btn').remove();
      ul.appendChild(row);
    });
    syncStationInputs();
  }
  $('station-search').addEventListener('input', debounce(renderSearch, 120));
  $('station-search').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { var b = $('search-results').querySelector('button'); if (b) { e.preventDefault(); b.focus(); } }
    if (e.key === 'Enter') { var r = S.searchStations(NET, this.value, 1)[0]; if (r) { e.preventDefault(); focusStation(r.id); } }
  });
  $('search-results').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var btns = Array.prototype.slice.call(this.querySelectorAll('button.result-name'));
    var i = btns.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    if (e.key === 'ArrowDown' && btns[i + 1]) btns[i + 1].focus();
    if (e.key === 'ArrowUp') (btns[i - 1] || $('station-search')).focus();
  });

  // ------------------------------------------------------------ wire controls
  $('select-all').addEventListener('click', selectAll);
  $('clear-all').addEventListener('click', clearAll);
  $('fit').addEventListener('click', fitToSelection);
  $('reset').addEventListener('click', reset);
  Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (r) {
    r.addEventListener('change', function () { if (r.checked) { state.mode = r.value; applyLayerVisibility(); onStateChange(); } });
  });
  var setOpacity = debounce(function (v) { state.opacity = v; applyLayerVisibility(); }, 30);
  $('opacity').addEventListener('input', function () { $('opacity-value').textContent = this.value + '%'; setOpacity(Number(this.value) / 100); });
  [['show-routes', 'showRoutes'], ['show-context', 'showContext'], ['show-stations', 'showStations']].forEach(function (p) {
    $(p[0]).addEventListener('change', function () { state[p[1]] = this.checked; applyLayerVisibility(); });
  });
  $('show-buildings').addEventListener('change', function () { state.showBuildings = this.checked; applyBuildings(); });
  [['show-standing', 'Standing'], ['show-developments', 'Development']].forEach(function (p) {
    $(p[0]).addEventListener('change', function () { if (this.checked) state.statuses.add(p[1]); else state.statuses.delete(p[1]); applyBuildings(); });
  });

  function setPanel(open) {
    document.body.classList.toggle('panel-collapsed', !open);
    $('panel-toggle').setAttribute('aria-expanded', String(open));
    $('panel-toggle-label').textContent = open ? 'Hide controls' : 'Show controls';
    setTimeout(function () { map.resize(); }, 0);
  }
  $('panel-toggle').addEventListener('click', function () { setPanel(document.body.classList.contains('panel-collapsed')); });
  if (window.innerWidth <= 760) setPanel(false);

  $('theme-toggle').addEventListener('click', function () {
    themePref = { auto: 'light', light: 'dark', dark: 'auto' }[themePref];
    storageSet('tube-walk-theme', themePref);
    switchTheme();
  });
  if (mql && mql.addEventListener) mql.addEventListener('change', function () { if (themePref === 'auto') switchTheme(); });
  function switchTheme() {
    var before = document.documentElement.getAttribute('data-theme');
    applyThemeAttr();
    if (before === effectiveTheme()) return;
    closePopups();
    styleOk = false;
    map.setStyle(usingFallback ? fallbackStyle() : BASEMAPS[effectiveTheme()], { diff: false });
  }

  var dialog = $('info-dialog');
  function openInfo() {
    renderInfoMeta();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  $('info-open').addEventListener('click', openInfo);
  $('info-open-2').addEventListener('click', openInfo);
  $('info-close').addEventListener('click', function () { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); });

  function renderInfoMeta() {
    var dl = $('info-meta');
    dl.textContent = '';
    var m = ISO.meta || {};
    var rows = [
      ['Routing provider', (m.providers && m.providers.join(', ')) || (ISO.status === 'error' ? 'unavailable' : 'not loaded')],
      ['Pedestrian profile', (m.profiles && m.profiles.join(', ')) || '—'],
      ['Parameters', m.parameters ? JSON.stringify(m.parameters) : '—'],
      ['Isochrones generated', m.isochronesGeneratedBetween ? fmtDate(m.isochronesGeneratedBetween[0]) + (m.isochronesGeneratedBetween[1] !== m.isochronesGeneratedBetween[0] ? ' – ' + fmtDate(m.isochronesGeneratedBetween[1]) : '') : '—'],
      ['Stations with walking areas', m.stationCount != null ? m.stationCount + ' of ' + m.totalStations : '—'],
      ['Topology retrieved', fmtDate(NET.meta.topology && NET.meta.topology.retrievedAt)],
      ['Network built', fmtDate(NET.meta.generatedAt)],
      ['Physical stations', String(NET.stations.length)],
      ['Walking-area origin', m.originNote || 'Supplied station coordinate (centroid).']
    ];
    rows.forEach(function (r) { dl.appendChild(el('dt', { text: r[0] })); dl.appendChild(el('dd', { text: r[1] })); });
    $('info-provider').textContent = (m.providers && m.providers.join(', ')) || 'the routing provider';
  }

  function renderProvenance() {
    var m = ISO.meta;
    var p = $('provenance');
    if (ISO.status === 'loading') { p.textContent = 'Walking areas: loading…'; return; }
    if (!m) { p.textContent = 'Walking areas: unavailable.'; return; }
    var when = m.isochronesGeneratedBetween ? fmtDate(m.isochronesGeneratedBetween[1]) : 'unknown date';
    p.textContent = 'Walking areas: ' + (m.providers || []).join(', ') + ' · ' + (m.profiles || []).join(', ') + ' profile · generated ' + when + ' · ' + m.stationCount + '/' + m.totalStations + ' stations.';
  }

  // ------------------------------------------------- progressive data loading
  function loadScript(src) {
    var inlined = { 'data/isochrones.js': 'TUBE_ISOCHRONES', 'data/coverage.js': 'TUBE_COVERAGE', 'data/buildings.js': 'TUBE_BUILDINGS' }[src];
    if (window.TUBE_SINGLE_FILE && inlined) return window[inlined] ? Promise.resolve() : Promise.reject(new Error(src + ' was not bundled'));
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function validIsoData(d) {
    return d && d.meta && d.stations && typeof d.stations === 'object';
  }

  function loadIsochrones() {
    loadScript('data/isochrones.js').then(function () {
      var d = window.TUBE_ISOCHRONES;
      if (!validIsoData(d)) throw new Error('public/data/isochrones.js is not valid walking-area data');
      var bad = 0;
      Object.keys(d.stations).forEach(function (id) {
        var rec = d.stations[id];
        if (!NET.byId[id] || !rec || !rec.g) { bad++; return; }
        var g = {};
        C.CONTOUR_SECONDS.forEach(function (sec) { if (rec.g[sec] && G.isValidPolygonal(rec.g[sec])) g[sec] = rec.g[sec]; else bad++; });
        ISO.stations[id] = { g: g, at: rec.at };
      });
      ISO.meta = d.meta;
      ISO.status = 'ready';
      if (bad) Messages.warning(bad + ' invalid walking-area geometr' + (bad === 1 ? 'y was' : 'ies were') + ' ignored.', 'iso-invalid');
      var missing = NET.stations.filter(function (s) { return s.lines.length && !ISO.stations[s.id]; }).length;
      if (missing) Messages.warning(missing + ' station(s) have no walking area yet. Run "npm run isochrones" to generate them.', 'iso-missing');
      if (d.meta.failures && d.meta.failures.length) Messages.warning('The last isochrone run failed for ' + d.meta.failures.length + ' station(s). See data/isochrones/_failures.json.', 'iso-failures');
      updateAttribution();
      return loadScript('data/coverage.js').then(function () {
        var c = window.TUBE_COVERAGE;
        if (c && c.lines && c.all) COVERAGE = c;
      }).catch(function () { /* optional: unions are then computed in the browser */ });
    }).catch(function (err) {
      ISO.status = 'error';
      Messages.error('Walking-area data could not be loaded (' + err.message + '). Run "npm run isochrones && npm run unions". Lines and stations are unaffected.', 'iso-load');
    }).then(function () {
      renderProvenance();
      renderStats();
      onStateChange();
      loadBuildings();
    });
  }

  function updateAttribution() {
    try {
      map.removeControl(attribution);
      attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: attributionHtml() });
      map.addControl(attribution, 'bottom-right');
    } catch (e) { /* non-fatal */ }
  }

  // --------------------------------------------- optional server (on demand)
  var serverConfig = null;
  function loadServerConfig() {
    if (IS_FILE) return;
    var base = (APP.apiBase || '').replace(/\/+$/, '');
    fetch(base + '/api/config', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) { serverConfig = cfg; })
      .catch(function () { serverConfig = null; /* static hosting: no API, which is fine */ });
  }
  function generateOnDemand(id, btn) {
    var base = (APP.apiBase || '').replace(/\/+$/, '');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 60000);
    fetch(base + '/api/isochrone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stationId: id }), signal: ctrl.signal })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || ('HTTP ' + r.status)); return j; }); })
      .then(function (j) {
        var g = {};
        (j.record.features || []).forEach(function (f) {
          var simp = G.simplifyGeometry(f.geometry, 0.000015, 5);
          if (simp) g[f.properties.seconds] = simp;
        });
        ISO.stations[id] = { g: g, at: j.record.generatedAt };
        ISO.augmented = true;
        unionCache.clear();
        Messages.info('Walking area generated for ' + NET.byId[id].name + '.');
        onStateChange();
        openStationPopup(id);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Generate walking area';
        Messages.error(err.name === 'AbortError' ? 'The routing request timed out.' : 'Could not generate walking area: ' + err.message);
      })
      .then(function () { clearTimeout(timer); });
  }

  // -------------------------------------------------------------------- init
  buildLineList();
  buildContourToggles();
  syncPanel();
  renderProvenance();
  if (IS_FILE && !window.TUBE_SINGLE_FILE) Messages.info('Opened from disk: unions run on the main thread (Web Workers need http). Use "npm start" for the best performance.', 'file-mode');
  map.once('load', function () { loadIsochrones(); });
  loadServerConfig();

  // Exposed for debugging and automated UI checks only.
  window.TubeWalkApp = { state: state, getSelection: function () { return selection; }, map: map, iso: ISO, buildings: BLD };
})();
