#!/usr/bin/env node
// Builds ONE self-contained HTML file (dist/tube-walk-map.html) that can be
// emailed, shared or opened from disk: CSS, MapLibre, polygon-clipping, app
// code and all station / line / walking-area data are inlined.
// Only the basemap tiles (OpenFreeMap) are loaded from the internet; without
// a connection the map falls back to a plain background.
// Unions run on the main thread (there is no separate Web Worker file).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, rel } from './lib/common.mjs';

const pub = path.join(ROOT, 'public');
const out = path.join(ROOT, 'dist', 'tube-walk-map.html');
const read = (p) => {
  const f = path.join(pub, p);
  if (!fs.existsSync(f)) {
    console.error(`ERROR: missing public/${p}. Run "npm install" and the data pipeline first.`);
    process.exit(1);
  }
  return fs.readFileSync(f, 'utf8');
};
const safeScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href).replace(/<\/style/gi, '<\\/style')}\n</style>`);

// Data loaded lazily by the normal app is bundled up front here.
const extra = ['data/isochrones.js', 'data/coverage.js', 'data/buildings.js'];
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  if (src === 'config.js') src = 'config.example.js';
  let block = `<script>\n${safeScript(read(src))}\n</script>`;
  if (src === 'data/network.js') {
    block = `<script>window.TUBE_SINGLE_FILE = true;</script>\n` + block +
      extra.map((x) => `\n<script>\n${safeScript(read(x))}\n</script>`).join('');
  }
  return block;
});
if (/<script src=|<link rel="stylesheet"/.test(html)) { console.error('ERROR: an external reference was not inlined'); process.exit(1); }

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`Wrote ${rel(out)} (${mb} MB) — a single self-contained file you can share.`);
