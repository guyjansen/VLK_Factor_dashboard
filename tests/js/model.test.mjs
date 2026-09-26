// Factor model layer on a synthetic dataset with known exposures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../../docs/assets/model.js");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function normal(r) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Four stocks, 3.5 years of weekdays; betas are known by construction. */
function syntheticData() {
  const r = rng(7);
  const dates = [];
  for (let d = Date.UTC(2023, 0, 2); d <= Date.UTC(2026, 5, 30); d += 86400000) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(new Date(d).toISOString().slice(0, 10));
  }
  const n = dates.length;
  const mkt = [100];
  const y10 = [2.5];
  const hy = [4.0];
  const fxg = [0.86];
  const ff = [100];
  for (let t = 1; t < n; t++) {
    mkt.push(mkt[t - 1] * (1 + 0.0003 + 0.01 * normal(r)));
    y10.push(y10[t - 1] + 0.04 * normal(r));
    hy.push(hy[t - 1] + 0.03 * normal(r));
    fxg.push(fxg[t - 1] * (1 + 0.004 * normal(r)));
    ff.push(ff[t - 1] * (1 + 0.004 * normal(r)));
  }
  const specs = [
    { id: "AAA", subsector: "Office", currency: "EUR", country: "FR", bm: 1.2, br: -0.0008 },
    { id: "BBB", subsector: "Office", currency: "EUR", country: "DE", bm: 0.8, br: -0.0004 },
    { id: "CCC", subsector: "Logistics", currency: "EUR", country: "NL", bm: 1.0, br: -0.0012 },
    { id: "DDD", subsector: "Logistics", currency: "GBP", country: "GB", bm: 0.9, br: -0.0006 },
  ];
  const stocks = specs.map((s, k) => {
    const tri = [50 + 10 * k];
    for (let t = 1; t < n; t++) {
      const rm = mkt[t] / mkt[t - 1] - 1;
      const dy = (y10[t] - y10[t - 1]) * 100;
      const ret = s.bm * rm + s.br * dy + 0.006 * normal(r);
      tri.push(tri[t - 1] * (1 + ret));
    }
    if (s.id === "BBB") for (let t = 0; t < 300; t++) tri[t] = null; // later listing
    return {
      id: s.id,
      name: `Stock ${s.id}`,
      ticker: `${s.id}.XX`,
      country: s.country,
      currency: s.currency,
      subsector: s.subsector,
      segment: "",
      tri,
      px: tri.map((v) => (v == null ? null : v * 0.9)),
      fund: { shares: 1e8 * (k + 1), market_cap_eur: 5e9 },
    };
  });
  const series = {
    MKT: { values: mkt },
    EUR10Y: { values: y10 },
    GB10Y: { values: y10.map((v) => v + 1) },
    EUR_HY_OAS: { values: hy },
    FX_GBP: { values: fxg },
    FF_HML: { values: ff },
  };
  return {
    meta: { subsectors: ["Office", "Logistics"], local_rate_by_country: { GB: "GB10Y" } },
    dates,
    stocks,
    series,
  };
}

const data = syntheticData();
const ctx = M.prepare(data);

test("weekly sampling picks the last trading day of each week", () => {
  const st = ctx.byId.AAA;
  const pts = M.samplePoints(ctx, st, "W", 10, 60);
  for (const p of pts.slice(1, -1)) {
    const next = ctx.dates[p + 1];
    const gap = (Date.parse(next) - Date.parse(ctx.dates[p])) / 86400000;
    assert.ok(gap >= 3, `${ctx.dates[p]} should end a week`);
  }
});

test("macro model recovers the true market and rate betas", () => {
  for (const [id, bm, br] of [["AAA", 1.2, -0.0008], ["CCC", 1.0, -0.0012]]) {
    const fit = M.fitModel(ctx, ctx.byId[id], ["MKT", "RATES", "CREDIT", "FXL"], { freq: "D", years: 3 });
    assert.ok(fit.ok, fit.error);
    assert.ok(Math.abs(fit.betas.MKT - bm) < 0.05, `${id} market beta ${fit.betas.MKT}`);
    assert.ok(Math.abs(fit.betas.RATES - br) < 0.0002, `${id} rate beta ${fit.betas.RATES}`);
    assert.deepEqual(fit.dropped.map((d) => d.id), ["FXL"], "FX factor dropped for a euro stock");
    assert.ok(fit.r2 > 0.6, `R2 ${fit.r2}`);
  }
});

test("local-currency view converts the market factor for a GBP stock", () => {
  const st = ctx.byId.DDD;
  const local = M.fitModel(ctx, st, ["MKT", "RATES", "FXL"], { freq: "W", years: 3, ccy: "local" });
  assert.ok(local.ok, local.error);
  assert.ok(local.factors.includes("FXL"));
  assert.equal(st.rateSeries, "GB10Y");
});

