"""Small HTTP helper with retries and a browser-like user agent."""

from __future__ import annotations

import logging
import time

import requests

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
)
RETRYABLE = {429, 500, 502, 503, 504}


class FetchError(RuntimeError):
    pass


def get(
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    timeout: float = 45,
    retries: int = 3,
    backoff: float = 2.0,
) -> requests.Response:
    """GET with retries on network errors and retryable status codes."""
    merged = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    merged.update(headers or {})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, headers=merged, timeout=timeout)
            if resp.status_code == 200:
                return resp
            if resp.status_code in RETRYABLE:
                last = FetchError(f"HTTP {resp.status_code} for {resp.url}")
            else:
                raise FetchError(f"HTTP {resp.status_code} for {resp.url}")
        except requests.RequestException as exc:  # network trouble: retry
            last = exc
        if attempt < retries - 1:
            wait = backoff ** (attempt + 1)
            log.debug("Retrying %s in %.0fs (%s)", url, wait, last)
            time.sleep(wait)
    raise FetchError(str(last))
