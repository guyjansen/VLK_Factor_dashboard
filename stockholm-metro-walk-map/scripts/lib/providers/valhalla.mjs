// Valhalla isochrone adapter (https://valhalla.github.io/valhalla/api/isochrone/api-reference/)
// One request returns all contours (300/600 s) for a location.
import { fetchJsonWithRetry, HttpError } from '../http.mjs';

export function createValhallaProvider(env = process.env) {
  const baseUrl = (env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de').replace(/\/+$/, '');
  const apiKey = env.VALHALLA_API_KEY || '';
  const isPublicFossgis = /valhalla1\.openstreetmap\.de/.test(baseUrl);

  return {
    id: 'valhalla',
    name: isPublicFossgis ? 'Valhalla (FOSSGIS public instance, OpenStreetMap data)' : `Valhalla (${new URL(baseUrl).host})`,
    profile: 'pedestrian',
    attribution: 'Routing: Valhalla (MIT) with OpenStreetMap data © OpenStreetMap contributors (ODbL)' +
      (isPublicFossgis ? '; hosted by FOSSGIS e.V.' : ''),
    // Public FOSSGIS instance: be gentle (≤1 request/second).
    defaultMinIntervalMs: isPublicFossgis ? 1100 : 100,
    requiresKey: false,

    /** Parameters recorded with each result (used for cache invalidation). */
    parameters(seconds, walkingSpeedMps) {
      return {
        costing: 'pedestrian',
        walking_speed_kmh: Number((walkingSpeedMps * 3.6).toFixed(2)),
        contours_seconds: seconds.slice(),
        polygons: true,
        denoise: 0.1,
        generalize_m: 3
      };
    },

    /**
     * @returns {Promise<Array<{seconds:number, geometry:object}>>}
     */
    async isochrone({ lon, lat }, seconds, walkingSpeedMps, opts = {}) {
      const p = this.parameters(seconds, walkingSpeedMps);
      const body = {
        locations: [{ lat, lon }],
        costing: 'pedestrian',
        costing_options: { pedestrian: { walking_speed: p.walking_speed_kmh } },
        contours: seconds.map((s) => ({ time: s / 60 })),
        polygons: true,
        denoise: p.denoise,
        generalize: p.generalize_m
      };
      const url = `${baseUrl}/isochrone${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''}`;
      const json = await fetchJsonWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'stockholm-metro-walk-map/1.0 (pedestrian isochrone preprocessing; low volume)' },
        body: JSON.stringify(body),
        ...opts
      });
      if (!json || !Array.isArray(json.features)) {
        throw new HttpError(`Valhalla returned no features: ${JSON.stringify(json).slice(0, 200)}`, { code: 'server', retryable: false });
      }
      return seconds.map((s) => {
        const f = json.features.find((x) => Math.abs(Number(x.properties?.contour) * 60 - s) < 0.5);
        if (!f) throw new HttpError(`Valhalla response lacks the ${s}s contour`, { code: 'server' });
        return { seconds: s, geometry: f.geometry };
      });
    }
  };
}
