"""Unit handling in fundamentals and price cleaning."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from factor_dashboard import fundamentals as fund
from factor_dashboard import prices

FX = {"EUR": 1.0, "GBP": 0.85, "SEK": 11.0, "CHF": 0.95, "NOK": 11.5, "USD": 1.1}


def _statements(equity=5.0e9, assets=1.0e10, debt=4.0e9, cash=2.0e8, shares=1.0e8):
    col = pd.Timestamp("2025-12-31")
    bs = pd.DataFrame(
        {col: [equity, assets, debt, cash, shares]},
        index=["Stockholders Equity", "Total Assets", "Total Debt", "Cash And Cash Equivalents", "Ordinary Shares Number"],
    )
    inc = pd.DataFrame({col: [6.0e8, 4.0e8, 1.0e8]}, index=["Total Revenue", "Normalized EBITDA", "Interest Expense"])
    return bs, inc


def test_cross_currency_book_value():
    """Cibus-style: statements in EUR, quote in SEK."""
    bs, inc = _statements()
    raw = {"info": {"financialCurrency": "EUR", "sharesOutstanding": 1.0e8}, "balance_sheet": bs, "income_stmt": inc}
    snap = fund.compute_snapshot(raw, quote_currency="SEK", price_scale=1.0, last_price=440.0, as_of=pd.Timestamp("2026-09-25"), fx=FX)
    # Book value per share = 50 EUR = 550 SEK -> P/B 0.8.
    assert snap["book_value_per_share"] == pytest.approx(550.0)
    assert snap["pb"] == pytest.approx(0.8)
    assert snap["ltv"] == pytest.approx(3.8e9 / 9.8e9, rel=1e-4)
    assert snap["nd_ebitda"] == pytest.approx(9.5)
    assert snap["interest_cover"] == pytest.approx(4.0)
    assert snap["market_cap_eur"] == pytest.approx(440.0 * 1e8 / 11.0, rel=1e-5)


def test_pence_quotes_and_dividends():
    bs, inc = _statements()
    divs = pd.Series([20.0, 21.0], index=pd.to_datetime(["2026-02-01", "2026-08-01"]))  # pence
    raw = {
        "info": {"financialCurrency": "GBP", "currency": "GBp", "sharesOutstanding": 1.0e8, "currentPrice": 820.0,
                 "targetMeanPrice": 902.0, "forwardPE": 1640.0, "recommendationKey": "hold"},
        "balance_sheet": bs,
        "income_stmt": inc,
        "dividends": divs,
    }
    snap = fund.compute_snapshot(raw, quote_currency="GBP", price_scale=0.01, last_price=8.2, as_of=pd.Timestamp("2026-09-25"), fx=FX)
    assert snap["dps_ttm"] == pytest.approx(0.41)
    assert snap["dividend_yield"] == pytest.approx(0.05)
    assert snap["pe_forward"] == pytest.approx(16.4)
    assert snap["consensus"]["upside"] == pytest.approx(0.1)
    assert snap["consensus"]["target_mean"] == pytest.approx(9.02)
    assert snap["consensus"]["rating"] == "Hold"
    assert snap["pb"] == pytest.approx(8.2 / 50.0)


def test_dividends_in_pounds_for_pence_quote_are_corrected():
    bs, inc = _statements()
    divs = pd.Series([0.20, 0.21], index=pd.to_datetime(["2026-02-01", "2026-08-01"]))  # pounds, not pence
    raw = {"info": {"financialCurrency": "GBP"}, "balance_sheet": bs, "income_stmt": inc, "dividends": divs}
    snap = fund.compute_snapshot(raw, quote_currency="GBP", price_scale=0.01, last_price=8.2, as_of=pd.Timestamp("2026-09-25"), fx=FX)
    assert snap["dividend_yield"] == pytest.approx(0.05)


def test_implausible_ratios_are_dropped():
    bs, inc = _statements(equity=1.0)  # absurd book value -> P/B out of range
    raw = {"info": {"financialCurrency": "EUR"}, "balance_sheet": bs, "income_stmt": inc}
    snap = fund.compute_snapshot(raw, quote_currency="EUR", price_scale=1.0, last_price=30.0, as_of=pd.Timestamp("2026-09-25"), fx=FX)
    assert snap["pb"] is None


def test_negative_ebitda_disables_leverage_multiples():
    bs, inc = _statements()
    inc.loc["Normalized EBITDA"] = -1.0e8
    raw = {"info": {"financialCurrency": "EUR"}, "balance_sheet": bs, "income_stmt": inc}
    snap = fund.compute_snapshot(raw, quote_currency="EUR", price_scale=1.0, last_price=30.0, as_of=pd.Timestamp("2026-09-25"), fx=FX)
    assert snap["nd_ebitda"] is None and snap["ev_ebitda"] is None
    assert snap["notes"]


def test_major_currency():
    assert prices.major_currency("GBp", "GBP") == ("GBP", 0.01)
    assert prices.major_currency("SEK", "SEK") == ("SEK", 1.0)
    assert prices.major_currency(None, "EUR") == ("EUR", 1.0)
    assert prices.infer_quote_currency("SGRO.L", "GBP") == "GBp"
    assert prices.infer_quote_currency("URW.PA", "EUR") == "EUR"


def test_fix_unit_glitches():
    idx = pd.bdate_range("2026-01-01", periods=6)
    s = pd.Series([850.0, 852.0, 8.53, 855.0, 85600.0, 857.0], index=idx)
    fixed = prices.fix_unit_glitches(s)
    assert fixed.tolist() == pytest.approx([850, 852, 853, 855, 856, 857])


def test_splice_uses_history_before_cutoff():
    idx = pd.bdate_range("2024-12-23", "2025-01-10")
    history = pd.Series(np.linspace(20, 22, len(idx)), index=idx)
    history = history[history.index < "2025-01-01"]
    primary = pd.Series(np.linspace(30, 33, len(idx)), index=idx)  # pre-2025 = a different company
    spliced = prices.splice_returns(primary, history, "2025-01-02")
    assert spliced.iloc[-1] == pytest.approx(primary.iloc[-1])
    pre = spliced[spliced.index < "2025-01-01"]
    np.testing.assert_allclose(pre.pct_change().dropna().to_numpy(), history.pct_change().dropna().to_numpy())
    post = spliced[spliced.index >= "2025-01-02"]
    np.testing.assert_allclose(post.to_numpy(), primary[primary.index >= "2025-01-02"].to_numpy())


def test_splice_without_history_returns_primary():
    idx = pd.bdate_range("2026-01-01", periods=5)
    primary = pd.Series([1.0, 2, 3, 4, 5], index=idx)
    assert prices.splice_returns(primary, None, "2026-01-03").equals(primary)


def test_market_snapshot_traded_value_in_eur():
    idx = pd.bdate_range("2026-01-01", "2026-09-25")
    close = pd.Series(10.0, index=idx)
    volume = pd.Series(1000.0, index=idx)
    fx = pd.Series(0.8, index=idx)  # 0.8 local per EUR
    snap = fund.market_snapshot(close, volume, fx)
    assert snap["adv_3m"] == pytest.approx(10000.0)
    assert snap["adv_3m_eur"] == pytest.approx(12500.0)
    assert snap["high_52w"] == snap["low_52w"] == 10.0
