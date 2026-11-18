// openrouteservice isochrone adapter (https://openrouteservice.org/dev/#/api-docs/v2/isochrones)
// Profile foot-walking; one request returns all ranges.
import { fetchJsonWithRetry, HttpError } from '../http.mjs';

export function createOrsProvider(env = process.env) {
  const baseUrl = (env.ORS_URL || 'https://api.openrouteservice.org').replace(/\/+$/, '');
  const apiKey = env.ORS_API_KEY || '';
  const isPublic = /api\.openrouteservice\.org/.test(baseUrl);

  return {
    id: 'openrouteservice',
    name: `openrouteservice (${new URL(baseUrl).host})`,
    profile: 'foot-walking',
    attribution: 'Routing: openrouteservice © HeiGIT gGmbH, with OpenStreetMap data © OpenStreetMap contributors (ODbL)',
    // Public free plan: 20 isochrone requests/minute, 500/day.
    defaultMinIntervalMs: isPublic ? 3100 : 100,
    requiresKey: isPublic,

    parameters(seconds) {
      // ORS foot-walking uses its own fixed profile speed (~5 km/h); it cannot
      // be set to exactly 1.4 m/s through the isochrone endpoint.
      return { profile: 'foot-walking', range_type: 'time', range_seconds: seconds.slice(), smoothing: 0 };
    },

    async isochrone({ lon, lat }, seconds, _walkingSpeedMps, opts = {}) {
      if (this.requiresKey && !apiKey) {
        throw new HttpError('ORS_API_KEY is not set. Add it to .env (see .env.example).', { code: 'auth' });
      }
      const json = await fetchJsonWithRetry(`${baseUrl}/v2/isochrones/foot-walking`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/geo+json, application/json',
          ...(apiKey ? { Authorization: apiKey } : {})
        },
        body: JSON.stringify({ locations: [[lon, lat]], range: seconds, range_type: 'time', smoothing: 0 }),
        ...opts
      });
      if (!json || !Array.isArray(json.features)) {
        throw new HttpError('openrouteservice returned no features', { code: 'server' });
      }
      return seconds.map((s) => {
        const f = json.features.find((x) => Number(x.properties?.value) === s);
        if (!f) throw new HttpError(`openrouteservice response lacks the ${s}s contour`, { code: 'server' });
        return { seconds: s, geometry: f.geometry };
      });
    }
  };
}
