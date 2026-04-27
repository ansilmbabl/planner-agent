from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any

from duckduckgo_search import DDGS

log = logging.getLogger(__name__)

TAVILY_SEARCH_URL = "https://api.tavily.com/search"


def ddg_search(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """DuckDuckGo text search. No API key. Returns title, href, body snippets."""
    q = (query or "").strip()
    if not q:
        return []
    n = min(max(1, max_results), 10)
    try:
        with DDGS() as d:
            r = d.text(q, max_results=n)
    except (OSError, TypeError, ValueError):
        return []
    out: list[dict[str, str]] = []
    for x in r or []:
        out.append(
            {
                "title": str(x.get("title", "")),
                "href": str(x.get("href", "")),
                "body": str(x.get("body", ""))[:500],
            }
        )
    return out


def tavily_search(api_key: str, query: str, max_results: int = 5) -> list[dict[str, str]]:
    """Tavily search API. Requires api_key from https://tavily.com"""
    q = (query or "").strip()
    key = (api_key or "").strip()
    if not q or not key:
        return []
    n = min(max(1, max_results), 10)
    body: dict[str, Any] = {
        "api_key": key,
        "query": q,
        "search_depth": "basic",
        "include_answer": False,
        "max_results": n,
    }
    try:
        req = urllib.request.Request(
            TAVILY_SEARCH_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TypeError) as e:
        log.warning("Tavily search failed: %s", e)
        return []
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        return []
    out: list[dict[str, str]] = []
    for x in results:
        if not isinstance(x, dict):
            continue
        title = str(x.get("title", "") or "")
        href = str(x.get("url", "") or x.get("href", "") or "")
        content = str(x.get("content", "") or x.get("snippet", "") or "")
        if href or title:
            out.append(
                {
                    "title": title,
                    "href": href,
                    "body": content[:500],
                }
            )
    return out