test("later listings shorten the sample instead of failing", () => {
  const fit = M.fitModel(ctx, ctx.byId.BBB, ["MKT"], { freq: "W", years: 5 });
  assert.ok(fit.ok);
  assert.ok(fit.start > ctx.dates[300]);
});

test("peer index excludes the stock itself", () => {
  const st = ctx.byId.AAA;
  const idx = M.peerIndex(ctx, st, "all");
  const t = 500;
  const others = ctx.stocks.filter((s) => s.id !== "AAA" && Number.isFinite(s.rEur[t]));
  const w = others.reduce((a, s) => a + s.capPrev[t], 0);
  const expected = others.reduce((a, s) => a + s.capPrev[t] * s.rEur[t], 0) / w;
  const got = idx[t] / idx[t - 1] - 1;
  assert.ok(Math.abs(got - expected) < 1e-12);
});

test("sector factor is orthogonal to the market inside the window", () => {
  const panel = M.buildPanel(ctx, ctx.byId.AAA, ["MKT", "SECTOR"], { freq: "W", years: 2 });
  const [m, s] = panel.cols;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const cov = mean(m.map((v, i) => (v - mean(m)) * (s[i] - mean(s))));
  assert.ok(Math.abs(cov) < 1e-12);
  assert.ok("SECTOR" in panel.gammas);
});

test("attribution contributions add up to the period return", () => {
  const st = ctx.byId.CCC;
  const end = ctx.n - 1;
  const start = end - 63;
  const att = M.attribution(ctx, st, ["MKT", "RATES", "CREDIT"], { freq: "W", years: 1 }, start, end);
  assert.ok(att.ok, att.error);
  const sum = Object.values(att.contributions).reduce((a, b) => a + b, 0) + att.specific;
  assert.ok(Math.abs(sum - att.total) < 1e-10);
  const actual = st.tri[end] / st.tri[start] - 1;
  assert.ok(Math.abs(att.total - actual) < 1e-10);
  assert.ok(Math.abs(att.contributions.MKT) > Math.abs(att.specific) * 0.1);
});

test("scenario impacts use the fitted betas", () => {
  const fit = M.fitModel(ctx, ctx.byId.AAA, ["MKT", "RATES"], { freq: "D", years: 3 });
  const s = M.scenario(fit, { RATES: 50 }, false);
  assert.ok(Math.abs(s.total - fit.betas.RATES * 50) < 1e-12);
  assert.equal(s.moves.MKT, 0);
  const c = M.scenario(fit, { RATES: 50 }, true);
  assert.ok(Number.isFinite(c.moves.MKT));
});

test("macro sensitivities include total and market-controlled effects", () => {
  const rows = M.macroSensitivities(ctx, ctx.byId.CCC, { freq: "W", years: 3 });
  const rates = rows.find((r) => r.id === "RATES");
  assert.ok(rates && Number.isFinite(rates.partial));
  assert.ok(rates.partialImpact < 0, "higher yields hurt this stock");
});

test("rolling fit returns one beta path per factor", () => {
  const roll = M.rollingFit(ctx, ctx.byId.AAA, ["MKT", "RATES"], { freq: "W" });
  assert.ok(roll.ok);
  assert.equal(roll.dates.length, roll.beta.MKT.length);
  assert.ok(Math.abs(roll.beta.MKT[roll.beta.MKT.length - 1] - 1.2) < 0.25);
});

test("stock statistics cover the standard horizons", () => {
  const stats = M.stockStats(ctx, ctx.byId.AAA);
  for (const k of ["d1", "w1", "m1", "m3", "ytd", "y1", "y3"]) assert.ok(Number.isFinite(stats.ret[k]), k);
  assert.ok(stats.vol1y > 0.05 && stats.vol1y < 0.6);
  assert.ok(stats.rsi14 >= 0 && stats.rsi14 <= 100);
});

test("episodes outside the data range are skipped", () => {
  const fit = M.fitModel(ctx, ctx.byId.AAA, ["MKT", "RATES"], { freq: "W", years: 2 });
  const covid = M.EPISODES.find((e) => e.id === "covid");
  assert.equal(M.episodeImpact(ctx, ctx.byId.AAA, fit, covid, "local"), null);
  const tariffs = M.EPISODES.find((e) => e.id === "tariffs25");
  const imp = M.episodeImpact(ctx, ctx.byId.AAA, fit, tariffs, "local");
  assert.ok(imp && Number.isFinite(imp.implied) && Number.isFinite(imp.actual));
});
