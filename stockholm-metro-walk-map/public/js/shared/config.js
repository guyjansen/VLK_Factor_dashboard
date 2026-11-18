/*
 * Central configuration shared by the browser app, the Node data pipeline and
 * the tests. UMD wrapper: works as a classic <script> (including file://) and
 * via require() in Node. Colours are defined ONLY here (tests enforce this).
 *
 * Line colours: SL's own screen colours, read from the design-system
 * stylesheet of https://sl.se/ (CSS custom properties --color-metro-blue,
 * --color-metro-red and --color-metro-green; evidence and retrieval date in
 * data/raw/sl-colours/manifest.json).
 *
 * The Stockholm metro (tunnelbana) has three colour lines. Each colour line is
 * operated as several numbered routes ("linje 10", "linje 11", ...). The map
 * selects by colour line; route numbers come from the operator's GTFS feed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetroConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hex(rgb) {
    return '#' + rgb.map(function (v) { return v.toString(16).padStart(2, '0'); }).join('').toUpperCase();
  }

  // Order here is also the slot order used to offset lines that share track
  // (red and green run side by side between Slussen and T-Centralen).
  var LINE_DEFS = [
    { id: 'blue', name: 'Blue line', localName: 'Blå linjen', rgb: [0, 125, 184], cssToken: '--color-metro-blue',
      routes: ['10', '11'], description: 'Hjulsta / Akalla – Kungsträdgården' },
    { id: 'red', name: 'Red line', localName: 'Röda linjen', rgb: [215, 29, 36], cssToken: '--color-metro-red',
      routes: ['13', '14'], description: 'Norsborg – Ropsten / Fruängen – Mörby centrum' },
    { id: 'green', name: 'Green line', localName: 'Gröna linjen', rgb: [20, 133, 65], cssToken: '--color-metro-green',
      routes: ['17', '18', '19'], description: 'Hässelby strand / Åkeshov / Alvik – Skarpnäck / Farsta strand / Hagsätra' }
  ];

  var LINES = LINE_DEFS.map(function (l, i) {
    return Object.freeze({
      id: l.id,
      name: l.name,
      localName: l.localName,
      rgb: Object.freeze(l.rgb.slice()),
      colour: hex(l.rgb),
      cssToken: l.cssToken,
      routes: Object.freeze(l.routes.slice()),
      description: l.description,
      mode: 'metro',
      order: i
    });
  });

  var LINE_BY_ID = {};
  var LINE_ID_BY_ROUTE = {};
  var LINE_ID_BY_NAME = {};
  LINES.forEach(function (l) {
    LINE_BY_ID[l.id] = l;
    l.routes.forEach(function (r) { LINE_ID_BY_ROUTE[r] = l.id; });
    LINE_ID_BY_NAME[l.name.toLowerCase()] = l.id;
    LINE_ID_BY_NAME[l.localName.toLowerCase()] = l.id;
  });

  var MODES = [{ id: 'metro', name: 'Stockholm metro (tunnelbana)', gtfsRouteTypes: ['1', '401'] }];

  // Walking-time contours: a violet sequential ramp. No SL metro line is
  // violet, and violet is far from the blue, red and green line colours and
  // from the gold company colour. Each contour also has its own outline
  // pattern (solid / dashed), so the threshold never depends on colour alone.
  var CONTOURS = [
    { seconds: 300, minutes: 5, label: '5 minutes', fill: '#6A3D9A', outline: '#3F1F66', dash: null },
    { seconds: 600, minutes: 10, label: '10 minutes', fill: '#C7B3E5', outline: '#7B5BA8', dash: [4, 2] }
  ];

  // Portfolio companies. Each company has its own colour; developments use
  // the same hue mixed 45% towards white ("a lighter shade"). Gold was chosen
  // to stand apart from the three line colours and the violet walking areas.
  // Add further companies here (suggested free hues: #8C510A brown,
  // #D6338A magenta, #2F4F4F slate).
  function lighten(rgb, t) { return rgb.map(function (v) { return Math.round(v + (255 - v) * t); }); }
  var COMPANIES = [
    { id: 'fabege', name: 'Fabege', rgb: [201, 138, 0] }
  ].map(function (c) {
    return Object.freeze({ id: c.id, name: c.name, rgb: Object.freeze(c.rgb.slice()), colour: hex(c.rgb), developmentColour: hex(lighten(c.rgb, 0.45)) });
  });
  var COMPANY_BY_NAME = {};
  COMPANIES.forEach(function (c) { COMPANY_BY_NAME[c.name] = c; });

  return Object.freeze({
    CITY: 'Stockholm',
    COMPANIES: Object.freeze(COMPANIES),
    COMPANY_BY_NAME: Object.freeze(COMPANY_BY_NAME),
    LINES: Object.freeze(LINES),
    LINE_BY_ID: Object.freeze(LINE_BY_ID),
    LINE_ID_BY_ROUTE: Object.freeze(LINE_ID_BY_ROUTE),
    LINE_ID_BY_NAME: Object.freeze(LINE_ID_BY_NAME),
    MODES: Object.freeze(MODES),
    CONTOURS: Object.freeze(CONTOURS),
    CONTOUR_SECONDS: Object.freeze(CONTOURS.map(function (c) { return c.seconds; })),
    WALKING_SPEED_MPS: 1.4,
    STATUSES: Object.freeze(['Standing', 'Development']),
    // Metro network extent [west, south, east, north] (Hjulsta–Ropsten, Akalla–Norsborg).
    CITY_BOUNDS: Object.freeze([17.80, 59.19, 18.15, 59.43]),
    // Sergels torg, used for geocode plausibility checks.
    CITY_CENTRE: Object.freeze([18.0649, 59.3326]),
    BASEMAPS: Object.freeze({
      light: 'https://tiles.openfreemap.org/styles/positron',
      dark: 'https://tiles.openfreemap.org/styles/dark'
    }),
    DISCLAIMER: 'Unofficial accessibility visualisation. Not affiliated with or endorsed by SL (Storstockholms Lokaltrafik), Region Stockholm, Samtrafiken or Trafiklab.',
    hexFromRgb: hex
  });
});
