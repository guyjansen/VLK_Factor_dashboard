"""Morning real estate RNS report.

Collects the day's London Stock Exchange regulatory announcements for real
estate companies and writes them into one document (HTML, plus a plain-text
copy for pasting into an e-mail).

Sources, in order:
  1. Investegate advanced search (RNS, sector 18 = real estate)
  2. londonstockexchange.com news explorer (sectors 302030, 351010, 351020)
If the first source fails, the second is used. Announcement bodies are
fetched in parallel from whichever site listed them.

Uses only the Python standard library (3.9+), so it runs on a locked-down
laptop without pip installs and without a browser. It also picks up the
Windows proxy settings and certificate store automatically.

Typical use (Task Scheduler starts it a minute or two before 07:00 UK time):

    python rns_report.py            # wait for 07:00 UK, poll, write report
    python rns_report.py --once     # one pass right now, no waiting
    python rns_report.py --diagnose # check both sources and save raw pages
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import gzip
import html
import http.cookiejar
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

# ----------------------------------------------------------------------------
# Settings (all can be overridden on the command line)
# ----------------------------------------------------------------------------
VERSION = "2"

INVESTEGATE_BASE = "https://www.investegate.co.uk"
INVESTEGATE_SECTORS = ["18"]          # 18 = Real Estate
INVESTEGATE_SOURCES = ["RNS"]
LSE_BASE = "https://www.londonstockexchange.com"
LSE_API = "https://api.londonstockexchange.com/api/v1/pages"
LSE_SECTORS = "302030,351010,351020"  # mortgage REITs, RE investment & services, REITs
LSE_HEADLINE_TYPES = "1,2"

START_TIME = "07:00:02"   # UK time to start polling
SETTLE_TIME = "07:03:30"  # keep polling for late arrivals until this UK time
GIVE_UP_TIME = "07:07:00" # stop retrying broken sources at this UK time
POLL_SECONDS = 15
HTTP_TIMEOUT = 20
WORKERS = 8

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
)

log = logging.getLogger("rns_report")


# ----------------------------------------------------------------------------
# UK time (works without the tzdata package, which Windows often lacks)
# ----------------------------------------------------------------------------
def _last_sunday(year: int, month: int) -> dt.date:
    d = dt.date(year, month + 1, 1) - dt.timedelta(days=1)
    return d - dt.timedelta(days=(d.weekday() + 1) % 7)


def uk_now() -> dt.datetime:
    """Current UK wall-clock time as a naive datetime."""
    utc = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    return utc_to_uk(utc)


def utc_to_uk(utc: dt.datetime) -> dt.datetime:
    y = utc.year
    bst_start = dt.datetime.combine(_last_sunday(y, 3), dt.time(1))
    bst_end = dt.datetime.combine(_last_sunday(y, 10), dt.time(1))
    return utc + dt.timedelta(hours=1 if bst_start <= utc < bst_end else 0)


def parse_hms(s: str) -> dt.time:
    parts = [int(p) for p in s.split(":")]
    while len(parts) < 3:
        parts.append(0)
    return dt.time(*parts)


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------
class FetchError(Exception):
    def __init__(self, msg: str, code: int | None = None, body: str = ""):
        super().__init__(msg)
        self.code = code
        self.body = body


class Session:
    """Keeps cookies between requests, as a browser tab does."""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def cookie(self, name: str) -> str | None:
        return next((c.value for c in self.jar if c.name == name), None)

    def cookie_names(self) -> list[str]:
        return sorted({c.name for c in self.jar})


def _decode(raw: bytes, headers) -> str:
    enc = (headers.get("Content-Encoding") or "").lower()
    if enc == "gzip":
        raw = gzip.decompress(raw)
    elif enc == "deflate":
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)
    return raw.decode(headers.get_content_charset() or "utf-8", errors="replace")


def fetch(url: str, *, accept: str = "text/html,application/xhtml+xml,*/*;q=0.8",
          referer: str | None = None, xhr: bool = False, retries: int = 2,
          timeout: float = HTTP_TIMEOUT, session: Session | None = None,
          data: bytes | None = None, headers: dict | None = None) -> str:
    """GET (or POST, when data is given) a URL and return the decoded body.

    Raises FetchError, which carries the HTTP status and error body if any.
    """
    h = {
        "User-Agent": USER_AGENT,
        "Accept": accept,
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    if referer:
        h["Referer"] = referer
    if xhr:
        h["X-Requested-With"] = "XMLHttpRequest"
    h.update(headers or {})
    open_ = session.opener.open if session else urllib.request.urlopen
    last: Exception | None = None
    code, body = None, ""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=h, data=data,
                                         method="POST" if data is not None else "GET")
            with open_(req, timeout=timeout) as resp:
                return _decode(resp.read(), resp.headers)
        except urllib.error.HTTPError as e:
            last, code = e, e.code
            try:
                body = _decode(e.read(), e.headers)
            except Exception:
                body = ""
            if e.code in (400, 401, 403, 404, 405, 410, 422):
                break  # retrying will not help
        except Exception as e:  # timeouts, resets, DNS hiccups
            last = e
        if attempt < retries:
            time.sleep(0.7 * (attempt + 1))
    raise FetchError(f"{url}: {last}", code, body)


# ----------------------------------------------------------------------------
# Minimal HTML tree (stdlib only)
# ----------------------------------------------------------------------------
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
BLOCKS = {"p", "div", "table", "ul", "ol", "dl", "pre", "blockquote", "form",
          "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "hr"}


class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag: str, attrs: dict | None = None, parent: "Node | None" = None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list = []
        self.parent = parent

    # -- queries ------------------------------------------------------------
    def iter(self, tag: str | None = None):
        for c in self.children:
            if isinstance(c, Node):
                if tag is None or c.tag == tag:
                    yield c
                yield from c.iter(tag)

    def classes(self) -> list[str]:
        return (self.attrs.get("class") or "").split()

    def find(self, tag: str | None = None, cls: str | None = None, id_: str | None = None):
        for n in self.iter(tag):
            if cls and cls not in n.classes():
                continue
            if id_ and n.attrs.get("id") != id_:
                continue
            return n
        return None

    def find_all(self, tag: str | None = None, cls: str | None = None):
        return [n for n in self.iter(tag) if not cls or cls in n.classes()]

    def text(self) -> str:
        out: list[str] = []
        _collect_text(self, out)
        return re.sub(r"\s+", " ", "".join(out)).strip()


def _collect_text(node: Node, out: list[str]) -> None:
    for c in node.children:
        if isinstance(c, str):
            out.append(c)
        elif c.tag not in ("script", "style"):
            if c.tag in BLOCKS or c.tag in ("br", "td", "th", "li", "tr"):
                out.append(" ")
            _collect_text(c, out)


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def _close_until(self, tags: set[str], stop: set[str] = frozenset()) -> None:
        for i in range(len(self.stack) - 1, 0, -1):
            t = self.stack[i].tag
            if t in stop:
                return
            if t in tags:
                del self.stack[i:]
                return

    def handle_starttag(self, tag, attrs):
        if tag == "p" or tag in BLOCKS:
            self._close_until({"p"}, stop={"div", "td", "th", "li", "table", "body"})
        elif tag == "li":
            self._close_until({"li"}, stop={"ul", "ol"})
        elif tag == "tr":
            self._close_until({"tr"}, stop={"table"})
        elif tag in ("td", "th"):
            self._close_until({"td", "th"}, stop={"tr", "table"})
        parent = self.stack[-1]
        node = Node(tag, {k: (v or "") for k, v in attrs}, parent)
        parent.children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        parent = self.stack[-1]
        parent.children.append(Node(tag, {k: (v or "") for k, v in attrs}, parent))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data:
            self.stack[-1].children.append(data)


def parse_html(s: str) -> Node:
    b = _TreeBuilder()
    b.feed(s)
    b.close()
    return b.root


# ----------------------------------------------------------------------------
# Data model
# ----------------------------------------------------------------------------
@dataclass
class Announcement:
    source: str              # "Investegate" or "LSE"
    url: str
    company: str
    tidm: str
    headline: str
    when: dt.datetime | None  # UK time
    body_html: str = ""
    body_text: str = ""
    error: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str]:
        return (self.tidm.upper(), re.sub(r"[^a-z0-9]", "", self.headline.lower()))


# ----------------------------------------------------------------------------
# Source 1: Investegate
# ----------------------------------------------------------------------------
def investegate_date(d: dt.date) -> str:
    """Date as the site's date picker formats it ('d MM yyyy')."""
    return f"{d.day} {d.strftime('%B %Y')}"


