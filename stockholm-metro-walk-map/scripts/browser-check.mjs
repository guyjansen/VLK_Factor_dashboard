#!/usr/bin/env node
// Headless browser check (Playwright + Chromium, not a project dependency:
// uses a globally available `playwright`). Loads the app
//   1. from the Express server (npm start must NOT be running; this script starts it)
//   2. from the single-file build (file://)
// at desktop size and at 320 px width, waits for walking areas and
// properties, exercises a few controls and fails on any console error or
// page error. Screenshots go to reports/screenshots/ for review.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib/common.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  try { ({ chromium } = require(require.resolve('playwright', { paths: [process.env.NODE_PATH || '', '/usr/lib/node_modules', '/usr/local/lib/node_modules'] }))); } catch {
    console.error('ERROR: playwright is not installed (npm i -g playwright && npx playwright install chromium).'); process.exit(1);
  }
}
const shots = path.join(ROOT, 'reports', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const PORT = 8091;
const server = spawn(process.execPath, ['server/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res, rej) => { server.stdout.on('data', (d) => /on http/.test(String(d)) && res()); server.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 15000); });

const single = path.join(ROOT, 'dist', 'stockholm-metro-walk-map.html');
const targets = [{ name: 'server', url: `http://localhost:${PORT}/` }];
if (fs.existsSync(single)) targets.push({ name: 'single-file', url: `file://${single}` });
else console.warn('warning: dist/stockholm-metro-walk-map.html missing (run npm run build) — single-file check skipped');
const sizes = [{ name: 'desktop', viewport: { width: 1366, height: 860 } }, { name: '320px', viewport: { width: 320, height: 640 } }];

const browser = await chromium.launch();
const problems = [];
for (const t of targets) {
  for (const s of sizes) {
    const page = await browser.newPage({ viewport: s.viewport, deviceScaleFactor: 1 });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/tiles\.openfreemap\.org|Failed to load resource/.test(m.text())) errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(t.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MetroWalkApp && window.MetroWalkApp.iso.status !== 'loading' && window.MetroWalkApp.buildings.status !== 'loading', null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    const summary = await page.textContent('#summary');
    const st = await page.evaluate(() => ({ iso: window.MetroWalkApp.iso.status, bld: window.MetroWalkApp.buildings.status, sel: window.MetroWalkApp.getSelection().stationIds.length, rows: document.querySelectorAll('#building-stats tbody tr').length }));
    if (st.iso !== 'ready' || st.bld !== 'ready') problems.push(`${t.name}/${s.name}: data not ready ${JSON.stringify(st)}`);
    if (!st.rows) problems.push(`${t.name}/${s.name}: no statistics rows`);
    await page.screenshot({ path: path.join(shots, `${t.name}-${s.name}.png`) });
    // Exercise controls: one line only, individual mode, floor-area stats, then reset.
    if (s.name === 'desktop') {
      await page.click('#clear-all');
      await page.check('#line-green');
      await page.waitForTimeout(1500);
      const one = await page.textContent('#summary');
      if (!/^1 line selected/.test(one)) problems.push(`${t.name}: summary after selecting one line is "${one}"`);
      await page.check('input[name="measure"][value="sqm"]');
      await page.check('input[name="mode"][value="individual"]');
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(shots, `${t.name}-${s.name}-green-individual.png`) });
      await page.click('#reset');
      await page.waitForTimeout(1500);
      await page.keyboard.press('Tab');
    }
    console.log(`${t.name.padEnd(11)} ${s.name.padEnd(7)} ${errs.length ? 'ERRORS' : 'ok'} · ${summary} · ${JSON.stringify(st)}`);
    errs.forEach((e) => problems.push(`${t.name}/${s.name}: ${e}`));
    await page.close();
  }
}
await browser.close();
server.kill();
if (problems.length) { console.error(`Browser check FAILED:\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`Browser check passed. Screenshots in ${path.relative(ROOT, shots)}/`);
