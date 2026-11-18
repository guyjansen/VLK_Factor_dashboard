#!/usr/bin/env node
// Parse the portfolio workbook (data/FABG_property_list_FY25.xlsx, sheet
// "Properties": one row per property, Fabege property list FY2025).
//
// Columns used: Region, Sub-area, Listing no., Property name, Area, Street
// address, Development property (Yes/No), Land & project property (Yes/No),
// Classification (formula), floor areas per use.
//
// Asset ID   = FAB-<region code>-<listing no.> (listing numbers restart per region).
// Status     = Standing    when Classification is "Investment"
//              Development when Classification is "Development" or "Land & project"
//              (decision confirmed by the user; the original classification is kept).
//              The classification is recomputed from the two Yes/No columns with the
//              workbook's own formula and must equal the cached formula value if present.
// Excluded   = assets outside the Stockholm metro scope (Borås), listed with a reason.
// Addresses  = the source abbreviates street names ("Döbelnsg" = Döbelnsgatan,
//              "Svetsarv" = Svetsarvägen). Abbreviations are expanded and every
//              street + first house number is kept as a geocoding candidate.
//
// Output: data/buildings.clean.json
import fs from 'node:fs';
import { paths, writeJson, rel, fail } from './lib/common.mjs';
import { readSheet } from './lib/xlsx.mjs';

const COMPANY = 'Fabege';
const REGION_CODES = { 'Stockholm inner city': 'SIC', Solna: 'SOL', 'Hammarby Sjöstad': 'HSJ', Flemingsberg: 'FLB', Other: 'OTH' };
// Municipality used in geocoding queries, by the workbook's "Area" column.
const MUNICIPALITY = {
  Norrmalm: 'Stockholm', Vasastan: 'Stockholm', 'Östermalm': 'Stockholm', Kungsholmen: 'Stockholm', Stadshagen: 'Stockholm',
  'Hammarby Sjöstad': 'Stockholm', 'Älvsjö': 'Stockholm',
  Arenastaden: 'Solna', 'Solna Business Park': 'Solna', 'Haga Norra': 'Solna', Ulriksdal: 'Solna', 'Råsunda': 'Solna', 'Frösunda': 'Solna', 'Solna Strand': 'Solna',
  Flemingsberg: 'Huddinge', Sollentuna: 'Sollentuna', 'Borås': 'Borås'
};
// Outside the scope of a Stockholm metro map (user decision: exclude Borås).
const EXCLUDED_AREAS = { 'Borås': 'Borås is about 400 km from Stockholm, outside the metro network scope (excluded by decision; listed, not mapped).' };
const USES = [
  ['Office (sqm)', 'Office'], ['Retail (sqm)', 'Retail'], ['Industrial + warehouse (sqm)', 'Industrial/warehouse'],
  ['Residential (sqm)', 'Residential'], ['Hotel (sqm)', 'Hotel'], ['Parking + other (sqm)', 'Parking/other']
];

if (!fs.existsSync(paths.portfolioXlsx)) fail(`missing ${rel(paths.portfolioXlsx)}`, 'Copy the Fabege property list workbook there.');
const rows = readSheet(paths.portfolioXlsx, 'Properties');
const header = rows[0].map((h) => String(h ?? '').trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) fail(`column "${name}" not found in sheet "Properties" (have: ${header.join(' | ')})`);
  return i;
};
const C = Object.fromEntries(['Region', 'Sub-area (listing table)', 'Listing no.', 'Property name', 'Area', 'Street address', 'Construction year',
  'Total lettable area (sqm)', 'Development property (Yes/No)', 'Land & project property (Yes/No)', 'Classification',
  'Environmentally certified (Yes/No)', 'Tax value (SEK 000s, 31/12/2025)', 'Source page', ...USES.map((u) => u[0])].map((n) => [n, col(n)]));

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

