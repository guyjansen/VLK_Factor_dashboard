#!/usr/bin/env node
// Production build: verify generated data, then copy public/ to dist/ as a
// self-contained static site (works on any static host or from disk).
// The Express server is optional; it adds on-demand isochrones and headers.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, paths, rel } from './lib/common.mjs';

const dist = path.join(ROOT, 'dist');
const errors = [];
const warnings = [];

function checkBrowserData(file, globalName, required) {
  if (!fs.existsSync(file)) { (required ? errors : warnings).push(`${rel(file)} is missing`); return null; }
  const ctx = { window: {} };
  try {
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { timeout: 5000 });
  } catch (err) {
    errors.push(`${rel(file)} is not valid JavaScript: ${err.message}`);
    return null;
  }
  if (!ctx.window[globalName]) errors.push(`${rel(file)} does not define window.${globalName}`);
  return ctx.window[globalName];
}

for (const f of ['vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/polygon-clipping.umd.min.js']) {
  if (!fs.existsSync(path.join(ROOT, 'public', f))) errors.push(`public/${f} is missing (run npm install)`);
}
const net = checkBrowserData(paths.publicNetwork, 'METRO_NETWORK', true);
const iso = checkBrowserData(paths.publicIsochrones, 'METRO_ISOCHRONES', false);
checkBrowserData(paths.publicCoverage, 'METRO_COVERAGE', false);
if (net && net.stations.length < 250) errors.push(`network.js has only ${net.stations.length} stations`);
if (iso && iso.meta.missing?.length) warnings.push(`${iso.meta.missing.length} station(s) have no isochrones`);
if (fs.existsSync(paths.validation)) {
  const v = JSON.parse(fs.readFileSync(paths.validation, 'utf8'));
  if (v.errors?.length) errors.push(`validation report has errors: ${v.errors.join('; ')}`);
} else warnings.push('data/validation-report.json missing (run npm run validate)');

warnings.forEach((w) => console.warn(`warning: ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`ERROR: ${e}`));
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), dist, { recursive: true, filter: (src) => !/\.tmp-/.test(src) });
if (!fs.existsSync(path.join(dist, 'config.js'))) fs.copyFileSync(path.join(ROOT, 'public', 'config.example.js'), path.join(dist, 'config.js'));
let bytes = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size; } })(dist);
console.log(`Built ${rel(dist)}/ (${(bytes / 1024 / 1024).toFixed(1)} MB). Serve it with any static web server, or run "npm start" to use the API server.`);