def investegate_page_url(d: dt.date, exclude_navs: bool) -> str:
    """The advanced-search page a person opens in the browser."""
    q = [("search_for", "1"), ("date_from", investegate_date(d)),
         ("exclude_navs", "true" if exclude_navs else "false"),
         ("sources", ",".join(INVESTEGATE_SOURCES)), ("sectors", ",".join(INVESTEGATE_SECTORS))]
    return f"{INVESTEGATE_BASE}/advanced-search?{urllib.parse.urlencode(q)}"


def investegate_draw_url(d: dt.date, exclude_navs: bool, *, date_from: bool = True,
                         date_to: bool = False, page: int | None = None) -> str:
    """The request the page's jQuery makes to fill its results table.

    jQuery sends list values as name[]=value (the plain form gets HTTP 422)
    and leaves out an empty category list. Sending "categories=" made the
    site return an empty table (checked 15 October 2026), so it is not sent.
    """
    q = [("search_for", "1"), ("search_word", ""),
         ("date_from", investegate_date(d) if date_from else ""),
         ("date_to", investegate_date(d) if date_to else ""),
         ("exclude_navs", "true" if exclude_navs else "false")]
    q += [("sources[]", s) for s in INVESTEGATE_SOURCES]
    q += [("sectors[]", s) for s in INVESTEGATE_SECTORS]
    q += [("key_word", ""), ("page", "" if page is None else str(page))]
    return f"{INVESTEGATE_BASE}/advanced-search/draw?{urllib.parse.urlencode(q)}"


# Ways of asking for the results table, most browser-like first. A browser
# loads the search page (getting session cookies) before the table request,
# so the session variants do the same.
INVESTEGATE_VARIANTS = [
    ("session, date", {"session": True, "date_from": True, "date_to": False}),
    ("session, date from+to", {"session": True, "date_from": True, "date_to": True}),
    ("session, no date", {"session": True, "date_from": False, "date_to": False}),
    ("no session, date", {"session": False, "date_from": True, "date_to": False}),
]

_COMPANY_TIDM = re.compile(r"^(.*?)\s*\(([A-Z0-9.]{1,8})\)\s*$")


def parse_investegate_list(page_html: str, base: str = INVESTEGATE_BASE) -> list[Announcement] | None:
    """Rows of the Investegate results table. None if there is no results table."""
    root = parse_html(page_html)
    table = root.find("table", cls="table-investegate")
    if table is None:
        return None
    out = []
    for tr in table.iter("tr"):
        tds = [c for c in tr.children if isinstance(c, Node) and c.tag == "td"]
        if len(tds) < 4:
            continue
        link = None
        for a in tds[-1].iter("a"):
            if "/announcement/" in a.attrs.get("href", ""):
                link = a
                break
        if link is None:
            continue
        company = tds[1].text()
        m = _COMPANY_TIDM.match(company)
        name, tidm = (m.group(1), m.group(2)) if m else (company, "")
        when = None
        try:
            when = dt.datetime.strptime(tds[0].text(), "%d %b %Y %I:%M %p")
        except ValueError:
            pass
        out.append(Announcement(
            source="Investegate",
            url=urllib.parse.urljoin(base + "/", link.attrs["href"]),
            company=name, tidm=tidm, headline=link.text(), when=when,
            extra={"newswire": tds[2].text()},
        ))
    return out


def investegate_max_page(page_html: str) -> int:
    nums = [int(n) for n in re.findall(r"[?&]page=(\d+)", page_html)]
    nums += [int(n) for n in re.findall(r'data-page="(\d+)"', page_html)]
    return max(nums, default=1)


def validate_investegate(rows: list[Announcement]) -> str:
    """Reason the rows cannot be the filtered list, or '' if they look right."""
    wanted = {s.upper() for s in INVESTEGATE_SOURCES}
    wires = {r.extra.get("newswire", "").upper() for r in rows} - {""}
    if wires - wanted:
        return f"source filter ignored (newswires {', '.join(sorted(wires))})"
    if len(rows) > 300:
        return f"{len(rows)} rows: sector filter ignored"
    return ""