/** "Döbelnsg" -> "Döbelnsgatan", "Svetsarv" -> "Svetsarvägen"; full names unchanged. */
export function expandStreet(name) {
  const words = name.split(' ');
  const last = words[words.length - 1];
  const full = /(gatan|gata|vägen|väg|torget|torg|leden|allé|kaj|slingan|gränd|boulevard|stigen|plan|backe|gången|stråket|platsen)$/i;
  let expanded = last;
  if (!full.test(last)) {
    if (/[a-zåäö]g$/i.test(last)) expanded = `${last}atan`;
    else if (/[a-zåäö]v$/i.test(last)) expanded = `${last}ägen`;
  }
  words[words.length - 1] = expanded;
  return { street: words.join(' '), abbreviated: expanded !== last };
}

/**
 * Split "Döbelnsg 20, 24, Kungstensg 21–23, Rådmansg 40" into
 * [{street:'Döbelnsgatan', number:'20'}, {street:'Kungstensgatan', number:'21'}, ...].
 * Bare numbers after a street belong to that street; only the first number of
 * each street is used (house ranges "21–23" -> 21).
 */
export function parseAddress(raw) {
  const out = [];
  const text = clean(raw).replace(/,?\s*(etc\.?|and others)$/i, '');
  if (!text) return out;
  // House number: digits plus an optional letter ("12A", "15C"; "21–23" -> 21; "25 A–C" -> 25A).
  const houseNumber = (tokens, i) => {
    const m = /^(\d+)([A-Za-z])?/.exec(tokens[i]);
    let n = m[1] + (m[2] ? m[2].toUpperCase() : '');
    if (!m[2] && /^[A-Z](?:[–-][A-Z])?$/.test(tokens[i + 1] || '')) n += tokens[i + 1][0];
    return n;
  };
  for (const part of text.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
    // Street = the words before the first token that starts with a digit.
    const tokens = part.split(' ');
    const firstNum = tokens.findIndex((t) => /^\d/.test(t));
    const nameTokens = firstNum < 0 ? tokens : tokens.slice(0, firstNum);
    if (!nameTokens.length || !/[A-Za-zÅÄÖåäö]{3}/.test(nameTokens.join(' '))) {
      // A bare house number ("…, 24") belongs to the previous street.
      if (out.length && firstNum === 0) out[out.length - 1].numbers.push(houseNumber(tokens, 0));
      continue;
    }
    const { street, abbreviated } = expandStreet(nameTokens.join(' '));
    const number = firstNum >= 0 ? houseNumber(tokens, firstNum) : null;
    const existing = out.find((a) => a.street === street);
    if (existing) { if (number) existing.numbers.push(number); continue; }
    out.push({ street, number, numbers: number ? [number] : [], sourceText: part, abbreviated });
  }
  out.forEach((a) => { a.numbers = [...new Set(a.numbers)]; });
  return out;
}

