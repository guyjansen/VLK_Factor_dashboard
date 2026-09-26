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
