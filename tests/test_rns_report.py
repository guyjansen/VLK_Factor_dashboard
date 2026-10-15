"""Offline tests for the morning real estate RNS report.

The list fixtures are cut from pages saved from investegate.co.uk and
londonstockexchange.com on 15 October 2026.
"""
import datetime as dt
import json
from pathlib import Path

import pytest

from rns_report import rns_report as r

FIX = Path(__file__).parent / "fixtures" / "rns"
DAY = dt.date(2026, 10, 15)

ARTICLE = """<html><head><title>x</title><script>var a = 1;</script></head><body>
<header><nav><a href="/">Home</a><a href="/news">News</a> Investegate menu text</nav></header>
<div class="container"><div class="row">
<div class="col-md-8">
  <h1>Big Yellow Group (BYG)</h1>
  <div class="news-window"><p><b>Big Yellow Group PLC</b><br>("Big Yellow" or "the Company")</p>
  <p><b>Response to media coverage</b></p>
  <p>The Board of Big Yellow notes the recent press speculation regarding a possible offer
  for the Company. The Board confirms that it has not received any approach.</p>
  <table><tr><td colspan="2" style="x">Occupancy</td><td>84.1%</td></tr></table>
  <p>This information is provided by RNS, the news service of the London Stock Exchange.</p></div>
</div>
<div class="col-md-4"><div class="tradingview-widget-container">UK 100 chart</div>
  <ul><li><a href="/a/1">Most read one</a></li><li><a href="/a/2">Most read two</a></li></ul></div>
</div></div>
<footer>Investegate is a trading name of ... long legal footer text here</footer>
</body></html>"""


def test_uk_time_handles_summer_and_winter():
    assert r.utc_to_uk(dt.datetime(2026, 10, 15, 6, 0)) == dt.datetime(2026, 10, 15, 7, 0)
    assert r.utc_to_uk(dt.datetime(2026, 12, 1, 7, 0)) == dt.datetime(2026, 12, 1, 7, 0)
    # Clocks go back at 01:00 UTC on the last Sunday of October (25 Oct 2026)
    assert r.utc_to_uk(dt.datetime(2026, 10, 25, 0, 59)).hour == 1
    assert r.utc_to_uk(dt.datetime(2026, 10, 25, 1, 0)).hour == 1


def test_investegate_request_matches_browser():
    url = r.investegate_list_urls(DAY, exclude_navs=False)[0]
    assert url.startswith("https://www.investegate.co.uk/advanced-search/draw?")
    assert "date_from=15+October+2026" in url
    assert "sources%5B%5D=RNS" in url and "sectors%5B%5D=18" in url
    assert "exclude_navs=false" in url


def test_parse_investegate_list():
    rows = r.parse_investegate_list((FIX / "investegate_draw.html").read_text(encoding="utf-8"))
    assert len(rows) == 27
    last = rows[-1]
    assert (last.company, last.tidm) == ("Workspace Group", "WKP")
    assert last.when == dt.datetime(2026, 10, 15, 7, 0)
    assert last.url.endswith("/workspace-group-plc-second-quarter-business-update/9823553")
    byg = next(a for a in rows if a.tidm == "BYG")
    assert byg.headline == "Response to media coverage"


def test_investegate_without_table_is_a_failure_not_empty():
    assert r.parse_investegate_list("<html><body>Access denied</body></html>") is None
    assert r.parse_investegate_list('<table class="table-investegate"><tbody></tbody></table>') == []


def test_parse_lse_list():
    rows = r.parse_lse_list((FIX / "lse_news.html").read_text(encoding="utf-8"))
    assert len(rows) == 10
    blnd = next(a for a in rows if a.tidm == "BLND")
    assert blnd.company == "British Land Co PLC"
    assert blnd.headline == "Trading Statement"
    assert blnd.when == dt.datetime(2026, 10, 15, 7, 0, 7)
    # A date inside the headline must not be taken as the release date
    town = next(a for a in rows if a.tidm == "TOWN")
    assert town.when.date() == DAY


def test_parse_lse_api_list():
    payload = json.dumps({"components": [{"content": [{"value": {"content": [
        {"id": 17836300, "title": "Response to media coverage", "companycode": "BYG",
         "companyname": "Big Yellow Group PLC", "datetime": "2026-10-15T06:00:07Z"}]}}]}]})
    (a,) = r.parse_lse_api_list(payload)
    assert a.url == "https://www.londonstockexchange.com/news-article/BYG/response-to-media-coverage/17836300"
    assert a.when == dt.datetime(2026, 10, 15, 7, 0, 7)


def test_extract_body_finds_announcement_and_drops_page_furniture():
    node = r.extract_body(ARTICLE)
    text = r.to_text(node)
    assert "has not received any approach" in text
    assert "Occupancy\t84.1%" in text
    for junk in ("Investegate menu", "Most read", "legal footer", "UK 100", "var a"):
        assert junk not in text
    clean = r.to_clean_html(node, "https://www.investegate.co.uk/x")
    assert '<td colspan="2">Occupancy</td>' in clean
    assert "style=" not in clean


