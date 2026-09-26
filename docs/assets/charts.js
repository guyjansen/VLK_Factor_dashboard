/*
 * Property Factor Lens - chart builders on top of ECharts.
 * Colours come from the CSS tokens so charts follow the page theme.
 * Tooltips lead with the value; labels are escaped.
 */
(function (root) {
  "use strict";

  const registry = new Map();
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function tokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      ink: v("--ink"),
      ink2: v("--ink-2"),
      muted: v("--muted"),
      hairline: v("--hairline"),
      baseline: v("--baseline"),
      surface: v("--surface"),
      surface2: v("--surface-2"),
      accent: v("--accent"),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
      pos: v("--pos"),
      neg: v("--neg"),
      mid: v("--mid"),
      other: v("--other"),
      otherStrong: v("--other-strong"),
      font: v("--font-body") || "system-ui, sans-serif",
    };
  }

  function mount(el, option) {
    if (!root.echarts) {
      el.textContent = "Charts need the ECharts library, which did not load.";
      return null;
    }
    let chart = registry.get(el);
    if (!chart || chart.isDisposed()) {
      chart = root.echarts.init(el, null, { renderer: "canvas" });
      registry.set(el, chart);
      if (root.ResizeObserver) {
        const ro = new ResizeObserver(() => {
          if (!chart.isDisposed()) chart.resize();
        });
        ro.observe(el);
        chart.__ro = ro;
      }
    }
    chart.setOption(option, true);
    return chart;
  }

  function disposeWithin(node) {
    for (const [el, chart] of registry) {
      if (!document.contains(el) || (node && node.contains(el))) {
        if (chart.__ro) chart.__ro.disconnect();
        if (!chart.isDisposed()) chart.dispose();
        registry.delete(el);
      }
    }
  }

  function base(t) {
    return {
      animation: false,
      textStyle: { fontFamily: t.font, color: t.ink2, fontSize: 12 },
      tooltip: {
        backgroundColor: t.surface,
        borderColor: t.hairline,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: t.ink, fontSize: 12, fontFamily: t.font },
        extraCssText: "box-shadow:0 6px 18px rgba(0,0,0,.14);border-radius:6px;",
        confine: true,
      },
    };
  }

  function valueAxis(t, fmt, extra = {}) {
    return Object.assign(
      {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.muted, formatter: fmt, hideOverlap: true },
        splitLine: { lineStyle: { color: t.hairline, width: 1 } },
        scale: true,
      },
      extra
    );
  }

  function row(color, label, value, kind = "line") {
    const key =
      kind === "dot"
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`
        : `<span style="display:inline-block;width:12px;height:2px;border-radius:2px;background:${color};margin:0 6px 3px 0"></span>`;
    return `<div style="display:flex;justify-content:space-between;gap:14px;align-items:center"><span style="color:inherit;opacity:.8">${key}${esc(label)}</span><b style="font-variant-numeric:tabular-nums">${esc(value)}</b></div>`;
  }

  // ------------------------------------------------------------------ time series
  /**
   * series: [{name, data:[[isoDate, value]], color, width, area, z, endLabel}]
   * opts: {yFmt, tipFmt, height, zeroLine, band:{lo,hi,color}}
   */
  function line(el, series, opts = {}) {
    const t = tokens();
    const yFmt = opts.yFmt || ((v) => v);
    const tipFmt = opts.tipFmt || yFmt;
    el.style.height = (opts.height || 260) + "px";
    const s = series.map((sr, i) => ({
      type: "line",
      name: sr.name,
      data: sr.data,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 7,
      connectNulls: false,
      z: sr.z || 2 + (series.length - i),
      lineStyle: { width: sr.width || 2, color: sr.color, type: sr.dashed ? [4, 3] : "solid", cap: "round", join: "round" },
      itemStyle: { color: sr.color, borderColor: t.surface, borderWidth: 2 },
      areaStyle: sr.area ? { color: sr.color, opacity: 0.1 } : undefined,
      emphasis: { disabled: true },
      endLabel: sr.endLabel
        ? {
            show: true,
            formatter: (p) => `${sr.endLabel === true ? sr.name : sr.endLabel}  ${yFmt(p.value[1])}`,
            color: t.ink,
            fontSize: 11.5,
            distance: 6,
          }
        : undefined,
      markLine:
        i === 0 && opts.zeroLine
          ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: t.baseline, width: 1, type: "solid" }, data: [{ yAxis: opts.zeroLine === true ? 0 : opts.zeroLine }] }
          : undefined,
    }));
    if (opts.band) {
      // Confidence band as a stacked area: invisible lower edge plus the width.
      s.unshift(
        { type: "line", name: "__lo", data: opts.band.lo, stack: "band", stackStrategy: "all", showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, tooltip: { show: false }, silent: true, z: 1 },
        {
          type: "line",
          name: "__band",
          data: opts.band.hi.map((d, k) => [d[0], isNum(d[1]) && isNum(opts.band.lo[k][1]) ? d[1] - opts.band.lo[k][1] : null]),
          stack: "band",
          stackStrategy: "all",
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: { color: opts.band.color, opacity: 0.16 },
          tooltip: { show: false },
          silent: true,
          z: 1,
        }
      );
    }
    const option = Object.assign(base(t), {
      grid: { left: 6, right: opts.rightPad || 16, top: 14, bottom: 6, containLabel: true },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: t.baseline } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: valueAxis(t, yFmt, opts.yAxis || {}),
      tooltip: Object.assign(base(t).tooltip, {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.baseline, width: 1 } },
        formatter: (params) => {
          const ps = params.filter((p) => !String(p.seriesName).startsWith("__"));
          if (!ps.length) return "";
          const d = ps[0].value[0];
          const head = `<div style="margin-bottom:4px;color:${t.muted}">${esc(opts.dateFmt ? opts.dateFmt(d) : d)}</div>`;
          return head + ps.filter((p) => isNum(p.value[1])).map((p) => row(p.color, p.seriesName, tipFmt(p.value[1]))).join("");
        },
      }),
      series: s,
    });
    return mount(el, option);
  }

  // ------------------------------------------------------------------ horizontal bars
  /** Round a tick interval up to 1, 2, 3, 4, 5, 6 or 8 times a power of ten. */
  function niceStep(x) {
    if (!(x > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / mag;
    const steps = [1, 2, 3, 4, 5, 6, 8, 10];
    return steps.find((v) => f <= v + 1e-9) * mag;
  }

  /**
   * items: [{label, value, color?, marker?, note?, bold?}]
   * opts: {fmt, labelFmt, symmetric, markerName, valueName, onClick, labelWidth, valueColumn}
   * Positive bars use --pos, negative --neg unless an item sets a colour.
   * With valueColumn the values sit in a fixed column on the right, which keeps
   * them clear of the reference ticks.
   */
  function hbar(el, items, opts = {}) {
    const t = tokens();
    const fmt = opts.fmt || ((v) => v);
    const labelFmt = opts.labelFmt || fmt;
    const rowH = opts.rowHeight || 26;
    el.style.height = Math.max(110, items.length * rowH + 34) + "px";
    const labelWidth = opts.labelWidth || 150;
    const gridLeft = labelWidth + 16;
    const valueColumn = !!opts.valueColumn;
    const cats = items.map((it) => it.label);
    const markers = items.map((it) => (isNum(it.marker) ? it.marker : null));
    const finiteVals = items.map((it) => it.value).concat(markers).filter(isNum);
    const lo = Math.min(0, ...finiteVals);
    const hi = Math.max(0, ...finiteVals);
    const pad = valueColumn ? 1.08 : 1.3;
    // Pick a round tick interval first, then bounds on whole intervals, so
    // every tick label is an exact round number.
    let min;
    let max;
    let interval;
    if (opts.symmetric) {
      interval = niceStep((Math.max(Math.abs(lo), Math.abs(hi), 1e-9) * pad) / 2);
      min = -2 * interval;
      max = 2 * interval;
    } else {
      interval = niceStep(((hi - lo) * pad || 1e-9) / 4);
      max = Math.ceil((hi * pad) / interval - 1e-9) * interval;
      min = Math.floor((lo * pad) / interval + 1e-9) * interval;
    }
    const yAxes = [
      {
        type: "category",
        data: cats,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: t.ink2,
          fontSize: 12,
          width: labelWidth,
          overflow: "truncate",
          ellipsis: "…",
          rich: { b: { fontWeight: 600, color: t.ink, fontSize: 12 } },
          formatter: (v, i) => (items[i] && items[i].bold ? `{b|${v}}` : v),
        },
      },
    ];
    if (valueColumn) {
      yAxes.push({
        type: "category",
        data: cats,
        inverse: true,
        position: "right",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: t.ink,
          fontSize: 12,
          align: "right",
          margin: 56,
          formatter: (v, i) => (items[i] && isNum(items[i].value) ? labelFmt(items[i].value, items[i]) : "–"),
        },
      });
    }
    const option = Object.assign(base(t), {
      grid: { left: gridLeft, right: valueColumn ? 64 : 30, top: 6, bottom: 22, containLabel: false },
      xAxis: valueAxis(t, fmt, { scale: false, min, max, interval }),
      yAxis: yAxes,
      tooltip: Object.assign(base(t).tooltip, {
        trigger: "item",
        formatter: (p) => {
          const it = items[p.dataIndex];
          if (!it) return "";
          let html = `<div style="margin-bottom:4px;color:${t.muted}">${esc(it.label)}</div>`;
          html += row(barColor(it, t), opts.valueName || "Value", fmt(it.value), "dot");
          if (isNum(it.marker)) html += row(t.ink, opts.markerName || "Reference", fmt(it.marker), "dot");
          if (it.note) html += `<div style="margin-top:4px;color:${t.muted};max-width:260px;white-space:normal">${esc(it.note)}</div>`;
          return html;
        },
      }),
      series: [
        {
          type: "bar",
          yAxisIndex: 0,
          data: items.map((it) => ({
            value: isNum(it.value) ? it.value : null,
            itemStyle: {
              color: barColor(it, t),
              borderRadius: isNum(it.value) && it.value < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 16,
          barCategoryGap: "38%",
          label: {
            show: !valueColumn && opts.labels !== false,
            position: "right",
            formatter: (p) => (isNum(p.value) ? labelFmt(p.value, items[p.dataIndex]) : ""),
            color: t.ink2,
            fontSize: 11.5,
          },
          labelLayout: (p) => {
            const it = items[p.dataIndex];
            if (valueColumn || !it || !isNum(it.value) || it.value >= 0) return {};
            // Negative bars: put the label left of the bar when there is room.
            const w = p.labelRect ? p.labelRect.width : 40;
            if (p.rect.x - w - 8 > gridLeft) return { x: p.rect.x - 6, align: "right" };
            return {};
          },
          markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: t.baseline, width: 1, type: "solid" }, data: [{ xAxis: 0 }] },
          z: 2,
        },
        {
          type: "scatter",
          name: opts.markerName || "Reference",
          yAxisIndex: 0,
          data: markers.map((m) => (m == null ? null : m)),
          symbol: "rect",
          symbolSize: [3, 16],
          itemStyle: { color: t.ink },
          z: 3,
          tooltip: { show: false },
        },
      ],
    });
    const chart = mount(el, option);
    if (chart && opts.onClick) {
      chart.off("click");
      chart.on("click", (p) => opts.onClick(items[p.dataIndex], p.dataIndex));
    }
    return chart;
  }

  function barColor(it, t) {
    if (it.color) return it.color;
    return isNum(it.value) && it.value < 0 ? t.neg : t.pos;
  }

  // ------------------------------------------------------------------ strip plot
  /**
   * rows: [{label, points:[{v, name, kind:"other"|"peer"|"sel"}]}]
   */
  function strip(el, rows, opts = {}) {
    const t = tokens();
    const fmt = opts.fmt || ((v) => v);
    el.style.height = Math.max(160, rows.length * 34 + 44) + "px";
    const cats = rows.map((r) => r.label);
    const kinds = { other: { c: t.other, s: 7, z: 1 }, peer: { c: t.series[1], s: 8, z: 2 }, sel: { c: t.series[0], s: 13, z: 3 } };
    const series = ["other", "peer", "sel"].map((k) => ({
      type: "scatter",
      name: k,
      symbolSize: kinds[k].s,
      itemStyle: { color: kinds[k].c, borderColor: t.surface, borderWidth: k === "sel" ? 2 : 1, opacity: k === "other" ? 0.9 : 1 },
      z: kinds[k].z,
      data: rows.flatMap((r, ri) => r.points.filter((p) => p.kind === k && isNum(p.v)).map((p) => ({ value: [p.v, ri], name: p.name }))),
      emphasis: { scale: 1.4 },
    }));
    const option = Object.assign(base(t), {
      grid: { left: 126, right: 28, top: 6, bottom: 24, containLabel: false },
      xAxis: valueAxis(t, fmt, { scale: true }),
      yAxis: {
        type: "category",
        data: cats,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink2, fontSize: 12, width: 112, overflow: "truncate", ellipsis: "…" },
        splitLine: { show: true, lineStyle: { color: t.hairline } },
      },
      tooltip: Object.assign(base(t).tooltip, {
        trigger: "item",
        formatter: (p) => `<div style="margin-bottom:4px;color:${t.muted}">${esc(cats[p.value[1]])}</div>` + row(p.color, p.name, fmt(p.value[0]), "dot"),
      }),
      series,
    });
    const chart = mount(el, option);
    if (chart && opts.onClick) {
      chart.off("click");
      chart.on("click", (p) => opts.onClick(p.name));
    }
    return chart;
  }

  // ------------------------------------------------------------------ scatter
  /**
   * points: [{x, y, name, id, kind}], opts: {xFmt, yFmt, xName, yName, fit:{slope,intercept}, onClick}
   */
  function scatter(el, points, opts = {}) {
    const t = tokens();
    el.style.height = (opts.height || 420) + "px";
    const xFmt = opts.xFmt || ((v) => v);
    const yFmt = opts.yFmt || ((v) => v);
    const kinds = { other: { c: t.otherStrong, s: 9, z: 1 }, peer: { c: t.series[1], s: 10, z: 2 }, sel: { c: t.series[0], s: 15, z: 4 } };
    const series = ["other", "peer", "sel"].map((k) => ({
      type: "scatter",
      name: k,
      symbolSize: kinds[k].s,
      z: kinds[k].z,
      itemStyle: { color: kinds[k].c, borderColor: t.surface, borderWidth: 2 },
      data: points.filter((p) => p.kind === k && isNum(p.x) && isNum(p.y)).map((p) => ({ value: [p.x, p.y], name: p.name, id: p.id })),
      label: {
        show: k !== "other",
        formatter: (p) => p.data.name,
        position: "right",
        color: t.ink2,
        fontSize: 11,
        distance: 4,
      },
      labelLayout: { hideOverlap: true },
      emphasis: { scale: 1.3, label: { show: true } },
    }));
    const xs = points.map((p) => p.x).filter(isNum);
    if (opts.fit && xs.length) {
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      series.push({
        type: "line",
        name: "fit",
        data: [
          [lo, opts.fit.intercept + opts.fit.slope * lo],
          [hi, opts.fit.intercept + opts.fit.slope * hi],
        ],
        showSymbol: false,
        silent: true,
        lineStyle: { color: t.baseline, width: 1.5 },
        tooltip: { show: false },
        z: 0,
      });
    }
    const option = Object.assign(base(t), {
      grid: { left: 10, right: 30, top: 34, bottom: 30, containLabel: true },
      xAxis: valueAxis(t, xFmt, { name: opts.xName, nameLocation: "middle", nameGap: 28, nameTextStyle: { color: t.ink2, fontSize: 12 } }),
      yAxis: valueAxis(t, yFmt, { name: opts.yName, nameLocation: "end", nameGap: 10, nameTextStyle: { color: t.ink2, fontSize: 12, align: "left" } }),
      tooltip: Object.assign(base(t).tooltip, {
        trigger: "item",
        formatter: (p) =>
          `<div style="margin-bottom:4px;font-weight:600">${esc(p.name)}</div>` +
          row(p.color, opts.xName || "x", xFmt(p.value[0]), "dot") +
          row(p.color, opts.yName || "y", yFmt(p.value[1]), "dot"),
      }),
      series,
    });
    const chart = mount(el, option);
    if (chart && opts.onClick) {
      chart.off("click");
      chart.on("click", (p) => p.data && p.data.id && opts.onClick(p.data.id));
    }
    return chart;
  }

  // ------------------------------------------------------------------ heatmap
  /**
   * rows: [labels], cols: [labels], cells: [{r, c, v, text, tip}], opts: {limit, onRowClick, selectedRow}
   * Diverging blue/red scale centred on zero with a grey midpoint.
   */
  function heatmap(el, rows, cols, cells, opts = {}) {
    const t = tokens();
    const rowH = opts.rowHeight || 20;
    el.style.height = rows.length * rowH + 70 + "px";
    const limit = opts.limit || 3;
    const option = Object.assign(base(t), {
      grid: { left: 6, right: 12, top: 40, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: cols,
        position: "top",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink2, fontSize: 11.5, interval: 0, hideOverlap: false },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: rows,
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: t.ink2,
          fontSize: 11.5,
          width: 190,
          overflow: "truncate",
          rich: { sel: { color: t.ink, fontWeight: 700 } },
          formatter: (v, i) => (i === opts.selectedRow ? `{sel|${v}}` : v),
        },
      },
      visualMap: {
        show: false,
        min: -limit,
        max: limit,
        dimension: 2,
        inRange: { color: [t.neg, t.mid, t.pos] },
      },
      tooltip: Object.assign(base(t).tooltip, {
        trigger: "item",
        formatter: (p) => {
          const cell = cells[p.dataIndex];
          return `<div style="margin-bottom:4px;font-weight:600">${esc(rows[cell.r])}</div><div style="color:${t.muted};margin-bottom:4px">${esc(cols[cell.c])}</div>${cell.tip ? esc(cell.tip) : ""}`;
        },
      }),
      series: [
        {
          type: "heatmap",
          data: cells.map((c) => {
            const v = isNum(c.v) ? Math.max(-limit, Math.min(limit, c.v)) : null;
            // Strong fills take white text; pale fills near zero take ink.
            const strong = v != null && Math.abs(v) > 0.55 * limit;
            return { value: [c.c, c.r, v], label: { color: strong ? "#ffffff" : t.ink } };
          }),
          label: {
            show: true,
            fontSize: 10.5,
            formatter: (p) => cells[p.dataIndex].text || "",
          },
          itemStyle: { borderColor: t.surface, borderWidth: 2 },
          emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
        },
      ],
    });
    const chart = mount(el, option);
    if (chart && opts.onRowClick) {
      chart.off("click");
      chart.on("click", (p) => {
        const cell = cells[p.dataIndex];
        if (cell) opts.onRowClick(cell.r);
      });
    }
    return chart;
  }

  root.PFCharts = { tokens, mount, disposeWithin, line, hbar, strip, scatter, heatmap };
})(typeof self !== "undefined" ? self : this);
