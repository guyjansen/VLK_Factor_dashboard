/*
 * Property Factor Lens - application: state, layout and the eight views.
 */
(function () {
  "use strict";

  const FA = window.FA;
  const M = window.PFModel;
  const U = window.PFUI;
  const C = window.PFCharts;
  const { el, clear } = U;
  const isNum = FA.isNum;
  const app = document.getElementById("app");
  const DATA = window.DASHBOARD_DATA;

  if (!DATA || !Array.isArray(DATA.stocks) || !DATA.stocks.length) {
    clear(app).appendChild(
      el("p", { class: "boot", text: "No data file found. Run python -m factor_dashboard.build to create docs/data/dashboard_data.js, then reload." })
    );
    return;
  }

  const ctx = M.prepare(DATA);
  const META = DATA.meta || {};
  const STOCKS = ctx.stocks;
  const SUBS = ctx.subsectors;
  const PRESETS = M.PRESETS;
  const F = M.FACTOR_BY_ID;
  const DASH = U.DASH;

  const TABS = [
    ["overview", "Overview"],
    ["exposures", "Factor exposures"],
    ["macro", "Macro & scenarios"],
    ["attribution", "Attribution"],
    ["risk", "Risk"],
    ["peers", "Peers & value"],
    ["coverage", "Coverage"],
    ["method", "Data & method"],
  ];
  const TAB_IDS = TABS.map((t) => t[0]);
  const ATTR_PERIODS = [
    ["1M", 1 / 12],
    ["3M", 0.25],
    ["6M", 0.5],
    ["YTD", "ytd"],
    ["1Y", 1],
    ["3Y", 3],
  ];

  // ------------------------------------------------------------------ state
  const STORE_KEY = "property-factor-lens:v1";
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {};
    }
  })();
  const hashStock = () => {
    const h = decodeURIComponent((location.hash || "").replace(/^#/, "")).toUpperCase();
    return ctx.byId[h] ? h : null;
  };
  const state = {
    stock: hashStock() || (ctx.byId[stored.stock] ? stored.stock : STOCKS[0].id),
    preset: PRESETS[stored.preset] || stored.preset === "custom" ? stored.preset : "full",
    custom: Array.isArray(stored.custom) ? stored.custom.filter((id) => F[id]) : null,
    freq: ["D", "W", "M"].includes(stored.freq) ? stored.freq : "W",
    years: [1, 2, 3, 5].includes(stored.years) ? stored.years : 3,
    ccy: stored.ccy === "EUR" ? "EUR" : "local",
    tab: TAB_IDS.includes(stored.tab) ? stored.tab : "overview",
    attr: ATTR_PERIODS.some((p) => p[0] === stored.attr) ? stored.attr : "3M",
    attrModel: stored.attrModel === "model" ? "model" : "sector",
    sx: stored.sx || "rate10",
    sy: stored.sy || "pb",
    heat: stored.heat === "impact" ? "impact" : "t",
    pickerOpen: false,
    scen: { MKT: 0, RATES: 50, CREDIT: 0, FXL: 0, OIL: 0 },
    conditional: true,
  };
  if (state.preset === "custom" && !(state.custom && state.custom.length)) state.preset = "full";
  if (state.freq === "M" && state.years < 3) state.years = 3;

  function persist() {
    try {
      const { stock, preset, custom, freq, years, ccy, tab, attr, attrModel, sx, sy, heat } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ stock, preset, custom, freq, years, ccy, tab, attr, attrModel, sx, sy, heat }));
    } catch (e) {
      /* storage unavailable: preferences are not remembered */
    }
  }

  // ------------------------------------------------------------------ computations (memoised)
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const setKey = () => `${state.freq}|${state.years}|${state.ccy}`;
  const opts = () => ({ freq: state.freq, years: state.years, ccy: state.ccy });

  function modelIds() {
    const ids = state.preset === "custom" && state.custom && state.custom.length ? state.custom : PRESETS[state.preset === "custom" ? "full" : state.preset].factors;
    return M.resolveFactors(ctx, ids);
  }
  const macroIds = () => M.resolveFactors(ctx, M.MACRO_SPEC);
  const styleIds = () => M.resolveFactors(ctx, M.STYLE_SPEC);
  // Newey-West errors cost time; skip them where no t-statistic is shown.
  const fits = (ids, hac = true) => once(`fits|${ids.join(",")}|${hac}|${setKey()}`, () => M.fitUniverse(ctx, ids, { ...opts(), hac }));
  const stats = () => once(`stats|${state.ccy}`, () => STOCKS.map((st) => M.stockStats(ctx, st, state.ccy)));
  const capmFits = () => fits(M.resolveFactors(ctx, ["MKT"]), false);
  const chars = () =>
    once(`chars|${setKey()}`, () => M.characteristics(ctx, stats(), capmFits().map((f) => (f.ok ? f.betas.MKT : NaN))));
  const sel = () => ctx.byId[state.stock];
  const peersOf = (st) => STOCKS.filter((s) => s.meta.subsector === st.meta.subsector);

  function macroSens(st) {
    return once(`macro|${st.id}|${setKey()}`, () => M.macroSensitivities(ctx, st, opts()));
  }

  function attrPeriod(key) {
    const end = ctx.asOfIndex;
    const p = ATTR_PERIODS.find((x) => x[0] === key) || ATTR_PERIODS[1];
    if (p[1] === "ytd") return { start: M.indexOnOrBefore(ctx.dates, `${Number(ctx.dates[end].slice(0, 4)) - 1}-12-31`), end };
    return { start: M.windowStart(ctx, end, p[1]), end };
  }

  function attribution(st, key, factorIds) {
    const ids = factorIds || (state.attrModel === "model" ? modelIds() : M.resolveFactors(ctx, M.ATTRIB_SPEC));
    return once(`attr|${st.id}|${key}|${ids.join(",")}|${setKey()}`, () => {
      const { start, end } = attrPeriod(key);
      return M.attribution(ctx, st, ids, opts(), start, end);
    });
  }

  // ------------------------------------------------------------------ small helpers
  const factorName = (id) => (F[id] ? F[id].short : id);
  const factorLabel = (id) => (F[id] ? F[id].label : id);
  const impact1s = (fit, id) => (fit && fit.ok && isNum(fit.betas[id]) ? fit.betas[id] * fit.factorStd[id] : NaN);
  const freqWord = () => M.FREQ_LABEL[state.freq];
  const windowWord = () => `${state.years}Y ${freqWord()}`;
  const ccyOf = (st) => (state.ccy === "EUR" ? "EUR" : st.meta.currency);

  function rateLabel(st) {
    const s = DATA.series[st.rateSeries];
    if (st.rateSeries === "EUR10Y") return "EUR 10Y yield";
    return s ? s.label : "home 10Y yield";
  }

  function exposureText(id, beta) {
    const f = F[id];
    if (!f || !isNum(beta)) return DASH;
    if (f.unit === "bp" || f.unit === "pts") return `${U.pct(beta * f.shock, 2, true)} per ${f.shockLabel}`;
    return U.num(beta, 2);
  }

  function median(values) {
    const v = values.filter(isNum);
    return v.length ? FA.median(v) : NaN;
  }

  /** Levels converted to the view currency of `st` (EUR levels in, local out). */
  function inViewCcy(levelsEur, st) {
    if (state.ccy === "EUR" || !st.fx) return levelsEur;
    return levelsEur.map((v, t) => v * st.fx[t]);
  }

  function seriesPoints(levels, start, end, rebase) {
    const out = [];
    let base = NaN;
    for (let t = start; t <= end; t++) {
      const v = levels[t];
      if (!isNum(v)) continue;
      if (!isNum(base)) base = v;
      out.push([ctx.dates[t], rebase ? (v / base) * 100 : v]);
    }
    return out;
  }

  function note(text) {
    return el("p", { class: "note", text });
  }

  function failBox(msg) {
    return el("div", { class: "empty", text: msg });
  }

  function chartBox(h) {
    return el("div", { class: "chart", style: h ? { height: h + "px" } : null });
  }

  /** Defer chart drawing until the element is in the document and has a width. */
  const pendingCharts = [];
  function draw(fn) {
    pendingCharts.push(fn);
  }
  function flushCharts() {
    while (pendingCharts.length) {
      const fn = pendingCharts.shift();
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ------------------------------------------------------------------ layout skeleton
  let railEl;
  let headEl;
  let controlsEl;
  let tabsEl;
  let panelEl;
  let mobilePicker;

  function build() {
    clear(app);
    const topbar = el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-inner" },
        el(
          "div",
          { class: "brand" },
          el("h1", { class: "brand-name", text: "Property Factor Lens" }),
          el("span", { class: "brand-sub", text: `${STOCKS.length} European listed real estate stocks · public data` })
        ),
        (mobilePicker = el("div", { class: "picker-mobile" })),
        el(
          "div",
          { class: "asof" },
          el("span", { text: `Prices to ${U.date(META.as_of)}` }),
          META.synthetic ? el("span", { class: "chip warn", text: "Synthetic demo data" }) : null
        )
      )
    );
    railEl = buildRail();
    headEl = el("section", { class: "stock-head", "aria-label": "Selected stock" });
    controlsEl = el("div", { class: "controls", role: "group", "aria-label": "Model settings" });
    tabsEl = el("div", { class: "tabs", role: "tablist", "aria-label": "Views" });
    panelEl = el("div", { class: "panel", role: "tabpanel", id: "panel" });
    const content = el("main", { class: "content", id: "main" }, dataBanner(), headEl, controlsEl, tabsEl, panelEl);
    app.append(topbar, el("div", { class: "shell" }, railEl, content));
  }

  function dataBanner() {
    const warnings = [];
    if (META.synthetic) warnings.push("This file holds synthetic demo data generated for testing. Run the data pipeline for real market data.");
    const fallback = {
      EUR_HY_OAS: M.available(ctx, "CREDIT_ETF") ? "credit uses the high-yield bond ETF proxy" : "credit factors are left out",
      GB10Y: "UK stocks use the EUR 10Y yield",
      SE10Y: "Swedish stocks use the EUR 10Y yield",
      CH10Y: "Swiss stocks use the EUR 10Y yield",
      NO10Y: "Norwegian stocks use the EUR 10Y yield",
    };
    let severe = !!META.synthetic;
    const missing = Object.entries(META.series_status || {})
      .filter(([, s]) => s.status === "failed" || String(s.status || "").startsWith("stale"))
      .map(([id, s]) => {
        const name = s.label || (DATA.series[id] && DATA.series[id].label) || id;
        if (s.status !== "failed") return `${name} is from the previous refresh`;
        if (!fallback[id]) severe = true;
        return fallback[id] ? `${name} is unavailable, so ${fallback[id]}` : `${name} is unavailable`;
      });
    if (missing.length) warnings.push(`Not in this refresh: ${missing.join("; ")}.`);
    if (!warnings.length) return null;
    // Inputs with a working fallback get a quiet note; anything else is a warning.
    return el("div", { class: severe ? "banner" : "banner info", role: "note" }, warnings.join(" "));
  }

  // ------------------------------------------------------------------ rail
  function buildRail() {
    const rail = el("aside", { class: "rail", "aria-label": "Coverage list" });
    const input = el("input", { type: "search", placeholder: `Search ${STOCKS.length} stocks`, "aria-label": "Search coverage", id: "rail-search", autocomplete: "off" });
    const list = el("div", { class: "rail-list" });
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      for (const b of list.querySelectorAll(".rail-item")) {
        const st = ctx.byId[b.dataset.id];
        const hit = !q || st.meta.name.toLowerCase().includes(q) || st.meta.ticker.toLowerCase().includes(q) || st.id.toLowerCase().includes(q);
        b.hidden = !hit;
      }
      for (const g of list.querySelectorAll(".rail-group")) g.hidden = !g.querySelector(".rail-item:not([hidden])");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = list.querySelector(".rail-item:not([hidden])");
        if (first) first.click();
      }
    });
    for (const ss of SUBS) {
      const members = STOCKS.filter((s) => s.meta.subsector === ss);
      const group = el("div", { class: "rail-group" }, el("h3", null, el("span", { text: ss }), el("span", { text: String(members.length) })));
      for (const st of members) {
        group.appendChild(
          el(
            "button",
            { type: "button", class: "rail-item", dataset: { id: st.id }, title: `${st.meta.name} · ${st.meta.ticker}`, onclick: () => selectStock(st.id) },
            el("span", { class: "nm", text: st.meta.name }),
            el("span", { class: "rt", text: "" })
          )
        );
      }
      list.appendChild(group);
    }
    rail.append(el("div", { class: "rail-search" }, input, el("p", { class: "note", style: { marginTop: "6px" }, text: "Figures: 1-month total return" })), list);
    rail.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...list.querySelectorAll(".rail-item:not([hidden])")];
      const i = items.findIndex((b) => b.dataset.id === state.stock);
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        next.click();
        next.focus();
      }
    });
    return rail;
  }

  function updateRail() {
    const s = stats();
    for (const b of railEl.querySelectorAll(".rail-item")) {
      const st = ctx.byId[b.dataset.id];
      b.setAttribute("aria-current", String(st.id === state.stock));
      b.querySelector(".rt").textContent = U.pct(s[st.i].ret.m1, 1, true);
    }
    const current = railEl.querySelector('.rail-item[aria-current="true"]');
    if (current && current.scrollIntoView) {
      const r = current.getBoundingClientRect();
      const rr = railEl.getBoundingClientRect();
      if (r.top < rr.top || r.bottom > rr.bottom) current.scrollIntoView({ block: "nearest" });
    }
    clear(mobilePicker).appendChild(
      U.select(
        SUBS.map((ss) => ({ group: ss, options: STOCKS.filter((s) => s.meta.subsector === ss).map((s) => ({ value: s.id, label: s.meta.name })) })),
        state.stock,
        (v) => selectStock(v),
        { "aria-label": "Select stock", id: "stock-select" }
      )
    );
  }

  // ------------------------------------------------------------------ header
  function renderHead() {
    const st = sel();
    const f = st.fund;
    const s = stats()[st.i];
    const mfit = fits(macroIds())[st.i];
    const capm = capmFits()[st.i];
    const peers = peersOf(st);
    const qccy = st.meta.currency;
    const peerMed = (fn) => median(peers.filter((p) => p !== st).map(fn));

    const title = el(
      "div",
      null,
      el("h2", { class: "stock-name", text: st.meta.name }),
      el(
        "div",
        { class: "stock-meta" },
        el("span", { class: "mono", text: st.meta.ticker }),
        el("span", { text: st.meta.exchange || "" }),
        el("span", { text: `${st.meta.country} · ${qccy}` }),
        el("span", { class: "chip accent", text: st.meta.subsector }),
        st.meta.segment ? el("span", { class: "chip", text: st.meta.segment }) : null
      )
    );
    const priceBlock = el(
      "div",
      { class: "price-block" },
      el("div", { class: "price", text: U.money(f.price != null ? f.price : s.price, qccy) }),
      el("div", { class: "price-sub", text: `${U.pct(stats()[st.i].ret.d1, 1, true)} on the day · close ${U.date(f.price_date || s.date)}` })
    );
    const upside = f.consensus && f.consensus.upside;
    const tiles = el(
      "div",
      { class: "tiles", "data-n": "8" },
      U.tile("Market cap", U.moneyCompact(f.market_cap_eur, "EUR"), f.market_cap && qccy !== "EUR" ? U.moneyCompact(f.market_cap, qccy) : `${U.ordinal(rankCap(st))} largest of ${STOCKS.length}`),
      U.tile("P/B (P/NAV proxy)", U.mult(f.pb), `sub-sector median ${U.mult(peerMed((p) => p.fund.pb))}`),
      U.tile("Dividend yield", U.pct(f.dividend_yield, 1), `sub-sector median ${U.pct(peerMed((p) => p.fund.dividend_yield), 1)}`),
      U.tile("1Y total return", U.pct(s.ret.y1, 1, true), `${U.pp(s.rel.y1.subsector)} vs sub-sector`),
      U.tile("Beta vs STOXX 600", capm.ok ? U.num(capm.betas.MKT, 2) : DASH, `${windowWord()}, market only`),
      U.tile("Rate sensitivity", mfit.ok && isNum(mfit.betas.RATES) ? U.pct(mfit.betas.RATES * 10, 2, true) : DASH, `per +10bp ${rateLabel(st).replace(" yield", "")}, market held constant`),
      U.tile("Volatility (1Y)", U.pct(s.vol1y, 0), mfit.ok ? `${U.pct(mfit.specificVolAnn, 0)} stock-specific` : ""),
      U.tile("Consensus upside", U.pct(upside, 0, true), f.consensus && f.consensus.analysts ? `${f.consensus.analysts} analysts${f.consensus.rating ? " · " + f.consensus.rating : ""}` : "Yahoo Finance consensus")
    );
    clear(headEl).append(el("div", { class: "stock-title-row" }, title, priceBlock), el("div", { class: "tiles-wrap" }, tiles));
  }

  function rankCap(st) {
    const caps = STOCKS.map((s) => s.fund.market_cap_eur);
    return FA.rankOf(caps, st.fund.market_cap_eur).rank;
  }

  // ------------------------------------------------------------------ controls
  function renderControls() {
    const presetOptions = Object.entries(PRESETS).map(([id, p]) => ({ value: id, label: p.label }));
    presetOptions.push({ value: "custom", label: "Custom" });
    const modelSel = U.select(presetOptions, state.preset, (v) => {
      state.preset = v;
      if (v === "custom" && !(state.custom && state.custom.length)) state.custom = modelIdsFor("full");
      changed("settings");
    }, { "aria-label": "Factor model", id: "model-select" });
    const pickBtn = el("button", {
      type: "button",
      class: "btn",
      "aria-expanded": String(state.pickerOpen),
      "aria-controls": "factor-picker",
      text: state.pickerOpen ? "Hide factors" : "Choose factors",
      onclick: () => {
        state.pickerOpen = !state.pickerOpen;
        renderControls();
      },
    });
    const children = [
      el("div", { class: "control" }, el("span", { class: "lbl", text: "Model" }), modelSel, pickBtn),
      el(
        "div",
        { class: "control" },
        el("span", { class: "lbl", text: "Returns" }),
        U.seg(
          [
            { value: "D", label: "Daily" },
            { value: "W", label: "Weekly" },
            { value: "M", label: "Monthly" },
          ],
          state.freq,
          (v) => {
            state.freq = v;
            if (v === "M" && state.years < 3) state.years = 3;
            changed("settings");
          },
          "Return frequency"
        )
      ),
      el(
        "div",
        { class: "control" },
        el("span", { class: "lbl", text: "Window" }),
        U.seg(
          [1, 2, 3, 5].map((y) => ({ value: y, label: `${y}Y`, title: state.freq === "M" && y < 3 ? "Monthly returns need at least 3 years" : null })),
          state.years,
          (v) => {
            if (state.freq === "M" && v < 3) return;
            state.years = v;
            changed("settings");
          },
          "Estimation window"
        )
      ),
      el(
        "div",
        { class: "control" },
        el("span", { class: "lbl", text: "Currency" }),
        U.seg(
          [
            { value: "local", label: "Local" },
            { value: "EUR", label: "EUR" },
          ],
          state.ccy,
          (v) => {
            state.ccy = v;
            changed("settings");
          },
          "Return currency"
        )
      ),
    ];
    if (state.pickerOpen) children.push(factorPicker());
    clear(controlsEl).append(...children);
  }

  function modelIdsFor(preset) {
    return M.resolveFactors(ctx, PRESETS[preset].factors);
  }

  function factorPicker() {
    const current = new Set(modelIds());
    const groups = [...new Set(M.FACTORS.map((f) => f.group))];
    const box = el("div", { class: "factor-picker", id: "factor-picker" });
    for (const g of groups) {
      const fs = el("fieldset", null, el("legend", { text: g }));
      for (const f of M.FACTORS.filter((x) => x.group === g)) {
        const ok = M.available(ctx, f.id);
        const cb = el("input", { type: "checkbox", id: `f-${f.id}`, checked: current.has(f.id), disabled: !ok });
        cb.addEventListener("change", () => {
          const next = new Set(modelIds());
          if (cb.checked) next.add(f.id);
          else next.delete(f.id);
          const ordered = M.FACTORS.map((x) => x.id).filter((id) => next.has(id));
          if (!ordered.length) {
            cb.checked = true;
            return;
          }
          state.preset = "custom";
          state.custom = ordered;
          changed("settings");
        });
        fs.appendChild(el("label", { for: `f-${f.id}`, class: ok ? null : "na", title: ok ? f.desc : "No data for this factor in the current refresh" }, cb, f.label));
      }
      box.appendChild(fs);
    }
    return box;
  }

  // ------------------------------------------------------------------ tabs
  function renderTabs() {
    clear(tabsEl);
    for (const [id, label] of TABS) {
      tabsEl.appendChild(
        el("button", {
          type: "button",
          role: "tab",
          id: `tab-${id}`,
          "aria-selected": String(state.tab === id),
          "aria-controls": "panel",
          tabindex: state.tab === id ? "0" : "-1",
          text: label,
          onclick: () => {
            state.tab = id;
            changed("tab");
          },
        })
      );
    }
    tabsEl.onkeydown = (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TAB_IDS.indexOf(state.tab);
      const j = (i + (e.key === "ArrowRight" ? 1 : TAB_IDS.length - 1)) % TAB_IDS.length;
      state.tab = TAB_IDS[j];
      changed("tab");
      const b = document.getElementById(`tab-${state.tab}`);
      if (b) b.focus();
    };
  }

  function renderPanel() {
    C.disposeWithin(panelEl);
    clear(panelEl);
    panelEl.setAttribute("aria-labelledby", `tab-${state.tab}`);
    const renderers = { overview, exposures, macro, attributionView, risk, peers, coverage, method };
    const fn = renderers[state.tab === "attribution" ? "attributionView" : state.tab];
    try {
      fn(panelEl);
    } catch (e) {
      console.error(e);
      panelEl.appendChild(failBox(`This view could not be drawn: ${e.message}`));
    }
    requestAnimationFrame(flushCharts);
  }

  // ------------------------------------------------------------------ change handling
  let pending = null;
  function changed(kind) {
    persist();
    if (kind === "tab") {
      renderTabs();
      renderPanel();
      return;
    }
    if (kind === "stock") {
      setHash();
      updateRail();
      renderHead();
      renderPanel();
      return;
    }
    // Settings: keep the current view on screen, dimmed, while recomputing.
    renderControls();
    panelEl.style.opacity = "0.55";
    headEl.style.opacity = "0.55";
    clearTimeout(pending);
    pending = setTimeout(() => {
      updateRail();
      renderHead();
      renderPanel();
      panelEl.style.opacity = "";
      headEl.style.opacity = "";
    }, 20);
  }

  function setHash() {
    if (location.hash === `#${state.stock}`) return;
    try {
      history.replaceState(null, "", `#${state.stock}`);
    } catch (e) {
      /* some embedded viewers block history changes */
    }
  }

  function selectStock(id) {
    if (!ctx.byId[id] || id === state.stock) return;
    state.stock = id;
    changed("stock");
  }

  window.addEventListener("hashchange", () => {
    const id = hashStock();
    if (id && id !== state.stock) {
      state.stock = id;
      changed("stock");
    }
  });

  // Charts read colours from CSS tokens: redraw when the theme changes.
  const redrawTheme = () => renderPanel();
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", redrawTheme);
  }
  new MutationObserver(redrawTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

  // ================================================================== VIEWS
  // ------------------------------------------------------------------ overview
  function overview(panel) {
    const st = sel();
    const fit = fits(modelIds())[st.i];
    const grid1 = el("div", { class: "grid-wide", style: { alignItems: "start" } });
    grid1.append(el("div", { class: "stack" }, factorProfileCard(st, fit), specificCard(st)), takeawaysCard(st));
    const grid2 = el("div", { class: "grid-2" });
    grid2.append(performanceCard(st), returnsTableCard(st));
    const grid3 = el("div", { class: "grid-2", style: { alignItems: "start" } });
    grid3.append(fundamentalsCard(st), profileCard(st));
    panel.append(grid1, grid2, grid3);
  }

  function factorProfileCard(st, fit) {
    const c = U.card("Factor profile", `Typical ${freqWord()} move in the shares for a one-standard-deviation move in each factor, ${windowWord()} regression (${PRESETS[state.preset] ? PRESETS[state.preset].label : "custom model"}). Black ticks mark the ${st.meta.subsector} median.`);
    if (!fit.ok) {
      c.body.appendChild(failBox(fit.error || "The model could not be estimated for this stock."));
      return c.root;
    }
    const all = fits(modelIds());
    const peers = peersOf(st).filter((p) => p !== st);
    const t = C.tokens();
    const items = fit.factors.map((id) => {
      const v = impact1s(fit, id);
      const significant = Math.abs(fit.t[id]) >= 1.96;
      return {
        label: factorName(id),
        value: v,
        marker: median(peers.map((p) => impact1s(all[p.i], id))),
        color: significant ? null : t.other,
        note: `Exposure ${exposureText(id, fit.betas[id])} (t ${U.num(fit.t[id], 1)}${significant ? "" : ", not significant at 5%"})`,
      };
    });
    const box = chartBox();
    c.body.append(
      U.legend([
        { label: "Positive, significant", color: t.pos, kind: "rect" },
        { label: "Negative, significant", color: t.neg, kind: "rect" },
        { label: "Not significant (|t| < 1.96)", color: t.other, kind: "rect" },
        { label: `${st.meta.subsector} median`, color: t.ink, kind: "line" },
      ]),
      box,
      el("div", { class: "stats-line" }, el("span", null, "R² ", el("b", { text: U.num(fit.r2, 2) })), el("span", null, "Observations ", el("b", { text: String(fit.n) })), el("span", null, "Specific volatility ", el("b", { text: U.pct(fit.specificVolAnn, 1) })), el("span", null, "Window ", el("b", { text: `${U.monthYear(fit.start)} – ${U.monthYear(fit.end)}` })))
    );
    if (fit.dropped.length) c.body.appendChild(note(`Left out: ${fit.dropped.map((d) => `${factorName(d.id)} (${d.reason})`).join("; ")}.`));
    draw(() => C.hbar(box, items, { fmt: (v) => U.pct(v, 1, true), labelFmt: (v) => U.pct(v, 2, true), symmetric: true, valueColumn: true, markerName: `${st.meta.subsector} median`, valueName: "1σ impact", labelWidth: 110 }));
    return c.root;
  }

  function takeawaysCard(st) {
    const c = U.card("Key takeaways", "Generated from the numbers on this page; check before quoting.");
    const list = el("ul", { class: "takeaways" });
    for (const item of takeaways(st)) list.appendChild(el("li", null, el("span", { class: "tag", text: item.tag }), el("span", { text: item.text })));
    if (!list.children.length) list.appendChild(el("li", null, el("span", { class: "tag", text: "Data" }), el("span", { text: "Not enough history to summarise this stock yet." })));
    c.body.appendChild(list);
    return c.root;
  }

  function takeaways(st) {
    const out = [];
    const mf = fits(macroIds());
    const sf = fits(styleIds());
    const fit = mf[st.i];
    const peers = peersOf(st);
    const ss = st.meta.subsector;
    const s = stats()[st.i];
    const f = st.fund;

    if (fit.ok && isNum(fit.betas.RATES)) {
      const v = fit.betas.RATES * 10;
      const others = peers.filter((p) => p !== st && mf[p.i].ok && isNum(mf[p.i].betas.RATES)).map((p) => mf[p.i].betas.RATES * 10);
      const lessSensitive = others.filter((x) => x > v).length;
      const sigTxt = Math.abs(fit.t.RATES) >= 1.96 ? "" : " The estimate is not statistically significant.";
      if (v < 0) {
        const total = others.length + 1;
        const rel =
          !others.length
            ? ""
            : lessSensitive === 0
              ? ` That makes it the least rate-sensitive of the ${total} ${ss} stocks.`
              : lessSensitive === others.length
                ? ` That makes it the most rate-sensitive of the ${total} ${ss} stocks.`
                : ` That is more rate-sensitive than ${lessSensitive} of its ${others.length} ${ss} peers.`;
        out.push({ tag: "Rates", text: `A +10bp move in the ${rateLabel(st)} has come with a ${U.pct(v, 2, true)} move in the shares, holding the market constant (t ${U.num(fit.t.RATES, 1)}).${rel}${sigTxt}` });
      } else {
        out.push({ tag: "Rates", text: `The shares have tended to rise with the ${rateLabel(st)} (${U.pct(v, 2, true)} per +10bp, t ${U.num(fit.t.RATES, 1)}), unusual for real estate.${sigTxt}` });
      }
    }
    const cf = capmFits();
    if (cf[st.i].ok) {
      const med = median(peers.filter((p) => p !== st).map((p) => (cf[p.i].ok ? cf[p.i].betas.MKT : NaN)));
      const b = cf[st.i].betas.MKT;
      if (isNum(med) && Math.abs(b - med) >= 0.15) {
        out.push({ tag: "Beta", text: `Market beta of ${U.num(b, 2)} against a ${ss} median of ${U.num(med, 2)}: ${b > med ? "a higher-beta way to play European equities" : "more defensive than its peers"}.` });
      } else {
        out.push({ tag: "Beta", text: `Market beta of ${U.num(b, 2)}, in line with the ${ss} median of ${U.num(med, 2)}.` });
      }
    }
    if (fit.ok) {
      if (fit.factors.includes("CREDIT") && Math.abs(fit.t.CREDIT) >= 1.96) {
        out.push({ tag: "Credit", text: `Credit matters: ${U.pct(fit.betas.CREDIT * 25, 2, true)} per +25bp in the EUR high-yield spread (t ${U.num(fit.t.CREDIT, 1)}).` });
      }
      if (fit.factors.includes("CREDIT_ETF") && Math.abs(fit.t.CREDIT_ETF) >= 1.96) {
        out.push({ tag: "Credit", text: `Credit matters: when EUR high-yield bonds lag governments by 1% (spreads widening), the shares have moved ${U.pct(-fit.betas.CREDIT_ETF * 0.01, 2, true)}, market held constant (t ${U.num(fit.t.CREDIT_ETF, 1)}).` });
      }
    }
    const sfit = sf[st.i];
    if (sfit.ok) {
      const styles = sfit.factors.filter((id) => !["MKT", "SECTOR"].includes(id)).map((id) => ({ id, t: sfit.t[id], b: sfit.betas[id] })).filter((x) => Math.abs(x.t) >= 1.96).sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
      if (styles.length) {
        const x = styles[0];
        const words = {
          SMB: ["behaves like a small cap", "behaves like a large cap"],
          HML: ["trades with value stocks", "trades against value, like a growth stock"],
          RMW: ["moves with profitable companies", "moves with less profitable companies"],
          CMA: ["moves with conservative investors (low asset growth)", "moves with high-investment companies"],
          WML: ["rides momentum: it tends to rise when recent winners rally", "is a momentum laggard: it tends to fall when recent winners rally"],
        }[x.id] || ["has a positive loading", "has a negative loading"];
        out.push({ tag: "Style", text: `Beyond market and sector, the stock ${x.b > 0 ? words[0] : words[1]} (${factorName(x.id).toLowerCase()} factor, t ${U.num(x.t, 1)}).` });
      } else {
        out.push({ tag: "Style", text: "No style factor is significant once market and sector are accounted for." });
      }
    }
    const att = attribution(st, "3M", attribIds());
    if (att.ok && att.lastFit && att.lastFit.ok) {
      const sd = att.lastFit.specificVolAnn * Math.sqrt(att.days / 252);
      const z = sd > 0 ? att.specific / sd : NaN;
      const big = Math.abs(z) >= 1.5;
      out.push({
        tag: "Specific",
        text: `Over 3 months the shares returned ${U.pct(att.total, 1, true)}; market, sector, rates and credit explain ${U.pct(att.total - att.specific, 1, true)} and the stock-specific part is ${U.pct(att.specific, 1, true)} (${U.num(z, 1)} standard deviations)${big ? ", a large idiosyncratic move worth explaining to clients" : ""}.`,
      });
    }
    const peerPB = peers.filter((p) => p !== st).map((p) => p.fund.pb);
    if (isNum(f.pb)) {
      const med = median(peerPB);
      const cheaper = STOCKS.map((p) => p.fund.pb).filter((v) => isNum(v) && v < f.pb).length;
      const n = STOCKS.map((p) => p.fund.pb).filter(isNum).length;
      out.push({ tag: "Valuation", text: `P/B of ${U.mult(f.pb)} versus a ${ss} median of ${U.mult(med)}; ${cheaper} of ${n - 1} coverage stocks trade on a lower multiple.${isNum(f.dividend_yield) ? ` Trailing dividend yield ${U.pct(f.dividend_yield, 1)}.` : ""}` });
    }
    if (isNum(f.ltv)) {
      const higher = STOCKS.map((p) => p.fund.ltv).filter((v) => isNum(v) && v > f.ltv).length;
      const n = STOCKS.map((p) => p.fund.ltv).filter(isNum).length;
      out.push({ tag: "Leverage", text: `LTV proxy of ${U.pct(f.ltv, 0)} (net debt over total assets less cash): ${U.ordinal(higher + 1)} highest of ${n} in coverage.` });
    }
    if (f.consensus && isNum(f.consensus.upside)) {
      const cns = f.consensus;
      out.push({ tag: "Consensus", text: `${cns.analysts || "Several"} analysts on Yahoo Finance; the mean target of ${U.money(cns.target_mean, st.meta.currency)} implies ${U.pct(cns.upside, 0, true)}${cns.rating ? `, average rating ${cns.rating.toLowerCase()}` : ""}.` });
    }
    if (isNum(s.price) && isNum(s.sma200)) {
      const gap = s.price / s.sma200 - 1;
      const rsiTxt = isNum(s.rsi14) ? ` RSI(14) ${U.num(s.rsi14, 0)}${s.rsi14 >= 70 ? ", overbought territory" : s.rsi14 <= 30 ? ", oversold territory" : ""}.` : "";
      out.push({ tag: "Technicals", text: `Trading ${U.pct(Math.abs(gap), 1)} ${gap >= 0 ? "above" : "below"} its 200-day average.${rsiTxt}` });
    }
    return out;
  }

  function performanceCard(st) {
    const c = U.card("Performance", `Total return rebased to 100 over the ${state.years}Y window, in ${state.ccy === "EUR" ? "EUR" : st.meta.currency}. Peer lines exclude ${st.meta.name}.`);
    const t = C.tokens();
    const end = ctx.asOfIndex;
    const start = M.windowStart(ctx, end, state.years);
    const own = state.ccy === "EUR" ? st.triEur : st.tri;
    const sub = inViewCcy(M.peerIndex(ctx, st, "sub"), st);
    const cov = inViewCcy(M.peerIndex(ctx, st, "all"), st);
    const mkt = ctx.series.MKT ? inViewCcy(ctx.series.MKT, st) : null;
    const lines = [
      { name: st.id, data: seriesPoints(own, Math.max(start, st.first), end, true), color: t.series[0], width: 2.2, endLabel: true },
      { name: `${st.meta.subsector} peers`, data: seriesPoints(sub, Math.max(start, st.first), end, true), color: t.series[1], width: 1.6 },
      { name: "Coverage", data: seriesPoints(cov, Math.max(start, st.first), end, true), color: t.series[2], width: 1.6 },
    ];
    if (mkt) lines.push({ name: "STOXX Europe 600", data: seriesPoints(mkt, Math.max(start, st.first), end, true), color: t.otherStrong, width: 1.6 });
    const box = chartBox();
    c.body.append(U.legend(lines.map((l) => ({ label: l.name === st.id ? st.meta.name : l.name, color: l.color }))), box);
    draw(() => C.line(box, lines, { yFmt: (v) => U.num(v, 0), tipFmt: (v) => U.num(v, 1), height: 290, rightPad: 80, dateFmt: U.date }));
    return c.root;
  }

  function returnsTableCard(st) {
    const c = U.card("Returns", `Total return in ${state.ccy === "EUR" ? "EUR" : st.meta.currency}; relative columns compare EUR returns.`);
    const s = stats()[st.i];
    const rows = [
      ["1W", "w1"],
      ["1M", "m1"],
      ["3M", "m3"],
      ["6M", "m6"],
      ["YTD", "ytd"],
      ["1Y", "y1"],
      ["3Y", "y3"],
      ["5Y", "y5"],
    ].map(([label, k]) => ({ label, ret: s.ret[k], sub: s.rel[k].subsector, cov: s.rel[k].coverage, mkt: s.rel[k].market }));
    c.body.appendChild(
      U.table(
        [
          { key: "label", label: "Period" },
          { key: "ret", label: "Return", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "sub", label: "vs sub-sector", num: true, fmt: (v) => U.pp(v) },
          { key: "cov", label: "vs coverage", num: true, fmt: (v) => U.pp(v) },
          { key: "mkt", label: "vs STOXX 600", num: true, fmt: (v) => U.pp(v) },
        ],
        rows,
        { sortable: false }
      )
    );
    const tech = [
      ["52-week range", `${U.money(st.fund.low_52w, st.meta.currency)} – ${U.money(st.fund.high_52w, st.meta.currency)}`],
      ["vs 50-day average", isNum(s.sma50) ? U.pct(s.price / s.sma50 - 1, 1, true) : DASH],
      ["vs 200-day average", isNum(s.sma200) ? U.pct(s.price / s.sma200 - 1, 1, true) : DASH],
      ["RSI (14 days)", U.num(s.rsi14, 0)],
      ["Momentum (12-1 months)", U.pct(s.mom12_1, 1, true)],
    ];
    c.body.appendChild(U.kv(tech));
    return c.root;
  }

  const attribIds = () => M.resolveFactors(ctx, M.ATTRIB_SPEC);

  function specificCard(st) {
    const fit = fits(attribIds(), false)[st.i];
    const c = U.card("Stock-specific return", `What is left after the market, the real estate sector, the home 10Y yield and credit: cumulative residual of the ${windowWord()} regression.`);
    if (!fit.ok || !fit.rows || !fit.rows.length) {
      c.body.appendChild(failBox(fit.error || "Not available."));
      return c.root;
    }
    const t = C.tokens();
    let level = 100;
    const data = [[ctx.dates[fit.rows[0]], 100]];
    fit.rows.forEach((row, k) => {
      if (k === 0) return;
      level *= 1 + fit.resid[k];
      data.push([ctx.dates[row], level]);
    });
    const periods = ["1M", "3M", "6M"].map((k) => {
      const a = attribution(st, k, attribIds());
      if (!a.ok || !a.lastFit || !a.lastFit.ok) return { label: k, text: DASH };
      const sd = a.lastFit.specificVolAnn * Math.sqrt(a.days / 252);
      return { label: k, value: a.specific, z: sd > 0 ? a.specific / sd : NaN };
    });
    const box = chartBox();
    c.body.append(
      el(
        "div",
        { class: "figure-row" },
        periods.map((p) => el("div", { class: "figure" }, el("span", { class: "v", text: isNum(p.value) ? U.pct(p.value, 1, true) : DASH }), el("span", { class: "l", text: `${p.label} specific · ${isNum(p.z) ? U.num(p.z, 1) + " σ" : "n/a"}` })))
      ),
      box,
      note("σ: the move divided by the stock's specific volatility over the same horizon. Beyond ±1.5 the move is unusual; beyond ±2 it is rare.")
    );
    draw(() => C.line(box, [{ name: "Specific return index", data, color: t.series[0], area: true }], { yFmt: (v) => U.num(v, 0), tipFmt: (v) => U.num(v, 1), height: 200, zeroLine: 100, dateFmt: U.date }));
    return c.root;
  }

  function fundamentalsCard(st) {
    const f = st.fund;
    const ccy = st.meta.currency;
    const c = U.card("Valuation, balance sheet & consensus", `Yahoo Finance data${f.balance_sheet_date ? `; balance sheet at ${U.date(f.balance_sheet_date)}` : ""}. P/B uses IFRS book value as a proxy for NAV.`);
    const cns = f.consensus || {};
    const counts = cns.counts ? `${cns.counts.strongBuy + cns.counts.buy} buy · ${cns.counts.hold} hold · ${cns.counts.sell + cns.counts.strongSell} sell` : null;
    c.body.appendChild(
      U.kv([
        ["Market cap", `${U.moneyCompact(f.market_cap_eur, "EUR")}${ccy !== "EUR" && isNum(f.market_cap) ? ` (${U.moneyCompact(f.market_cap, ccy)})` : ""}`],
        ["Book value per share", U.money(f.book_value_per_share, ccy)],
        ["P/B", U.mult(f.pb)],
        ["Dividend yield (trailing 12M)", `${U.pct(f.dividend_yield, 1)}${isNum(f.dps_ttm) ? ` · DPS ${U.money(f.dps_ttm, ccy)}` : ""}`],
        ["Forward P/E (consensus EPS)", U.mult(f.pe_forward, 1)],
        ["LTV proxy", U.pct(f.ltv, 1), "Net debt divided by total assets less cash."],
        ["Net debt / EBITDA (indicative)", U.mult(f.nd_ebitda, 1), "Yahoo EBITDA; omitted when it looks distorted by revaluations."],
        ["Interest cover (indicative)", U.mult(f.interest_cover, 1), "EBITDA over interest expense, from Yahoo statements."],
        ["EV / EBITDA (indicative)", U.mult(f.ev_ebitda, 1)],
        ["Revenue growth (last FY)", U.pct(f.revenue_growth, 1, true)],
        ["Avg daily traded value (3M)", U.moneyCompact(f.adv_3m_eur, "EUR")],
        ["Consensus target", isNum(cns.target_mean) ? `${U.money(cns.target_mean, ccy)} (${U.pct(cns.upside, 0, true)})` : DASH],
        ["Target range", isNum(cns.target_low) && isNum(cns.target_high) ? `${U.money(cns.target_low, ccy)} – ${U.money(cns.target_high, ccy)}` : DASH],
        ["Ratings", counts || (cns.rating ? `${cns.rating} (${cns.analysts || "?"} analysts)` : DASH)],
        ["Next results", f.next_results ? U.date(f.next_results) : f.last_results ? `last ${U.date(f.last_results)}` : DASH],
        f.ex_dividend ? [f.ex_dividend >= META.as_of ? "Next ex-dividend date" : "Last ex-dividend date", U.date(f.ex_dividend)] : null,
      ])
    );
    if (f.stale) c.body.appendChild(note("Fundamentals could not be refreshed today; these figures are from the previous refresh."));
    if (f.notes && f.notes.length) c.body.appendChild(note(f.notes.join(" ")));
    return c.root;
  }

  function profileCard(st) {
    const f = st.fund;
    const c = U.card("Company", st.meta.segment || "");
    if (f.description) c.body.appendChild(el("p", { style: { margin: 0, maxWidth: "95ch", color: "var(--ink-2)" }, text: f.description }));
    const bits = [];
    if (f.website) bits.push(el("a", { href: f.website, target: "_blank", rel: "noopener noreferrer", text: f.website.replace(/^https?:\/\//, "") }));
    if (f.employees) bits.push(el("span", { text: `${U.num(f.employees, 0)} employees` }));
    if (bits.length) c.body.appendChild(el("div", { class: "stats-line" }, bits));
    if (st.meta.note) c.body.appendChild(el("p", { class: "warn-note", text: st.meta.note }));
    return c.root;
  }

  // ------------------------------------------------------------------ exposures
  function exposures(panel) {
    const st = sel();
    const ids = modelIds();
    const all = fits(ids);
    const fit = all[st.i];
    const peers = peersOf(st);
    const c = U.card("Regression results", `${st.meta.name} ${freqWord()} total returns (${state.ccy === "EUR" ? "EUR" : "local currency"}) on the ${PRESETS[state.preset] ? PRESETS[state.preset].label.toLowerCase() : "custom"} factors. Newey-West standard errors.`);
    panel.appendChild(c.root);
    if (!fit.ok) {
      c.body.appendChild(failBox(fit.error || "The model could not be estimated for this stock."));
      return;
    }
    c.body.appendChild(
      el(
        "div",
        { class: "stats-line" },
        el("span", null, "Window ", el("b", { text: `${U.date(fit.start)} – ${U.date(fit.end)}` })),
        el("span", null, "Observations ", el("b", { text: String(fit.n) })),
        el("span", null, "R² ", el("b", { text: U.num(fit.r2, 2) })),
        el("span", null, "Adjusted R² ", el("b", { text: U.num(fit.adjR2, 2) })),
        el("span", null, "Alpha (annualised) ", el("b", { text: `${U.pct(fit.alphaAnn, 1, true)} (t ${U.num(fit.alphaT, 1)})` })),
        el("span", null, "Specific volatility ", el("b", { text: U.pct(fit.specificVolAnn, 1) })),
        el("span", null, "Newey-West lags ", el("b", { text: String(fit.lags) }))
      )
    );
    const rows = fit.factors.map((id) => {
      const peerBetas = peers.filter((p) => p !== st).map((p) => (all[p.i].ok ? all[p.i].betas[id] : NaN));
      const values = peers.map((p) => (all[p.i].ok ? all[p.i].betas[id] : NaN));
      const rank = FA.rankOf(values, fit.betas[id]);
      const k = fit.factors.indexOf(id);
      return {
        id,
        factor: factorLabel(id),
        beta: fit.betas[id],
        t: fit.t[id],
        sig: U.sig(fit.t[id]),
        impact: impact1s(fit, id),
        peer: median(peerBetas),
        rank: isNum(rank.rank) ? `${rank.rank} of ${rank.of}` : DASH,
        rankNum: rank.rank,
        share: fit.risk.share[k],
      };
    });
    c.body.appendChild(
      U.table(
        [
          { key: "factor", label: "Factor", title: "Hover a factor name in the picker for its definition" },
          { key: "beta", label: "Exposure", num: true, fmt: (v, r) => exposureText(r.id, v) },
          { key: "t", label: "t-stat", num: true, fmt: (v) => U.num(v, 2) },
          { key: "sig", label: "Sig.", fmt: (v) => v || "", sortable: false, title: "*** 1%, ** 5%, * 10%" },
          { key: "impact", label: "1σ move", num: true, fmt: (v) => U.pct(v, 2, true), title: `Share move for a one-standard-deviation ${freqWord()} factor move` },
          { key: "peer", label: `${st.meta.subsector} median`, num: true, fmt: (v, r) => exposureText(r.id, v) },
          { key: "rank", label: "Rank in sub-sector", num: true, sortValue: (r) => r.rankNum, title: "1 = highest exposure" },
          { key: "share", label: "Share of variance", num: true, fmt: (v) => U.pct(v, 0) },
        ],
        rows,
        { sortable: true, compact: true }
      )
    );
    const relNote = fit.factors.includes("SECTOR") && fit.factors.some((id) => F[id].group === "Rates" || F[id].group === "Credit")
      ? " With the sector factor in the model, rate and credit exposures measure sensitivity beyond the sector's own; pick a model without the sector for total sensitivities."
      : "";
    c.body.appendChild(note(`Market-type factors are betas (1.00 = moves one-for-one). Rate and spread factors show the share move for the standard shock. Sector and ETF style factors are orthogonalised to the market inside the window, so the market beta keeps its usual meaning.${relNote} ${fit.dropped.length ? "Left out: " + fit.dropped.map((d) => `${factorName(d.id)} (${d.reason})`).join("; ") + "." : ""}`));

    // Strip plot against the whole coverage.
    const strip = U.card("Exposure versus coverage", `Each dot is a coverage stock's one-standard-deviation impact. ${st.meta.name} in blue, ${st.meta.subsector} peers in orange.`);
    const t = C.tokens();
    const box = chartBox();
    strip.body.append(
      U.legend([
        { label: st.meta.name, color: t.series[0], kind: "dot" },
        { label: `${st.meta.subsector} peers`, color: t.series[1], kind: "dot" },
        { label: "Other coverage", color: t.other, kind: "dot" },
      ]),
      box
    );
    const stripRows = fit.factors.map((id) => ({
      label: factorName(id),
      points: STOCKS.map((p) => ({ v: impact1s(all[p.i], id), name: p.meta.name, kind: p === st ? "sel" : p.meta.subsector === st.meta.subsector ? "peer" : "other" })),
    }));
    draw(() =>
      C.strip(box, stripRows, {
        fmt: (v) => U.pct(v, 1, true),
        onClick: (name) => {
          const hit = STOCKS.find((s) => s.meta.name === name);
          if (hit) selectStock(hit.id);
        },
      })
    );
    panel.appendChild(strip.root);

    // Rolling betas as small multiples.
    const roll = once(`roll|${st.id}|${ids.join(",")}|${state.freq}|${state.ccy}`, () => M.rollingFit(ctx, st, ids, { freq: state.freq, ccy: state.ccy }));
    const rc = U.card("Rolling exposures", `${M.ROLLING_WINDOW[state.freq]}-${state.freq === "D" ? "day" : state.freq === "W" ? "week" : "month"} rolling regressions over the full history, with a ±2 standard error band. The flat line is the exposure over the selected window.`);
    if (!roll.ok) rc.body.appendChild(failBox(roll.error));
    else {
      const grid = el("div", { class: "grid-3" });
      for (const id of roll.factors) {
        const scale = F[id].unit === "bp" || F[id].unit === "pts" ? F[id].shock * 100 : 1;
        const fmt = F[id].unit === "bp" || F[id].unit === "pts" ? (v) => U.num(v, 2) + "%" : (v) => U.num(v, 2);
        const data = roll.dates.map((d, k) => [d, roll.beta[id][k] * scale]);
        const lo = roll.dates.map((d, k) => [d, (roll.beta[id][k] - 2 * roll.se[id][k]) * scale]);
        const hi = roll.dates.map((d, k) => [d, (roll.beta[id][k] + 2 * roll.se[id][k]) * scale]);
        const cell = el("div", { style: { minWidth: 0 } });
        const title = el("div", { style: { fontSize: "12.5px", fontWeight: 600 }, text: `${factorName(id)}${F[id].unit === "bp" || F[id].unit === "pts" ? ` (per ${F[id].shockLabel})` : ""}` });
        const box2 = chartBox();
        cell.append(title, box2);
        grid.appendChild(cell);
        const full = fit.ok && isNum(fit.betas[id]) ? fit.betas[id] * scale : null;
        draw(() =>
          C.line(box2, [{ name: factorName(id), data, color: t.series[0] }], {
            band: { lo, hi, color: t.series[0] },
            height: 170,
            yFmt: fmt,
            tipFmt: fmt,
            zeroLine: full == null ? 0 : full,
            dateFmt: U.date,
          })
        );
      }
      rc.body.appendChild(grid);
    }
    panel.appendChild(rc.root);
  }

  // ------------------------------------------------------------------ macro & scenarios
  function macro(panel) {
    const st = sel();
    const rows = macroSens(st);
    const peers = peersOf(st);
    const peerRows = peers.map((p) => (p === st ? rows : macroSens(p)));
    const c = U.card("Macro sensitivities", `Share move for a standard shock to each driver, ${windowWord()} regressions. "Total" regresses on the driver alone; "market held constant" adds the European market as a control.`);
    const data = rows.map((r) => {
      const peerVals = peerRows.map((pr) => {
        const x = pr.find((q) => q.id === r.id);
        return x ? (x.partialImpact != null ? x.partialImpact : x.totalImpact) : NaN;
      });
      const own = r.partialImpact != null ? r.partialImpact : r.totalImpact;
      const rank = FA.rankOf(peerVals, own, false);
      return {
        id: r.id,
        driver: r.id === "MKT" || r.id === "SECTOR" ? r.label : r.label,
        shock: r.id === "MKT" || r.id === "SECTOR" ? "+1%" : r.shockLabel,
        total: r.totalImpact,
        totalT: r.totalT,
        partial: r.partialImpact,
        partialT: r.partialT,
        r2: r.r2,
        peer: median(peerVals.filter((v, i) => peers[i] !== st)),
        rank: isNum(rank.rank) ? `${rank.rank} of ${rank.of}` : DASH,
        rankNum: rank.rank,
      };
    });
    c.body.appendChild(
      U.table(
        [
          { key: "driver", label: "Driver" },
          { key: "shock", label: "Shock", sortable: false },
          { key: "total", label: "Total effect", num: true, fmt: (v) => U.pct(v, 2, true) },
          { key: "totalT", label: "t", num: true, fmt: (v) => U.num(v, 1) },
          { key: "partial", label: "Market held constant", num: true, fmt: (v) => (v == null ? "·" : U.pct(v, 2, true)) },
          { key: "partialT", label: "t", num: true, fmt: (v) => (v == null ? "·" : U.num(v, 1)) },
          { key: "r2", label: "R² alone", num: true, fmt: (v) => U.num(v, 2) },
          { key: "peer", label: `${st.meta.subsector} median`, num: true, fmt: (v) => U.pct(v, 2, true) },
          { key: "rank", label: "Rank", num: true, sortValue: (r) => r.rankNum, title: "Rank in sub-sector, most negative effect = 1" },
        ],
        data,
        { sortable: true, compact: true }
      ),
      note(`Home 10Y for ${st.meta.name}: ${rateLabel(st)}. Market and sector rows are plain betas scaled to a +1% move. Peer medians use the market-held-constant effect where available.`)
    );
    panel.appendChild(c.root);

    // Rolling rate sensitivity versus peers.
    const rr = U.card("Rate sensitivity over time", `Rolling ${M.ROLLING_WINDOW[state.freq]}-${state.freq === "D" ? "day" : state.freq === "W" ? "week" : "month"} sensitivity to a +10bp move in the home 10Y yield (market held constant), against the ${st.meta.subsector} median.`);
    const box = chartBox();
    rr.body.appendChild(box);
    panel.appendChild(rr.root);
    const t = C.tokens();
    draw(() => {
      const rollOf = (p) => once(`rollrate|${p.id}|${state.freq}|${state.ccy}`, () => M.rollingFit(ctx, p, M.resolveFactors(ctx, ["MKT", "RATES"]), { freq: state.freq, ccy: state.ccy, step: state.freq === "D" ? 5 : 1 }));
      const mine = rollOf(st);
      if (!mine.ok || !mine.beta.RATES) {
        clear(box).appendChild(failBox("Not enough history for rolling estimates."));
        return;
      }
      const byDate = new Map();
      for (const p of peers) {
        if (p === st) continue;
        const r = rollOf(p);
        if (!r.ok || !r.beta.RATES) continue;
        r.dates.forEach((d, k) => {
          if (!byDate.has(d)) byDate.set(d, []);
          byDate.get(d).push(r.beta.RATES[k] * 1000);
        });
      }
      const medLine = mine.dates.filter((d) => byDate.has(d) && byDate.get(d).length >= 2).map((d) => [d, FA.median(byDate.get(d))]);
      const lines = [
        { name: st.meta.name, data: mine.dates.map((d, k) => [d, mine.beta.RATES[k] * 1000]), color: t.series[0], width: 2 },
        { name: `${st.meta.subsector} median`, data: medLine, color: t.series[1], width: 1.6 },
      ];
      rr.body.insertBefore(U.legend(lines.map((l) => ({ label: l.name, color: l.color }))), box);
      C.line(box, lines, { yFmt: (v) => U.num(v, 1) + "%", tipFmt: (v) => U.num(v, 2) + "%", height: 260, zeroLine: true, dateFmt: U.date });
    });

    panel.appendChild(scenarioCard(st));
    panel.appendChild(episodesCard(st));
  }

  function scenarioCard(st) {
    const ids = macroIds();
    const c = U.card("Scenario builder", `Model-implied share move for the shocks below, using each stock's ${windowWord()} macro model (market, home 10Y, credit, FX). With correlated moves on, factors you leave at zero move with the ones you shock, in line with their history.`);
    const creditId = ids.includes("CREDIT") ? "CREDIT" : ids.includes("CREDIT_ETF") ? "CREDIT_ETF" : null;
    const inputs = [
      { id: "MKT", label: "European equities", unit: "%", min: -30, max: 30, step: 1, hint: "STOXX Europe 600 total return" },
      { id: "RATES", label: "Home 10Y government yield", unit: "bp", min: -150, max: 150, step: 5, hint: "Each stock uses its own home market" },
    ];
    if (creditId === "CREDIT") inputs.push({ id: "CREDIT", label: "EUR high-yield spread", unit: "bp", min: -300, max: 500, step: 10, hint: "ICE BofA Euro HY OAS" });
    if (creditId === "CREDIT_ETF") inputs.push({ id: "CREDIT", label: "HY bonds vs governments", unit: "%", min: -15, max: 15, step: 0.5, hint: "Excess return of EUR high yield; negative = spreads widen" });
    inputs.push({ id: "FXL", label: "Home currency vs EUR", unit: "%", min: -15, max: 15, step: 0.5, hint: "Non-euro stocks only" });

    const left = el("div");
    const right = el("div", { style: { display: "grid", gap: "12px", minWidth: 0, alignContent: "start" } });
    const presets = [
      ["Rates +50bp", { MKT: 0, RATES: 50, CREDIT: 0, FXL: 0 }],
      ["Rates −50bp", { MKT: 0, RATES: -50, CREDIT: 0, FXL: 0 }],
      ["Equity sell-off", { MKT: -10, RATES: 0, CREDIT: 0, FXL: 0 }],
      ["Risk-off", { MKT: -10, RATES: -25, CREDIT: creditId === "CREDIT_ETF" ? -3 : 150, FXL: 0 }],
      ["Stagflation", { MKT: -5, RATES: 75, CREDIT: creditId === "CREDIT_ETF" ? -2 : 100, FXL: 0 }],
    ];
    left.appendChild(el("div", { class: "presets" }, presets.map(([label, v]) => el("button", { type: "button", class: "btn", text: label, onclick: () => { Object.assign(state.scen, v); update(); syncInputs(); } }))));
    const controls = {};
    for (const inp of inputs) {
      const id = `scen-${inp.id}`;
      const range = el("input", { type: "range", min: inp.min, max: inp.max, step: inp.step, value: state.scen[inp.id] || 0, "aria-label": `${inp.label} (${inp.unit})` });
      const number = el("input", { type: "number", class: "input", id, min: inp.min, max: inp.max, step: inp.step, value: state.scen[inp.id] || 0 });
      const onInput = (src) => {
        const v = Number(src.value);
        state.scen[inp.id] = isNum(v) ? v : 0;
        range.value = number.value = String(state.scen[inp.id]);
        update();
      };
      range.addEventListener("input", () => onInput(range));
      number.addEventListener("change", () => onInput(number));
      controls[inp.id] = { range, number };
      left.appendChild(el("div", { class: "shock" }, el("label", { for: id, text: `${inp.label} (${inp.unit})` }), number, range, el("span", { class: "hint", text: inp.hint })));
    }
    const condId = "scen-cond";
    const cond = el("input", { type: "checkbox", id: condId, checked: state.conditional });
    cond.addEventListener("change", () => {
      state.conditional = cond.checked;
      update();
    });
    left.appendChild(el("label", { for: condId, style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "8px", fontSize: "13px" } }, cond, "Correlated moves for factors left at zero"));
    function syncInputs() {
      for (const [id, ctl] of Object.entries(controls)) ctl.range.value = ctl.number.value = String(state.scen[id] || 0);
    }

    const shocksFor = (fit) => {
      const s = {};
      if (state.scen.MKT) s.MKT = state.scen.MKT / 100;
      if (state.scen.RATES) s.RATES = state.scen.RATES;
      if (state.scen.CREDIT) {
        if (fit.factors.includes("CREDIT")) s.CREDIT = state.scen.CREDIT;
        if (fit.factors.includes("CREDIT_ETF")) s.CREDIT_ETF = state.scen.CREDIT / 100;
      }
      if (state.scen.FXL && fit.factors.includes("FXL")) s.FXL = state.scen.FXL / 100;
      return s;
    };
    const figure = el("div", { class: "figure-row" });
    const breakdown = chartBox();
    const ranking = chartBox();
    const rankNote = el("p", { class: "note" });
    right.append(figure, el("div", { style: { fontSize: "12.5px", fontWeight: 600 }, text: "Where the move comes from" }), breakdown, el("div", { style: { fontSize: "12.5px", fontWeight: 600 }, text: `${st.meta.subsector} peers under the same scenario` }), ranking, rankNote);
    c.body.appendChild(el("div", { class: "scenario-grid" }, left, right));

    function update() {
      const all = fits(ids);
      const fit = all[st.i];
      clear(figure);
      if (!fit.ok) {
        figure.appendChild(failBox(fit.error || "No model"));
        return;
      }
      const res = M.scenario(fit, shocksFor(fit), state.conditional);
      const residSd = fit.specificVolAnn / Math.sqrt(fit.ppy);
      figure.append(
        el("div", { class: "figure" }, el("span", { class: "v", text: U.pct(res.total, 1, true) }), el("span", { class: "l", text: `${st.meta.name}, model-implied` })),
        el("div", { class: "figure" }, el("span", { class: "v", style: { fontSize: "20px" }, text: `±${U.pct(residSd, 1)}` }), el("span", { class: "l", text: `typical ${freqWord()} stock-specific noise` }))
      );
      const t = C.tokens();
      const items = fit.factors.map((id) => ({
        label: factorName(id),
        value: res.impacts[id],
        note: `Factor move ${F[id].unit === "bp" ? U.bp(res.moves[id], 0) : U.pct(res.moves[id], 1, true)} × exposure ${exposureText(id, fit.betas[id])}`,
      }));
      C.hbar(breakdown, items, { fmt: (v) => U.pct(v, 1, true), symmetric: true, valueName: "Contribution" });
      const peers = peersOf(st)
        .map((p) => {
          const pf = all[p.i];
          if (!pf.ok) return null;
          const r = M.scenario(pf, shocksFor(pf), state.conditional);
          return { label: p.meta.name, value: r.total, bold: p === st, color: p === st ? t.series[0] : t.otherStrong, id: p.id };
        })
        .filter(Boolean)
        .sort((a, b) => a.value - b.value);
      C.hbar(ranking, peers, { fmt: (v) => U.pct(v, 1, true), symmetric: true, labelWidth: 170, onClick: (it) => it && selectStock(it.id) });
      const everyone = STOCKS.map((p) => (all[p.i].ok ? M.scenario(all[p.i], shocksFor(all[p.i]), state.conditional).total : NaN));
      const rank = FA.rankOf(everyone, res.total, true);
      const sorted = STOCKS.map((p, i) => ({ p, v: everyone[i] })).filter((x) => isNum(x.v)).sort((a, b) => b.v - a.v);
      const best = sorted.slice(0, 3).map((x) => `${x.p.meta.name} ${U.pct(x.v, 1, true)}`).join(", ");
      const worst = sorted.slice(-3).reverse().map((x) => `${x.p.meta.name} ${U.pct(x.v, 1, true)}`).join(", ");
      rankNote.textContent = `Across all ${sorted.length} stocks, ${st.meta.name} ranks ${U.ordinal(rank.rank)}. Best placed: ${best}. Most exposed: ${worst}.`;
    }
    draw(update);
    return c.root;
  }

  function episodesCard(st) {
    const ids = macroIds();
    const all = fits(ids);
    const fit = all[st.i];
    const c = U.card("Historical stress episodes", `What today's macro exposures imply if each episode's factor moves happened again, next to what ${st.meta.name} actually did at the time.`);
    if (!fit.ok) {
      c.body.appendChild(failBox(fit.error || "No model"));
      return c.root;
    }
    const peers = peersOf(st);
    const rows = [];
    for (const ep of M.EPISODES) {
      const imp = M.episodeImpact(ctx, st, fit, ep, state.ccy);
      if (!imp) continue;
      const peerActual = median(peers.filter((p) => p !== st).map((p) => {
        const a = M.indexOnOrBefore(ctx.dates, ep.start);
        const b = M.indexOnOrBefore(ctx.dates, ep.end);
        const L = state.ccy === "EUR" ? p.triEur : p.tri;
        return a >= p.first ? L[b] / L[a] - 1 : NaN;
      }));
      rows.push({
        episode: ep.label,
        dates: `${U.date(imp.startDate)} – ${U.date(imp.endDate)}`,
        mkt: imp.moves.MKT,
        rates: imp.moves.RATES,
        credit: imp.moves.CREDIT != null ? imp.moves.CREDIT : imp.moves.CREDIT_ETF,
        creditIsBp: imp.moves.CREDIT != null,
        implied: imp.implied,
        actual: imp.actual,
        peer: peerActual,
      });
    }
    if (!rows.length) {
      c.body.appendChild(failBox("No episodes fall inside the data history."));
      return c.root;
    }
    c.body.appendChild(
      U.table(
        [
          { key: "episode", label: "Episode" },
          { key: "dates", label: "Dates", sortable: false },
          { key: "mkt", label: "Market", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "rates", label: "Home 10Y", num: true, fmt: (v) => U.bp(v, 0) },
          { key: "credit", label: "Credit", num: true, fmt: (v, r) => (r.creditIsBp ? U.bp(v, 0) : U.pct(v, 1, true)) },
          { key: "implied", label: "Implied today", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "actual", label: "Actual then", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "peer", label: "Peer median then", num: true, fmt: (v) => U.pct(v, 1, true) },
        ],
        rows,
        { sortable: false, compact: true }
      ),
      note("Implied moves ignore compounding and anything the macro factors do not capture, so long episodes are rougher. Actual returns are only shown where the stock was listed.")
    );
    return c.root;
  }

  // ------------------------------------------------------------------ attribution
  function attributionView(panel) {
    const st = sel();
    const att = attribution(st, state.attr);
    const bar = el(
      "div",
      { class: "controls" },
      el("div", { class: "control" }, el("span", { class: "lbl", text: "Period" }), U.seg(ATTR_PERIODS.map(([k]) => ({ value: k, label: k })), state.attr, (v) => { state.attr = v; persist(); renderPanel(); }, "Attribution period")),
      el(
        "div",
        { class: "control" },
        el("span", { class: "lbl", text: "Factors" }),
        U.seg(
          [
            { value: "sector", label: "Market, sector & macro", title: "Market, real estate sector, home 10Y yield, credit and FX: all up to date" },
            { value: "model", label: "Selected model", title: "The model chosen above; Fama-French factors lag by one to two months" },
          ],
          state.attrModel,
          (v) => {
            state.attrModel = v;
            persist();
            renderPanel();
          },
          "Attribution factors"
        )
      )
    );
    panel.appendChild(bar);
    if (!att.ok) {
      panel.appendChild(failBox(att.error || "Attribution unavailable."));
      return;
    }
    const tiles = el(
      "div",
      { class: "tiles", "data-n": "3" },
      U.tile("Total return", U.pct(att.total, 1, true), `${U.date(att.start)} – ${U.date(att.end)}`),
      U.tile("Explained by factors", U.pct(att.total - att.specific, 1, true), `${att.factors.length} factors`),
      U.tile("Stock-specific", U.pct(att.specific, 1, true), att.lastFit && att.lastFit.ok ? `${U.num(att.specific / (att.lastFit.specificVolAnn * Math.sqrt(att.days / 252)), 1)} σ` : "")
    );
    panel.appendChild(el("div", { class: "tiles-wrap" }, tiles));

    const grid = el("div", { class: "grid-2" });
    const c1 = U.card("Contribution by factor", "Daily contributions (exposure × factor return), linked with the Carino method so they add up to the total return. Exposures are re-estimated each month from data available at the time.");
    const t = C.tokens();
    const items = att.factors.map((id) => ({ label: factorName(id), value: att.contributions[id], note: `Average exposure ${exposureText(id, att.avgBeta[id])}` }));
    items.push({ label: "Stock-specific", value: att.specific, bold: true, color: isNum(att.specific) ? (att.specific < 0 ? t.neg : t.pos) : null });
    items.push({ label: "Total", value: att.total, bold: true, color: t.ink2 });
    const box = chartBox();
    c1.body.appendChild(box);
    draw(() => C.hbar(box, items, { fmt: (v) => U.pct(v, 1, true), symmetric: true, valueName: "Contribution" }));
    const missing = Object.entries(att.missing).filter(([, n]) => n > 0);
    if (missing.length) {
      const lagged = missing.some(([id]) => F[id].group === "Style: Fama-French");
      c1.body.appendChild(
        note(
          `Some factor data is not yet published for the latest days, so those moves count as stock-specific: ${missing.map(([id, n]) => `${factorName(id)} ${n} ${n === 1 ? "day" : "days"}`).join(", ")}.${lagged ? " The Fama-French factors arrive one to two months late; choose Market, sector & macro for an up-to-date split." : ""}`
        )
      );
    }
    const rows = att.factors.map((id) => ({
      id,
      factor: factorName(id),
      move: att.moves[id],
      moveTo: att.movesTo[id],
      exposure: att.avgBeta[id],
      contribution: att.contributions[id],
    }));
    c1.body.appendChild(
      U.table(
        [
          { key: "factor", label: "Factor" },
          {
            key: "move",
            label: "Factor move",
            num: true,
            fmt: (v, r) => {
              const txt = F[r.id].unit === "bp" ? U.bp(v, 0) : F[r.id].unit === "pts" ? U.num(v, 1, true) + " pts" : U.pct(v, 1, true);
              return r.moveTo && r.moveTo < att.end ? `${txt} (to ${U.date(r.moveTo, false)})` : txt;
            },
          },
          { key: "exposure", label: "Avg exposure", num: true, fmt: (v, r) => exposureText(r.id, v) },
          { key: "contribution", label: "Contribution", num: true, fmt: (v) => U.pct(v, 2, true) },
        ],
        rows,
        { sortable: true, sortKey: "contribution" }
      )
    );
    const c2 = U.card("Cumulative decomposition", "Total return split into the factor-explained and stock-specific parts through the period.");
    const box2 = chartBox();
    const lines = [
      { name: "Total", data: att.path.map((p) => [p.date, p.total * 100]), color: t.series[0], width: 2.2 },
      { name: "Factors", data: att.path.map((p) => [p.date, p.factors * 100]), color: t.series[2], width: 1.6 },
      { name: "Stock-specific", data: att.path.map((p) => [p.date, p.specific * 100]), color: t.series[1], width: 1.6 },
    ];
    c2.body.append(U.legend(lines.map((l) => ({ label: l.name, color: l.color }))), box2);
    draw(() => C.line(box2, lines, { yFmt: (v) => U.num(v, 0) + "%", tipFmt: (v) => U.num(v, 1, true) + "%", height: 300, zeroLine: true, dateFmt: U.date }));
    grid.append(c1.root, c2.root);
    panel.appendChild(grid);

    // Peers' stock-specific returns over the same period.
    const pc = U.card(`${st.meta.subsector}: stock-specific returns`, `Return not explained by the factors over ${state.attr}, for every ${st.meta.subsector} stock. Click a bar to open that stock.`);
    const pbox = chartBox();
    pc.body.appendChild(pbox);
    panel.appendChild(pc.root);
    draw(() => {
      const items2 = peersOf(st)
        .map((p) => {
          const a = attribution(p, state.attr);
          return a.ok ? { label: p.meta.name, value: a.specific, id: p.id, bold: p === st, color: p === st ? t.series[0] : t.otherStrong, note: `Total ${U.pct(a.total, 1, true)}, factors ${U.pct(a.total - a.specific, 1, true)}` } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.value - a.value);
      C.hbar(pbox, items2, { fmt: (v) => U.pct(v, 1, true), symmetric: true, labelWidth: 170, valueName: "Stock-specific", onClick: (it) => it && selectStock(it.id) });
    });
  }

  // ------------------------------------------------------------------ risk
  function risk(panel) {
    const st = sel();
    const fit = fits(modelIds())[st.i];
    const s = stats()[st.i];
    const capm = capmFits()[st.i];
    const tiles = el(
      "div",
      { class: "tiles", "data-n": "8" },
      U.tile("Volatility (window)", fit.ok ? U.pct(fit.volAnn, 1) : DASH, `${windowWord()}, annualised`),
      U.tile("Systematic", fit.ok ? U.pct(fit.systematicVolAnn, 1) : DASH, "from factor exposures"),
      U.tile("Stock-specific", fit.ok ? U.pct(fit.specificVolAnn, 1) : DASH, fit.ok ? `${U.pct(fit.risk.specificShare, 0)} of variance` : ""),
      U.tile("R²", fit.ok ? U.num(fit.r2, 2) : DASH, "share explained by factors"),
      U.tile("Max drawdown (1Y)", U.pct(s.maxDD1y, 1), "from the 1-year peak"),
      U.tile("1-day VaR 95%", U.pct(s.var95, 1), "historical, last year"),
      U.tile("1-day expected shortfall", U.pct(s.es95, 1), "average of the worst 5%"),
      U.tile("Beta vs STOXX 600", capm.ok ? U.num(capm.betas.MKT, 2) : DASH, `${windowWord()}, market only`)
    );
    panel.appendChild(el("div", { class: "tiles-wrap" }, tiles));
    const grid = el("div", { class: "grid-2" });
    const c1 = U.card("Where the risk comes from", "Share of return variance by factor (Euler decomposition: exposure × covariance). Negative shares offset risk.");
    if (fit.ok) {
      const t = C.tokens();
      const items = fit.factors.map((id, k) => ({ label: factorName(id), value: fit.risk.share[k], color: fit.risk.share[k] < 0 ? t.neg : t.series[0] }));
      items.push({ label: "Stock-specific", value: fit.risk.specificShare, color: t.series[1], bold: true });
      const box = chartBox();
      c1.body.appendChild(box);
      draw(() => C.hbar(box, items, { fmt: (v) => U.pct(v, 0), valueName: "Share of variance" }));
    } else c1.body.appendChild(failBox(fit.error || "Not available"));
    const c2 = U.card("Rolling volatility", "63-day realised volatility of daily returns, annualised.");
    const box2 = chartBox();
    c2.body.appendChild(box2);
    draw(() => {
      const t = C.tokens();
      const end = ctx.asOfIndex;
      const start = M.windowStart(ctx, end, state.years);
      const own = state.ccy === "EUR" ? st.triEur : st.tri;
      const sub = inViewCcy(M.peerIndex(ctx, st, "sub"), st);
      const mkt = ctx.series.MKT ? inViewCcy(ctx.series.MKT, st) : null;
      const lines = [
        { name: st.meta.name, data: rollingVol(own, start, end, st.obs), color: t.series[0], width: 2 },
        { name: `${st.meta.subsector} peers`, data: rollingVol(sub, start, end), color: t.series[1], width: 1.6 },
      ];
      if (mkt) lines.push({ name: "STOXX Europe 600", data: rollingVol(mkt, start, end), color: t.otherStrong, width: 1.6 });
      c2.body.insertBefore(U.legend(lines.map((l) => ({ label: l.name, color: l.color }))), box2);
      C.line(box2, lines, { yFmt: (v) => U.num(v, 0) + "%", tipFmt: (v) => U.num(v, 1) + "%", height: 260, dateFmt: U.date });
    });
    grid.append(c1.root, c2.root);
    panel.appendChild(grid);

    const c3 = U.card("Drawdown", `Decline from the running peak over the ${state.years}Y window.`);
    const box3 = chartBox();
    c3.body.appendChild(box3);
    panel.appendChild(c3.root);
    draw(() => {
      const t = C.tokens();
      const end = ctx.asOfIndex;
      const start = Math.max(M.windowStart(ctx, end, state.years), st.first);
      const own = state.ccy === "EUR" ? st.triEur : st.tri;
      const sub = inViewCcy(M.peerIndex(ctx, st, "sub"), st);
      const dd = (L) => {
        const pts = seriesPoints(L, start, end, false);
        const d = FA.drawdowns(pts.map((p) => p[1])).series;
        return pts.map((p, k) => [p[0], d[k] * 100]);
      };
      const lines = [
        { name: st.meta.name, data: dd(own), color: t.series[0], width: 2, area: true },
        { name: `${st.meta.subsector} peers`, data: dd(sub), color: t.series[1], width: 1.6 },
      ];
      c3.body.insertBefore(U.legend(lines.map((l) => ({ label: l.name, color: l.color }))), box3);
      C.line(box3, lines, { yFmt: (v) => U.num(v, 0) + "%", tipFmt: (v) => U.num(v, 1) + "%", height: 220, dateFmt: U.date });
    });

    // Correlations and pair spreads.
    const allFits = fits(modelIds());
    const corr = once(`corr|${st.id}|${modelIds().join(",")}|${setKey()}`, () => M.correlations(ctx, st, allFits, opts()));
    const rows = corr
      .filter((r) => r.id !== st.id && isNum(r.ret))
      .map((r) => {
        const other = ctx.byId[r.id];
        const pair = M.pairSpread(ctx, st, other);
        return { id: r.id, name: other.meta.name, subsector: other.meta.subsector, ret: r.ret, resid: r.resid, z: pair ? pair.z : NaN, rel3m: pair ? pair.change3m : NaN, peer: other.meta.subsector === st.meta.subsector };
      })
      .sort((a, b) => b.ret - a.ret)
      .slice(0, 12);
    const c4 = U.card("Closest peers and pair spreads", "Most correlated coverage stocks (weekly EUR returns over the window); an orange edge marks the same sub-sector. Specific correlation uses the model residuals. The spread z-score compares today's price ratio with its 1-year history: positive means the selected stock has outperformed that peer.");
    c4.body.appendChild(
      U.table(
        [
          { key: "name", label: "Stock", link: true },
          { key: "subsector", label: "Sub-sector" },
          { key: "ret", label: "Return corr.", num: true, fmt: (v) => U.num(v, 2) },
          { key: "resid", label: "Specific corr.", num: true, fmt: (v) => U.num(v, 2) },
          { key: "z", label: "Spread z (1Y)", num: true, fmt: (v) => U.num(v, 1, true) },
          { key: "rel3m", label: "Relative 3M", num: true, fmt: (v) => U.pct(v, 1, true) },
        ],
        rows,
        { sortable: true, onRowClick: (r) => selectStock(r.id), rowClass: (r) => (r.peer ? "peer" : "") }
      )
    );
    panel.appendChild(c4.root);

    const c5 = U.card(`${st.meta.subsector} correlation matrix`, `Correlation of weekly EUR returns over the ${state.years}Y window.`);
    const box5 = chartBox();
    c5.body.appendChild(box5);
    panel.appendChild(c5.root);
    draw(() => {
      const peers = peersOf(st);
      const ret = peers.map((p) => weeklyReturns(p));
      const cells = [];
      peers.forEach((a, i) =>
        peers.forEach((b, j) => {
          const v = i === j ? 1 : pairCorr(ret[i], ret[j]);
          cells.push({ r: i, c: j, v: isNum(v) ? (v - 0.5) * 6 : null, text: U.num(v, 2), tip: `Correlation ${U.num(v, 2)} with ${b.meta.name}` });
        })
      );
      C.heatmap(box5, peers.map((p) => p.meta.name), peers.map((p) => p.id), cells, { limit: 3, selectedRow: peers.indexOf(st), rowHeight: 24, onRowClick: (r) => selectStock(peers[r].id) });
    });
    panel.appendChild(note("Heatmap colours are centred on a correlation of 0.5: blue above, red below."));
  }

  function rollingVol(levels, start, end, obs) {
    const out = [];
    const win = 63;
    const rets = [];
    for (let t = Math.max(start - win, 1); t <= end; t++) {
      const r = levels[t] / levels[t - 1] - 1;
      if (obs && !obs[t]) continue;
      if (!isNum(r)) continue;
      rets.push(r);
      if (rets.length > win) rets.shift();
      if (t >= start && rets.length >= 40) out.push([ctx.dates[t], FA.std(rets) * Math.sqrt(252) * 100]);
    }
    return out;
  }

  function weeklyReturns(st) {
    return once(`wret|${st.id}|${state.years}`, () => {
      const end = ctx.asOfIndex;
      const start = M.windowStart(ctx, end, state.years);
      const pts = M.samplePoints(ctx, st, "W", start, end);
      const m = new Map();
      for (let k = 1; k < pts.length; k++) {
        const r = st.triEur[pts[k]] / st.triEur[pts[k - 1]] - 1;
        if (isNum(r)) m.set(pts[k], r);
      }
      return m;
    });
  }

  function pairCorr(a, b) {
    const x = [];
    const y = [];
    for (const [k, v] of a) if (b.has(k)) {
      x.push(v);
      y.push(b.get(k));
    }
    return x.length > 20 ? FA.correlation(x, y) : NaN;
  }

  // ------------------------------------------------------------------ peers & value
  const METRICS = {
    pb: { label: "P/B (P/NAV proxy)", get: (st) => st.fund.pb, fmt: (v) => U.mult(v) },
    dy: { label: "Dividend yield", get: (st) => st.fund.dividend_yield, fmt: (v) => U.pct(v, 1) },
    ltv: { label: "LTV proxy", get: (st) => st.fund.ltv, fmt: (v) => U.pct(v, 0) },
    pe: { label: "Forward P/E", get: (st) => st.fund.pe_forward, fmt: (v) => U.mult(v, 1) },
    upside: { label: "Consensus upside", get: (st) => st.fund.consensus && st.fund.consensus.upside, fmt: (v) => U.pct(v, 0, true) },
    mcap: { label: "Market cap (EUR bn)", get: (st) => (isNum(st.fund.market_cap_eur) ? st.fund.market_cap_eur / 1e9 : NaN), fmt: (v) => U.num(v, 1) },
    beta: { label: "Beta vs STOXX 600", get: (st) => (capmFits()[st.i].ok ? capmFits()[st.i].betas.MKT : NaN), fmt: (v) => U.num(v, 2) },
    rate10: { label: "Rate sensitivity (% per +10bp)", get: (st) => (macroFit(st).ok && isNum(macroFit(st).betas.RATES) ? macroFit(st).betas.RATES * 1000 : NaN), fmt: (v) => U.num(v, 2) + "%" },
    specvol: { label: "Specific volatility", get: (st) => (macroFit(st).ok ? macroFit(st).specificVolAnn : NaN), fmt: (v) => U.pct(v, 0) },
    vol: { label: "Volatility (1Y daily)", get: (st) => stats()[st.i].vol1y, fmt: (v) => U.pct(v, 0) },
    r1y: { label: "1Y total return", get: (st) => stats()[st.i].ret.y1, fmt: (v) => U.pct(v, 0, true) },
    r3m: { label: "3M total return", get: (st) => stats()[st.i].ret.m3, fmt: (v) => U.pct(v, 1, true) },
    mom: { label: "Momentum (12-1M)", get: (st) => stats()[st.i].mom12_1, fmt: (v) => U.pct(v, 0, true) },
  };
  const macroFit = (st) => fits(macroIds())[st.i];

  function peers(panel) {
    const st = sel();
    const c = U.card("Relative value map", "Pick any two measures. Blue is the selected stock, orange its sub-sector peers. The line is a least-squares fit across the coverage; click a dot to open that stock.");
    const opts2 = Object.entries(METRICS).map(([k, m]) => ({ value: k, label: m.label }));
    c.tools.append(
      el("label", { class: "control" }, el("span", { class: "lbl", text: "X" }), U.select(opts2, state.sx, (v) => { state.sx = v; persist(); renderPanel(); }, { "aria-label": "X axis measure" })),
      el("label", { class: "control" }, el("span", { class: "lbl", text: "Y" }), U.select(opts2, state.sy, (v) => { state.sy = v; persist(); renderPanel(); }, { "aria-label": "Y axis measure" }))
    );
    const mx = METRICS[state.sx] || METRICS.rate10;
    const my = METRICS[state.sy] || METRICS.pb;
    const pts = STOCKS.map((p) => ({ x: mx.get(p), y: my.get(p), name: p.meta.name, id: p.id, kind: p === st ? "sel" : p.meta.subsector === st.meta.subsector ? "peer" : "other" }));
    const fitLine = FA.fitLine(pts.map((p) => p.x), pts.map((p) => p.y));
    const box = chartBox();
    const t = C.tokens();
    c.body.append(
      U.legend([
        { label: st.meta.name, color: t.series[0], kind: "dot" },
        { label: `${st.meta.subsector} peers`, color: t.series[1], kind: "dot" },
        { label: "Other coverage", color: t.otherStrong, kind: "dot" },
      ]),
      el("div", { style: { fontSize: "12px", color: "var(--ink-2)", marginBottom: "-6px" }, text: `↑ ${my.label}` }),
      box
    );
    const me = pts[st.i];
    if (fitLine && isNum(me.x) && isNum(me.y)) {
      const expected = fitLine.intercept + fitLine.slope * me.x;
      c.body.appendChild(note(`${st.meta.name}: ${my.label} of ${my.fmt(me.y)} against ${my.fmt(expected)} on the fitted line at its ${mx.label.toLowerCase()} of ${mx.fmt(me.x)}. The line explains ${U.pct(fitLine.r2, 0)} of the variation across ${fitLine.n} stocks.`));
    }
    draw(() => C.scatter(box, pts, { xFmt: mx.fmt, yFmt: my.fmt, xName: mx.label, yName: my.label, showYName: false, fit: fitLine, onClick: (id) => selectStock(id) }));
    panel.appendChild(c.root);

    // Style characteristics.
    const ch = chars();
    const peersList = peersOf(st);
    const sc = U.card("Style characteristics", "Where the stock sits on each characteristic, in standard deviations from the coverage average (winsorised). Black ticks mark the sub-sector average.");
    const items = ch.map((d) => ({
      label: d.label,
      value: d.z[st.i],
      marker: FA.mean(peersList.map((p) => d.z[p.i])),
      note: `Raw value ${fmtChar(d, st.i)}`,
    }));
    const box2 = chartBox();
    sc.body.appendChild(box2);
    draw(() => C.hbar(box2, items, { fmt: (v) => U.num(v, 1, true), labelFmt: (v) => U.num(v, 2, true), symmetric: true, valueColumn: true, markerName: `${st.meta.subsector} average`, valueName: "z-score", labelWidth: 190 }));
    const crow = ch.map((d) => {
      const vals = peersList.map((p) => d.raw[p.i]);
      const rank = FA.rankOf(vals, d.raw[st.i]);
      return { label: d.label, value: fmtChar(d, st.i), z: d.z[st.i], rank: isNum(rank.rank) ? `${rank.rank} of ${rank.of}` : DASH, rankNum: rank.rank };
    });
    sc.body.appendChild(
      U.table(
        [
          { key: "label", label: "Characteristic" },
          { key: "value", label: "Value", num: true },
          { key: "z", label: "z vs coverage", num: true, fmt: (v) => U.num(v, 2, true) },
          { key: "rank", label: "Rank in sub-sector (1 = highest)", num: true, sortValue: (r) => r.rankNum },
        ],
        crow,
        { sortable: false }
      )
    );
    panel.appendChild(sc.root);

    // Peer table.
    const pc = U.card(`${st.meta.subsector} peer table`, "Click a name to open it.");
    const mf = fits(macroIds());
    const rows = peersList.map((p) => {
      const s = stats()[p.i];
      const f = p.fund;
      return {
        id: p.id,
        name: p.meta.name,
        mcap: f.market_cap_eur,
        pb: f.pb,
        dy: f.dividend_yield,
        ltv: f.ltv,
        pe: f.pe_forward,
        upside: f.consensus && f.consensus.upside,
        r3m: s.ret.m3,
        r1y: s.ret.y1,
        beta: capmFits()[p.i].ok ? capmFits()[p.i].betas.MKT : NaN,
        rate: mf[p.i].ok && isNum(mf[p.i].betas.RATES) ? mf[p.i].betas.RATES * 10 : NaN,
      };
    });
    pc.body.appendChild(
      U.table(
        [
          { key: "name", label: "Stock", link: true },
          { key: "mcap", label: "Mkt cap", num: true, fmt: (v) => U.moneyCompact(v, "EUR") },
          { key: "pb", label: "P/B", num: true, fmt: (v) => U.mult(v) },
          { key: "dy", label: "Div. yield", num: true, fmt: (v) => U.pct(v, 1) },
          { key: "ltv", label: "LTV proxy", num: true, fmt: (v) => U.pct(v, 0) },
          { key: "pe", label: "Fwd P/E", num: true, fmt: (v) => U.mult(v, 1) },
          { key: "upside", label: "Cons. upside", num: true, fmt: (v) => U.pct(v, 0, true) },
          { key: "r3m", label: "3M", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "r1y", label: "1Y", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "beta", label: "Beta", num: true, fmt: (v) => U.num(v, 2) },
          { key: "rate", label: "Per +10bp", num: true, fmt: (v) => U.pct(v, 2, true) },
        ],
        rows,
        { sortable: true, sortKey: "mcap", onRowClick: (r) => selectStock(r.id), rowClass: (r) => (r.id === st.id ? "sel" : "") }
      )
    );
    panel.appendChild(pc.root);
  }

  function fmtChar(d, i) {
    const src = d.show ? d.show[i] : d.raw[i];
    if (!isNum(src)) return DASH;
    if (d.fmt === "pct") return U.pct(src, 1);
    if (d.fmt === "x") return U.mult(src);
    if (d.fmt === "eur") return U.moneyCompact(src, "EUR");
    return U.num(src, 2);
  }

  // ------------------------------------------------------------------ coverage
  function coverage(panel) {
    const st = sel();
    const ids = modelIds();
    const all = fits(ids);
    const hc = U.card("Exposure heatmap", `All ${STOCKS.length} stocks, ${windowWord()} ${PRESETS[state.preset] ? PRESETS[state.preset].label.toLowerCase() : "custom"} model. Colour shows ${state.heat === "t" ? "the t-statistic (blue positive, red negative; pale = not significant)" : "the one-standard-deviation impact"}; the number is the exposure. Click a row to open that stock.`);
    hc.tools.appendChild(U.seg([{ value: "t", label: "t-stat" }, { value: "impact", label: "1σ impact" }], state.heat, (v) => { state.heat = v; persist(); renderPanel(); }, "Heatmap colour"));
    const order = [];
    for (const ss of SUBS) for (const p of STOCKS) if (p.meta.subsector === ss) order.push(p);
    const rows = order.map((p) => `${p.meta.name}`);
    const cols = ids.map(factorName);
    const cells = [];
    const impacts = order.flatMap((p) => ids.map((id) => impact1s(all[p.i], id))).filter(isNum).map(Math.abs);
    const impactScale = impacts.length ? FA.quantile(impacts, 0.9) : 1;
    order.forEach((p, r) => {
      const fit = all[p.i];
      ids.forEach((id, c) => {
        const ok = fit.ok && isNum(fit.betas[id]);
        const tv = ok ? fit.t[id] : NaN;
        const v = state.heat === "t" ? tv : ok ? (impact1s(fit, id) / impactScale) * 3 : NaN;
        const f = F[id];
        const text = ok ? (f.unit === "bp" || f.unit === "pts" ? U.num(fit.betas[id] * f.shock * 100, 2) : U.num(fit.betas[id], 2)) : "";
        cells.push({ r, c, v, text, tip: ok ? `Exposure ${exposureText(id, fit.betas[id])}, t ${U.num(tv, 1)}` : fit.error || "not in model" });
      });
    });
    const box = chartBox();
    hc.body.appendChild(box);
    hc.body.appendChild(note("Rate and spread columns show the % move per standard shock (e.g. per +10bp); other columns show betas."));
    draw(() => C.heatmap(box, rows, cols, cells, { limit: 3, selectedRow: order.indexOf(st), onRowClick: (r) => selectStock(order[r].id) }));
    panel.appendChild(hc.root);

    // Universe table.
    const mf = fits(macroIds());
    const tc = U.card("Coverage table", "Sort any column. Copy the table to paste into Excel.");
    const trows = order.map((p) => {
      const s = stats()[p.i];
      const f = p.fund;
      const fm = mf[p.i];
      return {
        id: p.id,
        name: p.meta.name,
        ticker: p.meta.ticker,
        subsector: p.meta.subsector,
        mcap: f.market_cap_eur,
        pb: f.pb,
        dy: f.dividend_yield,
        ltv: f.ltv,
        upside: f.consensus && f.consensus.upside,
        r1m: s.ret.m1,
        r3m: s.ret.m3,
        ytd: s.ret.ytd,
        r1y: s.ret.y1,
        vol: s.vol1y,
        beta: capmFits()[p.i].ok ? capmFits()[p.i].betas.MKT : NaN,
        rate: fm.ok && isNum(fm.betas.RATES) ? fm.betas.RATES * 10 : NaN,
        r2: fm.ok ? fm.r2 : NaN,
      };
    });
    const cols2 = [
      { key: "name", label: "Stock", link: true, cellClass: "clip" },
      { key: "ticker", label: "Ticker", fmt: (v) => el("span", { class: "mono", text: v }) },
      { key: "mcap", label: "Mkt cap", num: true, fmt: (v) => U.moneyCompact(v, "EUR") },
      { key: "pb", label: "P/B", num: true, fmt: (v) => U.mult(v) },
      { key: "dy", label: "Div. yield", num: true, fmt: (v) => U.pct(v, 1), csv: (r) => r.dy },
      { key: "ltv", label: "LTV", num: true, fmt: (v) => U.pct(v, 0) },
      { key: "upside", label: "Upside", num: true, fmt: (v) => U.pct(v, 0, true) },
      { key: "r1m", label: "1M", num: true, fmt: (v) => U.pct(v, 1, true) },
      { key: "r3m", label: "3M", num: true, fmt: (v) => U.pct(v, 1, true) },
      { key: "ytd", label: "YTD", num: true, fmt: (v) => U.pct(v, 1, true) },
      { key: "r1y", label: "1Y", num: true, fmt: (v) => U.pct(v, 1, true) },
      { key: "vol", label: "Vol 1Y", num: true, fmt: (v) => U.pct(v, 0) },
      { key: "beta", label: "Beta", num: true, fmt: (v) => U.num(v, 2) },
      { key: "rate", label: "Per +10bp", num: true, fmt: (v) => U.pct(v, 2, true) },
      { key: "r2", label: "R²", num: true, fmt: (v) => U.num(v, 2) },
    ];
    const tbl = U.table(cols2, trows, { sortable: true, compact: true, onRowClick: (r) => selectStock(r.id), rowClass: (r) => (r.id === st.id ? "sel" : ""), groupBy: (r) => r.subsector, maxHeight: "560px" });
    const copyBtn = el("button", { type: "button", class: "btn", text: "Copy as CSV", onclick: () => U.copyText(tbl.toCSV(), copyBtn) });
    tc.tools.appendChild(copyBtn);
    tc.body.appendChild(tbl);
    panel.appendChild(tc.root);

    // Sub-sector averages.
    const sc = U.card("Sub-sector averages", "Medians across each sub-sector.");
    const srows = SUBS.map((ss) => {
      const members = trows.filter((r) => r.subsector === ss);
      const med = (k) => median(members.map((r) => r[k]));
      return { subsector: ss, n: members.length, pb: med("pb"), dy: med("dy"), ltv: med("ltv"), r3m: med("r3m"), r1y: med("r1y"), beta: med("beta"), rate: med("rate"), vol: med("vol") };
    });
    sc.body.appendChild(
      U.table(
        [
          { key: "subsector", label: "Sub-sector" },
          { key: "n", label: "Stocks", num: true },
          { key: "pb", label: "P/B", num: true, fmt: (v) => U.mult(v) },
          { key: "dy", label: "Div. yield", num: true, fmt: (v) => U.pct(v, 1) },
          { key: "ltv", label: "LTV", num: true, fmt: (v) => U.pct(v, 0) },
          { key: "r3m", label: "3M", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "r1y", label: "1Y", num: true, fmt: (v) => U.pct(v, 1, true) },
          { key: "beta", label: "Beta", num: true, fmt: (v) => U.num(v, 2) },
          { key: "rate", label: "Per +10bp", num: true, fmt: (v) => U.pct(v, 2, true) },
          { key: "vol", label: "Vol 1Y", num: true, fmt: (v) => U.pct(v, 0) },
        ],
        srows,
        { sortable: true }
      )
    );
    panel.appendChild(sc.root);
  }

  // ------------------------------------------------------------------ data & method
  function sourceName(key) {
    const src = (META.sources || {})[key];
    return src ? src.name.replace(/,.*$/, "") : key || "";
  }

  function method(panel) {
    const c = U.card("Data sources and freshness", `Built ${META.generated_at ? META.generated_at.replace("T", " ").replace("Z", " UTC") : "?"}; prices to ${U.date(META.as_of)}. Every input is public.`);
    const status = META.series_status || {};
    const rows = Object.entries(DATA.series)
      .map(([id, s]) => ({ id, label: s.label, group: s.group, source: sourceName(s.source), code: s.code || "", last: s.last || "", status: s.stale ? "stale" : "ok" }))
      .concat(
        Object.entries(status)
          .filter(([id, s]) => !DATA.series[id] && s.status === "failed")
          .map(([id, s]) => ({ id, label: s.label || id, group: "", source: "", code: "", last: "", status: "failed", err: (s.errors || []).join("; ") }))
      );
    c.body.appendChild(
      U.table(
        [
          { key: "label", label: "Series" },
          { key: "group", label: "Group" },
          { key: "source", label: "Source" },
          { key: "code", label: "Code", fmt: (v) => el("span", { class: "mono", text: v || DASH }) },
          { key: "last", label: "Last observation", fmt: (v) => (v ? U.date(v) : DASH) },
          { key: "status", label: "Status", fmt: (v, r) => el("span", { class: v === "ok" ? "status-ok" : v === "failed" ? "status-bad" : "status-stale", title: r.err || null, text: v === "ok" ? "Up to date" : v === "failed" ? "Unavailable" : "Previous refresh" }) },
        ],
        rows,
        { sortable: true, sortKey: "group", sortDir: "asc" }
      )
    );
    const src = META.sources || {};
    c.body.appendChild(
      el(
        "ul",
        { style: { margin: 0, paddingLeft: "18px", display: "grid", gap: "4px", fontSize: "13px", color: "var(--ink-2)" } },
        Object.values(src).map((s) => el("li", null, el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", text: s.name }), `: ${s.used_for}`))
      )
    );
    panel.appendChild(c.root);

    const m = U.card("How the numbers are built", "");
    const P = (text) => el("p", { text });
    m.body.appendChild(
      el(
        "div",
        { class: "method" },
        el("h3", { text: "Returns" }),
        P("Share returns are total returns (dividends reinvested) from Yahoo Finance adjusted closes, in the stock's own currency or in EUR. Weekly returns run Friday to Friday; daily returns use each stock's own trading days so exchange holidays do not create false moves."),
        el("h3", { text: "Factors" }),
        el(
          "ul",
          null,
          M.FACTORS.filter((f) => M.available(ctx, f.id)).map((f) => el("li", null, el("b", { text: `${f.label}: ` }), f.desc))
        ),
        el("h3", { text: "Regressions" }),
        P("Exposures come from ordinary least squares with an intercept over the chosen window. t-statistics use Newey-West standard errors (Bartlett kernel, lag = floor(4·(n/100)^(2/9))), the same as statsmodels. Rolling charts use plain OLS errors. Factors with no variation in the window (for example FX for euro stocks) are dropped."),
        el("h3", { text: "Attribution" }),
        P("Each trading day's return is split into exposure × factor return plus a stock-specific remainder. Exposures are re-estimated at the start of every month using only the preceding window, so the attribution uses no information from the future. Daily pieces are linked with the Carino method so they add up exactly to the period return."),
        el("h3", { text: "Risk and scenarios" }),
        P("Variance is decomposed as exposure × factor covariance × exposure plus residual variance (Euler contributions). Scenarios multiply the chosen shocks by each stock's macro exposures; with correlated moves on, unshocked factors take their conditional expectation given the shocks, from the factor covariance in the window."),
        el("h3", { text: "Fundamentals" }),
        P("Book value, debt, cash and EBITDA come from the latest Yahoo Finance statements, converted into the quote currency. P/B uses IFRS book value as a proxy for NAV, and the LTV proxy is net debt over total assets less cash; both differ from company-reported EPRA figures. EBITDA-based ratios are left out when Yahoo's EBITDA margin looks distorted by revaluations. Consensus targets and ratings are Yahoo Finance's aggregates."),
        el("h3", { text: "Coverage notes" }),
        el(
          "ul",
          null,
          STOCKS.filter((s) => s.meta.note).map((s) => el("li", null, el("b", { text: `${s.meta.name}: ` }), s.meta.note))
        ),
        el("h3", { text: "Use" }),
        P("For research and discussion only. Public data can be late, revised or wrong; check figures against company filings and your own models before using them with clients.")
      )
    );
    panel.appendChild(m.root);
  }

  // ------------------------------------------------------------------ boot
  build();
  renderControls();
  renderTabs();
  updateRail();
  renderHead();
  renderPanel();
  setHash();
})();
