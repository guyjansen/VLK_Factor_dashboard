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
    url = r.investegate_draw_url(DAY, exclude_navs=False)
    assert url.startswith("https://www.investegate.co.uk/advanced-search/draw?")
    assert "date_from=15+October+2026" in url
    assert "sources%5B%5D=RNS" in url and "sectors%5B%5D=18" in url
    assert "exclude_navs=false" in url
    assert "categories" not in url  # jQuery drops an empty list
    assert "date_from=&" in r.investegate_draw_url(DAY, False, date_from=False)


def _investegate_fake(monkeypatch, rows_html, empty_html):
    """Investegate that only fills the table for a session that loaded the page."""
    calls = []

    def fake_fetch(url, session=None, **kw):
        calls.append((url, session))
        if "/advanced-search?" in url:
            session.loaded = True
            return "<html>search page</html>"
        if "/draw?" in url:
            return rows_html if getattr(session, "loaded", False) else empty_html
        raise r.FetchError(url)

    monkeypatch.setattr(r, "fetch", fake_fetch)
    return calls


def test_investegate_uses_a_browser_session(monkeypatch):
    rows_html = (FIX / "investegate_draw.html").read_text(encoding="utf-8")
    empty = '<table class="table-investegate"><tbody></tbody></table>'
    calls = _investegate_fake(monkeypatch, rows_html, empty)
    src = r.InvestegateSource(exclude_navs=False)
    rows = src.list(DAY)
    assert len(rows) == 27 and src.preferred == "session, date"
    assert "/advanced-search?" in calls[0][0]  # page loaded first, as a browser does
    # Next poll goes straight to the variant that worked, reusing the session
    calls.clear()
    assert len(src.list(DAY)) == 27 and len(calls) == 1


def test_investegate_empty_table_everywhere_is_an_empty_answer(monkeypatch):
    empty = '<table class="table-investegate"><tbody></tbody></table>'
    _investegate_fake(monkeypatch, empty, empty)
    assert r.InvestegateSource(False).list(DAY) == []


def test_investegate_rejects_unfiltered_results(monkeypatch):
    rows_html = (FIX / "investegate_draw.html").read_text(encoding="utf-8")
    unfiltered = rows_html.replace('title="RNS" href="https://www.investegate.co.uk/source/RNS">RNS<',
                                   'title="GNW" href="https://www.investegate.co.uk/source/GNW">GNW<', 1)
    _investegate_fake(monkeypatch, unfiltered, unfiltered)
    assert r.InvestegateSource(False).list(DAY) == []


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


LSE_LAYOUT = json.dumps({"id": "14", "layout": "onecol", "info": {"title": "Today's News"},
                         "components": [
                             {"id": "block_content:11111111-1111-1111-1111-111111111111",
                              "title": "News explorer - Hero"},
                             {"id": r.LSE_NEWS_COMPONENT, "title": "News explorer", "content": []}]})


def _lse_news_json(rows):
    return json.dumps([{"componentId": r.LSE_NEWS_COMPONENT, "content": [
        {"name": "newsexplorersearch", "value": {"totalElements": len(rows), "content": [
            {"id": int(a.url.rsplit("/", 1)[1]), "title": a.headline, "companycode": a.tidm,
             "companyname": a.company, "datetime": a.when.isoformat()} for a in rows]}}]}])


def test_parse_lse_api_list():
    payload = json.dumps({"components": [{"content": [{"value": {"content": [
        {"id": 17836300, "title": "Response to media coverage", "companycode": "BYG",
         "companyname": "Big Yellow Group PLC", "datetime": "2026-10-15T06:00:07Z"}]}}]}]})
    (a,) = r.parse_lse_api_list(payload)
    assert a.url == "https://www.londonstockexchange.com/news-article/BYG/response-to-media-coverage/17836300"
    assert a.when == dt.datetime(2026, 10, 15, 7, 0, 7)
    # The page layout is not a news list, so it must not read as an empty day
    assert r.parse_lse_api_list(LSE_LAYOUT) is None
    assert r.parse_lse_api_list(json.dumps({"totalElements": 0, "content": []})) == []


def test_lse_component_ids_puts_news_explorer_first():
    assert r.lse_component_ids(LSE_LAYOUT)[0] == r.LSE_NEWS_COMPONENT


def test_lse_refresh_payload(monkeypatch):
    sent = {}

    def fake_fetch(url, data=None, headers=None, **kw):
        sent.update(url=url, payload=json.loads(data), headers=headers)
        return "[]"

    monkeypatch.setattr(r, "fetch", fake_fetch)
    r.lse_refresh("news", r.lse_query(), [r.LSE_NEWS_COMPONENT], "page=0")
    p = sent["payload"]
    assert sent["url"].endswith("/api/v1/components/refresh")
    assert p["path"] == "news"
    assert p["parameters"].startswith("tab%3Dnews-explorer%26period%3Ddaily")
    assert p["components"] == [{"componentId": "block_content%3A431d02ac-09b8-40c9-aba6-04a72a4f2e49",
                                "parameters": "page=0"}]
    assert sent["headers"]["Content-Type"] == "application/json"


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
    lse_rows = r.parse_lse_list((FIX / "lse_news.html").read_text(encoding="utf-8"))
    calls = []

    def fake_fetch(url, data=None, **kw):
        calls.append(url)
        if "investegate" in url:
            raise r.FetchError(f"{url}: HTTP Error 403: Forbidden", 403)
        if url.endswith("/components/refresh"):
            path = json.loads(data)["path"]
            if path == "news":
                return _lse_news_json(lse_rows)
            raise r.FetchError(f"{url}: unexpected {path}")
        if "path=news-article" in url:
            nid = url.split("newsId%253D")[1] if "newsId%253D" in url else url.split("newsId%3D")[1]
            if nid.startswith("17837523"):  # HKLD
                raise r.FetchError(f"{url}: timed out")
            a = next(x for x in lse_rows if x.url.endswith(nid))
            return json.dumps({"components": [{"content": [{"name": "newsarticle", "value": {
                "body": f"<p><b>{a.company}</b></p><p>{a.headline}.</p><p>" + "Details. " * 20 + "</p>"}}]}]})
        if "/news-article/" in url:
            return "<html><body><nav>London Stock Exchange menu</nav></body></html>"
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
    assert "British Land Co PLC\n\nTrading Statement." in txt  # body text in the plain-text copy
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


def test_empty_weekday_is_flagged(monkeypatch, tmp_path):
    monkeypatch.setattr(r.InvestegateSource, "list", lambda self, day: [])
    monkeypatch.setattr(r.LseSource, "list", lambda self, day: [])
    r.main(["--once", "--date", DAY.isoformat(), "--out", str(tmp_path)])
    html = (tmp_path / "RNS_RealEstate_2026-10-15.html").read_text(encoding="utf-8")
    assert "WARNING: no announcements found" in html


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

    monkeypatch.setattr(r.InvestegateSource, "list", lambda self, day: fake_list(day, False))
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
