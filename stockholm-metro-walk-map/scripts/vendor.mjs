#!/usr/bin/env node
// Copies browser builds of pinned dependencies into public/vendor so the app
// can be served statically or opened from disk without a CDN, and creates
// public/config.js from the example if it does not exist yet.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/common.mjs';

const vendor = path.join(ROOT, 'public', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
const files = [
  ['node_modules/maplibre-gl/dist/maplibre-gl.js', 'maplibre-gl.js'],
  ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['node_modules/maplibre-gl/LICENSE.txt', 'maplibre-gl.LICENSE.txt'],
  ['node_modules/polygon-clipping/dist/polygon-clipping.umd.min.js', 'polygon-clipping.umd.min.js'],
  ['node_modules/polygon-clipping/LICENSE.md', 'polygon-clipping.LICENSE.txt']
];
let ok = true;
for (const [src, dest] of files) {
  const from = path.join(ROOT, src);
  if (!fs.existsSync(from)) { console.error(`vendor: missing ${src} (run npm install)`); ok = false; continue; }
  fs.copyFileSync(from, path.join(vendor, dest));
}
const cfg = path.join(ROOT, 'public', 'config.js');
if (!fs.existsSync(cfg)) fs.copyFileSync(path.join(ROOT, 'public', 'config.example.js'), cfg);
console.log(ok ? 'vendor: browser libraries copied to public/vendor' : 'vendor: some files missing');
process.exitCode = ok ? 0 : 1;
