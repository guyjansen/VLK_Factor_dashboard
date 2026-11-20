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

// ---------------------------------------------------------------------------
// Extra company sheets incl. joint ventures (data/jv-sheets.json): each sheet
// becomes its own company. Its rows reuse the reviewed location of the
// matching building (sameAs) or are geocoded; floor area comes from the sheet.
if (fs.existsSync(paths.jvConfig) && fs.existsSync(paths.sizesXlsx)) {
  const { readSheet } = await import('./lib/xlsx.mjs');
  const cfg = JSON.parse(fs.readFileSync(paths.jvConfig, 'utf8'));
  const doc = JSON.parse(fs.readFileSync(paths.buildingsClean, 'utf8'));
  const issues = [];
  for (const sh of cfg.sheets) {
    const rows = readSheet(paths.sizesXlsx, sh.sheet);
    const hi = rows.findIndex((r) => clean(r[0]) === 'Property Name');
    if (hi < 0) throw new Error(`"${sh.sheet}": header row not found`);
    const H = rows[hi].map(clean);
    const col = (n) => { const i = H.indexOf(n); if (i < 0) throw new Error(`"${sh.sheet}": column "${n}" not found`); return i; };
    const [NAME, KEY, TYPE, STREET, SIZE] = ['Property Name', 'Property Key', 'Property Type', 'Street', sh.sizeColumn].map(col);
    const FALLBACK = sh.fallbackSizeColumn ? col(sh.fallbackSizeColumn) : -1;
    const OWN = sh.ownershipColumn ? col(sh.ownershipColumn) : -1;
    let status = 'Standing', skip = false, n = 0;
    for (const r of rows.slice(hi + 2)) {
      const name = clean(r[NAME]);
      if (!name) continue;
      const restEmpty = r.slice(1).every((v) => v === null || clean(v) === '' || clean(v) === name);
      if (restEmpty || name === clean(r[STREET])) {
        if (sh.developmentSections.includes(name)) { status = 'Development'; skip = false; continue; }
        if (sh.skipSections.includes(name)) { skip = true; continue; }
        if (/^(property count|copyright|\+ properties)/i.test(name)) { skip = true; continue; }
        if (restEmpty) continue;
      }
      if (skip || /^(property count|copyright|\+ properties)/i.test(name)) continue;
      let sqm = Number(r[SIZE]);
      let sizeNote = null;
      // Percent Owned is a fraction (1, 0.5) in this sheet; a value of 100 is a
      // percentage typed into a fraction column and would inflate the size 100x.
      if (OWN >= 0 && Number(r[OWN]) > 1 && FALLBACK >= 0) { sqm = Number(r[FALLBACK]); sizeNote = `Percent Owned entered as ${r[OWN]} (fraction expected); used "${sh.fallbackSizeColumn}" instead of the inflated JV figure.`; }
      if (!Number.isFinite(sqm) || sqm <= 0) sqm = null;
      const sameAs = sh.sameAs[name] || null;
      const base = sameAs ? doc.buildings.find((b) => b.id === sameAs) : null;
      if (sameAs && !base) issues.push(`${sh.sheet}: "${name}" -> unknown building ${sameAs}`);
      if (!sameAs && !sh.geocode[name]) issues.push(`${sh.sheet}: "${name}" has neither a sameAs match nor a geocoding query`);
      doc.buildings.push({
        id: `${sh.idPrefix}${String(++n).padStart(2, '0')}`,
        company: sh.company,
        status,
        name: name.replace(/[+*]+\s*$/, '').trim(),
        sourceName: name,
        sourceMarker: (name.match(/[+*]+\s*$/) || [''])[0].trim() || null,
        propertyKey: Number(r[KEY]) || base?.propertyKey || null,
        propertyType: clean(r[TYPE]) || base?.propertyType || null,
        street: clean(r[STREET]) || base?.street || null,
        sourceSheet: sh.sheet,
        sameAs,
        geocodeQuery: sh.geocode[name] || null,
        sqm,
        sizeNote
      });
    }
  }
  // Sheets that replace a company's original rows: keep those rows only as
  // location references (sameAs targets) and hide them from all outputs.
  for (const sh of cfg.sheets.filter((x) => x.replacesOriginal)) {
    for (const b of doc.buildings) if (!b.sourceSheet && b.company === sh.company) b.superseded = sh.sheet;
  }
  if (issues.length) { console.error(`ERROR:\n  ${issues.join('\n  ')}`); process.exit(1); }
  writeJson(paths.buildingsClean, doc);
  for (const sh of cfg.sheets) {
    const bs = doc.buildings.filter((b) => b.company === sh.company && b.sourceSheet === sh.sheet);
    console.log(`  ${sh.company.padEnd(24)} standing ${bs.filter((b) => b.status === 'Standing').length}, development ${bs.filter((b) => b.status === 'Development').length} (sheet "${sh.sheet}")`);
  }
}
