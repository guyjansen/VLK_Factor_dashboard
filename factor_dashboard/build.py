"""Build ``docs/data/dashboard_data.js`` from public data sources.

Usage::

    python -m factor_dashboard.build                  # full refresh
    python -m factor_dashboard.build --no-fundamentals  # prices and factors only

When a source fails, the series from the previous build is reused (and marked
stale) so one flaky endpoint never blanks the dashboard. The build refuses to
write a file when too few stocks have fresh prices.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config, prices
from . import fundamentals as fund
from .output import read_data_js, write_data_js
from .sources import central_banks as cb
from .sources import french, fred, stooq, yahoo
from .universe import SUBSECTOR_ORDER, Stock, load_universe

log = logging.getLogger("factor_dashboard.build")

EXTRA_FX = {"DKK": "EURDKK=X", "PLN": "EURPLN=X", "CZK": "EURCZK=X"}


# --------------------------------------------------------------------------- helpers
def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _describe(series: pd.Series) -> dict:
    s = series.dropna()
    return {
        "first": s.index[0].strftime("%Y-%m-%d") if not s.empty else None,
        "last": s.index[-1].strftime("%Y-%m-%d") if not s.empty else None,
        "observations": int(s.size),
    }


def _validate_rate(series: pd.Series, name: str) -> pd.Series:
    s = series.dropna()
    if s.size < 60:
        raise ValueError(f"{name}: only {s.size} observations")
    if s.abs().max() > 40:
        raise ValueError(f"{name}: values out of range for a yield in percent")
    return s


def _fetch_rate(spec: config.RateSeries, start: str) -> tuple[pd.Series | None, dict]:
    errors = []
    for provider, code in spec.sources:
        try:
            if provider == "ecb":
                series = cb.fetch_ecb_yield(code, start)
            elif provider == "boe":
                series = cb.fetch_boe_series(code, start)
            elif provider == "riksbank":
                series = cb.fetch_riksbank_series(code, start)
            elif provider == "snb":
                series = cb.fetch_snb_series(code, start)
            elif provider == "norges":
                series = cb.fetch_norges_series(code, start)
            elif provider == "fred":
                series = fred.fetch_fred_series(code, start)
            elif provider == "stooq":
                series = stooq.fetch_stooq_series(code, start)
            else:
                raise ValueError(f"unknown provider {provider}")
            series = _validate_rate(series, f"{provider}:{code}")
            info = {"status": "ok", "source": provider, "code": code, **_describe(series)}
            if errors:
                info["fallback_errors"] = errors
            return series, info
        except Exception as exc:  # try the next provider
            errors.append(f"{provider}:{code}: {type(exc).__name__}: {exc}"[:300])
            log.warning("Rate source failed for %s via %s:%s: %s", spec.id, provider, code, exc)
    return None, {"status": "failed", "errors": errors}


def _french_indices(start: str) -> tuple[dict[str, pd.Series], dict]:
    try:
        df = french.fetch_europe_factors(start)
    except Exception as exc:
        log.warning("Kenneth French download failed: %s", exc)
        return {}, {"status": "failed", "errors": [f"{type(exc).__name__}: {exc}"[:300]]}
    out = {}
    for series_id, (column, _label) in config.FRENCH_FACTORS.items():
        if column in df.columns:
            r = df[column].dropna()
            out[series_id] = 100.0 * (1.0 + r).cumprod()
    info = {"status": "ok", "source": "french", **_describe(df.dropna(how="all").iloc[:, 0])}
    return out, info


def _local_per_eur(fx_series: dict[str, pd.Series], currency: str) -> pd.Series | None:
    if currency == "EUR":
        return None
    return fx_series.get(currency)


# --------------------------------------------------------------------------- main build
def build(options: config.BuildOptions) -> dict:
    t0 = time.time()
    start = options.start
    fetch_start = (pd.Timestamp(start) - pd.Timedelta(days=45)).strftime("%Y-%m-%d")
    universe = load_universe()
    previous = read_data_js(options.out)
    if previous and previous.get("meta", {}).get("synthetic"):
        previous = None
    warnings: list[str] = []
    series_status: dict[str, dict] = {}

    # 1. Yahoo prices: stocks, splice histories, market / style / FX series.
    stock_tickers = [s.ticker for s in universe] + [s.history_ticker for s in universe if s.history_ticker]
    macro_first = [spec.candidates[0] for spec in config.YAHOO_SERIES]
    log.info("Downloading %d stock and %d market tickers from Yahoo Finance", len(stock_tickers), len(macro_first))
    hist = yahoo.download_history(stock_tickers + macro_first + list(EXTRA_FX.values()), fetch_start)
    fallbacks = [
        c for spec in config.YAHOO_SERIES if spec.candidates[0] not in hist for c in spec.candidates[1:]
    ]
    if fallbacks:
        hist.update(yahoo.download_history(fallbacks, fetch_start))

    # 2. FX first: everything else converts through it.
    fx_series: dict[str, pd.Series] = {}
    out_series: dict[str, dict] = {}
    yahoo_currency: dict[str, str] = {}
    for spec in config.YAHOO_SERIES:
        ticker = next((c for c in spec.candidates if c in hist), None)
        if ticker is None:
            series_status[spec.id] = {"status": "failed", "errors": [f"no Yahoo data for {', '.join(spec.candidates)}"]}
            continue
        column = "Adj Close" if spec.use_adjusted else "Close"
        values = hist[ticker][column].dropna()
        if spec.kind == "fx":
            fx_series[spec.unit] = values
        series_status[spec.id] = {"status": "ok", "source": "yahoo", "code": ticker, **_describe(values)}
        out_series[spec.id] = {"spec": spec, "ticker": ticker, "values": values}
    fx_latest = {"EUR": 1.0}
    for ccy, s in fx_series.items():
        fx_latest[ccy] = float(s.dropna().iloc[-1])
    for ccy, ticker in EXTRA_FX.items():
        if ticker in hist:
            fx_latest[ccy] = float(hist[ticker]["Close"].dropna().iloc[-1])

    # Convert non-EUR ETF quotes (e.g. pence-quoted London lines) into EUR.
    for sid, item in out_series.items():
        spec = item["spec"]
        if spec.kind != "price" or spec.unit != "EUR":
            continue
        quote = yahoo.fetch_currency(item["ticker"]) or "EUR"
        yahoo_currency[item["ticker"]] = quote
        major, scale = prices.major_currency(quote, "EUR")
        values = prices.fix_unit_glitches(item["values"] * scale)
        if major != "EUR":
            if major not in fx_series:
                series_status[sid] = {"status": "failed", "errors": [f"no FX to convert {major}"]}
                item["values"] = None
                continue
            values = prices.to_eur(values, fx_series[major])
            series_status[sid]["converted_from"] = major
        item["values"] = values.dropna()

    # 3. Rates and credit spreads.
    for spec in config.RATE_SERIES:
        log.info("Fetching %s", spec.id)
        series, info = _fetch_rate(spec, fetch_start)
        series_status[spec.id] = info
        if series is not None:
            out_series[spec.id] = {"spec": spec, "values": series}

    # 4. Fama-French European factors.
    ff, ff_info = _french_indices(fetch_start)
    for sid, (column, label) in config.FRENCH_FACTORS.items():
        series_status[sid] = dict(ff_info) if sid in ff else {"status": "failed", "errors": ff_info.get("errors", ["missing column"])}
        if sid in ff:
            out_series[sid] = {"label": label, "values": ff[sid]}

    # 5. Fundamentals (also gives us each stock's quote currency).
    raw_fund: dict[str, dict] = {}
    if options.fundamentals:
        for i, stock in enumerate(universe, 1):
            log.info("Fundamentals %d/%d: %s", i, len(universe), stock.ticker)
            try:
                raw_fund[stock.id] = yahoo.fetch_fundamentals_raw(stock.ticker, pause=options.pause)
            except Exception as exc:
                log.warning("Fundamentals failed for %s: %s", stock.ticker, exc)
            time.sleep(options.pause)

    # 6. Stocks: units, splices, EUR conversion inputs.
    stock_frames: dict[str, dict] = {}
    stock_status: dict[str, dict] = {}
    for stock in universe:
        frame = hist.get(stock.ticker)
        status: dict = {"ticker": stock.ticker}
        if frame is None:
            status["prices"] = "failed"
            stock_status[stock.id] = status
            warnings.append(f"No Yahoo prices for {stock.name} ({stock.ticker})")
            continue
        info = (raw_fund.get(stock.id) or {}).get("info") or {}
        quote = info.get("currency") or yahoo_currency.get(stock.ticker)
        if not quote:
            quote = yahoo.fetch_currency(stock.ticker) or prices.infer_quote_currency(stock.ticker, stock.currency)
        major, scale = prices.major_currency(quote, stock.currency)
        if major != stock.currency:
            warnings.append(f"{stock.id}: Yahoo quotes {major}, config says {stock.currency}; using {major}")
        close = prices.fix_unit_glitches(frame["Close"] * scale)
        adj = prices.fix_unit_glitches(frame["Adj Close"] * scale)
        if stock.history_ticker:
            h = hist.get(stock.history_ticker)
            if h is not None:
                close = prices.splice_returns(close, prices.fix_unit_glitches(h["Close"] * scale), stock.splice_date)
                adj = prices.splice_returns(adj, prices.fix_unit_glitches(h["Adj Close"] * scale), stock.splice_date)
                status["spliced_with"] = stock.history_ticker
            else:
                # Before the splice date the primary line belongs to a different
                # entity, so start the series at the splice instead of mixing them.
                cutoff = pd.Timestamp(stock.splice_date)
                close, adj = close[close.index >= cutoff], adj[adj.index >= cutoff]
                status["history_truncated_at"] = stock.splice_date
                warnings.append(
                    f"{stock.id}: history ticker {stock.history_ticker} unavailable; series starts {stock.splice_date}"
                )
        status.update({"prices": "ok", "quote_currency": quote, "currency": major, **_describe(adj)})
        stock_frames[stock.id] = {
            "close": close.dropna(),
            "adj": adj.dropna(),
            "volume": frame["Volume"] if "Volume" in frame.columns else None,
            "currency": major,
            "scale": scale,
        }
        stock_status[stock.id] = status

    fresh = len(stock_frames)
    if fresh < options.min_stock_coverage * len(universe):
        raise SystemExit(
            f"Only {fresh}/{len(universe)} stocks have prices; refusing to overwrite {options.out}"
        )
    if "MKT" not in out_series or out_series["MKT"].get("values") is None:
        if not (previous and "MKT" in previous.get("series", {})):
            raise SystemExit("Market series (STOXX Europe 600) unavailable; refusing to build")

    # 7. Calendar: weekdays on which at least a tenth of the stocks traded.
    counts = pd.concat([f["adj"].rename(k) for k, f in stock_frames.items()], axis=1, sort=True).notna().sum(axis=1)
    counts = counts[counts.index >= pd.Timestamp(start)]
    calendar = counts[(counts >= max(3, int(0.1 * len(stock_frames)))) & (counts.index.dayofweek < 5)].index
    calendar = pd.DatetimeIndex(sorted(calendar))
    as_of = calendar[-1]
    log.info("Calendar: %d days from %s to %s", len(calendar), calendar[0].date(), as_of.date())

    # 8. Stock records.
    prev_stocks = {s["id"]: s for s in (previous or {}).get("stocks", [])}
    prev_dates = pd.DatetimeIndex((previous or {}).get("dates", []))

    def realign(values: list) -> list:
        s = pd.Series(values, index=prev_dates, dtype=float)
        return prices.round_sig(s.reindex(calendar).to_numpy())

    stocks_out = []
    for stock in universe:
        record = {**stock.to_meta()}
        frames = stock_frames.get(stock.id)
        if frames is not None:
            local_fx = _local_per_eur(fx_series, frames["currency"])
            record["currency"] = frames["currency"]
            record["tri"] = prices.round_sig(frames["adj"].reindex(calendar).to_numpy())
            record["px"] = prices.round_sig(frames["close"].reindex(calendar).to_numpy())
            market = fund.market_snapshot(frames["close"], frames["volume"], local_fx)
            fund_block = {}
            raw = raw_fund.get(stock.id)
            if raw and raw.get("info") is not None:
                try:
                    fund_block = fund.compute_snapshot(
                        raw,
                        quote_currency=frames["currency"],
                        price_scale=frames["scale"],
                        last_price=float(frames["close"].iloc[-1]),
                        as_of=frames["close"].index[-1],
                        fx=fx_latest,
                    )
                    fund_block.pop("fetched_at", None)
                    stock_status[stock.id]["fundamentals"] = "ok"
                except Exception as exc:
                    log.warning("Fundamentals snapshot failed for %s: %s", stock.id, exc)
                    stock_status[stock.id]["fundamentals"] = f"failed: {exc}"[:200]
            if not fund_block and stock.id in prev_stocks and prev_stocks[stock.id].get("fund"):
                fund_block = {**prev_stocks[stock.id]["fund"], "stale": True}
                stock_status[stock.id]["fundamentals"] = "stale (previous build)"
            fund_block.update(market)
            if raw and raw.get("errors"):
                stock_status[stock.id]["fundamental_errors"] = raw["errors"]
            record["fund"] = fund_block
        elif stock.id in prev_stocks and prev_dates.size:
            prev = prev_stocks[stock.id]
            record["tri"] = realign(prev.get("tri", []))
            record["px"] = realign(prev.get("px", []))
            record["fund"] = {**(prev.get("fund") or {}), "stale": True}
            stock_status[stock.id]["prices"] = "stale (previous build)"
        else:
            record["tri"] = [None] * len(calendar)
            record["px"] = [None] * len(calendar)
            record["fund"] = {}
        stocks_out.append(record)

    # 9. Series records.
    series_out: dict[str, dict] = {}
    for sid, item in out_series.items():
        values = item.get("values")
        if values is None or values.dropna().empty:
            continue
        spec = item.get("spec")
        aligned = values.reindex(calendar)
        if spec is not None and spec.kind == "rate":
            arr = prices.round_dp(aligned.to_numpy(), 4)
        else:
            arr = prices.round_sig(aligned.to_numpy(), 7)
        entry = {
            "label": spec.label if spec else item.get("label", sid),
            "kind": spec.kind if spec else "index",
            "unit": spec.unit if spec else "index",
            "group": spec.group if spec else "Style (Fama-French)",
            "description": (spec.description if spec else "Kenneth French library, European factor (long-short, daily)."),
            "values": arr,
        }
        entry.update({k: v for k, v in series_status.get(sid, {}).items() if k in ("source", "code", "first", "last")})
        series_out[sid] = entry

    prev_series = (previous or {}).get("series", {})
    for sid, prev in prev_series.items():
        if sid not in series_out and prev_dates.size:
            reused = {**prev, "values": realign(prev.get("values", [])), "stale": True}
            series_out[sid] = reused
            series_status.setdefault(sid, {})["status"] = "stale (previous build)"
            warnings.append(f"{sid}: source unavailable, reused previous build")

    for sid, st in series_status.items():
        if st.get("status") == "failed" and sid not in series_out:
            warnings.append(f"{sid}: unavailable ({'; '.join(st.get('errors', []))[:160]})")

    subsectors = [s for s in SUBSECTOR_ORDER if any(st.subsector == s for st in universe)]
    data = {
        "meta": {
            "title": "Property Factor Lens",
            "version": 1,
            "generated_at": _utc_now(),
            "as_of": as_of.strftime("%Y-%m-%d"),
            "start": calendar[0].strftime("%Y-%m-%d"),
            "synthetic": False,
            "subsectors": subsectors,
            "local_rate_by_country": config.LOCAL_RATE_BY_COUNTRY,
            "fx_latest": fx_latest,
            "sources": config.SOURCES,
            "series_status": series_status,
            "stock_status": stock_status,
            "warnings": warnings,
            "build_seconds": round(time.time() - t0, 1),
        },
        "dates": [d.strftime("%Y-%m-%d") for d in calendar],
        "stocks": stocks_out,
        "series": series_out,
    }
    return data


def summarise(data: dict) -> str:
    meta = data["meta"]
    lines = [f"As of {meta['as_of']} ({len(data['dates'])} days since {meta['start']})"]
    ok = sum(1 for s in meta["stock_status"].values() if s.get("prices") == "ok")
    fundamentals_ok = sum(1 for s in meta["stock_status"].values() if s.get("fundamentals") == "ok")
    lines.append(f"Stocks with fresh prices: {ok}/{len(data['stocks'])}; fresh fundamentals: {fundamentals_ok}")
    for sid, st in sorted(meta["series_status"].items()):
        lines.append(f"  {sid:<12} {st.get('status', '?'):<24} {st.get('source', '')}:{st.get('code', '')} last={st.get('last')}")
    for w in meta["warnings"]:
        lines.append(f"  ! {w}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", default=config.HISTORY_START, help="first date to include (YYYY-MM-DD)")
    parser.add_argument("--out", type=Path, default=config.DATA_JS, help="output data file")
    parser.add_argument("--no-fundamentals", action="store_true", help="skip per-stock fundamentals")
    parser.add_argument("--pause", type=float, default=0.6, help="seconds between Yahoo calls")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    options = config.BuildOptions(start=args.start, out=args.out, fundamentals=not args.no_fundamentals, pause=args.pause)
    data = build(options)
    size = write_data_js(data, options.out)
    print(summarise(data))
    print(f"Wrote {options.out} ({size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
