// Isochrone provider registry. Every adapter exposes the same small interface:
//   { id, name, profile, attribution, defaultMinIntervalMs, requiresKey,
//     parameters(seconds, walkingSpeedMps) -> object,
//     isochrone({lon, lat}, seconds, walkingSpeedMps, fetchOpts) -> [{seconds, geometry}] }
// To add a provider (e.g. GraphHopper), implement that interface and register it here.
import { createValhallaProvider } from './valhalla.mjs';
import { createOrsProvider } from './openrouteservice.mjs';

const FACTORIES = {
  valhalla: createValhallaProvider,
  openrouteservice: createOrsProvider,
  ors: createOrsProvider
};

export function createProvider(id, env = process.env) {
  const key = String(id || env.ISOCHRONE_PROVIDER || 'valhalla').toLowerCase();
  const factory = FACTORIES[key];
  if (!factory) throw new Error(`Unknown isochrone provider "${key}". Use one of: valhalla, openrouteservice.`);
  return factory(env);
}

export const PROVIDER_IDS = ['valhalla', 'openrouteservice'];
