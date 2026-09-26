/*
 * Property Factor Lens - factor model layer.
 * Builds return panels from the data file and runs the analytics in FA.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./analytics.js"));
  else root.PFModel = factory(root.FA);
})(typeof self !== "undefined" ? self : this, function (FA) {
  "use strict";

  const { isNum } = FA;
  const FFILL_LIMIT = 7;
  const PERIODS_PER_YEAR = { D: 252, W: 52, M: 12 };
  const ROLLING_WINDOW = { D: 126, W: 52, M: 36 };
  const MIN_OBS = { D: 120, W: 40, M: 24 };
  const FREQ_LABEL = { D: "daily", W: "weekly", M: "monthly" };

  // ------------------------------------------------------------------ factor catalogue
  const FACTORS = [
    { id: "MKT", label: "European equity market", short: "Market", group: "Market", kind: "asset", series: "MKT", convert: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "STOXX Europe 600 total return (iShares ETF, dividend-adjusted), in the stock's currency." },
    { id: "SECTOR", label: "Real estate sector (ex-market)", short: "RE sector", group: "Market", kind: "sector", convert: true, orth: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "Cap-weighted return of the other 54 coverage stocks, orthogonalised to the market within the estimation window." },
    { id: "RATES", label: "Home 10Y government yield", short: "Home 10Y", group: "Rates", kind: "rate", series: "local", unit: "bp", shock: 10, shockLabel: "+10bp", desc: "Change in the 10-year government yield of the stock's home market (EUR AAA curve for euro-area stocks)." },
    { id: "EUR10Y", label: "EUR 10Y yield", short: "EUR 10Y", group: "Rates", kind: "rate", series: "EUR10Y", unit: "bp", shock: 10, shockLabel: "+10bp", desc: "Change in the 10-year point of the ECB euro area AAA government curve." },
    { id: "EUR2Y", label: "EUR 2Y yield", short: "EUR 2Y", group: "Rates", kind: "rate", series: "EUR2Y", unit: "bp", shock: 10, shockLabel: "+10bp", desc: "Change in the 2-year point of the ECB euro area AAA government curve." },
    { id: "CURVE", label: "EUR 2s10s curve", short: "2s10s", group: "Rates", kind: "spread", series: ["EUR10Y", "EUR2Y"], unit: "bp", shock: 10, shockLabel: "+10bp steeper", desc: "Change in the 10Y minus 2Y spread of the ECB AAA curve." },
    { id: "CREDIT", label: "EUR high-yield spread", short: "HY spread", group: "Credit", kind: "rate", series: "EUR_HY_OAS", unit: "bp", shock: 25, shockLabel: "+25bp", desc: "Change in the ICE BofA Euro High Yield option-adjusted spread." },
    { id: "FXL", label: "Home currency vs EUR", short: "FX vs EUR", group: "FX", kind: "fxlocal", unit: "%", shock: 0.01, shockLabel: "+1% home ccy", desc: "Return of the stock's home currency against the euro (non-euro stocks only)." },
    { id: "EURUSD", label: "EUR/USD", short: "EUR/USD", group: "FX", kind: "asset", series: "FX_USD", unit: "%", shock: 0.01, shockLabel: "+1% EUR", desc: "Return of the euro against the US dollar." },
    { id: "OIL", label: "Brent crude oil", short: "Oil", group: "Macro", kind: "asset", series: "BRENT", unit: "%", shock: 0.1, shockLabel: "+10%", desc: "Return of the front-month Brent future (USD)." },
    { id: "VOL", label: "Equity volatility index", short: "Volatility", group: "Macro", kind: "level", series: "VOL", unit: "pts", shock: 5, shockLabel: "+5 pts", desc: "Change in VSTOXX (or VIX when VSTOXX is unavailable), in index points." },
    { id: "SMB", label: "Size (small minus big)", short: "Size", group: "Style: Fama-French", kind: "ls", series: "FF_SMB", unit: "%", shock: 0.01, shockLabel: "+1%", desc: "European small-cap minus large-cap portfolio return (Kenneth French library)." },
    { id: "HML", label: "Value (high minus low B/M)", short: "Value", group: "Style: Fama-French", kind: "ls", series: "FF_HML", unit: "%", shock: 0.01, shockLabel: "+1%", desc: "European value minus growth portfolio return (Kenneth French library)." },
    { id: "RMW", label: "Profitability (robust minus weak)", short: "Profitability", group: "Style: Fama-French", kind: "ls", series: "FF_RMW", unit: "%", shock: 0.01, shockLabel: "+1%", desc: "European high minus low operating profitability (Kenneth French library)." },
    { id: "CMA", label: "Investment (conservative minus aggressive)", short: "Investment", group: "Style: Fama-French", kind: "ls", series: "FF_CMA", unit: "%", shock: 0.01, shockLabel: "+1%", desc: "European low minus high asset growth (Kenneth French library)." },
    { id: "WML", label: "Momentum (winners minus losers)", short: "Momentum", group: "Style: Fama-French", kind: "ls", series: "FF_WML", unit: "%", shock: 0.01, shockLabel: "+1%", desc: "European 12-1 month winners minus losers (Kenneth French library)." },
    { id: "E_VAL", label: "Value ETF vs market", short: "Value (ETF)", group: "Style: MSCI ETFs", kind: "active", series: "ETF_VALUE", orth: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "MSCI Europe Value factor ETF minus the market, orthogonalised to the market." },
    { id: "E_MOM", label: "Momentum ETF vs market", short: "Momentum (ETF)", group: "Style: MSCI ETFs", kind: "active", series: "ETF_MOM", orth: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "MSCI Europe Momentum factor ETF minus the market, orthogonalised to the market." },
    { id: "E_QUAL", label: "Quality ETF vs market", short: "Quality (ETF)", group: "Style: MSCI ETFs", kind: "active", series: "ETF_QUAL", orth: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "MSCI Europe Quality factor ETF minus the market, orthogonalised to the market." },
    { id: "E_MINV", label: "Min volatility ETF vs market", short: "Min vol (ETF)", group: "Style: MSCI ETFs", kind: "active", series: "ETF_MINVOL", orth: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "MSCI Europe Minimum Volatility ETF minus the market, orthogonalised to the market." },
    { id: "E_SIZE", label: "Mid-cap ETF vs market", short: "Size (ETF)", group: "Style: MSCI ETFs", kind: "active", series: "ETF_SIZE", orth: true, unit: "%", shock: 0.01, shockLabel: "+1%", desc: "MSCI Europe Mid-Cap Equal Weight ETF minus the market, orthogonalised to the market." },
  ];
  const FACTOR_BY_ID = Object.fromEntries(FACTORS.map((f) => [f.id, f]));

  const PRESETS = {
    full: { label: "Macro + style", factors: ["MKT", "SECTOR", "RATES", "CREDIT", "SMB", "HML", "WML"] },
    macro: { label: "Real estate macro", factors: ["MKT", "RATES", "CREDIT", "FXL"] },
    ffc: { label: "Fama-French-Carhart", factors: ["MKT", "SMB", "HML", "RMW", "CMA", "WML"] },
    etf: { label: "MSCI style ETFs", factors: ["MKT", "SECTOR", "E_VAL", "E_MOM", "E_QUAL", "E_MINV"] },
    capm: { label: "Market only", factors: ["MKT"] },
  };
  const MACRO_SPEC = ["MKT", "RATES", "CREDIT", "FXL"];
  const STYLE_SPEC = ["MKT", "SECTOR", "SMB", "HML", "RMW", "CMA", "WML"];
  const MACRO_DRIVERS = ["RATES", "EUR10Y", "EUR2Y", "CURVE", "CREDIT", "FXL", "EURUSD", "OIL", "VOL"];

  const EPISODES = [
    { id: "covid", label: "COVID crash", start: "2020-02-19", end: "2020-03-18" },
    { id: "vaccine", label: "Vaccine rally", start: "2020-11-06", end: "2020-11-11" },
    { id: "rates22", label: "2022 rate shock", start: "2021-12-31", end: "2022-10-12" },
    { id: "gilts22", label: "UK mini-budget", start: "2022-09-22", end: "2022-09-27" },
    { id: "banks23", label: "Bank stress (SVB, Credit Suisse)", start: "2023-03-08", end: "2023-03-17" },
    { id: "rally23", label: "Late-2023 rates rally", start: "2023-10-27", end: "2023-12-27" },
    { id: "fiscal25", label: "German fiscal package", start: "2025-03-04", end: "2025-03-06" },
    { id: "tariffs25", label: "US tariff shock", start: "2025-04-02", end: "2025-04-07" },
  ];

  // ------------------------------------------------------------------ dates
  const DAY_MS = 86400000;
  const epochDay = (d) => Math.floor(Date.parse(d + "T00:00:00Z") / DAY_MS);

  /** Index of the last date <= d (or -1). Dates are sorted ISO strings. */
  function indexOnOrBefore(dates, d) {
    let lo = 0;
    let hi = dates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= d) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function shiftYears(d, years) {
    const dt = new Date(d + "T00:00:00Z");
    const months = Math.round(years * 12);
    dt.setUTCMonth(dt.getUTCMonth() - months);
    return dt.toISOString().slice(0, 10);
  }

  function shiftDays(d, days) {
    return new Date(Date.parse(d + "T00:00:00Z") - days * DAY_MS).toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------------ preparation
  function prepare(data) {
    const dates = data.dates;
    const n = dates.length;
    const series = {};
    for (const [id, s] of Object.entries(data.series || {})) series[id] = FA.ffill(s.values, FFILL_LIMIT);
    const fxByCcy = { USD: series.FX_USD, GBP: series.FX_GBP, SEK: series.FX_SEK, CHF: series.FX_CHF, NOK: series.FX_NOK };
    const localRate = (data.meta && data.meta.local_rate_by_country) || {};
    const dayNum = dates.map(epochDay);
    const weekEnd = new Uint8Array(n);
    const monthEnd = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
      const last = t === n - 1;
      weekEnd[t] = last || Math.floor((dayNum[t] + 3) / 7) !== Math.floor((dayNum[t + 1] + 3) / 7) ? 1 : 0;
      monthEnd[t] = last || dates[t].slice(0, 7) !== dates[t + 1].slice(0, 7) ? 1 : 0;
    }

    const stocks = data.stocks.map((s, i) => {
      const tri = FA.ffill(s.tri, FFILL_LIMIT);
      const px = FA.ffill(s.px, FFILL_LIMIT);
      const obs = new Uint8Array(n);
      for (let t = 0; t < n; t++) obs[t] = isNum(s.tri[t]) ? 1 : 0;
      const fx = s.currency === "EUR" ? null : fxByCcy[s.currency] || null;
      const triEur = fx ? tri.map((v, t) => v / fx[t]) : tri;
      const pxEur = fx ? px.map((v, t) => v / fx[t]) : px;
      const rateSeries = localRate[s.country] && series[localRate[s.country]] ? localRate[s.country] : "EUR10Y";
      const first = obs.indexOf(1);
      const last = obs.lastIndexOf(1);
      return { i, id: s.id, meta: s, fund: s.fund || {}, tri, px, obs, fx, triEur, pxEur, rateSeries, first, last };
    });

    // Cap weights for the sector index: current share count times price.
    const lastPx = (st) => (st.last >= 0 ? st.pxEur[st.last] : NaN);
    const shares = stocks.map((st) => {
      if (isNum(st.fund.shares) && st.fund.shares > 0) return st.fund.shares;
      if (isNum(st.fund.market_cap_eur) && isNum(lastPx(st))) return st.fund.market_cap_eur / lastPx(st);
      return NaN;
    });
    const caps = stocks.map((st, i) => (isNum(shares[i]) ? shares[i] * lastPx(st) : NaN));
    const medianCap = FA.median(caps);
    stocks.forEach((st, i) => {
      st.shares = isNum(shares[i]) ? shares[i] : isNum(lastPx(st)) ? medianCap / lastPx(st) : NaN;
      st.rEur = new Float64Array(n).fill(NaN);
      st.capPrev = new Float64Array(n).fill(NaN);
      for (let t = 1; t < n; t++) {
        if (!st.obs[t]) continue;
        const r = st.triEur[t] / st.triEur[t - 1] - 1;
        const c = st.shares * st.pxEur[t - 1];
        if (isNum(r) && isNum(c) && c > 0) {
          st.rEur[t] = r;
          st.capPrev[t] = c;
        }
      }
    });

    const subsectors = (data.meta && data.meta.subsectors) || [...new Set(stocks.map((s) => s.meta.subsector))];
    const agg = (members) => {
      const S = new Float64Array(n);
      const W = new Float64Array(n);
      for (const st of members) {
        for (let t = 1; t < n; t++) {
          if (isNum(st.rEur[t])) {
            S[t] += st.capPrev[t] * st.rEur[t];
            W[t] += st.capPrev[t];
          }
        }
      }
      return { S, W };
    };
    const totals = { all: agg(stocks) };
    for (const ss of subsectors) totals[ss] = agg(stocks.filter((s) => s.meta.subsector === ss));

    return {
      data,
      dates,
      n,
      dayNum,
      weekEnd,
      monthEnd,
      series,
      seriesMeta: data.series || {},
      stocks,
      byId: Object.fromEntries(stocks.map((s) => [s.id, s])),
      subsectors,
      totals,
      asOfIndex: n - 1,
      cache: new Map(),
    };
  }

  /** Cap-weighted EUR index of coverage stocks excluding `st` (scope: "all" or a sub-sector). */
  function peerIndex(ctx, st, scope = "all") {
    const key = `peer:${scope}:${st.i}`;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    const tot = ctx.totals[scope === "all" ? "all" : st.meta.subsector];
    const n = ctx.n;
    const level = new Float64Array(n);
    level[0] = 100;
    for (let t = 1; t < n; t++) {
      let S = tot.S[t];
      let W = tot.W[t];
      if (isNum(st.rEur[t])) {
        S -= st.capPrev[t] * st.rEur[t];
        W -= st.capPrev[t];
      }
      const r = W > 1e-9 ? S / W : 0;
      level[t] = level[t - 1] * (1 + r);
    }
    ctx.cache.set(key, level);
    return level;
  }

  // ------------------------------------------------------------------ factor levels
  function applicable(ctx, st, f) {
    switch (f.kind) {
      case "fxlocal":
        return st.fx ? true : "not applicable: euro-denominated stock";
      case "sector":
        return ctx.stocks.length > 2 ? true : "needs at least three stocks";
      case "rate": {
        const sid = f.series === "local" ? st.rateSeries : f.series;
        return ctx.series[sid] ? true : `${sid} data unavailable`;
      }
      case "spread":
        return f.series.every((s) => ctx.series[s]) ? true : "yield data unavailable";
      case "active":
        return ctx.series[f.series] && ctx.series.MKT ? true : `${f.series} data unavailable`;
      default:
        return ctx.series[f.series] ? true : `${f.series} data unavailable`;
    }
  }

  /** Returns a function (a, b) -> factor value over the interval (a, b]. */
  function factorFn(ctx, st, f, ccy) {
    const toLocal = ccy === "local" && f.convert && st.fx;
    const ratio = (L) => (a, b) => L[b] / L[a] - 1;
    switch (f.kind) {
      case "asset": {
        let L = ctx.series[f.series];
        if (toLocal) L = L.map((v, t) => v * st.fx[t]);
        return ratio(L);
      }
      case "sector": {
        let L = peerIndex(ctx, st, "all");
        if (toLocal) L = L.map((v, t) => v * st.fx[t]);
        return ratio(L);
      }
      case "ls":
        return ratio(ctx.series[f.series]);
      case "active": {
        const E = ctx.series[f.series];
        const M = ctx.series.MKT;
        return (a, b) => E[b] / E[a] - M[b] / M[a];
      }
      case "rate": {
        const R = ctx.series[f.series === "local" ? st.rateSeries : f.series];
        return (a, b) => (R[b] - R[a]) * 100;
      }
      case "spread": {
        const A = ctx.series[f.series[0]];
        const B = ctx.series[f.series[1]];
        return (a, b) => (A[b] - B[b] - (A[a] - B[a])) * 100;
      }
      case "fxlocal":
        return (a, b) => st.fx[a] / st.fx[b] - 1;
      case "level": {
        const V = ctx.series[f.series];
        return (a, b) => V[b] - V[a];
      }
      default:
        throw new Error(`unknown factor kind ${f.kind}`);
    }
  }

  function stockLevels(st, ccy) {
    return ccy === "EUR" ? st.triEur : st.tri;
  }

  // ------------------------------------------------------------------ panels
  /** Sampling points (indices) in [startIdx, endIdx]; the first element is the base. */
  function samplePoints(ctx, st, freq, startIdx, endIdx) {
    const pts = [];
    if (freq === "D") {
      let base = -1;
      for (let t = startIdx; t >= 0; t--) {
        if (st.obs[t]) {
          base = t;
          break;
        }
      }
      if (base >= 0) pts.push(base);
      for (let t = startIdx + 1; t <= endIdx; t++) if (st.obs[t]) pts.push(t);
      return pts;
    }
    const isEnd = freq === "M" ? ctx.monthEnd : ctx.weekEnd;
    let base = -1;
    for (let t = startIdx - 1; t >= 0; t--) {
      if (isEnd[t]) {
        base = t;
        break;
      }
    }
    if (base >= 0) pts.push(base);
    for (let t = Math.max(startIdx, 0); t <= endIdx; t++) if (isEnd[t]) pts.push(t);
    return pts;
  }

  function windowStart(ctx, endIdx, years) {
    if (!years || years === "max") return 0;
    const d = shiftYears(ctx.dates[endIdx], years);
    return Math.max(0, indexOnOrBefore(ctx.dates, d));
  }

  /**
   * Aligned regression panel for one stock.
   * opts: {freq, years | startIdx, endIdx, ccy}
   */
  function buildPanel(ctx, st, factorIds, opts) {
    const freq = opts.freq || "W";
    const ccy = opts.ccy || "local";
    const endIdx = opts.endIdx == null ? ctx.asOfIndex : opts.endIdx;
    const startIdx = opts.startIdx == null ? windowStart(ctx, endIdx, opts.years) : opts.startIdx;
    const dropped = [];
    const factors = [];
    for (const id of factorIds) {
      const f = FACTOR_BY_ID[id];
      if (!f) continue;
      const ok = applicable(ctx, st, f);
      if (ok === true) factors.push(f);
      else dropped.push({ id, reason: ok });
    }
    const fns = factors.map((f) => factorFn(ctx, st, f, ccy));
    const Y = stockLevels(st, ccy);
    const pts = samplePoints(ctx, st, freq, startIdx, endIdx);
    const rows = [];
    const y = [];
    const cols = factors.map(() => []);
    const coverage = factors.map(() => 0);
    for (let p = 1; p < pts.length; p++) {
      const a = pts[p - 1];
      const b = pts[p];
      const r = Y[b] / Y[a] - 1;
      if (!isNum(r)) continue;
      let ok = true;
      const vals = new Array(fns.length);
      for (let j = 0; j < fns.length; j++) {
        const v = fns[j](a, b);
        if (isNum(v)) coverage[j]++;
        else ok = false;
        vals[j] = v;
      }
      if (!ok) continue;
      rows.push(b);
      y.push(r);
      for (let j = 0; j < vals.length; j++) cols[j].push(vals[j]);
    }
    // Drop factors that do not vary (e.g. a pegged currency) to keep X'X invertible.
    for (let j = factors.length - 1; j >= 0; j--) {
      const v = FA.variance(cols[j]);
      if (!(v > 1e-14)) {
        dropped.push({ id: factors[j].id, reason: "no variation in the window" });
        factors.splice(j, 1);
        cols.splice(j, 1);
      }
    }
    // Orthogonalise flagged factors to the market inside the window.
    const gammas = {};
    const mktIdx = factors.findIndex((f) => f.id === "MKT");
    if (mktIdx >= 0) {
      const m = cols[mktIdx];
      const vm = FA.variance(m);
      factors.forEach((f, j) => {
        if (!f.orth || j === mktIdx) return;
        const g = vm > 0 ? FA.covariance(cols[j], m) / vm : 0;
        gammas[f.id] = g;
        cols[j] = cols[j].map((v, i) => v - g * m[i]);
      });
    }
    return { st, freq, ccy, startIdx, endIdx, factors, cols, y, rows, dropped, gammas, pointsAvailable: pts.length - 1 };
  }

  // ------------------------------------------------------------------ model fits
  function fitModel(ctx, st, factorIds, opts = {}) {
    const panel = buildPanel(ctx, st, factorIds, opts);
    const freq = panel.freq;
    const base = {
      ok: false,
      stock: st.id,
      freq,
      ccy: panel.ccy,
      factors: panel.factors.map((f) => f.id),
      dropped: panel.dropped,
      n: panel.y.length,
    };
    if (panel.y.length < Math.max(MIN_OBS[freq] * (opts.minObsScale || 1), panel.factors.length + 5)) {
      base.error = `Only ${panel.y.length} overlapping ${FREQ_LABEL[freq]} observations`;
      return base;
    }
    const fit = FA.ols(panel.y, panel.cols, { hac: opts.hac !== false });
    if (!fit) {
      base.error = "The factors are collinear in this window";
      return base;
    }
    const ppy = PERIODS_PER_YEAR[freq];
    const ids = base.factors;
    const betas = {};
    const se = {};
    const tstat = {};
    ids.forEach((id, j) => {
      betas[id] = fit.coef[j + 1];
      se[id] = fit.se[j + 1];
      tstat[id] = fit.t[j + 1];
    });
    const F = FA.covMatrix(panel.cols);
    const factorStd = {};
    const factorMean = {};
    ids.forEach((id, j) => {
      factorStd[id] = Math.sqrt(F[j][j]);
      factorMean[id] = FA.mean(panel.cols[j]);
    });
    const specificVar = FA.variance(fit.resid, 1) * (fit.n - 1) / Math.max(fit.n - fit.k, 1);
    const risk = FA.riskDecomposition(ids.map((id) => betas[id]), F, specificVar);
    const totalVar = FA.variance(panel.y);
    return Object.assign(base, {
      ok: true,
      start: ctx.dates[panel.rows[0]],
      end: ctx.dates[panel.rows[panel.rows.length - 1]],
      alpha: fit.coef[0],
      alphaT: fit.t[0],
      alphaAnn: fit.coef[0] * ppy,
      betas,
      se,
      t: tstat,
      r2: fit.r2,
      adjR2: fit.adjR2,
      lags: fit.lags,
      factorCov: F,
      factorStd,
      factorMean,
      gammas: panel.gammas,
      risk,
      volAnn: Math.sqrt(totalVar * ppy),
      specificVolAnn: Math.sqrt(specificVar * ppy),
      systematicVolAnn: Math.sqrt(Math.max(risk.systematic, 0) * ppy),
      ppy,
      rows: panel.rows,
      resid: fit.resid,
      y: panel.y,
      cols: panel.cols,
    });
  }

  function fitUniverse(ctx, factorIds, opts) {
    return ctx.stocks.map((st) => {
      const fit = fitModel(ctx, st, factorIds, opts);
      if (!opts.keepSeries) {
        delete fit.cols;
        delete fit.y;
      }
      return fit;
    });
  }

  /** Rolling betas over the full history, re-orthogonalising inside each window. */
  function rollingFit(ctx, st, factorIds, opts) {
    const freq = opts.freq || "W";
    const panel = buildPanel(ctx, st, factorIds, { freq, ccy: opts.ccy, startIdx: 0, endIdx: ctx.asOfIndex });
    const window = opts.window || ROLLING_WINDOW[freq];
    // buildPanel orthogonalised over the whole history; undo so each window can redo it.
    const raw = panel.cols.map((c, j) => {
      const g = panel.gammas[panel.factors[j].id];
      if (g == null) return c;
      const m = panel.cols[panel.factors.findIndex((f) => f.id === "MKT")];
      return c.map((v, i) => v + g * m[i]);
    });
    const mktIdx = panel.factors.findIndex((f) => f.id === "MKT");
    const orthIdx = panel.factors.map((f, j) => (f.orth && mktIdx >= 0 && j !== mktIdx ? j : -1)).filter((j) => j >= 0);
    const prepare = (ys, cs) => {
      if (!orthIdx.length) return { y: ys, cols: cs };
      const m = cs[mktIdx];
      const vm = FA.variance(m);
      const out = cs.slice();
      for (const j of orthIdx) {
        const g = vm > 0 ? FA.covariance(cs[j], m) / vm : 0;
        out[j] = cs[j].map((v, i) => v - g * m[i]);
      }
      return { y: ys, cols: out };
    };
    if (panel.y.length < window + 2) return { ok: false, error: "Not enough history for a rolling window", factors: [] };
    const roll = FA.rollingOLS(panel.y, raw, window, { prepare, step: opts.step || 1 });
    const ids = panel.factors.map((f) => f.id);
    return {
      ok: true,
      window,
      freq,
      factors: ids,
      dates: roll.end.map((e) => ctx.dates[panel.rows[e]]),
      beta: Object.fromEntries(ids.map((id, j) => [id, roll.coef.map((c) => c[j + 1])])),
      se: Object.fromEntries(ids.map((id, j) => [id, roll.se.map((s) => s[j + 1])])),
      alpha: roll.coef.map((c) => c[0]),
      r2: roll.r2,
    };
  }

  // ------------------------------------------------------------------ macro sensitivities
  function macroSensitivities(ctx, st, opts) {
    const rows = [];
    const capm = fitModel(ctx, st, ["MKT"], opts);
    if (capm.ok) {
      rows.push({ id: "MKT", total: capm.betas.MKT, totalT: capm.t.MKT, r2: capm.r2, partial: null, partialT: null });
    }
    const sectorRaw = fitModel(ctx, st, ["SECTOR"], opts);
    if (sectorRaw.ok) {
      rows.push({ id: "SECTOR", total: sectorRaw.betas.SECTOR, totalT: sectorRaw.t.SECTOR, r2: sectorRaw.r2, partial: null, partialT: null });
    }
    for (const id of MACRO_DRIVERS) {
      const f = FACTOR_BY_ID[id];
      if (applicable(ctx, st, f) !== true) continue;
      const total = fitModel(ctx, st, [id], opts);
      const partial = fitModel(ctx, st, ["MKT", id], opts);
      if (!total.ok) continue;
      rows.push({
        id,
        total: total.betas[id],
        totalT: total.t[id],
        r2: total.r2,
        partial: partial.ok ? partial.betas[id] : null,
        partialT: partial.ok ? partial.t[id] : null,
        factorStd: total.factorStd[id],
      });
    }
    return rows.map((r) => {
      const f = FACTOR_BY_ID[r.id];
      return Object.assign(r, {
        label: f.label,
        short: f.short,
        shock: f.shock,
        shockLabel: f.shockLabel,
        unit: f.unit,
        totalImpact: r.total * f.shock,
        partialImpact: r.partial == null ? null : r.partial * f.shock,
      });
    });
  }

  // ------------------------------------------------------------------ scenarios
  /** shocks: {factorId: value in factor units}; conditional fills the rest from the covariance. */
  function scenario(fit, shocks, conditional) {
    if (!fit || !fit.ok) return null;
    const ids = fit.factors;
    const given = {};
    ids.forEach((id, j) => {
      if (shocks[id] != null && isNum(shocks[id])) given[j] = shocks[id];
    });
    const x = conditional ? FA.conditionalShocks(fit.factorCov, given) : ids.map((id, j) => (j in given ? given[j] : 0));
    const impacts = {};
    let total = 0;
    ids.forEach((id, j) => {
      impacts[id] = fit.betas[id] * x[j];
      total += impacts[id];
    });
    return { total, impacts, moves: Object.fromEntries(ids.map((id, j) => [id, x[j]])) };
  }

  /** Factor moves between two dates and the move implied by a fit's betas. */
  function episodeImpact(ctx, st, fit, episode, ccy) {
    const a = indexOnOrBefore(ctx.dates, episode.start);
    const b = indexOnOrBefore(ctx.dates, episode.end);
    if (a < 0 || b <= a || !fit || !fit.ok) return null;
    const Y = stockLevels(st, ccy);
    const actual = Y[b] / Y[a] - 1;
    const moves = {};
    let implied = 0;
    let complete = true;
    const mkt = fit.factors.includes("MKT") ? factorFn(ctx, st, FACTOR_BY_ID.MKT, ccy)(a, b) : NaN;
    for (const id of fit.factors) {
      let v = factorFn(ctx, st, FACTOR_BY_ID[id], ccy)(a, b);
      if (fit.gammas[id] != null && isNum(mkt)) v -= fit.gammas[id] * mkt;
      moves[id] = v;
      if (isNum(v)) implied += fit.betas[id] * v;
      else complete = false;
    }
    return { actual: isNum(actual) ? actual : null, implied, moves, complete, startDate: ctx.dates[a], endDate: ctx.dates[b] };
  }

  // ------------------------------------------------------------------ attribution
  /**
   * Daily return attribution between two date indices. Betas are re-estimated
   * at the start of each calendar month from the preceding estimation window,
   * so no information after a day is used to explain it.
   */
  function attribution(ctx, st, factorIds, opts, startIdx, endIdx) {
    const ccy = opts.ccy || "local";
    const Y = stockLevels(st, ccy);
    const days = [];
    let prev = -1;
    for (let t = startIdx; t >= 0; t--) {
      if (st.obs[t]) {
        prev = t;
        break;
      }
    }
    if (prev < 0) return { ok: false, error: "No price history before the period" };
    for (let t = startIdx + 1; t <= endIdx; t++) {
      if (st.obs[t]) {
        days.push([prev, t]);
        prev = t;
      }
    }
    if (!days.length) return { ok: false, error: "No trading days in the period" };

    const fitCache = new Map();
    const fitFor = (t) => {
      const key = ctx.dates[t].slice(0, 7);
      if (!fitCache.has(key)) {
        let firstOfMonth = t;
        while (firstOfMonth > 0 && ctx.dates[firstOfMonth - 1].slice(0, 7) === key) firstOfMonth--;
        const est = fitModel(ctx, st, factorIds, { ...opts, endIdx: Math.max(firstOfMonth - 1, 0), hac: false });
        fitCache.set(key, est);
      }
      return fitCache.get(key);
    };

    const ids = factorIds.filter((id) => FACTOR_BY_ID[id] && applicable(ctx, st, FACTOR_BY_ID[id]) === true);
    const fns = Object.fromEntries(ids.map((id) => [id, factorFn(ctx, st, FACTOR_BY_ID[id], ccy)]));
    const mktFn = factorFn(ctx, st, FACTOR_BY_ID.MKT, ccy);
    const returns = [];
    const contribs = [];
    const dates = [];
    const missing = Object.fromEntries(ids.map((id) => [id, 0]));
    const betaSum = Object.fromEntries(ids.map((id) => [id, 0]));
    let usedDays = 0;
    let lastFit = null;
    for (const [a, b] of days) {
      const r = Y[b] / Y[a] - 1;
      if (!isNum(r)) continue;
      const fit = fitFor(b);
      if (!fit.ok) continue;
      lastFit = fit;
      const m = mktFn(a, b);
      const row = [];
      let explained = 0;
      for (const id of ids) {
        let c = 0;
        if (fit.betas[id] != null) {
          let v = fns[id](a, b);
          if (isNum(v) && fit.gammas[id] != null) v = isNum(m) ? v - fit.gammas[id] * m : NaN;
          if (isNum(v)) c = fit.betas[id] * v;
          else missing[id]++;
          betaSum[id] += fit.betas[id];
        }
        row.push(c);
        explained += c;
      }
      row.push(r - explained); // stock-specific, including alpha
      returns.push(r);
      contribs.push(row);
      dates.push(ctx.dates[b]);
      usedDays++;
    }
    if (!usedDays) {
      const err = fitFor(days[0][1]);
      return { ok: false, error: err.error || "Not enough history to estimate exposures before this period" };
    }
    const linked = FA.carino(returns, contribs);
    const path = FA.carinoPath(returns, contribs).map((p, i) => ({
      date: dates[i],
      total: p.total,
      factors: p.linked.slice(0, ids.length).reduce((a, b) => a + b, 0),
      specific: p.linked[ids.length],
    }));
    const moves = {};
    const a0 = days[0][0];
    const b0 = days[days.length - 1][1];
    for (const id of ids) moves[id] = fns[id](a0, b0);
    return {
      ok: true,
      factors: ids,
      start: ctx.dates[a0],
      end: ctx.dates[b0],
      days: usedDays,
      total: linked.total,
      contributions: Object.fromEntries(ids.map((id, j) => [id, linked.linked[j]])),
      specific: linked.linked[ids.length],
      avgBeta: Object.fromEntries(ids.map((id) => [id, betaSum[id] / usedDays])),
      moves,
      missing,
      path,
      lastFit,
    };
  }

  // ------------------------------------------------------------------ snapshots
  function periodReturn(L, a, b) {
    return a >= 0 && b > a ? L[b] / L[a] - 1 : NaN;
  }

  /** Price-based facts for one stock: returns, volatility, momentum, technicals. */
  function stockStats(ctx, st, ccy = "local") {
    const L = stockLevels(st, ccy);
    const end = st.last >= 0 ? st.last : ctx.asOfIndex;
    const d = ctx.dates[end];
    const at = (date) => indexOnOrBefore(ctx.dates, date);
    const ytdIdx = at(`${Number(d.slice(0, 4)) - 1}-12-31`);
    const horizons = {
      d1: end - 1,
      w1: at(shiftDays(d, 7)),
      m1: at(shiftYears(d, 1 / 12)),
      m3: at(shiftYears(d, 0.25)),
      m6: at(shiftYears(d, 0.5)),
      ytd: ytdIdx,
      y1: at(shiftYears(d, 1)),
      y3: at(shiftYears(d, 3)),
      y5: at(shiftYears(d, 5)),
    };
    const firstValid = (i) => (i >= st.first ? i : -1);
    const ret = {};
    for (const [k, i] of Object.entries(horizons)) ret[k] = periodReturn(L, firstValid(i), end);
    // Relative returns in EUR against peers (ex-stock) and the market.
    const cov = peerIndex(ctx, st, "all");
    const sub = peerIndex(ctx, st, "sub");
    const mkt = ctx.series.MKT;
    const rel = {};
    for (const [k, i] of Object.entries(horizons)) {
      const s = periodReturn(st.triEur, firstValid(i), end);
      rel[k] = {
        coverage: s - periodReturn(cov, i, end),
        subsector: s - periodReturn(sub, i, end),
        market: mkt ? s - periodReturn(mkt, i, end) : NaN,
      };
    }
    // Daily volatility over the last year and 12-1 momentum.
    const yStart = Math.max(horizons.y1, st.first);
    const daily = [];
    for (let t = yStart + 1; t <= end; t++) if (st.obs[t]) daily.push(L[t] / L[t - 1] - 1);
    const vol1y = FA.std(daily) * Math.sqrt(252);
    const m12 = firstValid(at(shiftYears(d, 1)));
    const m1 = at(shiftYears(d, 1 / 12));
    const mom12_1 = periodReturn(L, m12, m1);
    const dd = FA.drawdowns(Array.from(L.subarray(Math.max(yStart, 0), end + 1)));
    // Technicals on the quoted price.
    const px = st.px;
    const sma50 = FA.sma(px.subarray(0, end + 1), 50);
    const sma200 = FA.sma(px.subarray(0, end + 1), 200);
    const rsi = FA.rsi(px.subarray(0, end + 1), 14);
    // 1-day historical VaR/ES (95%) over the last year.
    const sorted = daily.slice().sort((x, y) => x - y);
    const q = Math.floor(0.05 * sorted.length);
    const var95 = sorted.length > 50 ? -sorted[q] : NaN;
    const es95 = sorted.length > 50 ? -FA.mean(sorted.slice(0, q + 1)) : NaN;
    return {
      end,
      date: d,
      ret,
      rel,
      vol1y,
      mom12_1,
      maxDD1y: dd.max,
      price: px[end],
      sma50: sma50[end],
      sma200: sma200[end],
      rsi14: rsi[end],
      var95,
      es95,
    };
  }

  /** Cross-sectional characteristics and z-scores for the whole coverage. */
  function characteristics(ctx, stats, betasByStock) {
    const get = (fn) => ctx.stocks.map((st, i) => {
      const v = fn(st, i);
      return isNum(v) ? v : NaN;
    });
    const defs = [
      { id: "value", label: "Value (book-to-price)", raw: get((st) => (st.fund.pb > 0 ? 1 / st.fund.pb : NaN)), fmt: "x", show: get((st) => st.fund.pb), showLabel: "P/B" },
      { id: "yield", label: "Dividend yield", raw: get((st) => st.fund.dividend_yield), fmt: "pct" },
      { id: "momentum", label: "Momentum (12-1M return)", raw: get((st, i) => stats[i].mom12_1), fmt: "pct" },
      { id: "size", label: "Size (log market cap)", raw: get((st) => (st.fund.market_cap_eur > 0 ? Math.log(st.fund.market_cap_eur) : NaN)), fmt: "eur", show: get((st) => st.fund.market_cap_eur), showLabel: "Market cap" },
      { id: "volatility", label: "Volatility (1Y daily)", raw: get((st, i) => stats[i].vol1y), fmt: "pct" },
      { id: "beta", label: "Market beta", raw: get((st, i) => (betasByStock ? betasByStock[i] : NaN)), fmt: "num" },
      { id: "leverage", label: "Leverage (LTV proxy)", raw: get((st) => st.fund.ltv), fmt: "pct" },
      { id: "liquidity", label: "Liquidity (log traded value)", raw: get((st) => (st.fund.adv_3m_eur > 0 ? Math.log(st.fund.adv_3m_eur) : NaN)), fmt: "eur", show: get((st) => st.fund.adv_3m_eur), showLabel: "Avg daily value" },
    ];
    for (const d of defs) d.z = FA.zscores(d.raw);
    return defs;
  }

  /** Correlations of the stock's returns (and model residuals) with every other stock. */
  function correlations(ctx, st, fits, opts) {
    const freq = opts.freq || "W";
    const ccy = "EUR";
    const endIdx = ctx.asOfIndex;
    const startIdx = windowStart(ctx, endIdx, opts.years);
    const series = (s) => {
      const L = stockLevels(s, ccy);
      const pts = samplePoints(ctx, s, freq === "D" ? "W" : freq, startIdx, endIdx);
      const out = new Map();
      for (let p = 1; p < pts.length; p++) {
        const r = L[pts[p]] / L[pts[p - 1]] - 1;
        if (isNum(r)) out.set(pts[p], r);
      }
      return out;
    };
    const base = series(st);
    const baseResid = new Map();
    const fit = fits[st.i];
    if (fit && fit.ok && fit.rows) fit.rows.forEach((row, k) => baseResid.set(row, fit.resid[k]));
    return ctx.stocks.map((other) => {
      if (other.i === st.i) return { id: other.id, ret: 1, resid: 1 };
      const o = series(other);
      const a = [];
      const b = [];
      for (const [k, v] of base) if (o.has(k)) {
        a.push(v);
        b.push(o.get(k));
      }
      const ofit = fits[other.i];
      const ra = [];
      const rb = [];
      if (ofit && ofit.ok && ofit.rows && fit && fit.ok) {
        const om = new Map();
        ofit.rows.forEach((row, k) => om.set(row, ofit.resid[k]));
        for (const [k, v] of baseResid) if (om.has(k)) {
          ra.push(v);
          rb.push(om.get(k));
        }
      }
      return { id: other.id, ret: FA.correlation(a, b), resid: ra.length > 20 ? FA.correlation(ra, rb) : NaN, n: a.length };
    });
  }

  /** Log price-ratio spread between two stocks (EUR) with a 1Y z-score. */
  function pairSpread(ctx, a, b) {
    const end = ctx.asOfIndex;
    const start = windowStart(ctx, end, 1);
    const vals = [];
    for (let t = start; t <= end; t++) {
      const v = Math.log(a.triEur[t] / b.triEur[t]);
      if (isNum(v)) vals.push(v);
    }
    if (vals.length < 60) return null;
    const m = FA.mean(vals);
    const s = FA.std(vals);
    const last = vals[vals.length - 1];
    const m3 = vals[Math.max(0, vals.length - 64)];
    return { z: s > 0 ? (last - m) / s : NaN, change3m: Math.exp(last - m3) - 1 };
  }

  return {
    FACTORS,
    FACTOR_BY_ID,
    PRESETS,
    MACRO_SPEC,
    STYLE_SPEC,
    MACRO_DRIVERS,
    EPISODES,
    PERIODS_PER_YEAR,
    ROLLING_WINDOW,
    FREQ_LABEL,
    indexOnOrBefore,
    shiftYears,
    shiftDays,
    prepare,
    peerIndex,
    applicable,
    factorFn,
    samplePoints,
    windowStart,
    buildPanel,
    fitModel,
    fitUniverse,
    rollingFit,
    macroSensitivities,
    scenario,
    episodeImpact,
    attribution,
    stockStats,
    characteristics,
    correlations,
    pairSpread,
  };
});
