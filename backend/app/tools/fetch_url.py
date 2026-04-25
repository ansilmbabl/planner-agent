from __future__ import annotations

import re
from html import unescape
from typing import Any

import httpx

from ..config import Settings


def _strip_tags(html: str) -> str:
    t = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    t = re.sub(r"(?is)<style.*?>.*?</style>", " ", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = unescape(t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


async def fetch_url_text(url: str, settings: Settings) -> dict[str, Any]:
    """GET URL and return small plain text excerpt. Best-effort; never raises to caller for orchestration."""
    u = (url or "").strip()
    if not u.startswith("http://") and not u.startswith("https://"):
        return {"ok": False, "error": "invalid_url", "url": u, "excerpt": ""}
    h = {
        "User-Agent": "PlannerCouncilBot/1.0 (+local research; contact via project)",
        "Accept": "text/html, text/plain, */*",
    }
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=settings.url_fetch_timeout_s,
            headers=h,
        ) as c:
            r = await c.get(u)
            r.raise_for_status()
            raw = r.text
            if len(raw.encode("utf-8", errors="replace")) > settings.max_url_fetch_bytes:
                raw = raw[: settings.max_url_fetch_bytes]
            text = _strip_tags(raw)[:20_000]
            return {
                "ok": True,
                "url": str(r.url),
                "status": r.status_code,
                "excerpt": text,
            }
    except httpx.HTTPError as e:
        return {"ok": False, "error": "http", "url": u, "detail": str(e)[:200], "excerpt": ""}
    except (OSError, ValueError) as e:
        return {"ok": False, "error": "other", "url": u, "detail": str(e)[:200], "excerpt": ""}