class InvestegateSource:
    name = "Investegate"

    def __init__(self, exclude_navs: bool):
        self.exclude_navs = exclude_navs
        self.session: Session | None = None
        self.preferred: str | None = None  # variant that last returned rows
        self._session_error: FetchError | None = None

    def _session(self, d: dt.date) -> Session:
        if self.session is None:
            if self._session_error:  # failed earlier in this poll: don't wait again
                raise self._session_error
            s = Session()
            try:
                fetch(investegate_page_url(d, self.exclude_navs), session=s)
            except FetchError as e:
                self._session_error = e
                raise
            self.session = s
        return self.session

    def fetch_variant(self, d: dt.date, opts: dict, page: int | None = None) -> str:
        s = self._session(d) if opts["session"] else None
        headers = {"Accept": "*/*"}
        if s is not None and s.cookie("XSRF-TOKEN"):
            headers["X-XSRF-TOKEN"] = urllib.parse.unquote(s.cookie("XSRF-TOKEN"))
        url = investegate_draw_url(d, self.exclude_navs, date_from=opts["date_from"],
                                   date_to=opts["date_to"], page=page)
        return fetch(url, xhr=True, referer=investegate_page_url(d, self.exclude_navs),
                     session=s, headers=headers)

    def list(self, d: dt.date) -> list[Announcement]:
        """Today's rows. [] when the site answers but lists nothing (yet)."""
        errors, answered = [], False
        self._session_error = None
        variants = sorted(INVESTEGATE_VARIANTS, key=lambda v: v[0] != self.preferred)
        for label, opts in variants:
            try:
                body = self.fetch_variant(d, opts)
            except FetchError as e:
                errors.append(f"{label}: {e}")
                continue
            rows = parse_investegate_list(body)
            if rows is None:
                errors.append(f"{label}: no results table in response")
                continue
            answered = True
            problem = validate_investegate(rows)
            if problem:
                errors.append(f"{label}: {problem}")
                continue
            # Further pages, while they still hold today's announcements
            last_page = min(investegate_max_page(body), 10)
            for p in range(2, last_page + 1):
                if rows and rows[-1].when and rows[-1].when.date() < d:
                    break
                try:
                    more = parse_investegate_list(self.fetch_variant(d, opts, page=p))
                except FetchError as e:
                    log.warning("Investegate page %d failed: %s", p, e)
                    break
                if not more:
                    break
                rows += more
            today = [r for r in rows if r.when is None or r.when.date() == d]
            if today:
                self.preferred = label
                log.info("Investegate list: %d rows (%s)", len(today), label)
                return today
            errors.append(f"{label}: 0 rows")
        if answered:
            log.info("Investegate: nothing listed for %s (%s)", d, "; ".join(errors))
            return []
        raise FetchError("Investegate listing failed: " + " | ".join(errors))


# ----------------------------------------------------------------------------
# Source 2: London Stock Exchange
# ----------------------------------------------------------------------------
LSE_REFRESH = "https://api.londonstockexchange.com/api/v1/components/refresh"
# The "News explorer" block on the /news page, which loads the announcement rows
LSE_NEWS_COMPONENT = "block_content:431d02ac-09b8-40c9-aba6-04a72a4f2e49"
_LSE_COMPONENT_ID = re.compile(r"^block_content:[0-9a-f-]{36}$")


def lse_query() -> str:
    return (f"tab=news-explorer&period=daily&headlinetypes={LSE_HEADLINE_TYPES}"
            f"&sectors={LSE_SECTORS}")


_LSE_ARTICLE = re.compile(r"/news-article/([^/\"'?#]+)/([^/\"'?#]+)/(\d+)")
_LSE_COMPANY = re.compile(r"^(.*?)\s*-\s*([A-Z0-9.]{1,8})\s*-\s*$")


def parse_lse_list(page_html: str) -> list[Announcement] | None:
    """Rows of the LSE news-explorer table as the browser shows it. None if absent."""
    root = parse_html(page_html)
    out, seen = [], set()
    for td in root.find_all("td", cls="news-title"):
        a = next((x for x in td.iter("a") if _LSE_ARTICLE.search(x.attrs.get("href", ""))), None)
        if a is None:
            continue
        href = urllib.parse.urljoin(LSE_BASE + "/", a.attrs["href"])
        if href in seen:
            continue
        seen.add(href)
        # Company is the text in the cell before the link: "British Land Co PLC - BLND -"
        lead = "".join(c for c in td.children if isinstance(c, str)).strip()
        m = _LSE_COMPANY.match(lead)
        tidm = _LSE_ARTICLE.search(href).group(1)
        company = m.group(1) if m else (lead.rstrip(" -") or tidm)
        tr = td.parent
        while tr is not None and tr.tag != "tr":
            tr = tr.parent
        when = _lse_row_time(tr.text() if tr is not None else td.text())
        out.append(Announcement("LSE", href, company, tidm, a.text(), when))
    return out or None


def _lse_row_time(row_text: str) -> dt.datetime | None:
    # Date and time sit side by side in the row ("15.10.26 07:00:07", or
    # "15 October 2026 07:00:07" in the mobile layout). Matching the pair avoids
    # picking up a date from the headline, e.g. "year ended 30 June 2026".
    for pattern, fmt in ((r"\b(\d{2}\.\d{2}\.\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\b", "%d.%m.%y"),
                         (r"\b(\d{1,2} [A-Z][a-z]+ \d{4})\s+(\d{2}:\d{2}(?::\d{2})?)\b", "%d %B %Y")):
        m = re.search(pattern, row_text)
        if m:
            try:
                day = dt.datetime.strptime(m.group(1), fmt).date()
                return dt.datetime.combine(day, parse_hms(m.group(2)))
            except ValueError:
                continue
    return None


