"""End-to-end build with every network source replaced by synthetic data."""

from __future__ import annotations

import zlib

import numpy as np
import pandas as pd
import pytest

from factor_dashboard import build as build_mod
from factor_dashboard import config
from factor_dashboard.output import read_data_js, write_data_js
from factor_dashboard.sources import yahoo
from factor_dashboard.universe import load_universe

DATES = pd.bdate_range("2018-11-15", "2026-09-25")


def _walk(seed: int, start: float, vol: float = 0.015) -> pd.Series:
    rng = np.random.default_rng(seed)
    r = rng.normal(0.0002, vol, len(DATES))
    return pd.Series(start * np.exp(np.cumsum(r)), index=DATES)


def fake_download_history(tickers, start, **kwargs):
    out = {}
    for i, t in enumerate(tickers):
        if t in ("MEUD.PA", "^STOXX", "IEFV.AS", "IEFM.AS", "IEFQ.AS", "MVEU.L", "^VIX"):
            continue  # first candidates succeed, fallbacks unused
        if t == "KOJAMO.HE":
            continue  # history ticker missing: build must cope
        level = {"EURGBP=X": 0.86, "EURSEK=X": 11.2, "EURCHF=X": 0.95, "EURNOK=X": 11.6, "EURUSD=X": 1.1}.get(t)
        base = level or (2500.0 if t.endswith(".L") else 40.0)
        close = _walk(zlib.crc32(t.encode()) % 1000, base, 0.004 if level else 0.008)
        adj = close * np.linspace(0.8, 1.0, len(close))
        frame = pd.DataFrame({"Close": close, "Adj Close": adj, "Volume": 1e5})
        if t == "VASTN.AS":
            frame = frame[frame.index < "2025-01-01"]
        out[t] = frame[frame.index >= pd.Timestamp(start)]
    return out


def fake_currency(ticker):
    return "GBp" if ticker.endswith(".L") else "EUR"


def fake_fundamentals(ticker, **kwargs):
    cols = [pd.Timestamp("2025-12-31"), pd.Timestamp("2024-12-31")]
    bs = pd.DataFrame(
        {
            cols[0]: [5.0e9, 1.0e10, 4.0e9, 3.0e8, 1.0e8],
            cols[1]: [4.8e9, 9.8e9, 4.1e9, 2.5e8, 1.0e8],
        },
        index=["Stockholders Equity", "Total Assets", "Total Debt", "Cash And Cash Equivalents", "Ordinary Shares Number"],
    )
    inc = pd.DataFrame(
        {cols[0]: [6.0e8, 4.5e8, 1.0e8], cols[1]: [5.6e8, 4.2e8, 0.9e8]},
        index=["Total Revenue", "Normalized EBITDA", "Interest Expense"],
    )
    pence = ticker.endswith(".L")
    divs = pd.Series([60.0 if pence else 0.6, 62.0 if pence else 0.62], index=pd.to_datetime(["2026-03-01", "2026-08-01"]))
    info = {
        "currency": "GBp" if pence else "EUR",
        "financialCurrency": "GBP" if pence else "EUR",
        "sharesOutstanding": 1.0e8,
        "currentPrice": 2500.0 if pence else 40.0,
        "targetMeanPrice": 2800.0 if pence else 44.0,
        "numberOfAnalystOpinions": 12,
        "recommendationMean": 2.1,
        "recommendationKey": "buy",
        "forwardPE": 1500.0 if pence else 15.0,
        "longBusinessSummary": "A property company. It owns buildings.",
    }
    return {
        "info": info,
        "balance_sheet": bs,
        "quarterly_balance_sheet": None,
        "income_stmt": inc,
        "dividends": divs,
        "calendar": {"Earnings Date": [pd.Timestamp("2026-10-20").date()]},
        "price_targets": {"mean": info["targetMeanPrice"]},
        "recommendations": pd.DataFrame([{"period": "0m", "strongBuy": 2, "buy": 5, "hold": 4, "sell": 1, "strongSell": 0}]),
        "errors": {},
    }


def fake_rate(spec, start):
    if spec.id == "NO10Y":
        return None, {"status": "failed", "errors": ["norges: offline"]}
    s = pd.Series(np.linspace(0.5, 3.0, len(DATES)), index=DATES)
    return s, {"status": "ok", "source": spec.sources[0][0], "code": spec.sources[0][1], "first": "x", "last": "y", "observations": len(s)}


def fake_french(start):
    rng = np.random.default_rng(3)
    out = {}
    for sid in config.FRENCH_FACTORS:
        r = pd.Series(rng.normal(0, 0.004, len(DATES) - 40), index=DATES[:-40])
        out[sid] = 100 * (1 + r).cumprod()
    return out, {"status": "ok", "source": "french"}


