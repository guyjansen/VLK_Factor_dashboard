"""Government bond yields from central bank data portals.

Every function returns a ``pd.Series`` of yields in percent, indexed by date.
Parsers are separate from fetchers so they can be tested offline.
"""

from __future__ import annotations

import io
import re
from datetime import date

import pandas as pd

from .. import http

ECB_YC_URL = "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{tenor}"
BOE_URL = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp"
RIKSBANK_URL = "https://api.riksbank.se/swea/v1/Observations/{series}/{start}"
SNB_URL = "https://data.snb.ch/api/cube/{cube}/data/csv/en"
NORGES_URL = "https://data.norges-bank.no/api/data/GOVT_GENERIC_RATES/{key}"


def _clean(series: pd.Series) -> pd.Series:
    series = pd.to_numeric(series, errors="coerce")
    series.index = pd.to_datetime(series.index).normalize()
    series = series[~series.index.duplicated(keep="last")].dropna().sort_index()
    if series.empty:
        raise ValueError("no observations parsed")
    return series.astype(float)


# ---------------------------------------------------------------- ECB
def parse_ecb_csv(text: str) -> pd.Series:
    df = pd.read_csv(io.StringIO(text))
    if "TIME_PERIOD" not in df.columns or "OBS_VALUE" not in df.columns:
        raise ValueError("unexpected ECB CSV layout")
    return _clean(pd.Series(df["OBS_VALUE"].values, index=df["TIME_PERIOD"].values))


def fetch_ecb_yield(tenor: str, start: str) -> pd.Series:
    resp = http.get(
        ECB_YC_URL.format(tenor=tenor),
        params={"startPeriod": start, "format": "csvdata"},
        headers={"Accept": "text/csv"},
    )
    return parse_ecb_csv(resp.text)


# ---------------------------------------------------------------- Bank of England
def parse_boe_csv(text: str, code: str) -> pd.Series:
    if "<html" in text[:500].lower():
        raise ValueError("Bank of England returned HTML instead of CSV")
    df = pd.read_csv(io.StringIO(text))
    date_col = next((c for c in df.columns if c.strip().upper() == "DATE"), df.columns[0])
    value_col = code if code in df.columns else df.columns[-1]
    idx = pd.DatetimeIndex(pd.to_datetime(df[date_col], format="%d %b %Y", errors="coerce"))
    keep = ~idx.isna()
    return _clean(pd.Series(df[value_col].to_numpy()[keep], index=idx[keep]))


def fetch_boe_series(code: str, start: str) -> pd.Series:
    start_str = pd.Timestamp(start).strftime("%d/%b/%Y")
    params = {
        "csv.x": "yes",
        "Datefrom": start_str,
        "Dateto": "now",
        "SeriesCodes": code,
        "CSVF": "TN",
        "UsingCodes": "Y",
        "VPD": "Y",
        "VFD": "N",
    }
    resp = http.get(BOE_URL, params=params, headers={"Accept": "text/csv,*/*"})
    return parse_boe_csv(resp.text, code)


# ---------------------------------------------------------------- Riksbank
def parse_riksbank_json(payload) -> pd.Series:
    if isinstance(payload, dict):  # some versions wrap observations
        payload = payload.get("observations") or payload.get("data") or []
    rows = [(o.get("date"), o.get("value")) for o in payload if isinstance(o, dict)]
    if not rows:
        raise ValueError("no Riksbank observations")
    dates, values = zip(*rows)
    return _clean(pd.Series(values, index=dates))


def fetch_riksbank_series(series_id: str, start: str) -> pd.Series:
    url = RIKSBANK_URL.format(series=series_id, start=pd.Timestamp(start).strftime("%Y-%m-%d"))
    end = date.today().isoformat()
    resp = http.get(f"{url}/{end}", headers={"Accept": "application/json"})
    return parse_riksbank_json(resp.json())


# ---------------------------------------------------------------- Swiss National Bank
def _snippet(text: str, n: int = 240) -> str:
    return re.sub(r"\s+", " ", text[:n])


def parse_snb_csv(text: str, maturity: str) -> pd.Series:
    lines = text.splitlines()
    start = next(
        (i for i, line in enumerate(lines) if re.match(r'^"?Date"?\s*[;,]', line.strip())),
        None,
    )
    if start is None:
        raise ValueError(f"SNB CSV header not found: {_snippet(text)!r}")
    body = "\n".join(lines[start:])
    sep = ";" if body.count(";") >= body.count(",") else ","
    df = pd.read_csv(io.StringIO(body), sep=sep, dtype=str)
    df.columns = [c.strip().strip('"') for c in df.columns]
    value_col = next((c for c in df.columns if c.lower() == "value"), df.columns[-1])
    dim_cols = [c for c in df.columns if c not in ("Date", value_col)]
    if dim_cols:
        codes = df[dim_cols[0]].astype(str).str.strip().str.strip('"')
        wanted = {maturity, maturity.replace("J", "Y"), maturity.rstrip("JY")}
        mask = codes.isin(wanted)
        if not mask.any():
            raise ValueError(f"SNB maturity {maturity} not in {sorted(codes.unique())[:20]}")
        df = df[mask]
    values = df[value_col].astype(str).str.replace(",", ".", regex=False)
    return _clean(pd.Series(values.values, index=df["Date"].values))


def fetch_snb_series(spec: str, start: str) -> pd.Series:
    cube, maturity = spec.split(":", 1)
    resp = http.get(SNB_URL.format(cube=cube), params={"fromDate": pd.Timestamp(start).strftime("%Y-%m-%d")})
    return parse_snb_csv(resp.text, maturity)


# ---------------------------------------------------------------- Norges Bank
def parse_sdmx_csv(text: str) -> pd.Series:
    first_line = text.lstrip("\ufeff").splitlines()[0] if text.strip() else ""
    sep = ";" if first_line.count(";") > first_line.count(",") else ","
    df = pd.read_csv(io.StringIO(text), sep=sep)
    df.columns = [c.strip().strip('"').lstrip("\ufeff") for c in df.columns]
    time_col = next((c for c in df.columns if c.upper() in ("TIME_PERIOD", "TIME PERIOD")), None)
    value_col = next((c for c in df.columns if c.upper() in ("OBS_VALUE", "OBS VALUE")), None)
    if not time_col or not value_col:
        raise ValueError(f"unexpected SDMX CSV layout, columns={list(df.columns)[:12]}: {_snippet(text)!r}")
    values = df[value_col]
    if not pd.api.types.is_numeric_dtype(values):
        values = values.astype(str).str.replace(",", ".", regex=False)
    return _clean(pd.Series(values.values, index=df[time_col].values))


def fetch_norges_series(key: str, start: str) -> pd.Series:
    resp = http.get(
        NORGES_URL.format(key=key),
        params={"format": "sdmx-csv", "startPeriod": pd.Timestamp(start).strftime("%Y-%m-%d"), "locale": "en"},
    )
    return parse_sdmx_csv(resp.text)
