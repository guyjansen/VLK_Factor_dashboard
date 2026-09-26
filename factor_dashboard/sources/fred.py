"""FRED (Federal Reserve Bank of St. Louis) CSV downloads."""

from __future__ import annotations

import io

import pandas as pd

from .. import http

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"


def parse_fred_csv(text: str, series_id: str) -> pd.Series:
    df = pd.read_csv(io.StringIO(text))
    date_col = next((c for c in df.columns if c.lower() in ("date", "observation_date")), df.columns[0])
    value_col = series_id if series_id in df.columns else df.columns[-1]
    values = pd.to_numeric(df[value_col], errors="coerce")  # FRED marks gaps with "."
    series = pd.Series(values.values, index=pd.to_datetime(df[date_col]))
    series = series.dropna().sort_index()
    if series.empty:
        raise ValueError(f"no observations for {series_id}")
    return series.astype(float)


def fetch_fred_series(series_id: str, start: str) -> pd.Series:
    resp = http.get(FRED_CSV_URL, params={"id": series_id, "cosd": pd.Timestamp(start).strftime("%Y-%m-%d")})
    return parse_fred_csv(resp.text, series_id)
