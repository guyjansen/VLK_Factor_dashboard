"""Coverage universe: the stocks the dashboard can show."""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
from pathlib import Path

from .config import UNIVERSE_CSV

SUBSECTOR_ORDER = (
    "Retail",
    "Office",
    "Logistics",
    "Self Storage",
    "Residential & Alternatives",
    "Diversified",
)


@dataclass(frozen=True)
class Stock:
    id: str
    name: str
    ticker: str
    exchange: str
    country: str
    currency: str
    subsector: str
    segment: str
    history_ticker: str = ""
    splice_date: str = ""
    note: str = ""

    def to_meta(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in ("", None)}


def load_universe(path: Path | str = UNIVERSE_CSV) -> list[Stock]:
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    stocks = []
    seen = set()
    for row in rows:
        clean = {k: (v or "").strip() for k, v in row.items()}
        if not clean.get("id"):
            continue
        if clean["id"] in seen:
            raise ValueError(f"Duplicate id in universe: {clean['id']}")
        if clean["subsector"] not in SUBSECTOR_ORDER:
            raise ValueError(f"Unknown sub-sector {clean['subsector']!r} for {clean['id']}")
        if bool(clean.get("history_ticker")) != bool(clean.get("splice_date")):
            raise ValueError(f"{clean['id']}: history_ticker and splice_date must be set together")
        seen.add(clean["id"])
        stocks.append(
            Stock(
                id=clean["id"],
                name=clean["name"],
                ticker=clean["ticker"],
                exchange=clean.get("exchange", ""),
                country=clean["country"],
                currency=clean["currency"],
                subsector=clean["subsector"],
                segment=clean.get("segment", ""),
                history_ticker=clean.get("history_ticker", ""),
                splice_date=clean.get("splice_date", ""),
                note=clean.get("note", ""),
            )
        )
    return stocks
