// Per-station isochrone cache shared by generate-isochrones.mjs and the server.
// One JSON file per station in data/isochrones/<stationId>.json, written
// atomically, so runs can be interrupted and resumed safely.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, writeJson, MetroConfig, MetroGeometry } from './common.mjs';

export function stationFile(stationId) {
  if (!/^[A-Za-z0-9_-]+$/.test(stationId)) throw new Error(`Invalid station id: ${stationId}`);
  return path.join(paths.isoDir, `${stationId}.json`);
}

export function parametersHash(providerId, params, origin) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ providerId, params, origin: [origin.lon.toFixed(6), origin.lat.toFixed(6)] }))
    .digest('hex').slice(0, 16);
}

export function readCached(stationId) {
  const f = stationFile(stationId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// Contours are cached individually: each feature records the parameter hash
// of the request that produced it (excluding the contour list), so adding a
// contour later (e.g. 600 s) fetches only that contour and leaves the
// existing polygons (e.g. 300 s) untouched.
const baseParams = (params) => { const { contours_seconds, ...rest } = params; void contours_seconds; return rest; };
const featureHash = (providerId, params, origin) => parametersHash(providerId, baseParams(params), origin);

/** Hash a cached feature was made with (supports records written before per-contour hashes). */
function hashOf(record, feature) {
  if (feature.properties.paramsHash) return feature.properties.paramsHash;
  if (!record.parameters || !record.origin) return null;
  // Legacy record: one request for all its contours; its hash covered them.
  const origin = { lon: record.origin[0], lat: record.origin[1] };
  if (record.paramsHash !== parametersHash(record.provider, record.parameters, origin)) return null;
  return featureHash(record.provider, record.parameters, origin);
}

/** Contours (seconds) of a cached record that are reusable with these inputs. */
export function usableContours(record, providerId, params, origin) {
  if (!record || !Array.isArray(record.features) || record.provider !== providerId) return [];
  const want = featureHash(providerId, params, origin);
  return record.features
    .filter((f) => hashOf(record, f) === want && MetroGeometry.isValidPolygonal(f.geometry))
    .map((f) => f.properties.seconds);
}

/** A cached record is reusable when every configured contour was produced with identical inputs. */
export function isCacheValid(record, providerId, params, origin) {
  const have = usableContours(record, providerId, params, origin);
  return MetroConfig.CONTOUR_SECONDS.every((s) => have.includes(s));
}

/**
 * Compute (or reuse) the configured contours (MetroConfig.CONTOUR_SECONDS) for
 * one station. Only missing contours are requested from the provider.
 * @returns {Promise<{record: object, fromCache: boolean, requested: number[]}>}
 */
export async function computeStation(provider, station, { force = false, fetchOpts = {} } = {}) {
  const seconds = MetroConfig.CONTOUR_SECONDS.slice();
  const speed = MetroConfig.WALKING_SPEED_MPS;
  const params = provider.parameters(seconds, speed);
  const origin = { lon: station.lon, lat: station.lat };
  const cached = readCached(station.id);
  const have = force ? [] : usableContours(cached, provider.id, params, origin);
  const missing = seconds.filter((x) => !have.includes(x));
  const hash = featureHash(provider.id, params, origin);
  const keep = (cached?.features || [])
    .filter((f) => have.includes(f.properties.seconds) && seconds.includes(f.properties.seconds))
    .map((f) => ({ ...f, properties: { ...f.properties, paramsHash: hashOf(cached, f), generatedAt: f.properties.generatedAt || cached.generatedAt } }));
  if (!missing.length) {
    const record = { ...cached, features: keep };
    return { record, fromCache: true, requested: [] };
  }

  const now = new Date().toISOString();
  const contours = await provider.isochrone(origin, missing, speed, fetchOpts);
  const fresh = contours.map(({ seconds: s, geometry }) => {
    const polys = MetroGeometry.toPolygons(geometry);
    if (!polys.length) throw new Error(`Provider returned invalid ${s}s geometry for ${station.name}`);
    return {
      type: 'Feature',
      properties: { stationId: station.id, stationName: station.name, seconds: s, minutes: s / 60, areaM2: Math.round(MetroGeometry.areaM2(polys)), paramsHash: hash, generatedAt: now, requestedContours: missing },
      geometry: MetroGeometry.toGeometry(polys)
    };
  });
  const features = keep.concat(fresh).sort((p, q) => p.properties.seconds - q.properties.seconds);
  const record = {
    stationId: station.id,
    stationName: station.name,
    origin: [station.lon, station.lat],
    originNote: 'Operator (GTFS) parent-station coordinate: a centroid, not an entrance.',
    provider: provider.id,
    providerName: provider.name,
    profile: provider.profile,
    parameters: { ...params, contours_seconds: features.map((f) => f.properties.seconds) },
    paramsHash: parametersHash(provider.id, { ...params, contours_seconds: features.map((f) => f.properties.seconds) }, origin),
    generatedAt: features.map((f) => f.properties.generatedAt).sort().slice(-1)[0],
    features
  };
  writeJson(stationFile(station.id), record, false);
  return { record, fromCache: false, requested: missing };
}
