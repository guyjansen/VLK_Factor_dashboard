#!/usr/bin/env node
// Import floor areas (sqm) for the portfolio.
//
// Source: the same workbook (data/FABG_property_list_FY25.xlsx, sheet
// "Properties", column "Total lettable area (sqm)"). Rows are joined on the
// asset ID (region code + listing no.) AND must agree on company and property
// name, so a reordered or edited sheet cannot attach an area to the wrong
// property. Any mismatch stops the import.
//
// A value of 0 or blank is treated as UNKNOWN (not zero floor area): those
// properties are excluded from floor-area shares and listed.
//
// Output: data/building-sizes.json  { meta, sizes: { <assetId>: sqm }, unknown: [...] }
import fs from 'node:fs';
import { paths, readJson, writeJson, rel, fail } from './lib/common.mjs';
import { readSheet } from './lib/xlsx.mjs';

const REGION_CODES = { 'Stockholm inner city': 'SIC', Solna: 'SOL', 'Hammarby Sjöstad': 'HSJ', Flemingsberg: 'FLB', Other: 'OTH' };
const COMPANY = 'Fabege'; // the workbook is Fabege's property list
const SIZE_COLUMN = 'Total lettable area (sqm)';

if (!fs.existsSync(paths.portfolioXlsx)) fail(`missing ${rel(paths.portfolioXlsx)}`);
let buildings;
try { buildings = new Map(readJson(paths.buildingsClean).buildings.map((b) => [b.id, b])); } catch (err) { fail(err.message, 'Run "npm run buildings:prepare" first.'); }
const rows = readSheet(paths.portfolioXlsx, 'Properties');
const header = rows[0].map((h) => String(h ?? '').trim());
const col = (name) => { const i = header.indexOf(name); if (i < 0) fail(`column "${name}" not found (have: ${header.join(', ')})`); return i; };
const [REG, NO, NAME, SIZE] = ['Region', 'Listing no.', 'Property name', SIZE_COLUMN].map(col);

const sizes = {};
const unknown = [];
const problems = [];
const seen = new Set();
for (const r of rows.slice(1)) {
  if (r.every((v) => v === null || String(v).trim() === '')) continue;
  const code = REGION_CODES[String(r[REG] ?? '').trim()];
  const id = code ? `FAB-${code}-${String(Number(r[NO])).padStart(2, '0')}` : null;
  if (!id) { problems.push(`row with region "${r[REG]}" has no asset id`); continue; }
  if (seen.has(id)) { problems.push(`${id}: appears twice`); continue; }
  seen.add(id);
  const b = buildings.get(id);
  const name = String(r[NAME] ?? '').replace(/\s+/g, ' ').trim();
  if (!b) { problems.push(`${id}: not in the prepared portfolio`); continue; }
  if (b.company !== COMPANY || b.name !== name) { problems.push(`${id}: company/name differ ("${COMPANY} / ${name}" vs "${b.company} / ${b.name}")`); continue; }
  const raw = r[SIZE];
  const v = Number(raw);
  if (raw === null || raw === '' || !Number.isFinite(v) || v <= 0) unknown.push({ id, company: b.company, name: b.name, value: raw ?? 'blank' });
  else sizes[id] = Math.round(v * 10) / 10;
}
for (const id of buildings.keys()) if (!seen.has(id)) problems.push(`${id}: no row in the size sheet`);
if (problems.length) fail(`${problems.length} row(s) could not be joined safely:\n  ${problems.join('\n  ')}`);

writeJson(paths.buildingSizes, {
  meta: { source: rel(paths.portfolioXlsx), sheet: 'Properties', column: SIZE_COLUMN, unit: 'sqm', joinedOn: 'asset ID (region + listing no.) with company and property-name check', importedAt: new Date().toISOString(), note: 'A size of 0 or blank is treated as unknown and excluded from floor-area shares.' },
  sizes,
  unknown
});
const total = Object.values(sizes).reduce((s, v) => s + v, 0);
console.log(`Imported floor areas for ${Object.keys(sizes).length}/${buildings.size} properties (${Math.round(total).toLocaleString('en-GB')} sqm).`);
console.log(`  unknown (0 or blank): ${unknown.length} — ${unknown.map((u) => u.id).join(', ')}`);
console.log(`Wrote ${rel(paths.buildingSizes)}`);
