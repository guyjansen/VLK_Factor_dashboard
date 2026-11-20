#!/usr/bin/env node
// Geocode the office portfolio (the workbook has addresses, no coordinates)
// with OpenStreetMap Nominatim (https://nominatim.openstreetmap.org).
//
// Usage policy respected: at most 1 request per 1.1 s, identifying
// User-Agent, every response cached in data/geocode-cache.json (so re-runs
// make no requests), results restricted to a London bounding box.
// Data © OpenStreetMap contributors, ODbL.
//
// For each property, several queries are tried and the most precise
// accepted answer wins:
//   1. structured search  street=<source street>, city=London
//   2. structured search  built from names like "Newman Street 23/24"
//   3. free text          "<property name>, London" (e.g. "One New Change")
//   4. free text          "<source street>, London"
// A result is rejected unless it lies on the source street. Precision comes
// from Nominatim's place_rank (building >= 29, street 26-28, area < 26), and
// a building-level hit without the requested house number counts as
// street-level. data/geocode-overrides.json holds reviewed queries for
// ambiguous addresses (e.g. Langham Place W1B vs Harringay N15).
//
// Output: data/geocode-cache.json, updates data/buildings.clean.json
// (lon, lat, geocode{query, precision, displayName, osm}).
import { paths, readJson, writeJson, rel, sleep, TubeGeometry } from './lib/common.mjs';
import { fetchJsonWithRetry } from './lib/http.mjs';

const BASE = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const VIEWBOX = '-0.65,51.75,0.40,51.25'; // west,north,east,south (Greater London + margin)
const doc = readJson(paths.buildingsClean);
const cache = readJson(paths.geocodeCache, {});
const overrides = readJson(paths.geocodeOverrides, { overrides: {} }).overrides || {};
let lastRequest = 0;
let requests = 0;

// q: free-text string, or {street, city} for a structured search.
async function geocode(q) {
  const key = typeof q === 'string' ? q : `street=${q.street}|city=${q.city}`;
  if (cache[key] !== undefined) return cache[key];
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  requests++;
  const params = typeof q === 'string' ? `q=${encodeURIComponent(q)}` : `street=${encodeURIComponent(q.street)}&city=${encodeURIComponent(q.city)}`;
  const url = `${BASE}/search?format=jsonv2&limit=1&countrycodes=gb&bounded=1&viewbox=${VIEWBOX}&${params}`;
  const res = await fetchJsonWithRetry(url, { headers: { 'User-Agent': 'tube-walk-map/1.0 (open-source station accessibility map)', Accept: 'application/json' }, retries: 3 });
  const hit = Array.isArray(res) && res[0] ? {
    lon: Number(res[0].lon), lat: Number(res[0].lat), placeRank: res[0].place_rank,
    category: res[0].category, type: res[0].type, addresstype: res[0].addresstype,
    displayName: res[0].display_name, osm: `${res[0].osm_type}/${res[0].osm_id}`
  } : null;
  cache[key] = hit;
  if (requests % 10 === 0) writeJson(paths.geocodeCache, cache);
  return hit;
}

