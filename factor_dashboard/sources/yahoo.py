"""Yahoo Finance access through the ``yfinance`` package.

Downloads run in small batches with retries because Yahoo throttles bursts of
requests. Nothing here interprets the numbers; unit handling (pence quotes,
currency conversion) lives in ``prices.py`` and ``fundamentals.py``.
"""

from __future__ import annotations

import logging
import time
from typing import Iterable

import pandas as pd

log = logging.getLogger(__name__)

PRICE_COLUMNS = ("Close", "Adj Close", "Volume")


def _yf():
    import yfinance as yf  # imported lazily so offline tests do not need it

    return yf


def _normalise_frame(frame: pd.DataFrame) -> pd.DataFrame | None:
    if frame is None or frame.empty:
        return None
    frame = frame.copy()
    idx = pd.DatetimeIndex(frame.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    frame.index = idx.normalize()
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    if "Adj Close" not in frame.columns and "Close" in frame.columns:
        frame["Adj Close"] = frame["Close"]
    keep = [c for c in PRICE_COLUMNS if c in frame.columns]
    frame = frame[keep]
    frame = frame[frame["Close"].notna() & (frame["Close"] > 0)]
    return frame if not frame.empty else None


def _split_download(raw: pd.DataFrame, batch: list[str]) -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    if raw is None or raw.empty:
        return out
    if isinstance(raw.columns, pd.MultiIndex):
        level0 = set(raw.columns.get_level_values(0))
        for ticker in batch:
            if ticker in level0:
                frame = _normalise_frame(raw[ticker])
                if frame is not None:
                    out[ticker] = frame
    elif len(batch) == 1:
        frame = _normalise_frame(raw)
        if frame is not None:
            out[batch[0]] = frame
    return out


def download_history(
    tickers: Iterable[str],
    start: str,
    *,
    batch_size: int = 10,
    retries: int = 3,
    pause: float = 1.5,
) -> dict[str, pd.DataFrame]:
    """Daily Close / Adj Close / Volume for each ticker that returns data."""
    yf = _yf()
    todo = list(dict.fromkeys(t for t in tickers if t))
    result: dict[str, pd.DataFrame] = {}
    for attempt in range(retries):
        if not todo:
            break
        missing = []
        for i in range(0, len(todo), batch_size):
            batch = todo[i : i + batch_size]
            raw = None
            for repair in (True, False):
                try:
                    raw = yf.download(
                        batch,
                        start=start,
                        auto_adjust=False,
                        actions=False,
                        group_by="ticker",
                        threads=True,
                        progress=False,
                        repair=repair,
                        multi_level_index=True,
                        timeout=30,
                    )
                    break
                except Exception as exc:  # repair needs scipy and can fail on odd data
                    log.warning("yfinance download failed (repair=%s) for %s: %s", repair, batch, exc)
            got = _split_download(raw, batch) if raw is not None else {}
            result.update(got)
            missing.extend(t for t in batch if t not in got)
            time.sleep(pause)
        todo = missing
        if todo and attempt < retries - 1:
            log.info("Retrying %d tickers without data: %s", len(todo), ", ".join(todo))
            time.sleep(pause * 4 * (attempt + 1))
    # Last resort: one ticker at a time through Ticker.history.
    for ticker in todo:
        try:
            frame = yf.Ticker(ticker).history(start=start, auto_adjust=False, actions=False)
            frame = _normalise_frame(frame)
            if frame is not None:
                result[ticker] = frame
        except Exception as exc:
            log.warning("Ticker.history failed for %s: %s", ticker, exc)
        time.sleep(pause)
    return result


def fetch_currency(ticker: str) -> str | None:
    """Quote currency as Yahoo reports it (e.g. 'GBp' for pence)."""
    yf = _yf()
    try:
        info = yf.Ticker(ticker).fast_info
        ccy = info.get("currency") if hasattr(info, "get") else getattr(info, "currency", None)
        return ccy or None
    except Exception as exc:
        log.warning("Could not read currency for %s: %s", ticker, exc)
        return None


def fetch_fundamentals_raw(ticker: str, *, retries: int = 2, pause: float = 0.6) -> dict:
    """Raw Yahoo objects for one ticker; each item is None when unavailable."""
    yf = _yf()
    t = yf.Ticker(ticker)
    getters = {
        "info": lambda: t.get_info(),
        "balance_sheet": lambda: t.balance_sheet,
        "quarterly_balance_sheet": lambda: t.quarterly_balance_sheet,
        "income_stmt": lambda: t.income_stmt,
        "dividends": lambda: t.dividends,
        "calendar": lambda: t.calendar,
        "price_targets": lambda: t.analyst_price_targets,
        "recommendations": lambda: t.recommendations_summary,
    }
    raw: dict = {"errors": {}}
    for key, getter in getters.items():
        value = None
        for attempt in range(retries):
            try:
                value = getter()
                break
            except Exception as exc:
                raw["errors"][key] = f"{type(exc).__name__}: {exc}"[:200]
                time.sleep(pause * (attempt + 2))
        raw[key] = value
        time.sleep(pause / 3)
    return raw
