/*
 * Property Factor Lens - numerical routines.
 * Pure functions with no DOM access, shared by the dashboard and the Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FA = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);

  // ------------------------------------------------------------------ series
  /** Forward-fill gaps of at most `limit` observations. Missing values become NaN. */
  function ffill(values, limit = Infinity) {
    const n = values.length;
    const out = new Float64Array(n);
    let last = NaN;
    let gap = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (isNum(v)) {
        out[i] = v;
        last = v;
        gap = 0;
      } else {
        gap++;
        out[i] = isNum(last) && gap <= limit ? last : NaN;
      }
    }
    return out;
  }

  function finite(a) {
    const out = [];
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) out.push(a[i]);
    return out;
  }

  function sum(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) s += a[i];
    return s;
  }

  function mean(a) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if (isNum(a[i])) {
        s += a[i];
        n++;
      }
    }
    return n ? s / n : NaN;
  }

  function variance(a, ddof = 1) {
    const m = mean(a);
    let s = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if (isNum(a[i])) {
        s += (a[i] - m) * (a[i] - m);
        n++;
      }
    }
    return n - ddof > 0 ? s / (n - ddof) : NaN;
  }

  const std = (a, ddof = 1) => Math.sqrt(variance(a, ddof));

  /** Covariance over pairs where both values are finite. */
  function covariance(a, b, ddof = 1) {
    let sa = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if (isNum(a[i]) && isNum(b[i])) {
        sa += a[i];
        sb += b[i];
        n++;
      }
    }
    if (n - ddof <= 0) return NaN;
    const ma = sa / n;
    const mb = sb / n;
    let s = 0;
    for (let i = 0; i < a.length; i++) if (isNum(a[i]) && isNum(b[i])) s += (a[i] - ma) * (b[i] - mb);
    return s / (n - ddof);
  }

  function correlation(a, b) {
    let sa = 0, sb = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      if (isNum(a[i]) && isNum(b[i])) {
        sa += a[i];
        sb += b[i];
        n++;
      }
    }
    if (n < 3) return NaN;
    const ma = sa / n;
    const mb = sb / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) {
      if (isNum(a[i]) && isNum(b[i])) {
        const da = a[i] - ma;
        const db = b[i] - mb;
        sab += da * db;
        saa += da * da;
        sbb += db * db;
      }
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
  }

  /** Quantile with linear interpolation (numpy's default). */
  function quantile(a, q) {
    const v = finite(a).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const pos = (v.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }

  const median = (a) => quantile(a, 0.5);

  // ------------------------------------------------------------------ linear algebra
  /** Inverse of a square matrix by Gauss-Jordan elimination with partial pivoting. */
  function invert(A) {
    const n = A.length;
    const M = A.map((row, i) => {
      const r = new Float64Array(2 * n);
      for (let j = 0; j < n; j++) r[j] = row[j];
      r[n + i] = 1;
      return r;
    });
    let scale = 0;
    for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(A[i][i]));
    const tol = 1e-12 * Math.max(scale, 1e-300);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) <= tol) return null;
      if (p !== c) {
        const t = M[p];
        M[p] = M[c];
        M[c] = t;
      }
      const piv = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map((r) => Array.from(r.subarray(n)));
  }

  function matVec(A, x) {
    return A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
  }

  // ------------------------------------------------------------------ regression
  /** Newey-West lag rule used by statsmodels users: floor(4 (n/100)^(2/9)). */
  const nwLags = (n) => Math.max(0, Math.floor(4 * Math.pow(n / 100, 2 / 9)));

  /**
   * Ordinary least squares with an intercept.
   * y: array (n); cols: array of k arrays (n each). Rows must be complete.
   * opts.hac: Newey-West (Bartlett) standard errors with small-sample correction,
   * matching statsmodels OLS.fit(cov_type="HAC", cov_kwds={"maxlags": L}).
   * Returns coef/se/t with the intercept first.
   */
  function ols(y, cols, opts = {}) {
    const n = y.length;
    const k = cols.length + 1;
    if (n <= k) return null;
    const Z = (i, j) => (j === 0 ? 1 : cols[j - 1][i]);
    // Column scaling keeps X'X well conditioned when units differ (bp vs returns).
    const s = new Float64Array(k);
    for (let j = 0; j < k; j++) {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += Z(i, j) * Z(i, j);
      s[j] = Math.sqrt(acc / n) || 1;
    }
    const A = Array.from({ length: k }, () => new Float64Array(k));
    const b = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      for (let p = 0; p < k; p++) {
        const zp = Z(i, p) / s[p];
        b[p] += zp * y[i];
        for (let q = 0; q <= p; q++) A[p][q] += zp * (Z(i, q) / s[q]);
      }
    }
    for (let p = 0; p < k; p++) for (let q = 0; q < p; q++) A[q][p] = A[p][q];
    const Ainv = invert(A);
    if (!Ainv) return null;
    const bs = matVec(Ainv, b);
    const coef = bs.map((v, j) => v / s[j]);

    const resid = new Float64Array(n);
    const fitted = new Float64Array(n);
    let ssr = 0;
    const ym = mean(y);
    let sst = 0;
    for (let i = 0; i < n; i++) {
      let f = 0;
      for (let j = 0; j < k; j++) f += coef[j] * Z(i, j);
      fitted[i] = f;
      resid[i] = y[i] - f;
      ssr += resid[i] * resid[i];
      sst += (y[i] - ym) * (y[i] - ym);
    }
    const sigma2 = ssr / (n - k);
    let covScaled; // covariance of the scaled coefficients
    let lags = 0;
    if (opts.hac) {
      lags = opts.lags == null ? nwLags(n) : opts.lags;
      const S = Array.from({ length: k }, () => new Float64Array(k));
      const zrow = (i) => {
        const r = new Float64Array(k);
        for (let j = 0; j < k; j++) r[j] = Z(i, j) / s[j];
        return r;
      };
      const rows = Array.from({ length: n }, (_, i) => zrow(i));
      for (let i = 0; i < n; i++) {
        const e2 = resid[i] * resid[i];
        const r = rows[i];
        for (let p = 0; p < k; p++) for (let q = 0; q < k; q++) S[p][q] += e2 * r[p] * r[q];
      }
      for (let l = 1; l <= lags; l++) {
        const w = 1 - l / (lags + 1);
        for (let i = l; i < n; i++) {
          const ee = w * resid[i] * resid[i - l];
          const r0 = rows[i];
          const r1 = rows[i - l];
          for (let p = 0; p < k; p++) {
            for (let q = 0; q < k; q++) S[p][q] += ee * (r0[p] * r1[q] + r1[p] * r0[q]);
          }
        }
      }
      const corr = n / (n - k);
      covScaled = Ainv.map((row, p) =>
        Ainv[0].map((_, q) => {
          let acc = 0;
          for (let a = 0; a < k; a++) {
            if (row[a] === 0) continue;
            for (let c = 0; c < k; c++) acc += row[a] * S[a][c] * Ainv[c][q];
          }
          return acc * corr;
        })
      );
    } else {
      covScaled = Ainv.map((row) => row.map((v) => v * sigma2));
    }
    const cov = covScaled.map((row, p) => row.map((v, q) => v / (s[p] * s[q])));
    const se = cov.map((row, j) => Math.sqrt(Math.max(row[j], 0)));
    const t = coef.map((c, j) => (se[j] > 0 ? c / se[j] : NaN));
    const r2 = sst > 0 ? 1 - ssr / sst : NaN;
    return {
      n,
      k,
      coef,
      se,
      t,
      cov,
      r2,
      adjR2: sst > 0 ? 1 - ((1 - r2) * (n - 1)) / (n - k) : NaN,
      sigma2,
      resid,
      fitted,
      lags,
    };
  }

  /**
   * OLS coefficients only (intercept first) over rows lo..hi, without copying
   * the data. Same scaling as ols(); used for the many small regressions of
   * the exposure-forecast backtest.
   */
  function olsCoef(y, cols, lo = 0, hi = y.length - 1) {
    const k = cols.length + 1;
    const n = hi - lo + 1;
    if (n <= k) return null;
    const s = new Float64Array(k);
    s[0] = 1;
    for (let j = 1; j < k; j++) {
      const c = cols[j - 1];
      let acc = 0;
      for (let i = lo; i <= hi; i++) acc += c[i] * c[i];
      s[j] = Math.sqrt(acc / n) || 1;
    }
    const A = Array.from({ length: k }, () => new Float64Array(k));
    const b = new Float64Array(k);
    const z = new Float64Array(k);
    for (let i = lo; i <= hi; i++) {
      z[0] = 1;
      for (let j = 1; j < k; j++) z[j] = cols[j - 1][i] / s[j];
      for (let p = 0; p < k; p++) {
        b[p] += z[p] * y[i];
        for (let q = 0; q <= p; q++) A[p][q] += z[p] * z[q];
      }
    }
    for (let p = 0; p < k; p++) for (let q = 0; q < p; q++) A[q][p] = A[p][q];
    const Ainv = invert(A);
    if (!Ainv) return null;
    return matVec(Ainv, b).map((v, j) => v / s[j]);
  }

  /** Two-sided p-value from a t statistic (normal approximation). */
  function pValue(t) {
    if (!isNum(t)) return NaN;
    return 2 * (1 - normCdf(Math.abs(t)));
  }

  function normCdf(x) {
    // Abramowitz-Stegun 7.1.26 via erf
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }

  /**
   * Rolling OLS over a fixed number of observations (plain OLS errors).
   * prepare(slice) may transform the columns of each window (e.g. to
   * orthogonalise a factor within the window) and must return {y, cols}.
   */
  function rollingOLS(y, cols, window, opts = {}) {
    const n = y.length;
    const out = { end: [], coef: [], se: [], r2: [] };
    const step = opts.step || 1;
    for (let e = window - 1; e < n; e += step) {
      const lo = e - window + 1;
      let ys = y.slice(lo, e + 1);
      let cs = cols.map((c) => c.slice(lo, e + 1));
      if (opts.prepare) {
        const prepared = opts.prepare(ys, cs);
        ys = prepared.y;
        cs = prepared.cols;
      }
      const fit = ols(ys, cs);
      if (!fit) continue;
      out.end.push(e);
      out.coef.push(fit.coef);
      out.se.push(fit.se);
      out.r2.push(fit.r2);
    }
    return out;
  }

  // ------------------------------------------------------------------ risk & scenarios
  /** Sample covariance matrix of the given columns. */
  function covMatrix(cols) {
    return cols.map((a) => cols.map((b) => covariance(a, b)));
  }

  /**
   * Euler decomposition of variance: beta' F beta + specific.
   * Contributions sum to total variance; shares can be negative.
   */
  function riskDecomposition(betas, F, specificVar) {
    const Fb = matVec(F, betas);
    const contrib = betas.map((b, i) => b * Fb[i]);
    const systematic = contrib.reduce((a, b) => a + b, 0);
    const total = systematic + specificVar;
    return {
      total,
      systematic,
      specific: specificVar,
      contrib,
      share: contrib.map((c) => c / total),
      specificShare: specificVar / total,
    };
  }

  /**
   * Conditional expectation of all factors given shocks to some of them,
   * assuming joint normality: x_u = S_us S_ss^-1 x_s. Shocked factors keep
   * their value. `given` maps factor index -> shock.
   */
  function conditionalShocks(F, given) {
    const k = F.length;
    const s = Object.keys(given).map(Number);
    const x = new Array(k).fill(0);
    if (!s.length) return x;
    const Sss = s.map((i) => s.map((j) => F[i][j]));
    const inv = invert(Sss);
    const xs = s.map((i) => given[i]);
    const w = inv ? matVec(inv, xs) : null;
    for (let u = 0; u < k; u++) {
      if (s.includes(u)) {
        x[u] = given[u];
      } else if (w) {
        x[u] = s.reduce((acc, i, a) => acc + F[u][i] * w[a], 0);
      }
    }
    return x;
  }

  /**
   * Carino linking: scale per-period contributions so they add up to the
   * compounded return. contributions[t][j] must sum over j to returns[t].
   */
  function carino(returns, contributions) {
    const T = returns.length;
    const m = T ? contributions[0].length : 0;
    let growth = 1;
    for (let t = 0; t < T; t++) growth *= 1 + returns[t];
    const R = growth - 1;
    const K = Math.abs(R) > 1e-12 ? Math.log(1 + R) / R : 1;
    const linked = new Array(m).fill(0);
    for (let t = 0; t < T; t++) {
      const r = returns[t];
      const kt = Math.abs(r) > 1e-12 ? Math.log(1 + r) / r : 1;
      for (let j = 0; j < m; j++) linked[j] += (kt / K) * contributions[t][j];
    }
    return { total: R, linked };
  }

  /** Running Carino-linked contributions for each prefix of the period. */
  function carinoPath(returns, contributions) {
    const T = returns.length;
    const m = T ? contributions[0].length : 0;
    const acc = new Array(m).fill(0);
    let growth = 1;
    const path = [];
    for (let t = 0; t < T; t++) {
      const r = returns[t];
      const kt = Math.abs(r) > 1e-12 ? Math.log(1 + r) / r : 1;
      for (let j = 0; j < m; j++) acc[j] += kt * contributions[t][j];
      growth *= 1 + r;
      const R = growth - 1;
      const K = Math.abs(R) > 1e-12 ? Math.log(1 + R) / R : 1;
      path.push({ total: R, linked: acc.map((a) => a / K) });
    }
    return path;
  }

  // ------------------------------------------------------------------ volatility forecasts
  /**
   * GARCH(1,1) with variance targeting (long-run variance = sample variance),
   * fitted by Gaussian maximum likelihood on a grid refined twice.
   * returns: daily returns. Null with fewer than 250 observations.
   */
  function garch11(returns) {
    const r = finite(returns);
    const n = r.length;
    if (n < 250) return null;
    const m = mean(r);
    const e = r.map((v) => v - m);
    const lrVar = variance(e, 0);
    if (!(lrVar > 0)) return null;
    const loglik = (a, b) => {
      const w = lrVar * (1 - a - b);
      let h = lrVar;
      let s = 0;
      for (let t = 0; t < n; t++) {
        if (t > 0) h = w + a * e[t - 1] * e[t - 1] + b * h;
        s += Math.log(h) + (e[t] * e[t]) / h;
      }
      return -0.5 * s;
    };
    let best = { a: 0.05, b: 0.9, ll: -Infinity };
    const search = (a0, a1, da, b0, b1, db) => {
      for (let a = Math.max(a0, 0.001); a <= a1 + 1e-12; a += da) {
        for (let b = Math.max(b0, 0); b <= b1 + 1e-12; b += db) {
          if (a + b >= 0.999) continue;
          const v = loglik(a, b);
          if (v > best.ll) best = { a, b, ll: v };
        }
      }
    };
    search(0.01, 0.3, 0.01, 0.5, 0.98, 0.02);
    search(best.a - 0.01, best.a + 0.01, 0.002, best.b - 0.02, best.b + 0.02, 0.004);
    search(best.a - 0.002, best.a + 0.002, 0.0005, best.b - 0.004, best.b + 0.004, 0.001);
    const { a: alpha, b: beta } = best;
    const omega = lrVar * (1 - alpha - beta);
    const condVar = new Float64Array(n);
    let h = lrVar;
    for (let t = 0; t < n; t++) {
      if (t > 0) h = omega + alpha * e[t - 1] * e[t - 1] + beta * h;
      condVar[t] = h;
    }
    const nextVar = omega + alpha * e[n - 1] * e[n - 1] + beta * condVar[n - 1];
    const persistence = alpha + beta;
    return {
      alpha,
      beta,
      omega,
      persistence,
      lrVar,
      nextVar,
      halfLife: persistence > 0 && persistence < 1 ? Math.log(0.5) / Math.log(persistence) : NaN,
      logLik: best.ll,
      condVar,
      n,
    };
  }

  /** Expected daily variance h trading days ahead (h = 1 is the next day). */
  function garchVarAt(g, h) {
    return g.lrVar + Math.pow(g.persistence, h - 1) * (g.nextVar - g.lrVar);
  }

  /** Expected variance of the cumulative return over the next h trading days. */
  function garchCumVar(g, h) {
    if (!(h > 0)) return 0;
    const p = g.persistence;
    const decay = Math.abs(1 - p) < 1e-12 ? h : (1 - Math.pow(p, h)) / (1 - p);
    return h * g.lrVar + (g.nextVar - g.lrVar) * decay;
  }

  // ------------------------------------------------------------------ technicals
  function sma(values, n) {
    const out = new Float64Array(values.length).fill(NaN);
    let s = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) {
        s = 0;
        count = 0;
        continue;
      }
      s += v;
      count++;
      if (count > n) {
        s -= values[i - n];
        count = n;
      }
      if (count === n) out[i] = s / n;
    }
    return out;
  }

  /** Wilder's RSI on a price series. */
  function rsi(values, n = 14) {
    const out = new Float64Array(values.length).fill(NaN);
    let avgGain = 0;
    let avgLoss = 0;
    let seen = 0;
    for (let i = 1; i < values.length; i++) {
      if (!isNum(values[i]) || !isNum(values[i - 1])) continue;
      const ch = values[i] - values[i - 1];
      const gain = Math.max(ch, 0);
      const loss = Math.max(-ch, 0);
      seen++;
      if (seen <= n) {
        avgGain += gain / n;
        avgLoss += loss / n;
        if (seen < n) continue;
      } else {
        avgGain = (avgGain * (n - 1) + gain) / n;
        avgLoss = (avgLoss * (n - 1) + loss) / n;
      }
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  /** Drawdown from the running peak for each point, and the maximum drawdown. */
  function drawdowns(levels) {
    const dd = new Float64Array(levels.length).fill(NaN);
    let peak = -Infinity;
    let worst = 0;
    for (let i = 0; i < levels.length; i++) {
      const v = levels[i];
      if (!isNum(v)) continue;
      peak = Math.max(peak, v);
      dd[i] = v / peak - 1;
      worst = Math.min(worst, dd[i]);
    }
    return { series: dd, max: worst };
  }

  // ------------------------------------------------------------------ cross-section
  /** z-scores after winsorising at the given quantiles; NaN stays NaN. */
  function zscores(values, lo = 0.05, hi = 0.95) {
    const qlo = quantile(values, lo);
    const qhi = quantile(values, hi);
    const clipped = values.map((v) => (isNum(v) ? Math.min(Math.max(v, qlo), qhi) : NaN));
    const m = mean(clipped);
    const s = std(clipped);
    return clipped.map((v) => (isNum(v) && s > 0 ? (v - m) / s : NaN));
  }

  /** Ranks 1..n with ties sharing their average rank; NaN stays NaN. */
  function ranks(values) {
    const idx = [];
    for (let i = 0; i < values.length; i++) if (isNum(values[i])) idx.push(i);
    idx.sort((a, b) => values[a] - values[b]);
    const out = new Array(values.length).fill(NaN);
    for (let s = 0; s < idx.length; ) {
      let e = s;
      while (e + 1 < idx.length && values[idx[e + 1]] === values[idx[s]]) e++;
      const avg = (s + e) / 2 + 1;
      for (let k = s; k <= e; k++) out[idx[k]] = avg;
      s = e + 1;
    }
    return out;
  }

  /** Spearman rank correlation over pairs where both values are finite. */
  function spearman(a, b) {
    const x = [];
    const y = [];
    for (let i = 0; i < a.length; i++) {
      if (isNum(a[i]) && isNum(b[i])) {
        x.push(a[i]);
        y.push(b[i]);
      }
    }
    return x.length < 3 ? NaN : correlation(ranks(x), ranks(y));
  }

  /** Rank (1 = highest) of `value` among `values`; returns {rank, of}. */
  function rankOf(values, value, descending = true) {
    const v = finite(values);
    if (!isNum(value)) return { rank: NaN, of: v.length };
    const better = v.filter((x) => (descending ? x > value : x < value)).length;
    return { rank: better + 1, of: v.length };
  }

  /** Simple least-squares line through (x, y) pairs. */
  function fitLine(xs, ys) {
    const xv = [];
    const yv = [];
    for (let i = 0; i < xs.length; i++) {
      if (isNum(xs[i]) && isNum(ys[i])) {
        xv.push(xs[i]);
        yv.push(ys[i]);
      }
    }
    if (xv.length < 3) return null;
    const fit = ols(yv, [xv]);
    if (!fit) return null;
    return { intercept: fit.coef[0], slope: fit.coef[1], r2: fit.r2, n: xv.length };
  }

  return {
    isNum,
    ffill,
    finite,
    sum,
    mean,
    variance,
    std,
    covariance,
    correlation,
    quantile,
    median,
    invert,
    matVec,
    nwLags,
    ols,
    olsCoef,
    pValue,
    normCdf,
    rollingOLS,
    covMatrix,
    riskDecomposition,
    conditionalShocks,
    carino,
    carinoPath,
    garch11,
    garchVarAt,
    garchCumVar,
    sma,
    rsi,
    drawdowns,
    zscores,
    ranks,
    spearman,
    rankOf,
    fitLine,
  };
});
