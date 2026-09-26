"""Read and write the dashboard data file (a JSON object wrapped in JS).

The dashboard loads the file with a plain <script> tag, which also works when
index.html is opened straight from disk (browsers block fetch() on file://).
Each stock and series is written on its own line to keep git diffs small.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from .config import DATA_JS_PREFIX


def _clean(obj):
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    return obj


def _dump(obj) -> str:
    return json.dumps(_clean(obj), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def write_data_js(data: dict, path: Path) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [DATA_JS_PREFIX + "{"]
    lines.append('"meta":' + _dump(data["meta"]) + ",")
    lines.append('"dates":' + _dump(data["dates"]) + ",")
    lines.append('"stocks":[')
    stocks = data["stocks"]
    for i, stock in enumerate(stocks):
        lines.append(_dump(stock) + ("," if i < len(stocks) - 1 else ""))
    lines.append("],")
    lines.append('"series":{')
    items = list(data["series"].items())
    for i, (key, value) in enumerate(items):
        lines.append(json.dumps(key) + ":" + _dump(value) + ("," if i < len(items) - 1 else ""))
    lines.append("}")
    lines.append("};")
    text = "\n".join(lines) + "\n"
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def read_data_js(path: Path) -> dict | None:
    path = Path(path)
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith(DATA_JS_PREFIX):
        text = text[len(DATA_JS_PREFIX) :]
    text = text.rstrip(";").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
