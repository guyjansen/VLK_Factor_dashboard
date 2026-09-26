"""Turn raw Yahoo fundamentals into a clean, unit-consistent snapshot.

Yahoo mixes units: London prices are in pence while statements are in pounds,
and statements can be in a different currency from the quote (e.g. Cibus
reports in EUR and trades in SEK). Every figure here is converted into the
stock's quote currency in major units before ratios are formed, and ratios
outside plausible ranges are dropped rather than shown.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone

import numpy as np
import pandas as pd

EQUITY_ROWS = ("Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest")
ASSET_ROWS = ("Total Assets",)
DEBT_ROWS = ("Total Debt",)
CASH_ROWS = (
    "Cash And Cash Equivalents",
    "Cash Cash Equivalents And Short Term Investments",
    "Cash Financial",
)
MINORITY_ROWS = ("Minority Interest",)
SHARE_ROWS = ("Ordinary Shares Number", "Share Issued")
PROPERTY_ROWS = ("Investment Properties",)
REVENUE_ROWS = ("Total Revenue", "Operating Revenue")
EBITDA_ROWS = ("Normalized EBITDA", "EBITDA")
INTEREST_ROWS = ("Interest Expense", "Interest Expense Non Operating")

REC_LABELS = {
    "strong_buy": "Strong buy",
    "buy": "Buy",
    "hold": "Hold",
    "underperform": "Underperform",
    "sell": "Sell",
}


def _num(value) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _in_range(value: float | None, lo: float, hi: float) -> float | None:
    return value if value is not None and lo <= value <= hi else None


def _statement_column(df: pd.DataFrame | None) -> tuple[pd.Series | None, pd.Timestamp | None]:
    """Most recent period of a statement that has any data."""
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return None, None
    cols = sorted(df.columns, key=lambda c: pd.Timestamp(c), reverse=True)
    for col in cols:
        column = pd.to_numeric(df[col], errors="coerce")
        if column.notna().sum() >= 3:
            return column, pd.Timestamp(col)
    return None, None


def _pick(column: pd.Series | None, rows: tuple[str, ...]) -> float | None:
    if column is None:
        return None
    for row in rows:
        if row in column.index:
            value = column.loc[row]
            if isinstance(value, pd.Series):
                value = value.dropna().iloc[0] if value.notna().any() else None
            value = _num(value)
            if value is not None:
                return value
    return None


def _complete(column: pd.Series | None) -> bool:
    return column is not None and all(_pick(column, rows) is not None for rows in (ASSET_ROWS, DEBT_ROWS, EQUITY_ROWS))


def _latest_balance_sheet(raw: dict) -> tuple[pd.Series | None, pd.Timestamp | None, pd.Series | None]:
    """Newest balance sheet column with assets, debt and equity; the other statement is the fallback."""
    q_col, q_date = _statement_column(raw.get("quarterly_balance_sheet"))
    a_col, a_date = _statement_column(raw.get("balance_sheet"))
    if _complete(q_col) and (not _complete(a_col) or q_date >= a_date):
        return q_col, q_date, a_col
    if a_col is not None:
        return a_col, a_date, q_col
    return q_col, q_date, None


def convert(amount: float | None, from_ccy: str | None, to_ccy: str, fx: dict) -> float | None:
    """Convert using 'units per EUR' rates; returns None when a rate is missing."""
    if amount is None:
        return None
    from_ccy = (from_ccy or to_ccy).upper()
    to_ccy = to_ccy.upper()
    if from_ccy == to_ccy:
        return amount
    if from_ccy not in fx or to_ccy not in fx:
        return None
    return amount * fx[to_ccy] / fx[from_ccy]


def _price_ratio_fix(ratio: float | None, lo: float, hi: float) -> float | None:
    """Correct 100x unit mix-ups in a ratio of two prices, then range-check."""
    if ratio is None or ratio <= 0:
        return None
    if ratio > 20:
        ratio /= 100.0
    elif ratio < 0.05:
        ratio *= 100.0
    return _in_range(ratio, lo, hi)


def _multiple_fix(value: float | None, lo: float, hi: float, fx_factor: float = 1.0) -> float | None:
    """P/E style multiples from Yahoo (price / EPS).

    Yahoo divides the quote price by EPS in the reporting currency, so the
    ratio can be off by a pence factor (100x) or by an exchange rate. Try the
    raw value first, then the corrected ones, and keep the first plausible one.
    """
    value = _num(value)
    if value is None or value <= 0:
        return None
    for candidate in (value, value * fx_factor, value / 100.0, value * fx_factor / 100.0):
        if lo <= candidate <= hi:
            return candidate
    return None


def _short_description(text: str | None, limit: int = 600) -> str | None:
    if not text:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = cut.rfind(". ")
    return (cut[: end + 1] if end > limit * 0.5 else cut.rstrip() + "…").strip()


def _iso(value) -> str | None:
    try:
        ts = pd.Timestamp(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(ts):
        return None
    return ts.strftime("%Y-%m-%d")


def _calendar(raw_calendar, as_of: pd.Timestamp | None = None) -> dict:
    out: dict = {}
    if not raw_calendar:
        return out
    cal = raw_calendar
    if isinstance(cal, pd.DataFrame):
        cal = {k: cal.loc[k].tolist() for k in cal.index}
    if not isinstance(cal, dict):
        return out
    earnings = cal.get("Earnings Date")
    if earnings is not None:
        dates = earnings if isinstance(earnings, (list, tuple)) else [earnings]
        iso = sorted(d for d in (_iso(x) for x in dates) if d)
        cutoff = (as_of or pd.Timestamp.today()).strftime("%Y-%m-%d")
        upcoming = [d for d in iso if d >= cutoff]
        if upcoming:
            out["next_results"] = upcoming[0]
        elif iso:
            out["last_results"] = iso[-1]
    for key, name in (("Ex-Dividend Date", "ex_dividend"), ("Dividend Date", "dividend_payment")):
        if cal.get(key) is not None:
            iso = _iso(cal.get(key))
            if iso:
                out[name] = iso
    return out


def _recommendation_counts(df) -> dict | None:
    if df is None or not isinstance(df, pd.DataFrame) or df.empty:
        return None
    row = df[df["period"] == "0m"] if "period" in df.columns else df.iloc[:1]
    if row.empty:
        row = df.iloc[:1]
    row = row.iloc[0]
    keys = ("strongBuy", "buy", "hold", "sell", "strongSell")
    counts = {k: int(_num(row.get(k)) or 0) for k in keys}
    return counts if sum(counts.values()) > 0 else None


def trailing_dividends(dividends, as_of: pd.Timestamp, days: int = 365) -> float | None:
    if dividends is None or not isinstance(dividends, pd.Series) or dividends.empty:
        return None
    idx = pd.DatetimeIndex(dividends.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    s = pd.Series(dividends.to_numpy(dtype=float), index=idx)
    window = s[(s.index > as_of - pd.Timedelta(days=days)) & (s.index <= as_of)]
    return float(window.sum()) if not window.empty else 0.0


def compute_snapshot(
    raw: dict,
    *,
    quote_currency: str,
    price_scale: float,
    last_price: float,
    as_of: pd.Timestamp,
    fx: dict,
) -> dict:
    """Build the fundamentals block for one stock.

    ``quote_currency`` is the ISO major currency of the quote (GBP for pence
    quotes), ``price_scale`` converts Yahoo's raw quote units to major units
    and ``last_price`` is already in major units. ``fx`` maps ISO currency to
    units per EUR.
    """
    info = raw.get("info") or {}
    fin_ccy = (info.get("financialCurrency") or quote_currency or "EUR").upper()
    snap: dict = {"quote_currency": quote_currency, "financial_currency": fin_ccy}
    notes: list[str] = []

    def to_quote(amount: float | None) -> float | None:
        return convert(amount, fin_ccy, quote_currency, fx)

    # Shares: prefer Yahoo's implied count (all share classes) when it is sane.
    shares = _num(info.get("sharesOutstanding"))
    implied = _num(info.get("impliedSharesOutstanding"))
    if implied and (shares is None or 0.9 <= implied / shares <= 3.0):
        shares = implied

    bs, bs_date, bs_other = _latest_balance_sheet(raw)
    bs_shares = _pick(bs, SHARE_ROWS) or _pick(bs_other, SHARE_ROWS)
    if shares is None:
        shares = bs_shares
    snap["shares"] = shares

    mcap = shares * last_price if shares else None
    snap["market_cap"] = mcap
    snap["market_cap_eur"] = convert(mcap, quote_currency, "EUR", fx)

    equity = _pick(bs, EQUITY_ROWS)
    assets = _pick(bs, ASSET_ROWS)
    debt = _pick(bs, DEBT_ROWS)
    cash = _pick(bs, CASH_ROWS) or 0.0
    minority = _pick(bs, MINORITY_ROWS) or 0.0
    properties = _pick(bs, PROPERTY_ROWS)
    snap["balance_sheet_date"] = bs_date.strftime("%Y-%m-%d") if bs_date is not None else None

    per_share_count = bs_shares or shares
    bvps = to_quote(equity / per_share_count) if equity and per_share_count else None
    snap["book_value_per_share"] = bvps
    snap["pb"] = _in_range(last_price / bvps, 0.05, 15.0) if bvps and bvps > 0 else None

    net_debt = (debt - cash) if debt is not None else None
    snap["net_debt"] = to_quote(net_debt)
    snap["total_debt"] = to_quote(debt)
    snap["cash"] = to_quote(cash)
    snap["total_assets"] = to_quote(assets)
    snap["equity"] = to_quote(equity)
    ltv = None
    if net_debt is not None:
        base = properties if properties and assets and properties > 0.3 * assets else (assets - cash if assets else None)
        if base and base > 0:
            ltv = _in_range(net_debt / base, -0.5, 1.2)
    snap["ltv"] = ltv

    inc, inc_date = _statement_column(raw.get("income_stmt"))
    revenue = _pick(inc, REVENUE_ROWS)
    ebitda = _pick(inc, EBITDA_ROWS)
    interest = _pick(inc, INTEREST_ROWS)
    snap["income_statement_date"] = inc_date.strftime("%Y-%m-%d") if inc_date is not None else None
    snap["revenue"] = to_quote(revenue)
    snap["ebitda"] = to_quote(ebitda)
    margin = ebitda / revenue if ebitda and revenue and revenue > 0 else None
    snap["ebitda_margin"] = margin
    if ebitda and ebitda > 0 and margin is not None and 0.3 <= margin <= 1.0:
        snap["nd_ebitda"] = _in_range(net_debt / ebitda, 0, 40) if net_debt is not None else None
        snap["interest_cover"] = _in_range(ebitda / abs(interest), 0.3, 30) if interest else None
        ev = (mcap or 0) + (to_quote(net_debt) or 0) + (to_quote(minority) or 0) if mcap else None
        snap["ev_ebitda"] = _in_range(ev / to_quote(ebitda), 3, 80) if ev and to_quote(ebitda) else None
    else:
        snap["nd_ebitda"] = snap["interest_cover"] = snap["ev_ebitda"] = None
        if ebitda is not None:
            notes.append("EBITDA-based ratios omitted: Yahoo's EBITDA looks distorted (e.g. by revaluations)")

    # Revenue growth from the two most recent fiscal years.
    snap["revenue_growth"] = None
    inc_df = raw.get("income_stmt")
    if isinstance(inc_df, pd.DataFrame) and not inc_df.empty:
        for row in REVENUE_ROWS:
            if row in inc_df.index:
                series = pd.to_numeric(inc_df.loc[row], errors="coerce").dropna()
                series = series.sort_index(ascending=False)
                if len(series) >= 2 and series.iloc[1] > 0:
                    snap["revenue_growth"] = _in_range(series.iloc[0] / series.iloc[1] - 1, -0.9, 5)
                break

    # Dividends: trailing twelve months, quote units -> major units.
    dps_raw = trailing_dividends(raw.get("dividends"), as_of)
    dps = dps_raw * price_scale if dps_raw is not None else None
    dy = dps / last_price if dps is not None and last_price else None
    if dy is not None and dy > 0.3 and 0.0005 < dy / 100 <= 0.3:
        dy, dps = dy / 100, dps / 100
        notes.append("Dividend units corrected (pence/pounds)")
    elif dy is not None and 0 < dy < 0.002 and price_scale < 1 and 0.005 < dy * 100 <= 0.3:
        dy, dps = dy * 100, dps * 100  # dividends reported in pounds for a pence quote
        notes.append("Dividend units corrected (pounds/pence)")
    snap["dps_ttm"] = dps
    snap["dividend_yield"] = _in_range(dy, 0, 0.3) if dy is not None else None

    # EPS is in the reporting currency; express it in the quote currency.
    fx_factor = 1.0
    if fin_ccy != quote_currency and fin_ccy in fx and quote_currency in fx:
        fx_factor = fx[fin_ccy] / fx[quote_currency]
    snap["pe_trailing"] = _multiple_fix(info.get("trailingPE"), 4, 80, fx_factor)
    snap["pe_forward"] = _multiple_fix(info.get("forwardPE"), 4, 80, fx_factor)

    # Analyst consensus as published on Yahoo Finance.
    targets = raw.get("price_targets") if isinstance(raw.get("price_targets"), dict) else {}
    current_raw = _num(info.get("currentPrice")) or _num(targets.get("current")) or (last_price / price_scale)
    target_raw = _num(info.get("targetMeanPrice")) or _num(targets.get("mean"))
    ratio = _price_ratio_fix(target_raw / current_raw, 0.3, 3.0) if target_raw and current_raw else None
    consensus = {
        "analysts": int(_num(info.get("numberOfAnalystOpinions")) or 0) or None,
        "rating_mean": _in_range(_num(info.get("recommendationMean")), 1, 5),
        "rating": REC_LABELS.get(str(info.get("recommendationKey") or "").lower()),
        "target_mean": last_price * ratio if ratio else None,
        "upside": ratio - 1 if ratio else None,
        "counts": _recommendation_counts(raw.get("recommendations")),
    }
    for key, field in (("target_high", "targetHighPrice"), ("target_low", "targetLowPrice")):
        value = _num(info.get(field)) or _num(targets.get(field.replace("target", "").replace("Price", "").lower()))
        r = _price_ratio_fix(value / current_raw, 0.1, 5.0) if value and current_raw else None
        consensus[key] = last_price * r if r else None
    snap["consensus"] = consensus if any(v is not None for v in consensus.values()) else None

    snap.update(_calendar(raw.get("calendar"), as_of))
    snap["description"] = _short_description(info.get("longBusinessSummary"))
    snap["website"] = info.get("website") or None
    snap["employees"] = int(_num(info.get("fullTimeEmployees")) or 0) or None
    snap["industry"] = info.get("industry") or None
    snap["notes"] = notes or None
    snap["fetched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {k: (_round(v) if isinstance(v, float) else v) for k, v in snap.items()}


def _round(value: float) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    if value == 0:
        return 0.0
    return float(f"{value:.6g}")


def market_snapshot(close: pd.Series, volume: pd.Series | None, local_per_eur: pd.Series | None) -> dict:
    """Price-derived facts: last price, 52-week range and traded value."""
    close = close.dropna()
    if close.empty:
        return {}
    last_date = close.index[-1]
    year = close[close.index > last_date - pd.Timedelta(days=365)]
    out = {
        "price": float(f"{close.iloc[-1]:.6g}"),
        "price_date": last_date.strftime("%Y-%m-%d"),
        "high_52w": float(f"{year.max():.6g}"),
        "low_52w": float(f"{year.min():.6g}"),
    }
    if volume is not None and not volume.dropna().empty:
        traded = (close * volume.reindex(close.index)).dropna()
        recent = traded[traded.index > last_date - pd.Timedelta(days=92)]
        if not recent.empty:
            adv = float(recent.mean())
            if local_per_eur is not None:
                fx = local_per_eur.reindex(recent.index).ffill().dropna()
                adv_eur = float((recent.reindex(fx.index) / fx).mean()) if not fx.empty else None
            else:
                adv_eur = adv
            out["adv_3m"] = float(f"{adv:.6g}")
            out["adv_3m_eur"] = float(f"{adv_eur:.6g}") if adv_eur else None
    return out
