"""Kenneth R. French Data Library: European daily factor returns."""

from __future__ import annotations

import io
import re
import zipfile

import pandas as pd

from .. import http
from ..config import FRENCH_FILES

BASE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
_DATE = re.compile(r"^\d{8}$")
_ALIASES = {"MOM": "WML", "Mom": "WML", "Mkt-RF": "MKT_RF"}


def parse_french_csv(text: str) -> pd.DataFrame:
    """Parse the first daily table in a French library CSV into decimal returns."""
    header: list[str] | None = None
    rows: list[list[float]] = []
    dates: list[str] = []
    for line in text.splitlines():
        cells = [c.strip() for c in line.split(",")]
        if header is None:
            if len(cells) >= 2 and cells[0] == "" and any(c in ("Mkt-RF", "SMB", "WML", "Mom", "MOM") for c in cells[1:]):
                header = [_ALIASES.get(c, c) for c in cells[1:]]
            continue
        if not cells or not _DATE.match(cells[0]):
            if rows:
                break  # the daily table has ended
            continue
        try:
            rows.append([float(c) for c in cells[1 : len(header) + 1]])
        except ValueError:
            continue
        dates.append(cells[0])
    if header is None or not rows:
        raise ValueError("could not find a daily factor table")
    df = pd.DataFrame(rows, columns=header, index=pd.to_datetime(dates, format="%Y%m%d"))
    df = df.replace([-99.99, -999.0], float("nan"))
    return df / 100.0


def _read_zip_csv(content: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        return zf.read(name).decode("latin-1")


def fetch_europe_factors(start: str) -> pd.DataFrame:
    """Daily European Fama-French five factors plus momentum (decimal returns)."""
    frames = []
    for filename in FRENCH_FILES.values():
        resp = http.get(BASE_URL + filename, timeout=90)
        frames.append(parse_french_csv(_read_zip_csv(resp.content)))
    df = pd.concat(frames, axis=1)
    df = df.loc[:, ~df.columns.duplicated()]
    return df[df.index >= pd.Timestamp(start)]
