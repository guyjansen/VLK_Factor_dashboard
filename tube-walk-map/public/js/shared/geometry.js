/*
 * Geometry helpers shared by the browser (main thread + Web Worker), the Node
 * preprocessing scripts and the tests. No dependencies except an injected
 * polygon-clipping instance for boolean union.
 *
 * Coordinates are WGS84 [lon, lat]. Polygon unions use polygon-clipping
 * (Martinez-Rueda style sweep-line), which handles overlaps and holes and
 * returns valid, non-overlapping MultiPolygon coordinates.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TubeGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EARTH_RADIUS = 6371008.8;
  var RAD = Math.PI / 180;

  function isFiniteCoord(c) {
    return Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) &&
      c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90;
  }

  /** Signed planar area of a ring in degree units (for orientation/degeneracy). */
  function planarRingArea(ring) {
    var s = 0;
    for (var i = 0, n = ring.length - 1; i < n; i++) {
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return s / 2;
  }

  /**
   * Clean one linear ring: drop invalid coordinates and consecutive
   * duplicates, close it, and reject rings with fewer than 4 positions or
   * (near) zero area. Returns null for unusable rings.
   */
  function cleanRing(ring) {
    if (!Array.isArray(ring)) return null;
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      var c = ring[i];
      if (!isFiniteCoord(c)) continue;
      var p = [c[0], c[1]];
      var last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(p);
    }
    if (out.length < 3) return null;
    var first = out[0];
    var end = out[out.length - 1];
    if (first[0] !== end[0] || first[1] !== end[1]) out.push([first[0], first[1]]);
    if (out.length < 4) return null;
    if (Math.abs(planarRingArea(out)) < 1e-14) return null;
    return out;
  }

  /**
   * Normalise a GeoJSON Polygon/MultiPolygon geometry (or a Feature wrapping
   * one) to an array of polygons (MultiPolygon coordinates) with cleaned rings.
   * Polygons whose outer ring is unusable are dropped; unusable holes are
   * dropped. Returns [] for anything else.
   */
  function toPolygons(input) {
    var geom = input && input.type === 'Feature' ? input.geometry : input;
    if (!geom || !geom.coordinates) return [];
    var polys;
    if (geom.type === 'Polygon') polys = [geom.coordinates];
    else if (geom.type === 'MultiPolygon') polys = geom.coordinates;
    else return [];
    var out = [];
    for (var i = 0; i < polys.length; i++) {
      var poly = polys[i];
      if (!Array.isArray(poly) || !poly.length) continue;
      var outer = cleanRing(poly[0]);
      if (!outer) continue;
      var rings = [outer];
      for (var j = 1; j < poly.length; j++) {
        var hole = cleanRing(poly[j]);
        if (hole) rings.push(hole);
      }
      out.push(rings);
    }
    return out;
  }

  /** Is this a usable Polygon/MultiPolygon geometry? */
  function isValidPolygonal(geom) {
    return toPolygons(geom).length > 0;
  }

  /** MultiPolygon coordinates -> GeoJSON geometry (Polygon when single). */
  function toGeometry(polys) {
    if (!polys || !polys.length) return null;
    if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
    return { type: 'MultiPolygon', coordinates: polys };
  }

  /**
   * True geometric union of polygonal geometries.
   * @param {Array} geoms GeoJSON geometries/features (Polygon/MultiPolygon)
   * @param {object} pc polygon-clipping module
   * @returns {{polygons: Array, skipped: number, inputCount: number}}
   */
  function unionGeometries(geoms, pc) {
    if (!pc || typeof pc.union !== 'function') throw new Error('polygon-clipping is required for unions');
    var parts = [];
    var skipped = 0;
    for (var i = 0; i < geoms.length; i++) {
      var p = toPolygons(geoms[i]);
      if (p.length) parts.push(p); else skipped++;
    }
    if (!parts.length) return { polygons: [], skipped: skipped, inputCount: geoms.length };
    if (parts.length === 1) {
      // Still run through union so self-overlaps inside one input are resolved.
      try {
        return { polygons: pc.union(parts[0]), skipped: skipped, inputCount: geoms.length };
      } catch (e) {
        return { polygons: parts[0], skipped: skipped, inputCount: geoms.length };
      }
    }
    try {
      return { polygons: pc.union.apply(null, parts), skipped: skipped, inputCount: geoms.length };
    } catch (err) {
      // Robust fallback: incremental union, skipping any geometry that makes
      // the sweep-line fail (extremely rare; reported via `skipped`).
      var acc = null;
      for (var k = 0; k < parts.length; k++) {
        try {
          acc = acc ? pc.union(acc, parts[k]) : pc.union(parts[k]);
        } catch (e2) {
          skipped++;
        }
      }
      return { polygons: acc || [], skipped: skipped, inputCount: geoms.length };
    }
  }

  /** Spherical area of a ring in m² (same method as Turf / d3-geo approximation). */
  function ringAreaM2(coords) {
    var total = 0;
    var n = coords.length;
    if (n <= 2) return 0;
    for (var i = 0; i < n; i++) {
      var lower, middle, upper;
      if (i === n - 2) { lower = n - 2; middle = n - 1; upper = 0; }
      else if (i === n - 1) { lower = n - 1; middle = 0; upper = 1; }
      else { lower = i; middle = i + 1; upper = i + 2; }
      var p1 = coords[lower], p2 = coords[middle], p3 = coords[upper];
      total += (p3[0] * RAD - p1[0] * RAD) * Math.sin(p2[1] * RAD);
    }
    return Math.abs(total * EARTH_RADIUS * EARTH_RADIUS / 2);
  }

  /** Area of a polygonal geometry in m² (outer rings minus holes). */
  function areaM2(geomOrPolys) {
    var polys = Array.isArray(geomOrPolys) ? geomOrPolys : toPolygons(geomOrPolys);
    var a = 0;
    for (var i = 0; i < polys.length; i++) {
      for (var j = 0; j < polys[i].length; j++) {
        var r = ringAreaM2(polys[i][j]);
        a += j === 0 ? r : -r;
      }
    }
    return a;
  }

  function haversineM(a, b) {
    var dLat = (b[1] - a[1]) * RAD;
    var dLon = (b[0] - a[0]) * RAD;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function sqSegDist(p, a, b) {
    var x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      var t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }

  /** Douglas-Peucker simplification of an open polyline (tolerance in degrees). */
  function simplifyLine(points, tolerance) {
    if (points.length <= 2) return points.slice();
    var sqTol = tolerance * tolerance;
    var keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    var stack = [[0, points.length - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var maxD = 0, idx = -1;
      for (var i = seg[0] + 1; i < seg[1]; i++) {
        var d = sqSegDist(points[i], points[seg[0]], points[seg[1]]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx !== -1 && maxD > sqTol) {
        keep[idx] = 1;
        stack.push([seg[0], idx], [idx, seg[1]]);
      }
    }
    var out = [];
    for (var k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  function roundCoord(c, decimals) {
    var f = Math.pow(10, decimals);
    return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
  }

  /**
   * Simplify + round a polygonal geometry for display. Rings that collapse
   * are dropped (holes) or kept unsimplified (outer rings). The analysis copy
   * should always be kept separately at full precision.
   */
  function simplifyGeometry(geom, toleranceDeg, decimals) {
    var polys = toPolygons(geom);
    var dec = decimals == null ? 5 : decimals;
    var out = [];
    for (var i = 0; i < polys.length; i++) {
      var rings = [];
      for (var j = 0; j < polys[i].length; j++) {
        var ring = polys[i][j];
        var simp = toleranceDeg > 0 ? simplifyLine(ring, toleranceDeg) : ring;
        var rounded = cleanRing(simp.map(function (c) { return roundCoord(c, dec); }));
        if (!rounded) {
          if (j > 0) continue;
          rounded = cleanRing(ring.map(function (c) { return roundCoord(c, dec); }));
          if (!rounded) break;
        }
        rings.push(rounded);
      }
      if (rings.length) out.push(rings);
    }
    return toGeometry(out);
  }

  /** [west, south, east, north] of any nested coordinate array; null if empty. */
  function bbox(coords) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function walk(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < b[0]) b[0] = c[0];
        if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0];
        if (c[1] > b[3]) b[3] = c[1];
        return;
      }
      for (var i = 0; i < c.length; i++) walk(c[i]);
    })(coords);
    return b[0] === Infinity ? null : b;
  }

  /**
   * Radial statistics of a polygon's outer-ring vertices around a centre.
   * A circular buffer has coefficient of variation ~0; pedestrian-network
   * isochrones are irregular. Used by tests and validation.
   */
  function radialStats(geom, centre) {
    var polys = toPolygons(geom);
    var r = [];
    polys.forEach(function (p) { p[0].forEach(function (c) { r.push(haversineM(centre, c)); }); });
    if (!r.length) return null;
    var mean = r.reduce(function (s, v) { return s + v; }, 0) / r.length;
    var variance = r.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / r.length;
    return { mean: mean, max: Math.max.apply(null, r), min: Math.min.apply(null, r), cv: Math.sqrt(variance) / mean, n: r.length };
  }

  /** Ray-casting point-in-polygon for MultiPolygon coordinates (holes respected). */
  function pointInPolygons(pt, polys) {
    function inRing(ring) {
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }
    for (var p = 0; p < polys.length; p++) {
      if (!inRing(polys[p][0])) continue;
      var inHole = false;
      for (var h = 1; h < polys[p].length; h++) if (inRing(polys[p][h])) { inHole = true; break; }
      if (!inHole) return true;
    }
    return false;
  }

  return {
    cleanRing: cleanRing,
    toPolygons: toPolygons,
    toGeometry: toGeometry,
    isValidPolygonal: isValidPolygonal,
    unionGeometries: unionGeometries,
    areaM2: areaM2,
    haversineM: haversineM,
    simplifyLine: simplifyLine,
    simplifyGeometry: simplifyGeometry,
    bbox: bbox,
    radialStats: radialStats,
    pointInPolygons: pointInPolygons
  };
});
