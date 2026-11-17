/*
 * Optional runtime configuration. `npm install` copies this file to
 * public/config.js (git-ignored) if that does not exist. No secrets belong here:
 * everything in public/ is sent to every visitor.
 */
window.TUBE_APP_CONFIG = {
  // Basemap style URLs (MapLibre style JSON). OpenFreeMap needs no key and
  // permits public use; replace with your own tile service for heavy traffic.
  basemaps: {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark'
  },
  // Base URL of the optional server API (same origin by default). Ignored when
  // the page is opened from disk (file://).
  apiBase: '',
  // Initial state.
  initialLines: 'all', // 'all' or an array of line ids, e.g. ['victoria']
  initialContours: [300, 600]
};
