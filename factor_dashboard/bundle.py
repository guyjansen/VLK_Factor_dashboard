"""Bundle the dashboard into one self-contained HTML file for sharing.

Usage::

    python -m factor_dashboard.bundle            # dist/property_factor_lens.html, fully offline
    python -m factor_dashboard.bundle --cdn      # smaller: loads ECharts from jsDelivr
    python -m factor_dashboard.bundle --fragment --cdn --out dist/page.html
                                                 # body-only page for hosts that add <html>/<head>

The result opens straight from disk (double-click) and can be e-mailed or
dropped into Teams/SharePoint; it holds the data as of the last refresh.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from .config import DATA_JS, DOCS_DIR, ROOT

ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"
SCRIPT_RE = re.compile(r'<script src="([^"]+)"></script>')
STYLE_RE = re.compile(r'<link rel="stylesheet" href="(assets/[^"]+)">')
DEFAULT_OUT = ROOT / "dist" / "property_factor_lens.html"


def _inline_js(js: str) -> str:
    """Keep inline code from closing its <script> element early."""
    return js.replace("</script", "<\\/script").replace("<!--", "<\\!--")


def render(data_path: Path = DATA_JS, cdn: bool = False, fragment: bool = False) -> str:
    html = (DOCS_DIR / "index.html").read_text(encoding="utf-8")

    def style_sub(m: re.Match) -> str:
        return "<style>\n" + (DOCS_DIR / m.group(1)).read_text(encoding="utf-8") + "\n</style>"

    def script_sub(m: re.Match) -> str:
        src = m.group(1)
        if src.endswith("echarts.min.js") and cdn:
            return f'<script src="{ECHARTS_CDN}"></script>'
        path = Path(data_path) if src == "data/dashboard_data.js" else DOCS_DIR / src
        if not path.exists():
            raise FileNotFoundError(f"{path} is missing; run python -m factor_dashboard.build first")
        return "<script>\n" + _inline_js(path.read_text(encoding="utf-8")) + "\n</script>"

    html = STYLE_RE.sub(style_sub, html)
    html = SCRIPT_RE.sub(script_sub, html)
    if fragment:
        head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
        body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
        head = re.sub(r'<meta (charset|name="viewport")[^>]*>\s*', "", head)
        title = re.search(r"<title>.*?</title>", head, re.S).group(0)
        head = head.replace(title, "")
        html = f"{title}\n{head.strip()}\n{body.strip()}\n"
    return html


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=DATA_JS, help="data file to embed")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output HTML file")
    parser.add_argument("--cdn", action="store_true", help="load ECharts from jsDelivr instead of inlining it")
    parser.add_argument("--fragment", action="store_true", help="omit <html>, <head> and <body> wrappers")
    args = parser.parse_args(argv)
    html = render(args.data, cdn=args.cdn, fragment=args.fragment)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(html, encoding="utf-8")
    print(f"Wrote {args.out} ({len(html.encode('utf-8')) / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
