// Per-station isochrone cache shared by generate-isochrones.mjs and the server.
// One JSON file per station in data/isochrones/<stationId>.json, written
// atomically, so runs can be interrupted and resumed safely.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, writeJson, TubeConfig, TubeGeometry } from './common.mjs';

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

/** A cached record is reusable when it was produced with identical inputs. */
export function isCacheValid(record, providerId, params, origin) {
  if (!record || !Array.isArray(record.features)) return false;
  if (record.paramsHash !== parametersHash(providerId, params, origin)) return false;
  return TubeConfig.CONTOUR_SECONDS.every((s) => record.features.some((f) => f.properties.seconds === s && TubeGeometry.isValidPolygonal(f.geometry)));
}

/**
 * Compute (or reuse) the 60/120/300 s isochrones for one station.
 * @returns {Promise<{record: object, fromCache: boolean}>}
 */
export async function computeStation(provider, station, { force = false, fetchOpts = {} } = {}) {
  const seconds = TubeConfig.CONTOUR_SECONDS.slice();
  const speed = TubeConfig.WALKING_SPEED_MPS;
  const params = provider.parameters(seconds, speed);
  const origin = { lon: station.lon, lat: station.lat };
  const cached = readCached(station.id);
  if (!force && isCacheValid(cached, provider.id, params, origin)) return { record: cached, fromCache: true };

  const contours = await provider.isochrone(origin, seconds, speed, fetchOpts);
  const features = contours.map(({ seconds: s, geometry }) => {
    const polys = TubeGeometry.toPolygons(geometry);
    if (!polys.length) throw new Error(`Provider returned invalid ${s}s geometry for ${station.name}`);
    return {
      type: 'Feature',
      properties: { stationId: station.id, stationName: station.name, seconds: s, minutes: s / 60, areaM2: Math.round(TubeGeometry.areaM2(polys)) },
      geometry: TubeGeometry.toGeometry(polys)
    };
  });
  const record = {
    stationId: station.id,
    stationName: station.name,
    origin: [station.lon, station.lat],
    originNote: 'Supplied station coordinate (centroid), not individual entrances.',
    provider: provider.id,
    providerName: provider.name,
    profile: provider.profile,
    parameters: params,
    paramsHash: parametersHash(provider.id, params, origin),
    generatedAt: new Date().toISOString(),
    features
  };
  writeJson(stationFile(station.id), record, false);
  return { record, fromCache: false };
}
