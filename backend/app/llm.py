from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Sequence
from typing import Any, Literal, TypedDict

import httpx

from .config import Settings, get_settings


class ChatMsg(TypedDict, total=False):
    role: Literal["user", "assistant", "system"]
    content: str


def _msg_user(content: str) -> ChatMsg:
    return {"role": "user", "content": content}


def _msg_system(content: str) -> ChatMsg:
    return {"role": "system", "content": content}


def _json_extract(text: str) -> str:
    t = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", t)
    if m:
        return m.group(1).strip()
    m2 = re.search(r"\{[\s\S]*\}", t)
    if m2:
        return m2.group(0)
    return t


async def complete_chat(
    settings: Settings,
    messages: Sequence[ChatMsg],
    model: str | None = None,
    *,
    temperature: float = 0.2,
) -> str:
    """Non-streaming completion for JSON / structured output."""
    provider = settings.llm_provider
    m = model or (settings.ollama_model if provider == "ollama" else None)
    if provider == "ollama":
        return await _ollama_chat(settings, list(messages), m or settings.ollama_model, stream=False, temperature=temperature)
    if provider == "openai":
        return await _openai_chat(
            settings,
            list(messages),
            model or settings.openai_model,
            stream=False,
            temperature=temperature,
        )
    if provider == "anthropic":
        return await _anthropic_chat(
            settings,
            list(messages),
            model or settings.anthropic_model,
            stream=False,
            temperature=temperature,
        )
    raise ValueError(f"Unknown provider: {provider}")


async def _ollama_chat(
    settings: Settings,
    messages: list[ChatMsg],
    model: str,
    stream: bool,
    temperature: float,
) -> str:
    url = f"{settings.ollama_base_url.rstrip('/')}/api/chat"
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "options": {"temperature": temperature},
    }
    if stream:
        raise NotImplementedError
    async with httpx.AsyncClient(timeout=settings.request_timeout_s) as c:
        r = await c.post(url, json=body)
        r.raise_for_status()
        data = r.json()
        return str(data.get("message", {}).get("content", "")).strip()


async def _openai_chat(
    settings: Settings,
    messages: list[ChatMsg],
    model: str,
    stream: bool,
    temperature: float,
) -> str:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set for openai provider")
    base = (settings.openai_base_url or "https://api.openai.com/v1").rstrip("/")
    url = f"{base}/chat/completions"
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    }
    if stream:
        raise NotImplementedError
    h = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=settings.request_timeout_s) as c:
        r = await c.post(url, json=body, headers=h)
        r.raise_for_status()
        out = r.json()
        ch = (out.get("choices") or [{}])[0]
        return str(ch.get("message", {}).get("content", "")).strip()


async def _anthropic_chat(
    settings: Settings,
    messages: list[ChatMsg],
    model: str,
    stream: bool,
    temperature: float,
) -> str:
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set for anthropic provider")
    if stream:
        raise NotImplementedError
    system = ""
    conv: list[dict[str, str]] = []
    for m in messages:
        if m["role"] == "system":
            system += m["content"] + "\n"
        else:
            role = m["role"]
            if role == "assistant":
                conv.append({"role": "assistant", "content": m["content"]})
            else:
                conv.append({"role": "user", "content": m["content"]})
    url = "https://api.anthropic.com/v1/messages"
    body: dict[str, Any] = {
        "model": model,
        "max_tokens": 4096,
        "temperature": temperature,
        "system": system.strip(),
        "messages": conv,
    }
    h = {
        "x-api-key": settings.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=settings.request_timeout_s) as c:
        r = await c.post(url, json=body, headers=h)
        r.raise_for_status()
        out = r.json()
        parts = (out.get("content") or [])
        if parts and parts[0].get("type") == "text":
            return str(parts[0].get("text", "")).strip()
        return ""


async def ollama_list_models(base_url: str) -> list[str]:
    url = f"{base_url.rstrip('/')}/api/tags"
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            r = await c.get(url)
            r.raise_for_status()
            d = r.json()
            models = d.get("models") or []
            return [m.get("name", "") for m in models if m.get("name")]
    except (httpx.HTTPError, OSError, ValueError):
        return []


async def complete_structured_json(
    settings: Settings,
    system: str,
    user: str,
    model: str | None = None,
) -> dict[str, Any]:
    last_err: str | None = None
    for attempt in range(settings.plan_json_retries + 1):
        u = user
        if attempt and last_err is not None:
            u = f"{user}\n\nReturn JSON only, no other text. Fix this parse error: {last_err!s}"
        messages: list[ChatMsg] = [
            _msg_system(system),
            _msg_user(u),
        ]
        text = await complete_chat(settings, messages, model=model, temperature=0.1 if attempt == 0 else 0.0)
        raw = _json_extract(text)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            last_err = str(e)
    raise ValueError(f"Model did not return valid JSON. Last: {last_err}")


# --- convenience for orchestrator to mix agent system prompts ---
__all__ = [
    "ChatMsg",
    "complete_chat",
    "complete_structured_json",
    "ollama_list_models",
    "_json_extract",
    "_msg_user",
    "_msg_system",
]