const precisionOf = (h) => (h.placeRank >= 29 ? 'building' : h.placeRank >= 26 ? 'street' : 'area');
const RANK = { building: 3, street: 2, area: 1 };
const withLondon = (s) => (/london/i.test(s) ? s : `${s}, London`);
const nameQuery = (n) => withLondon(n.replace(/^(Broadgate|Regent's Place|Canada Water)-/, '$1 ').replace(/\bNos\b/g, '').replace(/\s+/g, ' ').trim());
// "Newman Street 23/24" -> "23 Newman Street" (the workbook's naming style).
const nameAsAddress = (n) => {
  const m = /^(.*?\b(?:Street|Road|Square|Place|Terrace|Gate|Avenue|Lane|Yard|Row|Way|Court|Crescent))\s+(\d+)/i.exec(n.replace(/^[^-]+-(?=\D)/, ''));
  return m ? `${m[2]} ${m[1]}` : null;
};
// Street name without house numbers, ready for comparison.
const roadKey = (s) => String(s || '').split(/[,:]/)[0]
  .replace(/^[\d\s\-–/.,a-z&]+(?=[A-Z])/, '')
  .toLowerCase().replace(/\bsaint\b/g, 'st').replace(/\bst\.\s/g, 'st ').replace(/[’'.]/g, '').replace(/\s+street$/, '').replace(/\s+/g, ' ').trim();
const onStreet = (h, street) => {
  const want = roadKey(street);
  if (!want) return true;
  return h.displayName.split(', ').some((part) => roadKey(part) === want);
};
const firstNumber = (s) => (/^(\d+)/.exec(String(s || '').trim()) || [])[1] || null;

for (const b of doc.buildings) {
  if (b.sameAs) {
    const t = doc.buildings.find((x) => x.id === b.sameAs);
    b.lon = t.lon; b.lat = t.lat;
    b.geocode = { ...t.geocode, method: `same building as ${t.id}`, note: `Location reused from ${t.id} (${t.name}).` };
    continue;
  }
  if (overrides[b.id] && Number.isFinite(overrides[b.id].lat) && Number.isFinite(overrides[b.id].lon)) {
    b.lon = overrides[b.id].lon; b.lat = overrides[b.id].lat;
    b.geocode = { query: null, method: 'manual coordinates', precision: 'manual', displayName: null, osm: null, note: overrides[b.id].reason, rejected: [] };
    continue;
  }
  const attempts = [];
  const street = (b.street || '').split(/:/)[0].replace(/,\s*$/, '').trim();
  if (overrides[b.id]) attempts.push({ q: overrides[b.id].query, why: 'reviewed override', check: false });
  else if (b.geocodeQuery) attempts.push({ q: b.geocodeQuery, why: 'reviewed query (jv-sheets.json)', check: false });
  else {
    if (street) attempts.push({ q: { street: street.split(',')[0], city: 'London' }, why: /^\d/.test(street) ? 'address' : 'street', check: true });
    const alt = nameAsAddress(b.name);
    if (alt) attempts.push({ q: { street: alt, city: 'London' }, why: 'address from property name', check: true });
    attempts.push({ q: nameQuery(b.name), why: 'property name', check: true });
    if (street) attempts.push({ q: withLondon(street), why: 'street (free text)', check: true });
  }
  let best = null;
  const rejected = [];
  for (const a of attempts) {
    let h;
    try { h = await geocode(a.q); } catch (err) { console.warn(`  ${b.name}: ${err.message}`); continue; }
    if (!h) continue;
    const label = typeof a.q === 'string' ? a.q : `${a.q.street}, ${a.q.city}`;
    // The result must lie on the source street (stops "70 Victoria Street"
    // matching Queen Victoria Street, or a station named after the road).
    if (a.check && street && !onStreet(h, street)) { rejected.push(`${label} -> ${h.displayName.split(', ').slice(0, 3).join(', ')}`); continue; }
    // Implausible for this central-London portfolio: > 9 km from Charing Cross.
    if (!overrides[b.id] && TubeGeometry.haversineM([h.lon, h.lat], [-0.1246, 51.5074]) > 9000) { rejected.push(`${label} -> ${h.displayName.split(', ').slice(0, 3).join(', ')} (too far from central London)`); continue; }
    let precision = precisionOf(h);
    // Post boxes and similar street furniture only show the street.
    if (precision === 'building' && h.category === 'amenity' && /post_box|bench|waste/.test(h.type)) precision = 'street';
    if (overrides[b.id]?.precision) precision = overrides[b.id].precision;
    // A building-level hit without the requested house number is only street-level.
    const num = a.why === 'address' ? firstNumber(street) : a.why === 'address from property name' ? firstNumber(label) : null;
    if (precision === 'building' && num && !new RegExp(`(^|[ ,\\-/])${num}([ ,\\-/a-z]|$)`, 'i').test(h.displayName.split(', ').slice(0, 3).join(', '))) precision = 'street';
    const cand = { ...h, query: label, method: a.why, precision };
    if (!best || RANK[cand.precision] > RANK[best.precision]) best = cand;
    if (best.precision === 'building') break;
  }
  if (best) {
    b.lon = best.lon; b.lat = best.lat;
    b.geocode = { query: best.query, method: best.method, precision: best.precision, displayName: best.displayName, osm: best.osm, note: overrides[b.id]?.reason || null, rejected };
  } else {
    b.lon = b.lat = null;
    b.geocode = { query: attempts.map((a) => (typeof a.q === 'string' ? a.q : `${a.q.street}, ${a.q.city}`)).join(' | '), method: null, precision: 'not found', displayName: null, osm: null, rejected };
  }
  console.log(`${b.id} ${b.company.padEnd(22)} ${b.name.slice(0, 38).padEnd(38)} ${String(b.geocode.precision).padEnd(9)} ${(b.geocode.displayName || '').slice(0, 70)}`);
}
writeJson(paths.geocodeCache, cache);
doc.geocodedAt = new Date().toISOString();
doc.geocoder = { name: 'Nominatim (OpenStreetMap)', url: BASE, attribution: 'Geocoding © OpenStreetMap contributors (ODbL), Nominatim' };
writeJson(paths.buildingsClean, doc);
const tally = doc.buildings.reduce((m, b) => ((m[b.geocode.precision] = (m[b.geocode.precision] || 0) + 1), m), {});
console.log(`\n${requests} Nominatim requests (rest from cache). Precision: ${JSON.stringify(tally)}`);
console.log(`Wrote ${rel(paths.buildingsClean)}, ${rel(paths.geocodeCache)}`);
