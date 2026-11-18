#!/usr/bin/env node
// Geocode the portfolio (the workbook has addresses, no coordinates) with
// OpenStreetMap Nominatim (https://nominatim.openstreetmap.org).
//
// Usage policy: at most one request per 1.1 s, identifying User-Agent,
// every response cached in data/geocode-cache.json (re-runs make no requests),
// results restricted to Sweden and a Stockholm-county view box.
// Data © OpenStreetMap contributors, ODbL.
//
// Per property, candidates are tried in order and the most precise ACCEPTED
// answer wins:
//   1. reviewed override query (data/geocode-overrides.json), if any
//   2. structured search  street="<no> <street>", city=<municipality>  for each source address
//   3. structured search  street="<street>",      city=<municipality>  (street level)
//   4. properties without any address: "<area>, <municipality>" at area level
// A result is REJECTED when
//   - its road (addressdetails) is not the source street (stops similarly
//     named streets in other districts), or
//   - it lies more than MAX_KM from Sergels torg, or
//   - (area level) it is a whole municipality or larger, not a district.
// Precision: building = house number matched; street = street matched without
// the house number; area = district only; unlocated = nothing accepted.
//
// Output: data/geocode-cache.json, data/geocode-review.json and updates
// data/buildings.clean.json (lon, lat, geocode{...}).
import { paths, readJson, writeJson, rel, sleep, MetroConfig, MetroGeometry, USER_AGENT } from './lib/common.mjs';
import { fetchJsonWithRetry } from './lib/http.mjs';

const BASE = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const VIEWBOX = '17.55,59.65,18.75,58.95'; // west,north,east,south (Stockholm county + margin)
const MAX_KM = 30; // Flemingsberg is ~16 km and Sollentuna ~15 km from the centre
const doc = readJson(paths.buildingsClean);
const cache = readJson(paths.geocodeCache, {});
const ovDoc = readJson(paths.geocodeOverrides, { overrides: {} });
const overrides = ovDoc.overrides || {};
let lastRequest = 0;
let requests = 0;

const unknownOverrides = Object.keys(overrides).filter((id) => !doc.buildings.some((b) => b.id === id));
if (unknownOverrides.length) {
  console.error(`ERROR: geocode override(s) for unknown asset id(s): ${unknownOverrides.join(', ')}. Remove or fix them in ${rel(paths.geocodeOverrides)}.`);
  process.exit(1);
}

