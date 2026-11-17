#!/usr/bin/env node
// Step 1: parse and validate the station table.
//   input : data/Underground_and_Elizabeth_Stations.xlsx (default; British
//           National Grid X/Y, converted to WGS84) or a CSV given with
//           --input (e.g. the original Underground-only data/stations.csv)
//   output: data/stations.clean.json  (records + parse issues + duplicate analysis)
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJson, rel, parseArgs, ROOT, TubeGeometry } from './lib/common.mjs';
import { parseStationsCsv, parseStationTable } from './lib/csv.mjs';
import { readFirstSheet } from './lib/xlsx.mjs';
import { osgbToWgs84 } from './lib/osgb.mjs';
import { nameKey } from './lib/names.mjs';

const args = parseArgs(process.argv.slice(2));
const input = args.input ? path.resolve(ROOT, String(args.input)) : (fs.existsSync(paths.xlsx) ? paths.xlsx : paths.csv);
if (!fs.existsSync(input)) {
  console.error(`ERROR: missing station input ${rel(input)}. Put the supplied workbook at ${rel(paths.xlsx)} (or a CSV with NAME, Longitude, Latitude, LINES, OBJECTID and pass --input <file>).`);
  process.exit(1);
}

let parsed;
try {
  if (/\.xlsx$/i.test(input)) {
    const rows = readFirstSheet(input);
    if (!rows.length) throw new Error('workbook has no rows');
    parsed = parseStationTable(rows[0], rows.slice(1).map((cells, i) => ({ line: i + 2, cells })), { toWgs84: osgbToWgs84 });
  } else {
    parsed = parseStationsCsv(fs.readFileSync(input, 'utf8'), { toWgs84: osgbToWgs84 });
  }
} catch (err) {
  console.error(`ERROR: could not read ${rel(input)}: ${err.message}`);
  process.exit(1);
}
const { records, issues, coordinateSystem } = parsed;

// Duplicate analysis (reporting only; joining decides what is one station).
const byName = new Map();
for (const r of records) {
  const k = nameKey(r.name);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(r);
}
const duplicateNames = [...byName.values()].filter((g) => g.length > 1).map((g) => ({
  name: g[0].name,
  objectIds: g.map((r) => r.objectId),
  maxSeparationM: Math.round(Math.max(...g.flatMap((a) => g.map((b) => TubeGeometry.haversineM([a.lon, a.lat], [b.lon, b.lat])))))
}));

const duplicateCoordinates = [];
const nearDuplicates = [];
for (let i = 0; i < records.length; i++) {
  for (let j = i + 1; j < records.length; j++) {
    const a = records[i], b = records[j];
    const d = TubeGeometry.haversineM([a.lon, a.lat], [b.lon, b.lat]);
    if (d < 1) duplicateCoordinates.push({ objectIds: [a.objectId, b.objectId], names: [a.name, b.name] });
    else if (d < 200) nearDuplicates.push({ objectIds: [a.objectId, b.objectId], names: [a.name, b.name], distanceM: Math.round(d) });
  }
}
const duplicateObjectIds = [...records.reduce((m, r) => m.set(r.objectId, (m.get(r.objectId) || 0) + 1), new Map())]
  .filter(([, n]) => n > 1).map(([id]) => id);

writeJson(paths.stationsClean, {
  source: rel(input),
  coordinateSystem,
  preparedAt: new Date().toISOString(),
  recordCount: records.length,
  records,
  issues,
  duplicates: { duplicateNames, duplicateCoordinates, nearDuplicates, duplicateObjectIds }
});

console.log(`Parsed ${records.length} station records from ${rel(input)} (${coordinateSystem})`);
console.log(`  parse issues: ${issues.length}`);
console.log(`  duplicate names: ${duplicateNames.map((d) => `${d.name} (${d.objectIds.join(', ')})`).join('; ') || 'none'}`);
console.log(`  records < 200 m apart: ${nearDuplicates.length}; identical coordinates: ${duplicateCoordinates.length}`);
console.log(`Wrote ${rel(paths.stationsClean)}`);
