from __future__ import annotations

from duckduckgo_search import DDGS

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
