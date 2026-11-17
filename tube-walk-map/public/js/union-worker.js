/*
 * Web Worker: polygon unions off the main thread. Receives
 *   { jobId, groups: [{ seconds, geoms: [GeoJSON geometry, ...] }] }
 * and replies
 *   { jobId, results: [{ seconds, geometry, areaM2, skipped }] }  or  { jobId, error }
 */
/* global importScripts, TubeGeometry, polygonClipping */
importScripts('../vendor/polygon-clipping.umd.min.js', 'shared/geometry.js');

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    var results = (msg.groups || []).map(function (g) {
      var r = TubeGeometry.unionGeometries(g.geoms, polygonClipping);
      return { seconds: g.seconds, geometry: TubeGeometry.toGeometry(r.polygons), areaM2: TubeGeometry.areaM2(r.polygons), skipped: r.skipped };
    });
    self.postMessage({ jobId: msg.jobId, results: results });
  } catch (err) {
    self.postMessage({ jobId: msg.jobId, error: String(err && err.message || err) });
  }
};