def _first(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def parse_lse_api_list(payload: str) -> list[Announcement] | None:
    """News items from LSE JSON. None if the JSON holds no news list at all
    (for example the page/CMS layout), so that it is not mistaken for an
    empty day."""
    try:
        data = json.loads(payload)
    except ValueError:
        return None
    out, seen, has_list = [], set(), False
    for d in _walk_dicts(data):
        if "totalElements" in d or "newsexplorersearch" in str(d.get("name", "")).lower():
            has_list = True
        nid = _first(d, "id", "newsId", "newsid")
        title = _first(d, "title", "headline")
        code = _first(d, "companycode", "companyCode", "tidm", "issuercode")
        if not (nid and title and code) or not str(nid).isdigit() or str(nid) in seen:
            continue
        seen.add(str(nid))
        slug = re.sub(r"[^a-z0-9]+", "-", str(title).lower()).strip("-")
        when = None
        for k in ("datetime", "publishedDate", "dateTime", "date", "publishDate"):
            if d.get(k):
                when = _parse_iso(str(d[k]))
                if when:
                    break
        out.append(Announcement("LSE", f"{LSE_BASE}/news-article/{code}/{slug}/{nid}",
                                str(_first(d, "companyname", "companyName", "issuername") or code),
                                str(code), html.unescape(str(title)), when))
    return out if (out or has_list) else None


def _parse_iso(s: str) -> dt.datetime | None:
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is not None:
        t = utc_to_uk(t.astimezone(dt.timezone.utc).replace(tzinfo=None))
    return t


def _walk_dicts(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk_dicts(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk_dicts(v)


def lse_component_ids(pages_json: str) -> list[str]:
    """Block ids in an LSE page layout, the news blocks first."""
    try:
        data = json.loads(pages_json)
    except ValueError:
        return []
    found: list[tuple[int, str]] = []
    for d in _walk_dicts(data):
        for v in d.values():
            if isinstance(v, str) and _LSE_COMPONENT_ID.match(v):
                label = str(_first(d, "title", "name", "label", "type") or "").strip().lower()
                rank = 0 if label in ("news explorer", "news article") else \
                    1 if "news" in label else 2
                found.append((rank, v))
    seen, out = set(), []
    for _, v in sorted(found, key=lambda x: x[0]):
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def lse_pages_url(path: str, parameters: str) -> str:
    return f"{LSE_API}?" + urllib.parse.urlencode({"path": path, "parameters": parameters})


def lse_refresh(path: str, parameters: str, components: list[str],
                component_params: str | None, encode_ids: bool = True) -> str:
    """POST to the endpoint the LSE site uses to load a block's data."""
    payload = {
        "path": path,
        "parameters": urllib.parse.quote(parameters, safe=""),
        "components": [{"componentId": urllib.parse.quote(c, safe="") if encode_ids else c,
                        "parameters": component_params} for c in components],
    }
    return fetch(LSE_REFRESH, data=json.dumps(payload).encode("utf-8"),
                 accept="application/json, text/plain, */*", referer=LSE_BASE + "/",
                 headers={"Content-Type": "application/json", "Origin": LSE_BASE})


def lse_list_variants(query: str):
    """(label, callable returning the response text), most likely first."""
    paged = f"{query}&page=0&size=100"
    return [
        ("refresh, paged", lambda: lse_refresh("news", query, [LSE_NEWS_COMPONENT], paged)),
        ("refresh, query", lambda: lse_refresh("news", query, [LSE_NEWS_COMPONENT], query)),
        ("refresh, raw id", lambda: lse_refresh("news", query, [LSE_NEWS_COMPONENT], paged,
                                                encode_ids=False)),
        ("refresh, no params", lambda: lse_refresh("news", query, [LSE_NEWS_COMPONENT], None)),
    ]


class LseSource:
    name = "LSE"

    def __init__(self):
        self.preferred: str | None = None

    def list(self, d: dt.date) -> list[Announcement]:
        errors, answered = [], False
        variants = sorted(lse_list_variants(lse_query()), key=lambda v: v[0] != self.preferred)
        for label, call in variants:
            try:
                rows = parse_lse_api_list(call())
            except FetchError as e:
                errors.append(f"{label}: {e}")
                continue
            if rows is None:
                errors.append(f"{label}: no news list in response")
                continue
            answered = True
            if len(rows) > 300:
                errors.append(f"{label}: {len(rows)} rows: sector filter ignored")
                continue
            today = [r for r in rows if r.when is None or r.when.date() == d]
            if today:
                self.preferred = label
                log.info("LSE list: %d rows (%s)", len(today), label)
                return today
            errors.append(f"{label}: 0 rows")
        # Last resort: the web page itself, in case it ever ships the rows
        try:
            rows = parse_lse_list(fetch(f"{LSE_BASE}/news?{lse_query()}"))
            if rows is not None:
                today = [r for r in rows if r.when is None or r.when.date() == d]
                log.info("LSE list: %d rows (web page)", len(today))
                return today
            errors.append("web page: no news rows in page")
        except FetchError as e:
            errors.append(f"web page: {e}")
        if answered:
            log.info("LSE: nothing listed for %s (%s)", d, "; ".join(errors))
            return []
        raise FetchError("LSE listing failed: " + " | ".join(errors))


def lse_article_json(news_id: str, headline: str = "") -> str | None:
    """Announcement HTML from the LSE APIs, or None."""
    params = f"newsId={news_id}"
    try:
        layout = fetch(lse_pages_url("news-article", params), accept="application/json",
                       referer=LSE_BASE + "/")
    except FetchError as e:
        log.warning("LSE article layout failed for %s: %s", news_id, e)
        layout = ""
    body = extract_json_body(layout, headline) if layout else None
    if body:
        return body
    ids = lse_component_ids(layout) if layout else []
    if ids:
        try:
            return extract_json_body(lse_refresh("news-article", params, ids, None), headline)
        except FetchError as e:
            log.warning("LSE article refresh failed for %s: %s", news_id, e)
    return None


# ----------------------------------------------------------------------------
# Announcement body extraction
# ----------------------------------------------------------------------------
DROP_TAGS = {"script", "style", "noscript", "iframe", "svg", "form", "nav", "header",
             "footer", "aside", "button", "select", "input", "textarea", "template",
             "link", "meta", "head", "title", "object", "embed", "canvas", "video"}
DROP_CLASS = re.compile(
    r"(^|[\s_-])(cookie|onetrust|consent|navbar|nav-bar|breadcrumbs?|sidebar|side-bar|"
    r"footer|advert|adverts|advertisement|tradingview|social|share|modal|popup|"
    r"newsletter|subscribe|related|recommended|most-read)($|[\s_-])", re.I)
# Known containers, checked before the generic search. Only used when they hold
# a real amount of text, so a wrong guess costs nothing.
KNOWN_BODY = [("div", "news-body"), ("div", "news-body-content"), ("div", "news-article-content"),
              ("div", "announcement-content"), ("div", "announcement-body"),
              ("div", "announcement-text"), ("div", "article-body"), ("div", "rns-body")]
KNOWN_BODY_IDS = ["rns", "ArticleContent", "announcement", "news-body", "newsArticle"]


def _prune(node: Node) -> None:
    keep = []
    for c in node.children:
        if isinstance(c, Node):
            ident = " ".join(c.classes() + [c.attrs.get("id", "")])
            if c.tag in DROP_TAGS or (ident.strip() and DROP_CLASS.search(ident)):
                continue
            if "display:none" in c.attrs.get("style", "").replace(" ", ""):
                continue
            _prune(c)
        keep.append(c)
    node.children = keep


def _weights(node: Node, memo: dict) -> int:
    """Non-link text length under a node (links count for a tenth)."""
    total = 0
    for c in node.children:
        if isinstance(c, str):
            total += len(c.strip())
        else:
            w = _weights(c, memo)
            total += w // 10 if c.tag == "a" else w
    memo[id(node)] = total
    return total


def extract_body(page_html: str) -> Node | None:
    root = parse_html(page_html)
    body = root.find("body") or root
    _prune(body)
    memo: dict = {}
    _weights(body, memo)
    for tag, cls in KNOWN_BODY:
        n = body.find(tag, cls=cls)
        if n is not None and memo.get(id(n), 0) >= 150:
            return n
    for id_ in KNOWN_BODY_IDS:
        n = body.find(id_=id_)
        if n is not None and memo.get(id(n), 0) >= 150:
            return n
    # Generic: walk down while one child holds most of the text
    node = body
    while True:
        kids = [c for c in node.children if isinstance(c, Node)]
        if not kids:
            break
        best = max(kids, key=lambda k: memo.get(id(k), 0))
        if memo.get(id(best), 0) >= 0.8 * memo.get(id(node), 1) and memo.get(id(best), 0) > 0:
            node = best
        else:
            break
    return node if memo.get(id(node), 0) > 0 else None


def extract_json_body(page: str, headline: str = "") -> str | None:
    """Longest HTML 'body' string in embedded or returned JSON (LSE) that
    mentions the headline, so that a CMS text block is not taken instead."""
    blobs = []
    if page.lstrip().startswith(("{", "[")):
        blobs.append(page)
    blobs += re.findall(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', page, re.S)
    best = None
    for blob in blobs:
        try:
            data = json.loads(blob)
        except ValueError:
            try:  # older Angular transfer-state escaping
                data = json.loads(blob.replace("&q;", '"').replace("&a;", "&").replace(
                    "&s;", "'").replace("&l;", "<").replace("&g;", ">"))
            except ValueError:
                continue
        for d in _walk_dicts(data):
            v = d.get("body")
            if isinstance(v, str) and len(v) > 100 and (best is None or len(v) > len(best)) \
                    and _mentions(re.sub(r"<[^>]+>", " ", v), headline):
                best = v
    return best


ALLOWED = {"p", "br", "b", "strong", "i", "em", "u", "sub", "sup", "table", "thead",
           "tbody", "tfoot", "tr", "td", "th", "ul", "ol", "li", "h1", "h2", "h3", "h4",
           "h5", "h6", "pre", "blockquote", "hr", "div", "a", "caption", "img"}


def to_clean_html(node: Node, base_url: str) -> str:
    out: list[str] = []

    def emit(n):
        for c in n.children:
            if isinstance(c, str):
                out.append(html.escape(c, quote=False))
                continue
            if c.tag in DROP_TAGS:
                continue
            if c.tag not in ALLOWED:
                emit(c)
                continue
            attrs = ""
            if c.tag in ("td", "th"):
                for k in ("colspan", "rowspan"):
                    if c.attrs.get(k, "").isdigit():
                        attrs += f' {k}="{c.attrs[k]}"'
            elif c.tag == "a":
                href = urllib.parse.urljoin(base_url, c.attrs.get("href", ""))
                if href.startswith("http"):
                    attrs = f' href="{html.escape(href)}"'
            elif c.tag == "img":
                src = urllib.parse.urljoin(base_url, c.attrs.get("src", ""))
                if not src.startswith("http"):
                    continue
                attrs = f' src="{html.escape(src)}" alt="{html.escape(c.attrs.get("alt", ""))}"'
            if c.tag in VOID:
                out.append(f"<{c.tag}{attrs}>")
                continue
            out.append(f"<{c.tag}{attrs}>")
            emit(c)
            out.append(f"</{c.tag}>")

    emit(node)
    return "".join(out).strip()


def to_text(node: Node) -> str:
    out: list[str] = []

    def emit(n, pre=False):
        for c in n.children:
            if isinstance(c, str):
                out.append(c if pre else re.sub(r"\s+", " ", c))
                continue
            if c.tag in DROP_TAGS:
                continue
            if c.tag == "br":
                out.append("\n")
            elif c.tag in ("td", "th"):
                emit(c, pre)
                out.append("\t")
            elif c.tag == "tr":
                emit(c, pre)
                out.append("\n")
            elif c.tag == "li" or c.tag in BLOCKS:
                out.append("\n")
                if c.tag == "li":
                    out.append("- ")
                emit(c, pre or c.tag == "pre")
                out.append("\n")
            else:
                emit(c, pre)

    emit(node)
    text = "".join(out)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _mentions(text: str, headline: str) -> bool:
    """Whether extracted text plausibly belongs to the announcement."""
    words = [w for w in re.findall(r"[a-z]{4,}", headline.lower())]
    low = text.lower()
    return not words or any(w in low for w in words)


def fetch_body(a: Announcement) -> Announcement:
    try:
        node = None
        if a.source == "LSE":
            m = _LSE_ARTICLE.search(a.url)
            j = lse_article_json(m.group(3), a.headline) if m else None
            if not j:
                page = fetch(a.url)
                j = extract_json_body(page, a.headline)
                if not j:
                    node = extract_body(page)
                    if node is not None and not _mentions(node.text(), a.headline):
                        node = None  # page furniture, not the announcement
            if j:
                node = parse_html(j)
        else:
            node = extract_body(fetch(a.url))
        if node is None:
            raise FetchError("could not find the announcement text on the page")
        a.body_html = to_clean_html(node, a.url)
        a.body_text = to_text(node)
        if len(a.body_text) < 40:
            raise FetchError("announcement text looks empty")
    except Exception as e:  # keep going: one bad page must not sink the report
        a.error = str(e)
        log.warning("Body failed for %s: %s", a.url, e)
    return a


# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------
CSS = """
body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1b1b1b;max-width:60em;margin:1.5em auto;padding:0 1em}
h1{font-size:18pt;margin-bottom:.2em} h2{font-size:14pt;margin:1.6em 0 .2em;border-top:2px solid #333;padding-top:.6em}
.meta{color:#555;font-size:10pt} .err{color:#a00}
table{border-collapse:collapse;margin:.5em 0} td,th{border:1px solid #bbb;padding:2px 6px;vertical-align:top;font-size:10pt}
table.index td{border:none;border-bottom:1px solid #ddd} img{max-width:100%}
.body{margin-top:.6em}
"""


def _fmt_time(t: dt.datetime | None) -> str:
    return t.strftime("%H:%M") if t else ""


def build_html(day: dt.date, items: list[Announcement], status: str) -> str:
    e = html.escape
    rows = "".join(
        f'<tr><td>{_fmt_time(a.when)}</td><td>{e(a.company)}{f" ({e(a.tidm)})" if a.tidm else ""}</td>'
        f'<td><a href="#a{i}">{e(a.headline)}</a></td></tr>'
        for i, a in enumerate(items))
    parts = [f"<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
             f"<title>Real estate RNS {day.isoformat()}</title><style>{CSS}</style></head><body>",
             f"<h1>Real estate RNS announcements: {day.strftime('%A %d %B %Y')}</h1>",
             f"<p class='meta'>{e(status)}</p>"]
    if items:
        parts.append(f"<table class='index'>{rows}</table>")
    else:
        parts.append("<p>No real estate announcements found.</p>")
    for i, a in enumerate(items):
        parts.append(f"<h2 id='a{i}'>{e(a.company)}{f' ({e(a.tidm)})' if a.tidm else ''}: "
                     f"{e(a.headline)}</h2>")
        parts.append(f"<p class='meta'>{_fmt_time(a.when)} UK &middot; "
                     f"<a href='{e(a.url)}'>{e(a.url)}</a></p>")
        if a.error:
            parts.append(f"<p class='err'>Could not retrieve the text ({e(a.error)}). "
                         f"Open the link above.</p>")
        else:
            parts.append(f"<div class='body'>{a.body_html}</div>")
    parts.append("</body></html>")
    return "\n".join(parts)


def build_text(day: dt.date, items: list[Announcement], status: str) -> str:
    out = [f"REAL ESTATE RNS ANNOUNCEMENTS: {day.strftime('%A %d %B %Y')}", status, ""]
    for a in items:
        out.append(f"  {_fmt_time(a.when):5}  {a.company} ({a.tidm}): {a.headline}")
    for a in items:
        out += ["", "=" * 78, f"{a.company} ({a.tidm}): {a.headline}",
                f"{_fmt_time(a.when)} UK | {a.url}", "=" * 78, ""]
        out.append(f"[Could not retrieve the text: {a.error}. Open the link above.]"
                   if a.error else a.body_text)
    return "\n".join(out) + "\n"


def write_atomic(path: Path, content: str) -> Path:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    try:
        os.replace(tmp, path)
        return path
    except PermissionError:  # file is open in Word/Edge: write next to it instead
        alt = path.with_name(f"{path.stem}_{uk_now():%H%M%S}{path.suffix}")
        os.replace(tmp, alt)
        return alt


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------
class Collector:
    def __init__(self, day: dt.date, source: str, exclude_navs: bool,
                 since: dt.time | None = None):
        self.day = day
        self.source = source
        self.exclude_navs = exclude_navs
        self.since = since
        self.items: dict[tuple, Announcement] = {}
        self.used: set[str] = set()
        self.last_error = ""
        self.listed_ok = False
        self.sources = {"investegate": InvestegateSource(exclude_navs), "lse": LseSource()}
        self.notes: dict[str, str] = {}  # per-source outcome for the status line

    def _list(self) -> list[Announcement]:
        order = {"auto": ["investegate", "lse"], "investegate": ["investegate"],
                 "lse": ["lse"]}[self.source]
        errors, empty = [], None
        for name in order:
            src = self.sources[name]
            try:
                rows = src.list(self.day)
            except FetchError as e:
                log.warning("%s", e)
                errors.append(str(e))
                self.notes[src.name] = "failed"
                continue
            if self.since:
                rows = [r for r in rows if r.when is None or r.when.time() >= self.since]
            self.listed_ok = True
            if rows:
                self.used.add(src.name)
                self.notes[src.name] = f"{len(rows)} listed"
                return rows
            self.notes[src.name] = "answered but listed nothing"
            empty = rows  # nothing here (yet); see whether the other source has items
        self.last_error = " | ".join(errors)
        return empty or []

    def poll(self, pool) -> int:
        rows = self._list()
        new = [r for r in rows if r.key not in self.items]
        for r in new:
            self.items[r.key] = r
        if new:
            log.info("Fetching %d new announcement(s)", len(new))
            list(pool.map(fetch_body, new))
        # Retry earlier failures once more on each pass
        fresh = {id(a) for a in new}
        retry = [a for a in self.items.values() if a.error and id(a) not in fresh]
        if retry:
            for a in retry:
                a.error = ""
            list(pool.map(fetch_body, retry))
        return len(new)

    def sorted_items(self) -> list[Announcement]:
        return sorted(self.items.values(),
                      key=lambda a: (a.when or dt.datetime.max, a.company.lower(), a.headline))


def run(args) -> int:
    now = uk_now()
    day = dt.date.fromisoformat(args.date) if args.date else now.date()
    start = dt.datetime.combine(day, parse_hms(args.start))
    settle = dt.datetime.combine(day, parse_hms(args.settle))
    give_up = dt.datetime.combine(day, parse_hms(args.give_up))
    once = args.once or day != now.date() or now >= settle

    if not once and now < start:
        wait = (start - now).total_seconds()
        log.info("Waiting %.0f s until %s UK", wait, start.time())
        time.sleep(wait)

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    html_path = out_dir / f"RNS_RealEstate_{day.isoformat()}.html"
    txt_path = out_dir / f"RNS_RealEstate_{day.isoformat()}.txt"
    since = parse_hms(args.since) if args.since else None
    col = Collector(day, args.source, args.exclude_navs, since)
    t0 = time.monotonic()
    written = None

    def write(final: bool):
        nonlocal written
        items = col.sorted_items()
        failed = sum(1 for a in items if a.error)
        status = (f"{len(items)} announcement(s); source: {', '.join(sorted(col.used)) or 'none'}; "
                  f"generated {uk_now():%H:%M:%S} UK"
                  + (f"; {failed} could not be retrieved" if failed else "")
                  + ("" if col.listed_ok else f"; SOURCES FAILED: {col.last_error}")
                  + (f"; WARNING: no announcements found ({', '.join(f'{k}: {v}' for k, v in col.notes.items())})."
                     " A weekday normally has several, so run --diagnose"
                     if final and not items and col.listed_ok and day.weekday() < 5 else "")
                  + ("" if final else " (still checking for late announcements)"))
        written = write_atomic(html_path, build_html(day, items, status))
        write_atomic(txt_path, build_text(day, items, status))
        log.info("Wrote %s (%d items, %.1f s)", written, len(items), time.monotonic() - t0)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        while True:
            try:
                new = col.poll(pool)
            except Exception as e:  # never die before writing something
                log.exception("Poll failed: %s", e)
                new = 0
            if once:
                break
            if new:
                write(final=False)
            now = uk_now()
            if now >= give_up or (now >= settle and col.listed_ok):
                break
            time.sleep(max(1.0, min(args.poll, (give_up - now).total_seconds())))
    write(final=True)
    if args.open and written and hasattr(os, "startfile"):
        os.startfile(str(written))  # type: ignore[attr-defined]
    return 0 if col.listed_ok else 2


def _err(e: FetchError) -> str:
    snippet = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", e.body or ""))[:160].strip()
    return f"HTTP {e.code}: {e}" + (f" | {snippet}" if snippet else "") if e.code else str(e)


def announcement_table_queries(d: dt.date) -> list[list[tuple[str, str]]]:
    """Investegate's other table (/announcement-table, DataTables JSON). Probed for information."""
    cols = [("date", "created_on"), ("source_code", "source_code"), ("company", "companies.name"),
            ("head_line", "head_line"), ("symbol", "companies.symbol")]
    base = [("draw", "1")]
    for i, (data, name) in enumerate(cols):
        base += [(f"columns[{i}][data]", data), (f"columns[{i}][name]", name),
                 (f"columns[{i}][searchable]", "true"), (f"columns[{i}][orderable]", "true"),
                 (f"columns[{i}][search][value]", ""), (f"columns[{i}][search][regex]", "false")]
    base += [("order[0][column]", "0"), ("order[0][dir]", "desc"), ("start", "0"),
             ("length", "100"), ("search[value]", ""), ("search[regex]", "false"),
             ("tab", "all-tab"), ("categories", ""), ("searchtype", ""), ("words", "")]
    src, sec = ",".join(INVESTEGATE_SOURCES), ",".join(INVESTEGATE_SECTORS)
    return [
        base + [("source", src), ("sectors", sec), ("date", "")],
        base + [("source", src)] + [("sectors[]", s) for s in INVESTEGATE_SECTORS] + [("date", "")],
        base + [("source", src), ("sectors", sec), ("date", investegate_date(d))],
    ]


def _summarise_table_json(body: str) -> str:
    try:
        data = json.loads(body)
    except ValueError:
        return "not JSON: " + re.sub(r"\s+", " ", body[:150])
    if not isinstance(data, dict):
        return f"JSON {type(data).__name__}"
    rows = data.get("data") or []
    head = "; ".join(
        " | ".join(re.sub(r"<[^>]+>", "", str(r.get(k, ""))).strip()[:40]
                   for k in ("date", "source_code", "company", "head_line"))
        for r in rows[:4] if isinstance(r, dict))
    return (f"recordsTotal={data.get('recordsTotal')} recordsFiltered={data.get('recordsFiltered')} "
            f"rows={len(rows)}; first: {head}")


def diagnose(args) -> int:
    """Try every way of reading each source, save the raw responses and write
    a short summary (output/debug/probe_summary.txt) to send for debugging."""
    day = dt.date.fromisoformat(args.date) if args.date else uk_now().date()
    dbg = Path(args.out).expanduser() / "debug"
    dbg.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []

    def say(s: str = "") -> None:
        print(s)
        lines.append(s)

    def save(name: str, text: str | None) -> None:
        (dbg / name).write_text(text or "", encoding="utf-8")

    def show(rows: list[Announcement]) -> None:
        for a in rows[:6]:
            when = a.when.strftime("%d-%m %H:%M") if a.when else "?"
            wire = a.extra.get("newswire", "")
            say(f"      {when}  {wire:4} {a.tidm:6} {a.company[:32]:32} | {a.headline[:60]}")
        if len(rows) > 6:
            say(f"      ... {len(rows) - 6} more")

    found: dict[str, Announcement] = {}
    say(f"rns_report diagnose v{VERSION}; UK time {uk_now():%Y-%m-%d %H:%M:%S}; date {day}; "
        f"Python {sys.version.split()[0]}")

    say("\nINVESTEGATE")
    inv = InvestegateSource(args.exclude_navs)
    try:
        s = Session()
        page = fetch(investegate_page_url(day, args.exclude_navs), session=s)
        inv.session = s
        save("investegate_page.html", page)
        say(f"  search page: {len(page)} bytes; cookies: {', '.join(s.cookie_names()) or 'none'}")
    except FetchError as e:
        say(f"  search page: FAILED {_err(e)}")
    for i, (label, opts) in enumerate(INVESTEGATE_VARIANTS, 1):
        if opts["session"] and inv.session is None:
            say(f"  [{label}] skipped (no session)")
            continue
        try:
            body = inv.fetch_variant(day, opts)
        except FetchError as e:
            save(f"investegate_draw_{i}.html", e.body)
            say(f"  [{label}] FAILED {_err(e)}")
            continue
        save(f"investegate_draw_{i}.html", body)
        rows = parse_investegate_list(body)
        if rows is None:
            say(f"  [{label}] {len(body)} bytes, no results table")
            continue
        problem = validate_investegate(rows)
        today = [r for r in rows if r.when is None or r.when.date() == day]
        say(f"  [{label}] {len(body)} bytes, {len(rows)} rows, {len(today)} dated {day}"
            + (f"  REJECTED: {problem}" if problem else ""))
        show(rows)
        if today and not problem:
            found.setdefault("Investegate", today[0])
    for i, q in enumerate(announcement_table_queries(day), 1):
        url = f"{INVESTEGATE_BASE}/announcement-table?{urllib.parse.urlencode(q)}"
        try:
            body = fetch(url, xhr=True, accept="application/json, text/javascript, */*",
                         referer=INVESTEGATE_BASE + "/", session=inv.session)
            save(f"investegate_table_{i}.json", body)
            say(f"  [announcement-table {i}] {len(body)} bytes: {_summarise_table_json(body)}")
        except FetchError as e:
            save(f"investegate_table_{i}.json", e.body)
            say(f"  [announcement-table {i}] FAILED {_err(e)}")

    say("\nLONDON STOCK EXCHANGE")
    query = lse_query()
    try:
        layout = fetch(lse_pages_url("news", query), accept="application/json",
                       referer=LSE_BASE + "/")
        save("lse_pages_news.json", layout)
        ids = lse_component_ids(layout)
        say(f"  page layout: {len(layout)} bytes; blocks: {', '.join(ids[:6]) or 'none'}")
        if ids and LSE_NEWS_COMPONENT not in ids:
            say(f"  NOTE: {LSE_NEWS_COMPONENT} is not in the layout any more")
    except FetchError as e:
        ids = []
        say(f"  page layout: FAILED {_err(e)}")
    variants = lse_list_variants(query)
    extra_ids = [c for c in ids[:3] if c != LSE_NEWS_COMPONENT]
    if extra_ids:
        variants.append(("refresh, layout ids", lambda: lse_refresh(
            "news", query, extra_ids, f"{query}&page=0&size=100")))
    no_sector = query.split("&sectors=")[0]
    variants.append(("refresh, ALL sectors (comparison)", lambda: lse_refresh(
        "news", no_sector, [LSE_NEWS_COMPONENT], f"{no_sector}&page=0&size=100")))
    for i, (label, call) in enumerate(variants, 1):
        try:
            body = call()
        except FetchError as e:
            save(f"lse_refresh_{i}.json", e.body)
            say(f"  [{label}] FAILED {_err(e)}")
            continue
        save(f"lse_refresh_{i}.json", body)
        rows = parse_lse_api_list(body)
        if rows is None:
            say(f"  [{label}] {len(body)} bytes, no news list. Starts: {re.sub(chr(10), ' ', body[:160])}")
            continue
        today = [r for r in rows if r.when is None or r.when.date() == day]
        say(f"  [{label}] {len(body)} bytes, {len(rows)} rows, {len(today)} dated {day}")
        show(rows)
        if today and "ALL sectors" not in label:
            found.setdefault("LSE", today[0])
    try:
        body = fetch(f"{LSE_BASE}/news?{query}")
        save("lse_list.html", body)
        rows = parse_lse_list(body)
        say(f"  [web page] {len(body)} bytes, " + ("no news rows" if rows is None else f"{len(rows)} rows"))
    except FetchError as e:
        say(f"  [web page] FAILED {_err(e)}")

    say("\nANNOUNCEMENT TEXT")
    if not found:
        say("  no rows found on any source, so no announcement to test")
    for name, a in found.items():
        try:
            save(f"{name.lower()}_article.html", fetch(a.url))
        except FetchError as e:
            say(f"  [{name}] article page FAILED {_err(e)}")
        fetch_body(a)
        say(f"  [{name}] {a.company} ({a.tidm}): {a.headline}")
        say(f"      {a.url}")
        if a.error:
            say(f"      ERROR {a.error}")
        else:
            say(f"      {len(a.body_text)} chars: " + a.body_text[:400].replace("\n", " "))

    say(f"\nRaw responses saved in {dbg}")
    (dbg / "probe_summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Summary to send: {dbg / 'probe_summary.txt'}")
    return 0 if found else 2


TASK_NAME = "RNS Real Estate Morning Report"


def local_time_for_uk(uk_time: dt.time, day: dt.date) -> dt.datetime:
    """The laptop's local clock time that corresponds to a UK time."""
    uk = dt.datetime.combine(day, uk_time)
    offset = utc_to_uk(uk) - uk  # 0 or 1 hour; exact except in the changeover hour
    utc = (uk - offset).replace(tzinfo=dt.timezone.utc)
    return utc.astimezone().replace(tzinfo=None)


def task_xml(python: str, script: str, start_local: dt.datetime) -> str:
    days = "".join(f"<{d}/>" for d in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"))
    e = html.escape
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Collects the day's real estate RNS announcements into one document.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger>
    <StartBoundary>{start_local:%Y-%m-%dT%H:%M:%S}</StartBoundary><Enabled>true</Enabled>
    <ScheduleByWeek><DaysOfWeek>{days}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
  </CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>{e(python)}</Command><Arguments>"{e(script)}"</Arguments>
    <WorkingDirectory>{e(str(Path(script).parent))}</WorkingDirectory>
  </Exec></Actions>
</Task>
"""


def install_task(at_uk: str) -> int:
    """Register a weekday Windows scheduled task that starts at `at_uk` UK time."""
    import subprocess
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")  # no console window
    python = str(pyw if pyw.exists() else exe)
    script = str(Path(__file__).resolve())
    tomorrow = uk_now().date() + dt.timedelta(days=1)
    start = local_time_for_uk(parse_hms(at_uk), tomorrow)
    xml_path = Path(script).with_name("rns_task.xml")
    xml_path.write_text(task_xml(python, script, start), encoding="utf-16")
    cmd = ["schtasks", "/Create", "/TN", TASK_NAME, "/XML", str(xml_path), "/F"]
    print("Running:", subprocess.list2cmdline(cmd))
    rc = subprocess.call(cmd)
    if rc == 0:
        print(f"Scheduled '{TASK_NAME}' for weekdays at {start:%H:%M} local time "
              f"({at_uk} UK). Reports go to {Path(script).parent / 'output'}")
    return rc


def main(argv=None) -> int:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--once", action="store_true", help="one pass now, no waiting or polling")
    p.add_argument("--diagnose", action="store_true", help="test both sources, save raw pages")
    p.add_argument("--source", choices=["auto", "investegate", "lse"], default="auto")
    p.add_argument("--date", help="YYYY-MM-DD (default: today, UK)")
    p.add_argument("--since", help="only announcements at or after HH:MM UK, e.g. 07:00")
    p.add_argument("--exclude-navs", action="store_true",
                   help="drop NAV, EMM/EPT, Rule 8 (Form 8.x) and FRN rate-fix notices")
    p.add_argument("--start", default=START_TIME, help="UK time to start polling")
    p.add_argument("--settle", default=SETTLE_TIME, help="UK time to stop polling")
    p.add_argument("--give-up", default=GIVE_UP_TIME, help="UK time to stop retrying failed sources")
    p.add_argument("--poll", type=float, default=POLL_SECONDS, help="seconds between polls")
    p.add_argument("--workers", type=int, default=WORKERS)
    p.add_argument("--out", default=str(here / "output"), help="output folder")
    p.add_argument("--open", action="store_true", help="open the report when done (Windows)")
    p.add_argument("--install-task", nargs="?", const="06:58", metavar="HH:MM",
                   help="create a weekday Windows scheduled task starting at this UK time "
                        "(default 06:58)")
    args = p.parse_args(argv)
    if args.install_task:
        return install_task(args.install_task)

    logs = Path(args.out).expanduser() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.FileHandler(logs / f"rns_report_{uk_now():%Y-%m-%d}.log", encoding="utf-8")]
    if sys.stdout is not None:  # None under pythonw.exe (scheduled task)
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=handlers, force=True)
    return diagnose(args) if args.diagnose else run(args)


if __name__ == "__main__":
    sys.exit(main())
