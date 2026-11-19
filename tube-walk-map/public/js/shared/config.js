/*
 * Central configuration shared by the browser app, the Node data pipeline and
 * the tests. UMD wrapper: works as a classic <script> (including file://) and
 * via require() in Node.
 *
 * Line colours: Transport for London "Colour standard", Issue 11 (August
 * 2026), RGB column (the values TfL specifies for screens and devices):
 * section 5 "London Underground line colours" for the Underground lines and
 * section 3 "Mode colours" for the Elizabeth line (RGB 96 57 158).
 *
 * The Elizabeth line is shown as a line alongside the Underground lines. Its
 * `mode` is kept only for data handling (TfL API mode name, validation limits).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TubeConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hex(rgb) {
    return '#' + rgb.map(function (v) { return v.toString(16).padStart(2, '0'); }).join('').toUpperCase();
  }

  // Order here is also the left-to-right slot order used to offset lines that
  // share track, so the same line always sits in the same relative position.
  var LINE_DEFS = [
    { id: 'bakerloo', name: 'Bakerloo', rgb: [178, 99, 0], pms: '470', mode: 'tube' },
    { id: 'central', name: 'Central', rgb: [220, 36, 31], pms: '485', mode: 'tube' },
    { id: 'circle', name: 'Circle', rgb: [255, 200, 10], pms: '116', mode: 'tube' },
    { id: 'district', name: 'District', rgb: [0, 125, 50], pms: '356', mode: 'tube' },
    { id: 'hammersmith-city', name: 'Hammersmith & City', rgb: [245, 137, 166], pms: '197', mode: 'tube' },
    { id: 'jubilee', name: 'Jubilee', rgb: [131, 141, 147], pms: '430', mode: 'tube' },
    { id: 'metropolitan', name: 'Metropolitan', rgb: [155, 0, 88], pms: '235', mode: 'tube' },
    { id: 'northern', name: 'Northern', rgb: [0, 0, 0], pms: 'Black', mode: 'tube' },
    { id: 'piccadilly', name: 'Piccadilly', rgb: [0, 25, 168], pms: '072', mode: 'tube' },
    { id: 'victoria', name: 'Victoria', rgb: [3, 155, 229], pms: '299', mode: 'tube' },
    { id: 'waterloo-city', name: 'Waterloo & City', rgb: [118, 208, 189], pms: '338', mode: 'tube' },
    { id: 'elizabeth', name: 'Elizabeth line', rgb: [96, 57, 158], pms: '266', mode: 'elizabeth-line' }
  ];

  var LINES = LINE_DEFS.map(function (l, i) {
    return Object.freeze({
      id: l.id,
      name: l.name,
      rgb: Object.freeze(l.rgb.slice()),
      colour: hex(l.rgb),
      pms: l.pms,
      mode: l.mode,
      order: i
    });
  });

  var LINE_BY_ID = {};
  var LINE_ID_BY_NAME = {};
  LINES.forEach(function (l) {
    LINE_BY_ID[l.id] = l;
    LINE_ID_BY_NAME[l.name.toLowerCase()] = l.id;
  });
  // Spelling variants that may appear in source data.
  LINE_ID_BY_NAME['hammersmith and city'] = 'hammersmith-city';
  LINE_ID_BY_NAME['hammersmith & city line'] = 'hammersmith-city';
  LINE_ID_BY_NAME['waterloo and city'] = 'waterloo-city';
  LINE_ID_BY_NAME['elizabeth'] = 'elizabeth';

  var MODES = [
    { id: 'tube', name: 'London Underground', tflMode: 'tube' },
    { id: 'elizabeth-line', name: 'Elizabeth line', tflMode: 'elizabeth-line' }
  ];

  // Walking-time contours. Colours are a teal-green sequential ramp. The
  // Elizabeth line already uses purple, and no line uses this hue (Waterloo &
  // City is a much lighter, bluer turquoise). Each contour also has its own
  // outline dash pattern, so state does not depend on colour alone.
  var CONTOURS = [
    { seconds: 300, minutes: 5, label: '5 minutes', fill: '#1F8A7D', outline: '#13594F', dash: null },
    { seconds: 600, minutes: 10, label: '10 minutes', fill: '#9ED9CC', outline: '#4F9E90', dash: [4, 2] }
  ];

  // Office portfolio companies. Each company has its own colour; its
  // development pipeline uses the same hue mixed 45% towards white ("a bit
  // lighter"). Hues were chosen to stand apart from each other and from the
  // teal walking-area fills; points always have a dark outline.
  function lighten(rgb, t) { return rgb.map(function (v) { return Math.round(v + (255 - v) * t); }); }
  var COMPANIES = [
    { id: 'landsec', name: 'Landsec', rgb: [232, 113, 10] },
    { id: 'gpe', name: 'Great Portland Estates', rgb: [194, 24, 91] },
    { id: 'british-land', name: 'British Land', rgb: [21, 101, 192] },
    { id: 'derwent', name: 'Derwent London', rgb: [143, 108, 0] },
    // Portfolios including joint ventures (sheets "British Land 2" / "Land Sec 2").
    { id: 'british-land-jv', name: 'British Land (incl. JV)', rgb: [93, 64, 55] },
    { id: 'landsec-jv', name: 'Landsec (incl. JV)', rgb: [104, 159, 56] }
  ].map(function (c) {
    return Object.freeze({ id: c.id, name: c.name, colour: hex(c.rgb), developmentColour: hex(lighten(c.rgb, 0.45)) });
  });
  var COMPANY_BY_NAME = {};
  COMPANIES.forEach(function (c) { COMPANY_BY_NAME[c.name] = c; });

  return Object.freeze({
    COMPANIES: Object.freeze(COMPANIES),
    COMPANY_BY_NAME: Object.freeze(COMPANY_BY_NAME),
    LINES: Object.freeze(LINES),
    LINE_BY_ID: Object.freeze(LINE_BY_ID),
    LINE_ID_BY_NAME: Object.freeze(LINE_ID_BY_NAME),
    MODES: Object.freeze(MODES),
    CONTOURS: Object.freeze(CONTOURS),
    CONTOUR_SECONDS: Object.freeze([300, 600]),
    WALKING_SPEED_MPS: 1.4,
    // Approximate Greater London extent [west, south, east, north].
    LONDON_BOUNDS: Object.freeze([-0.62, 51.39, 0.27, 51.71]),
    BASEMAPS: Object.freeze({
      light: 'https://tiles.openfreemap.org/styles/positron',
      dark: 'https://tiles.openfreemap.org/styles/dark'
    }),
    DISCLAIMER: 'Unofficial accessibility visualisation. Not affiliated with or endorsed by Transport for London.',
    hexFromRgb: hex
  });
});
