"""Price cleaning: quote units, 100x glitches, ticker splices and FX."""

from __future__ import annotations

import numpy as np
import pandas as pd

MINOR_UNITS = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01), "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}


def major_currency(quote_currency: str | None, fallback: str) -> tuple[str, float]:
    """Map a Yahoo quote currency to (ISO major currency, scale to major units)."""
    if not quote_currency:
        return fallback, 1.0
    if quote_currency in MINOR_UNITS:
        return MINOR_UNITS[quote_currency]
    return quote_currency.upper(), 1.0


def infer_quote_currency(ticker: str, config_currency: str) -> str:
    """Best guess when Yahoo metadata is unavailable: LSE shares quote in pence."""
    if ticker.upper().endswith(".L") and config_currency == "GBP":
        return "GBp"
    return config_currency


def fix_unit_glitches(series: pd.Series) -> pd.Series:
    """Undo isolated 100x jumps (pence/pound mix-ups) in a positive price series."""
    s = series.dropna().astype(float).copy()
    if len(s) < 3:
        return series
    values = s.to_numpy(dtype=float, copy=True)
    for i in range(1, len(values)):
        ratio = values[i] / values[i - 1]
        if 60 < ratio < 160:
            values[i] /= 100.0
        elif 1 / 160 < ratio < 1 / 60:
            values[i] *= 100.0
    s = pd.Series(values, index=s.index)
    return s.reindex(series.index)


def splice_returns(primary: pd.Series, history: pd.Series | None, splice_date: str | None) -> pd.Series:
    """Combine two price series by chaining returns.

    Dates on/after ``splice_date`` use the primary series' returns (measured
    against the primary's previous observation); earlier dates use the history
    series' returns where available and the primary's own returns otherwise.
    The level is anchored on the primary's most recent value, so recent prices
    are real quotes and older ones are return-consistent back-extrapolations.
    """
    primary = primary.dropna().astype(float)
    if history is None or history.dropna().empty or not splice_date:
        return primary
    history = history.dropna().astype(float)
    cutoff = pd.Timestamp(splice_date)

    prim_ret = primary.pct_change()
    hist_ret = history.pct_change()
    dates = primary.index.union(history.index)
    dates = dates[dates <= primary.index.max()]

    chosen = pd.Series(np.nan, index=dates)
    after = dates >= cutoff
    chosen[after] = prim_ret.reindex(dates[after]).to_numpy()
    before = dates[~after]
    hist_part = hist_ret.reindex(before)
    prim_part = prim_ret.reindex(before)
    chosen[~after] = hist_part.where(hist_part.notna(), prim_part).to_numpy()

    # Keep only dates where some series actually traded.
    observed = primary.reindex(dates).notna() | history.reindex(dates).notna()
    chosen = chosen[observed]
    first_valid = chosen.first_valid_index()
    if first_valid is None:
        return primary
    growth = (1.0 + chosen.fillna(0.0)).cumprod()
    level = growth / growth.iloc[-1] * primary.iloc[-1]
    # The first observation has no return; its level is the base of the chain.
    start = chosen.index.get_loc(first_valid) - 1
    return level.iloc[max(start, 0) :]


def to_eur(values: pd.Series, local_per_eur: pd.Series | None) -> pd.Series:
    """Convert a local-currency series to EUR using 'local units per EUR'."""
    if local_per_eur is None:
        return values
    fx = local_per_eur.reindex(values.index).ffill(limit=7)
    return values / fx


def round_sig(values: np.ndarray, digits: int = 7) -> list:
    """Round to significant digits; NaN becomes None (JSON null)."""
    out = []
    for v in np.asarray(values, dtype=float):
        if not np.isfinite(v):
            out.append(None)
        elif v == 0:
            out.append(0.0)
        else:
            out.append(float(f"{v:.{digits}g}"))
    return out


def round_dp(values: np.ndarray, decimals: int = 4) -> list:
    out = []
    for v in np.asarray(values, dtype=float):
        out.append(round(float(v), decimals) if np.isfinite(v) else None)
    return out


def extend_with_index(values: pd.Series, index: pd.Series | None) -> pd.Series:
    """Carry a series past its last date using the index's returns (e.g. an ETF
    that has not printed today's close, extended with the underlying index)."""
    values = values.dropna()
    if index is None or values.empty:
        return values
    index = index.dropna()
    last = values.index[-1]
    if last not in index.index:
        return values
    tail = index[index.index > last]
    if tail.empty:
        return values
    extension = values.iloc[-1] * tail / index.loc[last]
    return pd.concat([values, extension])