/** q: {street, city} structured search or {q} free text. Cached by its canonical key. */
async function geocode(q) {
  const params = q.q ? { q: q.q } : { street: q.street, city: q.city };
  const key = JSON.stringify(params);
  if (cache[key] !== undefined) return cache[key];
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  requests++;
  const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '3', countrycodes: 'se', viewbox: VIEWBOX, bounded: '1', ...params });
  const res = await fetchJsonWithRetry(`${BASE}/search?${qs}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'sv,en' }, retries: 3 });
  const hits = (Array.isArray(res) ? res : []).map((h) => ({
    lon: Number(h.lon), lat: Number(h.lat), placeRank: h.place_rank, category: h.category, type: h.type, addresstype: h.addresstype,
    displayName: h.display_name, osm: `${h.osm_type}/${h.osm_id}`, address: h.address || {}
  }));
  cache[key] = hits;
  if (requests % 10 === 0) writeJson(paths.geocodeCache, cache);
  return hits;
}

const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[’'.:]/g, '').replace(/\s+/g, ' ').trim();
const roadOf = (h) => h.address.road || h.address.pedestrian || h.address.footway || h.address.square || h.address.place || h.address.cycleway || h.address.path || null;
const onStreet = (h, street) => norm(roadOf(h)) === norm(street) || (h.addresstype === 'road' && norm(h.displayName.split(',')[0]) === norm(street));
const houseMatches = (h, number) => {
  const hn = norm(h.address.house_number || '');
  if (!hn || !number) return false;
  const want = norm(number);
  const digits = (x) => (/^\d+/.exec(x) || [''])[0];
  // "20" matches "20", "20A", "20-24"; "12A" needs the same digits.
  return hn.split(/[;,\s–-]+/).some((p) => digits(p) === digits(want));
};
const AREA_TYPES = new Set(['suburb', 'neighbourhood', 'quarter', 'city_district', 'residential', 'commercial', 'industrial', 'retail', 'hamlet', 'borough', 'locality', 'isolated_dwelling', 'village']);
const kmFromCentre = (h) => MetroGeometry.haversineM([h.lon, h.lat], MetroConfig.CITY_CENTRE) / 1000;
const RANK = { building: 3, street: 2, area: 1 };

function evaluate(h, attempt) {
  if (kmFromCentre(h) > MAX_KM) return { reject: `${kmFromCentre(h).toFixed(0)} km from the city centre` };
  if (attempt.kind === 'area') {
    if (!AREA_TYPES.has(h.addresstype)) return { reject: `result is a ${h.addresstype}, not a district` };
    return { precision: 'area' };
  }
  if (attempt.kind === 'override') {
    if (attempt.street && !onStreet(h, attempt.street)) return { reject: `on "${roadOf(h) || h.displayName.split(',')[0]}", not on ${attempt.street}` };
    return { precision: attempt.precision || (attempt.number && houseMatches(h, attempt.number) ? 'building' : 'street') };
  }
  if (!onStreet(h, attempt.street)) return { reject: `on "${roadOf(h) || h.displayName.split(',')[0]}", not on ${attempt.street}` };
  if (attempt.number && houseMatches(h, attempt.number)) return { precision: 'building' };
  return { precision: 'street' };
}

const review = [];
for (const b of doc.buildings) {
  if (b.excluded) {
    b.lon = b.lat = null;
    b.geocode = { precision: 'excluded', query: null, method: null, displayName: null, osm: null, note: b.excludedReason, rejected: [] };
    console.log(`${b.id.padEnd(11)} excluded  ${b.name}`);
    continue;
  }
  const attempts = [];
  const ov = overrides[b.id];
  if (ov) {
    attempts.push({ kind: 'override', q: ov.street ? { street: ov.street, city: ov.city } : { q: ov.query }, number: ov.number || null, street: ov.streetName || null, precision: ov.precision || null });
  } else {
    // Structured search for every listed house number (max 3 per street); a
    // number with a letter ("47A") is also tried without it.
    for (const a of b.addresses) {
      for (const n of a.numbers.slice(0, 3)) {
        attempts.push({ kind: 'address', q: { street: `${n} ${a.street}`, city: b.municipality }, street: a.street, number: n });
        if (/[A-Z]$/.test(n)) attempts.push({ kind: 'address', q: { street: `${n.replace(/[A-Z]$/, '')} ${a.street}`, city: b.municipality }, street: a.street, number: n });
      }
    }
    // Free-text form of the first number per street (sometimes matches where the structured form does not).
    for (const a of b.addresses) if (a.numbers.length) attempts.push({ kind: 'address', q: { q: `${a.street} ${a.numbers[0].replace(/[A-Z]$/, '')}, ${b.municipality}` }, street: a.street, number: a.numbers[0] });
    for (const a of b.addresses) attempts.push({ kind: 'street', q: { street: a.street, city: b.municipality }, street: a.street, number: null });
    if (!b.addresses.length) attempts.push({ kind: 'area', q: { q: `${b.area}, ${b.municipality}` } });
  }
  let best = null;
  const rejected = [];
  for (const a of attempts) {
    let hits;
    try { hits = await geocode(a.q); } catch (err) { console.warn(`  ${b.id}: ${err.message}`); continue; }
    const label = a.q.q || `${a.q.street}, ${a.q.city}`;
    for (const h of hits) {
      const ev = evaluate(h, a);
      if (ev.reject) { rejected.push(`${label} -> ${h.displayName.split(', ').slice(0, 4).join(', ')} (${ev.reject})`); continue; }
      const cand = { ...h, query: label, method: a.kind, precision: ev.precision };
      if (!best || RANK[cand.precision] > RANK[best.precision]) best = cand;
      break; // first accepted hit of this query
    }
    if (best?.precision === 'building') break;
    if (best && a.kind === 'street') break; // street fallback found; area level would be worse
  }
  if (best) {
    b.lon = best.lon; b.lat = best.lat;
    b.geocode = { query: best.query, method: best.method, precision: best.precision, displayName: best.displayName, osm: best.osm, road: roadOf(best), houseNumber: best.address.house_number || null, kmFromCentre: Number(kmFromCentre(best).toFixed(2)), note: ov?.reason || null, rejected };
  } else {
    b.lon = b.lat = null;
    b.geocode = { query: attempts.map((a) => a.q.q || `${a.q.street}, ${a.q.city}`).join(' | ') || null, method: null, precision: 'unlocated', displayName: null, osm: null, note: ov?.reason || (b.addresses.length ? 'No result on the source street.' : 'No street address in the source and no district-level match.'), rejected };
  }
  review.push({ id: b.id, name: b.name, source: b.street, area: b.area, precision: b.geocode.precision, query: b.geocode.query, geocodedAs: b.geocode.displayName, lat: b.lat, lon: b.lon, rejected: rejected.slice(0, 4) });
  console.log(`${b.id.padEnd(11)} ${String(b.geocode.precision).padEnd(9)} ${b.name.slice(0, 22).padEnd(22)} ${(b.geocode.displayName || b.geocode.note || '').slice(0, 90)}`);
}
writeJson(paths.geocodeCache, cache);
const unusedOverrides = Object.keys(overrides).filter((id) => doc.buildings.find((b) => b.id === id)?.geocode?.method !== 'override');
doc.geocodedAt = new Date().toISOString();
doc.geocoder = { name: 'Nominatim (OpenStreetMap)', url: BASE, attribution: 'Geocoding © OpenStreetMap contributors (ODbL), Nominatim', maxKmFromCentre: MAX_KM, viewbox: VIEWBOX };
const tally = doc.buildings.reduce((m, b) => ((m[b.geocode.precision] = (m[b.geocode.precision] || 0) + 1), m), {});
doc.geocodePrecisionCounts = tally;
writeJson(paths.buildingsClean, doc);
writeJson(paths.geocodeReview, {
  generatedAt: doc.geocodedAt,
  precisionCounts: tally,
  note: 'Every result below street/building level, every override, and the rejected candidates, for hand-checking. See README "Geocoding review".',
  overridesApplied: Object.keys(overrides).filter((id) => !unusedOverrides.includes(id)),
  unusedOverrides,
  rows: review
});
console.log(`\n${requests} Nominatim request(s) (rest from cache). Precision: ${JSON.stringify(tally)}`);
if (unusedOverrides.length) { console.error(`ERROR: override(s) not applied: ${unusedOverrides.join(', ')}`); process.exitCode = 1; }
console.log(`Wrote ${rel(paths.buildingsClean)}, ${rel(paths.geocodeCache)}, ${rel(paths.geocodeReview)}`);