const buildings = [];
const issues = [];
rows.slice(1).forEach((r, i) => {
  const line = i + 2;
  if (r.every((v) => v === null || clean(v) === '')) return;
  const region = clean(r[C.Region]);
  const listing = Number(r[C['Listing no.']]);
  const name = clean(r[C['Property name']]);
  const area = clean(r[C.Area]);
  if (!REGION_CODES[region]) { issues.push({ line, type: 'unknown-region', value: region }); return; }
  if (!Number.isInteger(listing) || !name) { issues.push({ line, type: 'missing-id-or-name', value: `${listing} ${name}` }); return; }
  const dev = clean(r[C['Development property (Yes/No)']]);
  const land = clean(r[C['Land & project property (Yes/No)']]);
  if (![dev, land].every((v) => v === 'Yes' || v === 'No')) issues.push({ line, type: 'bad-yes-no', value: `${dev}/${land}` });
  // Same rule as the workbook formula =IF(O="Yes","Development",IF(P="Yes","Land & project","Investment")).
  const classification = dev === 'Yes' ? 'Development' : land === 'Yes' ? 'Land & project' : 'Investment';
  const cached = clean(r[C.Classification]);
  if (cached && !cached.startsWith('=') && cached !== classification) issues.push({ line, type: 'classification-mismatch', value: `${cached} vs ${classification}` });
  const uses = Object.fromEntries(USES.map(([colName, label]) => [label, Number(r[C[colName]]) || 0]));
  const total = Number(r[C['Total lettable area (sqm)']]) || 0;
  const sumUses = Object.values(uses).reduce((s, v) => s + v, 0);
  if (Math.abs(sumUses - total) > 1) issues.push({ line, type: 'area-sum-mismatch', value: `${name}: uses ${sumUses} vs total ${total}` });
  let propertyType;
  if (total > 0) {
    const [topLabel, topVal] = Object.entries(uses).sort((a, b) => b[1] - a[1])[0];
    const share = Math.round((100 * topVal) / total);
    propertyType = share >= 50 ? `${topLabel} (${share}% of lettable area)` : `Mixed use (largest: ${topLabel}, ${share}%)`;
  } else propertyType = classification === 'Land & project' ? 'Land / project (no lettable area reported)' : 'No lettable area reported';
  const rawAddress = clean(r[C['Street address']]) || null;
  const excludedReason = EXCLUDED_AREAS[area] || null;
  buildings.push({
    id: `FAB-${REGION_CODES[region]}-${String(listing).padStart(2, '0')}`,
    company: COMPANY,
    status: classification === 'Investment' ? 'Standing' : 'Development',
    classification,
    name,
    region,
    subArea: clean(r[C['Sub-area (listing table)']]),
    listingNo: listing,
    area,
    municipality: MUNICIPALITY[area] || null,
    street: rawAddress,
    addresses: parseAddress(rawAddress),
    propertyType,
    usesSqm: uses,
    totalLettableSqmSource: total,
    constructionYear: clean(r[C['Construction year']]) || null,
    environmentallyCertified: clean(r[C['Environmentally certified (Yes/No)']]) || null,
    taxValueKSEK: Number(r[C['Tax value (SEK 000s, 31/12/2025)']]) || null,
    sourcePage: r[C['Source page']] ?? null,
    sourceRow: line,
    excluded: !!excludedReason,
    excludedReason
  });
  if (!MUNICIPALITY[area]) issues.push({ line, type: 'unknown-area', value: area });
});

const dupIds = buildings.map((b) => b.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupIds.length) fail(`duplicate asset ids: ${dupIds.join(', ')}`);
const hard = issues.filter((x) => ['unknown-region', 'missing-id-or-name', 'bad-yes-no', 'classification-mismatch', 'unknown-area'].includes(x.type));
if (hard.length) fail(`portfolio workbook problems:\n  ${hard.map((x) => `row ${x.line}: ${x.type} ${x.value}`).join('\n  ')}`);

writeJson(paths.buildingsClean, {
  source: rel(paths.portfolioXlsx), sheet: 'Properties', preparedAt: new Date().toISOString(),
  statusRule: 'Standing = Classification "Investment"; Development = "Development" or "Land & project".',
  buildings, issues
});
const tally = {};
for (const b of buildings) {
  const k = b.excluded ? 'excluded' : b.status;
  tally[k] = (tally[k] || 0) + 1;
}
const byClass = buildings.reduce((m, b) => ((m[b.classification] = (m[b.classification] || 0) + 1), m), {});
console.log(`Parsed ${buildings.length} properties from ${rel(paths.portfolioXlsx)}: ${JSON.stringify(tally)}; classification ${JSON.stringify(byClass)}`);
console.log(`  without street address: ${buildings.filter((b) => !b.addresses.length).map((b) => `${b.id} ${b.name}`).join(', ')}`);
console.log(`  abbreviations expanded: ${buildings.flatMap((b) => b.addresses.filter((a) => a.abbreviated).map((a) => a.street)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);
if (issues.length) console.log(`  notes: ${issues.map((x) => `row ${x.line} ${x.type}: ${x.value}`).join('; ')}`);
