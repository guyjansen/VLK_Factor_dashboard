#!/usr/bin/env node
// Parse the office portfolio workbook (data/London_office_data.xlsx).
//
// Layout: one sheet with blocks per company. A block starts with a title row
// (only column A filled, e.g. "LANDSECURITIES" or "British land Development:"),
// optionally followed by a "Property Name | Property Key | Property Type |
// Street" header row and then one row per property. Titles containing
// "develop" start that company's development pipeline.
//
// Output: data/buildings.clean.json
import fs from 'node:fs';
import { paths, writeJson, rel } from './lib/common.mjs';
import { readFirstSheet } from './lib/xlsx.mjs';

// Canonical company names for the block titles found in the workbook.
const COMPANY_ALIASES = [
  [/^land\s*securities|^landsec/i, 'Landsec'],
  [/^great portland/i, 'Great Portland Estates'],
  [/^british\s*land/i, 'British Land'],
  [/^derwent/i, 'Derwent London']
];

if (!fs.existsSync(paths.officesXlsx)) {
  console.error(`ERROR: missing ${rel(paths.officesXlsx)}. Copy the office workbook there.`);
  process.exit(1);
}
const rows = readFirstSheet(paths.officesXlsx);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

const buildings = [];
const issues = [];
let company = null;
let isDevelopment = false;
rows.forEach((r, i) => {
  const line = i + 1;
  const [a, b, c, d] = [0, 1, 2, 3].map((k) => clean(r[k]));
  if (!a && !b && !c && !d) return;
  if (/^property name$/i.test(a)) return; // repeated header row
  if (a && !b && !c && !d) {
    const hit = COMPANY_ALIASES.find(([re]) => re.test(a));
    if (!hit) { issues.push({ line, type: 'unknown-section-title', value: a }); return; }
    company = hit[1];
    isDevelopment = /develop/i.test(a);
    return;
  }
  if (!company) { issues.push({ line, type: 'row-before-any-company', value: a }); return; }
  if (!a) { issues.push({ line, type: 'missing-property-name', value: [b, c, d].join(' | ') }); return; }
  // Trailing "+" / "*" are footnote markers in the source; kept as flags.
  const markers = (a.match(/[+*]+\s*$/) || [''])[0].trim();
  buildings.push({
    id: `B${String(buildings.length + 1).padStart(3, '0')}`,
    company,
    status: isDevelopment ? 'Development' : 'Standing',
    name: a.replace(/[+*]+\s*$/, '').trim(),
    sourceName: a,
    sourceMarker: markers || null,
    propertyKey: b ? Number(b) || b : null,
    propertyType: c || null,
    street: d || null,
    sourceRow: line
  });
});

const keyCounts = buildings.reduce((m, x) => (x.propertyKey ? m.set(x.propertyKey, (m.get(x.propertyKey) || 0) + 1) : m), new Map());
const duplicateKeys = [...keyCounts].filter(([, n]) => n > 1).map(([k]) => k);
writeJson(paths.buildingsClean, { source: rel(paths.officesXlsx), preparedAt: new Date().toISOString(), buildings, issues, duplicateKeys });
const by = {};
for (const x of buildings) { by[x.company] ||= { Standing: 0, Development: 0 }; by[x.company][x.status]++; }
console.log(`Parsed ${buildings.length} properties from ${rel(paths.officesXlsx)}`);
for (const [k, v] of Object.entries(by)) console.log(`  ${k.padEnd(24)} standing ${v.Standing}, development ${v.Development}`);
if (issues.length) console.log(`  issues: ${JSON.stringify(issues)}`);
if (duplicateKeys.length) console.log(`  duplicate property keys: ${duplicateKeys.join(', ')}`);
