#!/usr/bin/env node
// Step 1: parse and validate the supplied station CSV.
//   input : data/stations.csv
//   output: data/stations.clean.json  (records + parse issues + duplicate analysis)
import fs from 'node:fs';
import { paths, writeJson, rel, TubeGeometry } from './lib/common.mjs';
import { parseStationsCsv } from './lib/csv.mjs';
import { nameKey } from './lib/names.mjs';

if (!fs.existsSync(paths.csv)) {
  console.error(`ERROR: missing input file ${rel(paths.csv)}. Copy the supplied station CSV there (columns NAME, Longitude, Latitude, LINES, OBJECTID).`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseStationsCsv(fs.readFileSync(paths.csv, 'utf8'));
} catch (err) {
  console.error(`ERROR: could not parse ${rel(paths.csv)}: ${err.message}`);
  process.exit(1);
}
const { records, issues } = parsed;

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
  source: rel(paths.csv),
  preparedAt: new Date().toISOString(),
  recordCount: records.length,
  records,
  issues,
  duplicates: { duplicateNames, duplicateCoordinates, nearDuplicates, duplicateObjectIds }
});

console.log(`Parsed ${records.length} station records from ${rel(paths.csv)}`);
console.log(`  parse issues: ${issues.length}`);
console.log(`  duplicate names: ${duplicateNames.map((d) => `${d.name} (${d.objectIds.join(', ')})`).join('; ') || 'none'}`);
console.log(`  records < 200 m apart: ${nearDuplicates.length}; identical coordinates: ${duplicateCoordinates.length}`);
console.log(`Wrote ${rel(paths.stationsClean)}`);
