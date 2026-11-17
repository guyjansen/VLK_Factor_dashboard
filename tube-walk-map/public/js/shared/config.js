/*
 * Central configuration shared by the browser app, the Node data pipeline and
 * the tests. UMD wrapper: works as a classic <script> (including file://) and
 * via require() in Node.
 *
 * Line colours: Transport for London "Colour standard", Issue 11 (August
 * 2026), section 5 "London Underground line colours", RGB column (the RGB
 * values are the ones TfL specifies for screens and devices).
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
    { id: 'bakerloo', name: 'Bakerloo', rgb: [178, 99, 0], pms: '470' },
    { id: 'central', name: 'Central', rgb: [220, 36, 31], pms: '485' },
    { id: 'circle', name: 'Circle', rgb: [255, 200, 10], pms: '116' },
    { id: 'district', name: 'District', rgb: [0, 125, 50], pms: '356' },
    { id: 'hammersmith-city', name: 'Hammersmith & City', rgb: [245, 137, 166], pms: '197' },
    { id: 'jubilee', name: 'Jubilee', rgb: [131, 141, 147], pms: '430' },
    { id: 'metropolitan', name: 'Metropolitan', rgb: [155, 0, 88], pms: '235' },
    { id: 'northern', name: 'Northern', rgb: [0, 0, 0], pms: 'Black' },
    { id: 'piccadilly', name: 'Piccadilly', rgb: [0, 25, 168], pms: '072' },
    { id: 'victoria', name: 'Victoria', rgb: [3, 155, 229], pms: '299' },
    { id: 'waterloo-city', name: 'Waterloo & City', rgb: [118, 208, 189], pms: '338' }
  ];

  var LINES = LINE_DEFS.map(function (l, i) {
    return Object.freeze({
      id: l.id,
      name: l.name,
      rgb: Object.freeze(l.rgb.slice()),
      colour: hex(l.rgb),
      pms: l.pms,
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

  // Walking-time contours. Colours are a violet sequential ramp: violet is not
  // used by any Underground line, and each contour also has its own outline
  // dash pattern so state does not depend on colour alone.
  var CONTOURS = [
    { seconds: 60, minutes: 1, label: '1 minute', fill: '#4B1FA3', outline: '#2E0F6E', dash: null },
    { seconds: 120, minutes: 2, label: '2 minutes', fill: '#8B6BD6', outline: '#5A3DB0', dash: [4, 2] },
    { seconds: 300, minutes: 5, label: '5 minutes', fill: '#C7B8F2', outline: '#7E66C9', dash: [1, 2] }
  ];

  return Object.freeze({
    LINES: Object.freeze(LINES),
    LINE_BY_ID: Object.freeze(LINE_BY_ID),
    LINE_ID_BY_NAME: Object.freeze(LINE_ID_BY_NAME),
    CONTOURS: Object.freeze(CONTOURS),
    CONTOUR_SECONDS: Object.freeze([60, 120, 300]),
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
