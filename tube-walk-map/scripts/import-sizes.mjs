#!/usr/bin/env node
// Import building floor areas (sqm) from the annotated portfolio workbook
// (data/London_office_sizes_sqm.xlsx, sheet "All assets", column
// "Property size"). Rows are joined on Asset ID and must also agree on
// company and property name, so a reordered or edited sheet cannot attach
// a size to the wrong building.
//
// A size of 0 or blank is treated as UNKNOWN (not zero floor area): such
// buildings are excluded from floor-area shares and listed in the output.
//
// Output: data/building-sizes.json  { meta, sizes: { <assetId>: sqm }, unknown: [...] }
import fs from 'node:fs';
import { paths, readJson, writeJson, rel } from './lib/common.mjs';
import { readSheet } from './lib/xlsx.mjs';

if (!fs.existsSync(paths.sizesXlsx)) {
  console.error(`ERROR: missing ${rel(paths.sizesXlsx)}. Copy the workbook with the "Property size" column there.`);
  process.exit(1);
}
const buildings = new Map(readJson(paths.buildingsClean).buildings.map((b) => [b.id, b]));
const rows = readSheet(paths.sizesXlsx, 'All assets');
const header = rows[0].map((h) => String(h ?? '').trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) { console.error(`ERROR: column "${name}" not found in "All assets" (have: ${header.join(', ')})`); process.exit(1); }
  return i;
};
const [ID, CO, NAME, SIZE] = ['Asset ID', 'Company', 'Property name', 'Property size'].map(col);

const sizes = {};
const unknown = [];
const problems = [];
for (const r of rows.slice(1)) {
  const id = String(r[ID] ?? '').trim();
  if (!id) continue;
  const b = buildings.get(id);
  if (!b) { problems.push(`${id}: not in the portfolio data`); continue; }
  if (b.company !== r[CO] || b.name !== r[NAME]) { problems.push(`${id}: company/name differ ("${r[CO]} / ${r[NAME]}" vs "${b.company} / ${b.name}")`); continue; }
  const v = Number(r[SIZE]);
  if (r[SIZE] === null || r[SIZE] === '' || !Number.isFinite(v) || v <= 0) unknown.push({ id, company: b.company, name: b.name, value: r[SIZE] });
  else sizes[id] = Math.round(v * 10) / 10;
}
// Reviewed corrections (data/building-size-overrides.json) replace workbook values.
const corrections = readJson(paths.buildingSizeOverrides, { overrides: {} }).overrides;
const applied = [];
for (const [id, o] of Object.entries(corrections)) {
  const b = buildings.get(id);
  if (!b || b.company !== o.company || b.name !== o.name || (o.propertyKey && b.propertyKey !== o.propertyKey)) {
    console.error(`ERROR: size correction ${id} does not match the portfolio (${o.company} / ${o.name})`);
    process.exit(1);
  }
  applied.push({ id, name: b.name, from: sizes[id] ?? null, to: o.sqm });
  sizes[id] = o.sqm;
  const u = unknown.findIndex((x) => x.id === id);
  if (u >= 0) unknown.splice(u, 1);
}
const missingRows = [...buildings.keys()].filter((id) => !(id in sizes) && !unknown.some((u) => u.id === id));
missingRows.forEach((id) => unknown.push({ id, company: buildings.get(id).company, name: buildings.get(id).name, value: 'row missing' }));
if (problems.length) {
  console.error(`ERROR: ${problems.length} row(s) could not be joined safely:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
writeJson(paths.buildingSizes, {
  meta: { source: rel(paths.sizesXlsx), sheet: 'All assets', column: 'Property size', unit: 'sqm', importedAt: new Date().toISOString(), corrections: applied, note: 'A size of 0 or blank is treated as unknown and excluded from floor-area shares.' },
  sizes,
  unknown
});
const total = Object.values(sizes).reduce((s, v) => s + v, 0);
console.log(`Imported floor areas for ${Object.keys(sizes).length}/${buildings.size} buildings (${Math.round(total).toLocaleString('en-GB')} sqm).`);
if (unknown.length) console.log(`  unknown size: ${unknown.map((u) => `${u.id} ${u.name} (${u.value})`).join('; ')}`);
applied.forEach((a) => console.log(`  corrected ${a.id} ${a.name}: ${a.from} -> ${a.to} sqm`));
console.log(`Wrote ${rel(paths.buildingSizes)}`);
