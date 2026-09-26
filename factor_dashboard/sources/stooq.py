"""Stooq daily CSV downloads, used as a fallback for bond yields."""

from __future__ import annotations

import io

import pandas as pd

from .. import http

STOOQ_URL = "https://stooq.com/q/d/l/"


def parse_stooq_csv(text: str) -> pd.Series:
    if not text.lstrip().lower().startswith("date"):
        raise ValueError(f"Stooq returned no data: {text[:80]!r}")
    df = pd.read_csv(io.StringIO(text))
    series = pd.Series(pd.to_numeric(df["Close"], errors="coerce").values, index=pd.to_datetime(df["Date"]))
    series = series.dropna().sort_index()
    if series.empty:
        raise ValueError("empty Stooq series")
    return series.astype(float)


def fetch_stooq_series(symbol: str, start: str) -> pd.Series:
    resp = http.get(STOOQ_URL, params={"s": symbol, "i": "d", "d1": pd.Timestamp(start).strftime("%Y%m%d")})
    return parse_stooq_csv(resp.text)