@pytest.fixture()
def offline(monkeypatch):
    monkeypatch.setattr(yahoo, "download_history", fake_download_history)
    monkeypatch.setattr(yahoo, "fetch_currency", fake_currency)
    monkeypatch.setattr(yahoo, "fetch_fundamentals_raw", fake_fundamentals)
    monkeypatch.setattr(build_mod, "_fetch_rate", fake_rate)
    monkeypatch.setattr(build_mod, "_french_indices", fake_french)
    monkeypatch.setattr(build_mod.time, "sleep", lambda s: None)


def test_offline_build_produces_consistent_file(offline, tmp_path):
    out = tmp_path / "data.js"
    data = build_mod.build(config.BuildOptions(out=out, pause=0))
    universe = load_universe()
    assert len(data["stocks"]) == len(universe)
    n = len(data["dates"])
    assert n > 1500
    for stock in data["stocks"]:
        assert len(stock["tri"]) == n and len(stock["px"]) == n
    for sid, series in data["series"].items():
        assert len(series["values"]) == n, sid
    # Pence quotes are converted to pounds.
    segro = next(s for s in data["stocks"] if s["id"] == "SGRO")
    assert segro["currency"] == "GBP"
    assert 5 < segro["fund"]["price"] < 100
    assert segro["fund"]["pe_forward"] == pytest.approx(15.0)
    assert 0 < segro["fund"]["dividend_yield"] < 0.2
    assert segro["fund"]["consensus"]["upside"] == pytest.approx(0.12, abs=1e-6)
    # Failed series are reported, not silently dropped.
    assert data["meta"]["series_status"]["NO10Y"]["status"] == "failed"
    assert "NO10Y" not in data["series"]
    # Vastned history is spliced from VASTN.AS; Lumo copes with a missing history ticker.
    status = data["meta"]["stock_status"]
    assert status["VASTB"]["spliced_with"] == "VASTN.AS"
    assert "spliced_with" not in status["URW"]
    assert status["LUMO"]["prices"] == "ok"
    size = write_data_js(data, out)
    assert size > 100_000
    again = read_data_js(out)
    assert again["meta"]["as_of"] == data["meta"]["as_of"]
    assert again["stocks"][0]["tri"][-1] == data["stocks"][0]["tri"][-1]


def test_failed_series_reuse_previous_build(offline, tmp_path, monkeypatch):
    out = tmp_path / "data.js"
    first = build_mod.build(config.BuildOptions(out=out, pause=0))
    write_data_js(first, out)

    def rate_down(spec, start):
        return None, {"status": "failed", "errors": ["offline"]}

    monkeypatch.setattr(build_mod, "_fetch_rate", rate_down)
    second = build_mod.build(config.BuildOptions(out=out, pause=0))
    assert second["series"]["EUR10Y"]["stale"] is True
    assert second["meta"]["series_status"]["EUR10Y"]["status"].startswith("stale")
    assert any("EUR10Y" in w for w in second["meta"]["warnings"])


def test_build_refuses_when_prices_missing(offline, tmp_path, monkeypatch):
    monkeypatch.setattr(yahoo, "download_history", lambda tickers, start, **kw: {})
    with pytest.raises(SystemExit):
        build_mod.build(config.BuildOptions(out=tmp_path / "x.js", pause=0))


def test_bundle_inlines_assets_and_data(tmp_path):
    from factor_dashboard import bundle

    data = tmp_path / "data.js"
    data.write_text('window.DASHBOARD_DATA = {"meta":{"note":"</script>"},"dates":[],"stocks":[],"series":{}};\n')
    html = bundle.render(data)
    assert '<script src="' not in html  # everything inline
    assert "<\\/script>" in html  # data cannot close the script tag early
    assert "window.PFModel" in html or "PFModel" in html
    frag = bundle.render(data, cdn=True, fragment=True)
    assert frag.lstrip().startswith("<title>")
    assert "<html" not in frag and "<body" not in frag
    assert bundle.ECHARTS_CDN in frag


def test_previous_series_that_had_stopped_updating_is_not_reused(offline, tmp_path, monkeypatch):
    out = tmp_path / "data.js"
    first = build_mod.build(config.BuildOptions(out=out, pause=0))
    n = len(first["dates"])
    first["series"]["CH10Y"]["values"] = first["series"]["CH10Y"]["values"][: n - 60] + [None] * 60
    write_data_js(first, out)

    def rate(spec, start):
        if spec.id == "CH10Y":
            return None, {"status": "failed", "errors": ["offline"]}
        return fake_rate(spec, start)

    monkeypatch.setattr(build_mod, "_fetch_rate", rate)
    second = build_mod.build(config.BuildOptions(out=out, pause=0))
    assert "CH10Y" not in second["series"]
    assert second["meta"]["series_status"]["CH10Y"]["status"] == "failed"
