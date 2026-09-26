/*
 * Property Factor Lens - DOM helpers and number formatting.
 * All text goes in through textContent; nothing is parsed as HTML.
 */
(function (root) {
  "use strict";

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const DASH = "–";

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, String(v));
      }
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ------------------------------------------------------------------ formatting
  const nf = (dp) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const cache = {};
  const numf = (dp) => cache[dp] || (cache[dp] = nf(dp));
  const MINUS = "−";

  function num(x, dp = 2, sign = false) {
    if (!isNum(x)) return DASH;
    const s = numf(dp).format(Math.abs(x));
    if (x < 0 && Number(s.replace(/,/g, "")) !== 0) return MINUS + s;
    return (sign && x > 0 ? "+" : "") + s;
  }

  const pct = (x, dp = 1, sign = false) => (isNum(x) ? num(x * 100, dp, sign) + "%" : DASH);
  const pp = (x, dp = 1) => (isNum(x) ? num(x * 100, dp, true) + " pp" : DASH);
  const bp = (x, dp = 0, sign = true) => (isNum(x) ? num(x, dp, sign) + " bp" : DASH);
  const mult = (x, dp = 2) => (isNum(x) ? num(x, dp) + "x" : DASH);

  function compact(x, dp = 1) {
    if (!isNum(x)) return DASH;
    const a = Math.abs(x);
    if (a >= 1e9) return num(x / 1e9, dp) + "bn";
    if (a >= 1e6) return num(x / 1e6, dp) + "m";
    if (a >= 1e3) return num(x / 1e3, dp) + "k";
    return num(x, dp);
  }

  const SYMBOL = { EUR: "€", GBP: "£", USD: "$" };
  function money(x, ccy = "EUR", dp = 2) {
    if (!isNum(x)) return DASH;
    const sym = SYMBOL[ccy];
    const body = num(Math.abs(x), dp);
    const sign = x < 0 ? MINUS : "";
    return sym ? `${sign}${sym}${body}` : `${sign}${ccy} ${body}`;
  }
  function moneyCompact(x, ccy = "EUR") {
    if (!isNum(x)) return DASH;
    const sym = SYMBOL[ccy];
    return sym ? `${sym}${compact(x)}` : `${ccy} ${compact(x)}`;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function date(iso, withYear = true) {
    if (!iso) return DASH;
    const [y, m, d] = iso.split("-");
    return withYear ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : `${Number(d)} ${MONTHS[Number(m) - 1]}`;
  }
  const monthYear = (iso) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : DASH);

  function tstat(t) {
    return isNum(t) ? `t ${num(t, 1)}` : DASH;
  }

  /** Significance label for a t statistic (two-sided, normal approximation). */
  function sig(t) {
    if (!isNum(t)) return "";
    const a = Math.abs(t);
    if (a >= 2.58) return "***";
    if (a >= 1.96) return "**";
    if (a >= 1.65) return "*";
    return "";
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ------------------------------------------------------------------ components
  function tile(label, value, sub, attrs = {}) {
    return el("div", { class: "tile", ...attrs }, el("span", { class: "tile-label", text: label }), el("span", { class: "tile-value", text: value }), sub != null ? el("span", { class: "tile-sub", text: sub }) : null);
  }

  function card(title, sub, opts = {}) {
    const head = el("div", { class: "card-head" }, el("div", null, el("h3", { class: "card-title", text: title }), sub ? el("p", { class: "card-sub", text: sub }) : null));
    const tools = el("div", { class: "card-tools" });
    head.appendChild(tools);
    const body = el("div", { class: "card-body", style: { display: "grid", gap: "10px", minWidth: "0" } });
    const root = el("section", { class: "card" + (opts.class ? " " + opts.class : ""), id: opts.id }, head, body);
    return { root, body, tools };
  }

  function seg(options, value, onChange, label) {
    const group = el("div", { class: "seg", role: "group", "aria-label": label });
    for (const opt of options) {
      group.appendChild(
        el("button", {
          type: "button",
          "aria-pressed": String(opt.value === value),
          text: opt.label,
          title: opt.title || null,
          onclick: () => onChange(opt.value),
        })
      );
    }
    return group;
  }

  function select(options, value, onChange, attrs = {}) {
    const s = el("select", attrs);
    for (const opt of options) {
      if (opt.group) {
        const g = el("optgroup", { label: opt.group });
        for (const o of opt.options) g.appendChild(el("option", { value: o.value, text: o.label, selected: o.value === value }));
        s.appendChild(g);
      } else {
        s.appendChild(el("option", { value: opt.value, text: opt.label, selected: opt.value === value }));
      }
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  function kv(pairs) {
    const dl = el("dl", { class: "kv" });
    for (const p of pairs) {
      if (!p) continue;
      const [k, v, note] = p;
      dl.appendChild(el("dt", { text: k, title: note || null }));
      dl.appendChild(el("dd", null, v instanceof Node ? v : String(v)));
    }
    return dl;
  }

  function legend(items) {
    return el(
      "div",
      { class: "legend" },
      items.map((it) =>
        el("span", null, el("i", { class: it.kind === "dot" ? "key-dot" : it.kind === "rect" ? "key-rect" : "key-line", style: { background: it.color } }), it.label)
      )
    );
  }

  /**
   * Sortable table.
   * columns: [{key, label, num, fmt(value,row), sortValue(row), title, class}]
   * opts: {rows, sortKey, sortDir, onRowClick, rowClass(row), groupBy(row), maxHeight}
   */
  function table(columns, rows, opts = {}) {
    const wrap = el("div", { class: "table-wrap", style: opts.maxHeight ? { maxHeight: opts.maxHeight, overflowY: "auto" } : null });
    let sortKey = opts.sortKey || null;
    let sortDir = opts.sortDir || "desc";
    const render = () => {
      clear(wrap);
      const tbl = el("table", { class: "table" + (opts.compact ? " compact" : "") });
      const thead = el("thead");
      const tr = el("tr");
      for (const c of columns) {
        const th = el("th", { class: (c.num ? "num " : "") + (c.class || ""), scope: "col", title: c.title || null });
        if (opts.sortable !== false && c.sortable !== false) {
          if (sortKey === c.key) th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
          th.appendChild(
            el("button", {
              type: "button",
              class: "sort",
              onclick: () => {
                if (sortKey === c.key) sortDir = sortDir === "asc" ? "desc" : "asc";
                else {
                  sortKey = c.key;
                  sortDir = c.num ? "desc" : "asc";
                }
                render();
              },
              text: c.label + (sortKey === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""),
            })
          );
        } else th.textContent = c.label;
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      tbl.appendChild(thead);
      const tbody = el("tbody");
      let data = rows.slice();
      if (sortKey) {
        const col = columns.find((c) => c.key === sortKey);
        const val = (r) => (col && col.sortValue ? col.sortValue(r) : r[sortKey]);
        data.sort((a, b) => {
          const va = val(a);
          const vb = val(b);
          const na = va == null || (typeof va === "number" && !Number.isFinite(va));
          const nb = vb == null || (typeof vb === "number" && !Number.isFinite(vb));
          if (na && nb) return 0;
          if (na) return 1;
          if (nb) return -1;
          const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
          return sortDir === "asc" ? cmp : -cmp;
        });
      }
      let lastGroup = null;
      for (const r of data) {
        if (opts.groupBy && !sortKey) {
          const g = opts.groupBy(r);
          if (g !== lastGroup) {
            tbody.appendChild(el("tr", { class: "group-row" }, el("td", { colspan: columns.length, text: g })));
            lastGroup = g;
          }
        }
        const row = el("tr", { class: opts.rowClass ? opts.rowClass(r) : null });
        for (const c of columns) {
          const v = r[c.key];
          const content = c.fmt ? c.fmt(v, r) : v == null ? DASH : String(v);
          const td = el("td", { class: (c.num ? "num " : "") + (c.cellClass || "") });
          if (c.link && opts.onRowClick) {
            td.appendChild(el("button", { type: "button", class: "link", onclick: () => opts.onRowClick(r) }, content instanceof Node ? content : String(content)));
          } else if (content instanceof Node) td.appendChild(content);
          else td.textContent = content;
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
    };
    render();
    wrap.toCSV = () => {
      const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const lines = [columns.map((c) => esc(c.label)).join(",")];
      for (const r of rows) {
        lines.push(
          columns
            .map((c) => {
              const v = c.csv ? c.csv(r) : r[c.key];
              return esc(v == null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v));
            })
            .join(",")
        );
      }
      return lines.join("\n");
    };
    return wrap;
  }

  /** Copy text; falls back to selecting it in a textarea when the clipboard is refused. */
  function copyText(text, button) {
    const done = (msg) => {
      if (!button) return;
      const old = button.textContent;
      button.textContent = msg;
      setTimeout(() => (button.textContent = old), 1600);
    };
    try {
      navigator.clipboard.writeText(text).then(
        () => done("Copied"),
        () => fallback()
      );
    } catch (e) {
      fallback();
    }
    function fallback() {
      const ta = el("textarea", { style: { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0" } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      done(ok ? "Copied" : "Copy blocked");
    }
  }

  function signClass(x) {
    return isNum(x) ? (x > 0 ? "pos" : x < 0 ? "neg" : "") : "";
  }

  root.PFUI = {
    isNum,
    DASH,
    el,
    append,
    clear,
    num,
    pct,
    pp,
    bp,
    mult,
    compact,
    money,
    moneyCompact,
    date,
    monthYear,
    tstat,
    sig,
    ordinal,
    tile,
    card,
    seg,
    select,
    kv,
    legend,
    table,
    copyText,
    signClass,
  };
})(typeof self !== "undefined" ? self : this);
