// Numerical routines checked against statsmodels and closed-form results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FA = require("../../docs/assets/analytics.js");
const fixture = JSON.parse(readFileSync(new URL("../fixtures/ols_fixture.json", import.meta.url)));

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test("OLS matches statsmodels coefficients, OLS and Newey-West errors", () => {
  for (const [i, c] of fixture.cases.entries()) {
    const plain = FA.ols(c.y, c.cols);
    const hac = FA.ols(c.y, c.cols, { hac: true });
    assert.equal(hac.lags, c.lags, `case ${i} lag rule`);
    c.coef.forEach((b, j) => close(plain.coef[j], b, 1e-8, `case ${i} coef ${j}`));
    c.se_ols.forEach((s, j) => close(plain.se[j], s, 1e-8, `case ${i} se ${j}`));
    c.se_hac.forEach((s, j) => close(hac.se[j], s, 1e-7, `case ${i} hac se ${j}`));
    close(plain.r2, c.r2, 1e-10, `case ${i} r2`);
    close(plain.adjR2, c.adj_r2, 1e-10, `case ${i} adj r2`);
  }
});

test("OLS refuses collinear designs and tiny samples", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.equal(FA.ols([1, 2, 3, 4, 5, 6, 7, 9], [x, x.map((v) => 2 * v)]), null);
  assert.equal(FA.ols([1, 2], [[1, 2]]), null);
});

test("ffill respects the gap limit", () => {
  const out = Array.from(FA.ffill([1, null, null, null, 5, null], 2));
  assert.deepEqual(out.map((v) => (Number.isNaN(v) ? null : v)), [1, 1, 1, null, 5, 5]);
});

test("quantile interpolates like numpy", () => {
  close(FA.quantile([1, 2, 3, 4], 0.25), 1.75, 1e-12, "q25");
  close(FA.median([5, 1, 3]), 3, 1e-12, "median");
});

test("Carino-linked contributions add up to the compounded return", () => {
  const returns = [0.02, -0.01, 0.03, -0.015];
  const contribs = returns.map((r) => [0.6 * r, 0.3 * r, 0.1 * r]);
  const { total, linked } = FA.carino(returns, contribs);
  const compounded = returns.reduce((g, r) => g * (1 + r), 1) - 1;
  close(total, compounded, 1e-12, "total");
  close(linked.reduce((a, b) => a + b, 0), compounded, 1e-12, "sum");
  const path = FA.carinoPath(returns, contribs);
  close(path[path.length - 1].linked.reduce((a, b) => a + b, 0), compounded, 1e-12, "path end");
});

test("conditional shocks follow the regression of one factor on another", () => {
  const F = [
    [4, 2],
    [2, 9],
  ];
  const x = FA.conditionalShocks(F, { 0: 1 });
  close(x[0], 1, 1e-12, "given");
  close(x[1], 0.5, 1e-12, "implied");
});

test("risk decomposition sums to total variance", () => {
  const F = [
    [0.0004, 0.0001],
    [0.0001, 25],
  ];
  const r = FA.riskDecomposition([1.1, -0.004], F, 0.0003);
  close(r.contrib.reduce((a, b) => a + b, 0) + r.specific, r.total, 1e-12, "sum");
  close(r.share.reduce((a, b) => a + b, 0) + r.specificShare, 1, 1e-12, "shares");
});

test("technical indicators", () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(FA.rsi(rising, 14)[29], 100);
  close(FA.sma([1, 2, 3, 4, 5], 5)[4], 3, 1e-12, "sma");
  close(FA.drawdowns([100, 120, 90, 130]).max, -0.25, 1e-12, "max drawdown");
});

test("z-scores are centred after winsorising", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  const z = FA.zscores(values);
  const raw = FA.zscores(values, 0, 1);
  close(FA.mean(z), 0, 1e-12, "mean");
  assert.ok(z[9] < raw[9], "outlier is pulled in by winsorising");
  assert.ok(Number.isNaN(FA.zscores([1, null, 3, 4])[1]), "missing stays missing");
});

test("coefficient-only OLS matches the full regression, also on a row range", () => {
  for (const [i, c] of fixture.cases.entries()) {
    const full = FA.ols(c.y, c.cols);
    FA.olsCoef(c.y, c.cols).forEach((b, j) => close(b, full.coef[j], 1e-9, `case ${i} coef ${j}`));
    const lo = 5;
    const hi = c.y.length - 4;
    const part = FA.ols(c.y.slice(lo, hi + 1), c.cols.map((col) => col.slice(lo, hi + 1)));
    FA.olsCoef(c.y, c.cols, lo, hi).forEach((b, j) => close(b, part.coef[j], 1e-9, `case ${i} range coef ${j}`));
  }
});

test("ranks share ties and Spearman ignores monotone transforms", () => {
  assert.deepEqual(FA.ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  const x = [0.3, -1.2, 2.5, 0.7, 1.1, -0.4];
  close(FA.spearman(x, x.map((v) => Math.exp(3 * v))), 1, 1e-12, "monotone");
  close(FA.spearman(x, x.map((v) => -v)), -1, 1e-12, "reversed");
  assert.ok(Number.isNaN(FA.spearman([1, 2], [2, 1])), "too few pairs");
});

test("GARCH(1,1) recovers simulated parameters and forecasts back to the long-run level", () => {
  let s = 12345;
  const uniform = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12))) * Math.cos(2 * Math.PI * uniform());
  const [a, b, lr] = [0.08, 0.9, 1e-4];
  const r = [];
  let h = lr;
  let prev = 0;
  for (let t = 0; t < 6000; t++) {
    h = lr * (1 - a - b) + a * prev * prev + b * h;
    prev = Math.sqrt(h) * normal();
    r.push(prev);
  }
  const g = FA.garch11(r);
  assert.ok(Math.abs(g.alpha - a) < 0.04, `alpha ${g.alpha}`);
  assert.ok(Math.abs(g.beta - b) < 0.05, `beta ${g.beta}`);
  assert.ok(Math.abs(g.persistence - (a + b)) < 0.02, `persistence ${g.persistence}`);
  close(FA.garchCumVar(g, 1), g.nextVar, 1e-12, "one day ahead");
  let sum = 0;
  for (let k = 1; k <= 10; k++) sum += FA.garchVarAt(g, k);
  close(FA.garchCumVar(g, 10), sum, 1e-12, "cumulative = sum of daily variances");
  close(FA.garchCumVar(g, 100000) / 100000, g.lrVar, 1e-3, "long horizons revert");
  assert.equal(FA.garch11(r.slice(0, 100)), null, "too short");
});