def test_extract_json_body_from_lse_page():
    state = {"x": {"components": [{"content": [{"name": "newsarticle", "value": {
        "title": "Trading Statement", "body": "<p>" + "British Land trading update. " * 10 + "</p>"}}]}]}}
    page = f'<html><body><script id="ng-lseg-state" type="application/json">{json.dumps(state)}</script></body></html>'
    assert r.extract_json_body(page).startswith("<p>British Land trading update.")


@pytest.fixture
def fake_web(monkeypatch):
    """Investegate down, LSE up: the report must fall back to LSE."""
    lse_list = (FIX / "lse_news.html").read_text(encoding="utf-8")
    calls = []

    def fake_fetch(url, **kw):
        calls.append(url)
        if "investegate" in url:
            raise r.FetchError(f"{url}: HTTP Error 403: Forbidden")
        if "/news?" in url:
            return lse_list
        if "/news-article/" in url:
            if "HKLD" in url:
                raise r.FetchError(f"{url}: timed out")
            return ARTICLE.replace("Big Yellow", url.split("/")[4])
        raise r.FetchError(f"{url}: unexpected")

    monkeypatch.setattr(r, "fetch", fake_fetch)
    return calls


def test_end_to_end_falls_back_to_lse(fake_web, tmp_path):
    code = r.main(["--once", "--date", DAY.isoformat(), "--since", "07:00", "--out", str(tmp_path)])
    assert code == 0
    html = (tmp_path / "RNS_RealEstate_2026-10-15.html").read_text(encoding="utf-8")
    txt = (tmp_path / "RNS_RealEstate_2026-10-15.txt").read_text(encoding="utf-8")
    assert "source: LSE" in html
    assert "10 announcement(s)" in html
    assert "1 could not be retrieved" in html  # HKLD body fetch failed
    assert "Could not retrieve the text" in html
    assert "BLND Group PLC" in txt  # body text made it into the plain-text copy
    # Index is in time order
    assert txt.index("Workspace Group PLC") < txt.index("Safestore Holdings plc (SAFE): Director")


def test_sources_all_down_still_writes_a_report(monkeypatch, tmp_path):
    def down(url, **kw):
        raise r.FetchError(f"{url}: connection refused")

    monkeypatch.setattr(r, "fetch", down)
    code = r.main(["--once", "--date", DAY.isoformat(), "--out", str(tmp_path)])
    assert code == 2
    html = (tmp_path / "RNS_RealEstate_2026-10-15.html").read_text(encoding="utf-8")
    assert "SOURCES FAILED" in html


def test_morning_loop_waits_for_seven_and_picks_up_late_items(monkeypatch, tmp_path):
    """Started at 06:58: waits, polls until settle time, adds late arrivals."""
    clock = {"now": dt.datetime(2026, 10, 15, 6, 58, 0)}
    monkeypatch.setattr(r, "uk_now", lambda: clock["now"])
    monkeypatch.setattr(r.time, "sleep", lambda s: clock.__setitem__("now", clock["now"] + dt.timedelta(seconds=s)))
    rows = r.parse_investegate_list((FIX / "investegate_draw.html").read_text(encoding="utf-8"))
    seven = [x for x in rows if x.when.time() == dt.time(7, 0)]
    polls = []

    def fake_list(day, exclude_navs):
        polls.append(clock["now"])
        if clock["now"] < dt.datetime(2026, 10, 15, 7, 0):
            raise AssertionError("polled before 07:00")
        n = 3 if len(polls) == 1 else len(seven)  # the rest arrive a poll later
        return [r.Announcement(**{**a.__dict__, "extra": {}}) for a in seven[:n]]

    monkeypatch.setattr(r, "list_investegate", fake_list)
    monkeypatch.setattr(r, "fetch", lambda url, **kw: ARTICLE)
    assert r.main(["--out", str(tmp_path)]) == 0
    assert polls[0] >= dt.datetime(2026, 10, 15, 7, 0)
    assert polls[-1] >= dt.datetime(2026, 10, 15, 7, 3, 30) - dt.timedelta(seconds=r.POLL_SECONDS)
    html = (tmp_path / "RNS_RealEstate_2026-10-15.html").read_text(encoding="utf-8")
    assert f"{len(seven)} announcement(s); source: Investegate" in html
    assert "still checking" not in html


def test_scheduled_task_xml_and_local_time():
    # 06:58 UK is 05:58 UTC in summer
    local = r.local_time_for_uk(dt.time(6, 58), dt.date(2026, 10, 16))
    utc = local.astimezone(dt.timezone.utc).replace(tzinfo=None)
    assert utc == dt.datetime(2026, 10, 16, 5, 58)
    xml = r.task_xml(r"C:\Python\pythonw.exe", r"C:\RNS\rns_report.py", local)
    import xml.etree.ElementTree as ET
    ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
    root = ET.fromstring(xml.split("\n", 1)[1])
    assert root.find(".//t:WakeToRun", ns).text == "true"
    assert root.find(".//t:Arguments", ns).text == '"C:\\RNS\\rns_report.py"'
