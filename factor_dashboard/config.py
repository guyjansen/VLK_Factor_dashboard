"""Static configuration: paths, history start and the market series to fetch."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE_CSV = ROOT / "config" / "universe.csv"
DOCS_DIR = ROOT / "docs"
DATA_JS = DOCS_DIR / "data" / "dashboard_data.js"
DATA_JS_PREFIX = "window.DASHBOARD_DATA = "

# First date shipped to the dashboard. Seven-plus years covers 5Y estimation
# windows and the stress episodes used in the scenario tab (COVID, 2022 rates).
HISTORY_START = "2019-01-01"

# Forward-fill limit (business days) used when a series has a gap.
FFILL_LIMIT = 7


@dataclass(frozen=True)
class YahooSeries:
    """A market series sourced from Yahoo Finance, tried in candidate order."""

    id: str
    label: str
    candidates: tuple[str, ...]
    kind: str  # "price" (total-return level) or "fx" or "level"
    unit: str
    group: str
    description: str = ""
    use_adjusted: bool = True


@dataclass(frozen=True)
class RateSeries:
    """A yield or spread (in percent) with an ordered list of sources."""

    id: str
    label: str
    sources: tuple[tuple[str, str], ...]  # (provider, code)
    group: str
    description: str = ""
    unit: str = "%"
    kind: str = "rate"


YAHOO_SERIES: tuple[YahooSeries, ...] = (
    YahooSeries(
        "MKT",
        "STOXX Europe 600 (total return)",
        ("EXSA.DE", "MEUD.PA", "^STOXX"),
        "price",
        "EUR",
        "Market",
        "iShares STOXX Europe 600 UCITS ETF, dividend-adjusted; falls back to the price index.",
    ),
    YahooSeries(
        "ETF_VALUE",
        "MSCI Europe Value factor",
        ("IEFV.L", "IEFV.AS"),
        "price",
        "EUR",
        "Style (ETF)",
        "iShares Edge MSCI Europe Value Factor UCITS ETF (Acc).",
    ),
    YahooSeries(
        "ETF_MOM",
        "MSCI Europe Momentum factor",
        ("IEFM.L", "IEFM.AS"),
        "price",
        "EUR",
        "Style (ETF)",
        "iShares Edge MSCI Europe Momentum Factor UCITS ETF (Acc).",
    ),
    YahooSeries(
        "ETF_QUAL",
        "MSCI Europe Quality factor",
        ("IEFQ.L", "IEFQ.AS"),
        "price",
        "EUR",
        "Style (ETF)",
        "iShares Edge MSCI Europe Quality Factor UCITS ETF (Acc).",
    ),
    YahooSeries(
        "ETF_MINVOL",
        "MSCI Europe Minimum Volatility",
        ("EUN0.DE", "MVEU.L"),
        "price",
        "EUR",
        "Style (ETF)",
        "iShares Edge MSCI Europe Minimum Volatility UCITS ETF (Acc).",
    ),
    YahooSeries(
        "ETF_SIZE",
        "MSCI Europe Mid-Cap Equal Weight",
        ("IEFS.L",),
        "price",
        "EUR",
        "Style (ETF)",
        "iShares MSCI Europe Mid-Cap Equal Weight UCITS ETF, used as a size tilt.",
    ),
    YahooSeries("BRENT", "Brent crude oil", ("BZ=F",), "price", "USD", "Commodities", "ICE Brent front-month future.", False),
    YahooSeries("VOL", "Equity volatility (VSTOXX / VIX)", ("^V2TX", "^VIX"), "level", "pts", "Risk sentiment", "Implied volatility index level.", False),
    # FX: quoted as units of foreign currency per 1 EUR (Yahoo "EURxxx=X").
    YahooSeries("FX_USD", "USD per EUR", ("EURUSD=X",), "fx", "USD", "FX", "", False),
    YahooSeries("FX_GBP", "GBP per EUR", ("EURGBP=X",), "fx", "GBP", "FX", "", False),
    YahooSeries("FX_SEK", "SEK per EUR", ("EURSEK=X",), "fx", "SEK", "FX", "", False),
    YahooSeries("FX_CHF", "CHF per EUR", ("EURCHF=X",), "fx", "CHF", "FX", "", False),
    YahooSeries("FX_NOK", "NOK per EUR", ("EURNOK=X",), "fx", "NOK", "FX", "", False),
)

RATE_SERIES: tuple[RateSeries, ...] = (
    RateSeries(
        "EUR10Y",
        "EUR 10Y yield (AAA curve)",
        (("ecb", "SR_10Y"), ("stooq", "10dey.b")),
        "Rates",
        "ECB euro area AAA government bond spot curve, 10-year point.",
    ),
    RateSeries(
        "EUR5Y",
        "EUR 5Y yield (AAA curve)",
        (("ecb", "SR_5Y"), ("stooq", "5dey.b")),
        "Rates",
        "ECB euro area AAA government bond spot curve, 5-year point.",
    ),
    RateSeries(
        "EUR2Y",
        "EUR 2Y yield (AAA curve)",
        (("ecb", "SR_2Y"), ("stooq", "2dey.b")),
        "Rates",
        "ECB euro area AAA government bond spot curve, 2-year point.",
    ),
    RateSeries(
        "GB10Y",
        "UK 10Y gilt yield",
        (("boe", "IUDMNZC"), ("boe", "IUDMNPY"), ("stooq", "10uky.b")),
        "Rates",
        "Bank of England nominal zero-coupon gilt curve, 10-year point.",
    ),
    RateSeries(
        "SE10Y",
        "Sweden 10Y government yield",
        (("riksbank", "SEGVB10YC"), ("stooq", "10sey.b")),
        "Rates",
        "Sveriges Riksbank, 10-year government bond yield.",
    ),
    RateSeries(
        "CH10Y",
        "Switzerland 10Y government yield",
        (("snb", "rendoblid:10J"), ("stooq", "10chy.b")),
        "Rates",
        "Swiss National Bank, spot yield on 10-year Confederation bonds.",
    ),
    RateSeries(
        "NO10Y",
        "Norway 10Y government yield",
        (("norges", "B.10Y.GBON"), ("stooq", "10noy.b")),
        "Rates",
        "Norges Bank generic 10-year government bond yield.",
    ),
    RateSeries(
        "EUR_HY_OAS",
        "EUR high-yield credit spread",
        (("fred", "BAMLHE00EHYIOAS"),),
        "Credit",
        "ICE BofA Euro High Yield Index option-adjusted spread (via FRED).",
    ),
)

# Kenneth French data library, European developed-market factors (daily, USD).
FRENCH_FILES = {
    "five_factor": "Europe_5_Factors_Daily_CSV.zip",
    "momentum": "Europe_Mom_Factor_Daily_CSV.zip",
}
FRENCH_FACTORS = {
    "FF_SMB": ("SMB", "Size (SMB)"),
    "FF_HML": ("HML", "Value (HML)"),
    "FF_RMW": ("RMW", "Profitability (RMW)"),
    "FF_CMA": ("CMA", "Investment (CMA)"),
    "FF_WML": ("WML", "Momentum (WML)"),
}

# Local 10Y series per country (falls back to EUR10Y in the dashboard).
LOCAL_RATE_BY_COUNTRY = {"GB": "GB10Y", "SE": "SE10Y", "CH": "CH10Y", "NO": "NO10Y"}

SOURCES = {
    "yahoo": {
        "name": "Yahoo Finance",
        "url": "https://finance.yahoo.com",
        "used_for": "Share prices, total-return prices, FX, ETFs, commodities, fundamentals and analyst consensus",
    },
    "french": {
        "name": "Kenneth R. French Data Library",
        "url": "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html",
        "used_for": "Fama-French European size, value, profitability, investment and momentum factors",
    },
    "ecb": {
        "name": "European Central Bank Data Portal",
        "url": "https://data.ecb.europa.eu",
        "used_for": "Euro area AAA government yield curve (2Y, 5Y, 10Y)",
    },
    "boe": {
        "name": "Bank of England Database",
        "url": "https://www.bankofengland.co.uk/boeapps/database",
        "used_for": "UK gilt yields",
    },
    "riksbank": {
        "name": "Sveriges Riksbank",
        "url": "https://www.riksbank.se/en-gb/statistics/",
        "used_for": "Swedish government bond yields",
    },
    "snb": {
        "name": "Swiss National Bank Data Portal",
        "url": "https://data.snb.ch",
        "used_for": "Swiss Confederation bond yields",
    },
    "norges": {
        "name": "Norges Bank",
        "url": "https://www.norges-bank.no/en/topics/Statistics/",
        "used_for": "Norwegian government bond yields",
    },
    "fred": {
        "name": "FRED, Federal Reserve Bank of St. Louis",
        "url": "https://fred.stlouisfed.org",
        "used_for": "ICE BofA Euro High Yield option-adjusted spread",
    },
    "stooq": {
        "name": "Stooq",
        "url": "https://stooq.com",
        "used_for": "Fallback source for government bond yields",
    },
}


@dataclass
class BuildOptions:
    start: str = HISTORY_START
    out: Path = DATA_JS
    fundamentals: bool = True
    pause: float = 0.6  # seconds between per-ticker Yahoo calls
    min_stock_coverage: float = 0.8  # abort if fewer stocks than this share have prices
    extra: dict = field(default_factory=dict)
