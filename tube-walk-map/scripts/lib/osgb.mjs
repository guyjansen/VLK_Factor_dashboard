// Ordnance Survey National Grid (EPSG:27700, OSGB36 Transverse Mercator)
// easting/northing -> WGS84 longitude/latitude.
//
// Method: inverse Transverse Mercator on the Airy 1830 ellipsoid (OS
// "A guide to coordinate systems in Great Britain", annex C), then a 7-parameter
// Helmert transformation OSGB36 -> WGS84 (OS published parameters).
// Accuracy is about 2-5 m. That is well within the precision of a single
// station-centroid coordinate, but it is not the centimetre-level OSTN15 grid
// transformation.
const RAD = Math.PI / 180;

function inverseTM(E, N) {
  const a = 6377563.396, b = 6356256.909;
  const F0 = 0.9996012717, lat0 = 49 * RAD, lon0 = -2 * RAD, N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;
  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n * n + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);
  const sin = Math.sin(lat), cos = Math.cos(lat), tan = Math.tan(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sin * sin);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const VII = tan / (2 * rho * nu);
  const VIII = tan / (24 * rho * nu ** 3) * (5 + 3 * tan ** 2 + eta2 - 9 * tan ** 2 * eta2);
  const IX = tan / (720 * rho * nu ** 5) * (61 + 90 * tan ** 2 + 45 * tan ** 4);
  const X = 1 / (cos * nu);
  const XI = 1 / (cos * 6 * nu ** 3) * (nu / rho + 2 * tan ** 2);
  const XII = 1 / (cos * 120 * nu ** 5) * (5 + 28 * tan ** 2 + 24 * tan ** 4);
  const XIIA = 1 / (cos * 5040 * nu ** 7) * (61 + 662 * tan ** 2 + 1320 * tan ** 4 + 720 * tan ** 6);
  const dE = E - E0;
  return {
    lat: lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    lon: lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7
  };
}

function toCartesian(lat, lon, a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [nu * Math.cos(lat) * Math.cos(lon), nu * Math.cos(lat) * Math.sin(lon), (1 - e2) * nu * Math.sin(lat)];
}

function toGeodetic([x, y, z], a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - e2)), prev;
  do {
    prev = lat;
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  } while (Math.abs(lat - prev) > 1e-12);
  return { lat, lon: Math.atan2(y, x) };
}

/** @returns {[number, number]} [longitude, latitude] in WGS84 degrees */
export function osgbToWgs84(easting, northing) {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return [NaN, NaN];
  const { lat, lon } = inverseTM(easting, northing);
  const [x, y, z] = toCartesian(lat, lon, 6377563.396, 6356256.909);
  // OSGB36 -> WGS84 Helmert parameters (Ordnance Survey).
  const tx = 446.448, ty = -125.157, tz = 542.06;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * RAD, ry = (0.247 / 3600) * RAD, rz = (0.8421 / 3600) * RAD;
  const x2 = tx + (1 + s) * x - rz * y + ry * z;
  const y2 = ty + rz * x + (1 + s) * y - rx * z;
  const z2 = tz - ry * x + rx * y + (1 + s) * z;
  const g = toGeodetic([x2, y2, z2], 6378137, 6356752.314245);
  return [g.lon / RAD, g.lat / RAD];
}
