"""Merge LLM-generated JSON into council configs when creating a new council."""

from __future__ import annotations

import json
import re
from typing import Any

from .council_config import AgentDef, CouncilConfigFile

_AGENT_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


def valid_bootstrap_agent_id(s: str) -> bool:
    t = (s or "").strip()
    return bool(t and _AGENT_ID_RE.match(t) and len(t) <= 64)


def roster_json_for_prompt(config: CouncilConfigFile) -> str:
    rows: list[dict[str, str]] = []
    if config.orchestrator:
        o = config.orchestrator
        rows.append(
            {
                "role": "orchestrator",
                "id": o.id,
                "name": o.name,
                "title": o.title or "",
            }
        )
    for a in config.debating_agents:
        rows.append(
            {
                "role": "specialist",
                "id": a.id,
                "name": a.name,
                "title": a.title or "",
            }
        )
    return json.dumps(rows, ensure_ascii=False, indent=2)


def apply_council_bootstrap_patch(config: CouncilConfigFile, data: dict[str, Any]) -> None:
    """Apply model JSON onto template. Specialists must include non-empty system_prompt."""
    orch_patch = data.get("orchestrator")
    if isinstance(orch_patch, dict) and config.orchestrator:
        o = config.orchestrator
        sp = orch_patch.get("system_prompt")
        if isinstance(sp, str) and sp.strip():
            o.system_prompt = sp.strip()
        nm = orch_patch.get("name")
        if isinstance(nm, str) and nm.strip():
            o.name = nm.strip()
        tl = orch_patch.get("title")
        if isinstance(tl, str) and tl.strip():
            o.title = tl.strip()
        if "tools_enabled" in orch_patch:
            o.tools_enabled = bool(orch_patch["tools_enabled"])

    raw_agents = data.get("agents")
    if not isinstance(raw_agents, list):
        raw_agents = []

    orch_id = config.orchestrator.id if config.orchestrator else None
    by_id_idx: dict[str, int] = {a.id: i for i, a in enumerate(config.debating_agents)}
    order = list(config.debating_agents)

    for item in raw_agents:
        if not isinstance(item, dict):
            continue
        aid_raw = item.get("id")
        if not isinstance(aid_raw, str):
            continue
        aid = aid_raw.strip()
        if not valid_bootstrap_agent_id(aid):
            continue
        if orch_id and aid == orch_id:
            continue
        sp = item.get("system_prompt")
        if not isinstance(sp, str) or not sp.strip():
            continue
        sp = sp.strip()
        nm = item.get("name")
        tl = item.get("title")
        te = item.get("tools_enabled")

        if aid in by_id_idx:
            i = by_id_idx[aid]
            cur = order[i]
            order[i] = AgentDef(
                id=aid,
                name=(nm if isinstance(nm, str) and nm.strip() else cur.name),
                title=(tl if isinstance(tl, str) else cur.title) or "",
                system_prompt=sp,
                tools_enabled=bool(te) if te is not None else cur.tools_enabled,
            )
        else:
            order.append(
                AgentDef(
                    id=aid,
                    name=(nm if isinstance(nm, str) and nm.strip() else aid),
                    title=(tl if isinstance(tl, str) else "") or "",
                    system_prompt=sp,
                    tools_enabled=True if te is None else bool(te),
                )
            )
            by_id_idx[aid] = len(order) - 1

    config.debating_agents = order

    _apply_routing_guidelines_bootstrap(config, data, orch_patch if isinstance(orch_patch, dict) else None)


def _apply_routing_guidelines_bootstrap(
    config: CouncilConfigFile,
    data: dict[str, Any],
    orch_patch: dict[str, Any] | None,
) -> None:
    """Set orchestrator_user_instructions from bootstrap JSON (after agents are merged)."""
    _max = 48_000
    text: str | None = None
    top = data.get("orchestrator_user_instructions")
    if isinstance(top, str) and top.strip():
        text = top.strip()
    elif orch_patch:
        nested = orch_patch.get("orchestrator_user_instructions")
        if isinstance(nested, str) and nested.strip():
            text = nested.strip()
        else:
            alt = orch_patch.get("routing_guidelines")
            if isinstance(alt, str) and alt.strip():
                text = alt.strip()
    if not text:
        return
    if len(text) > _max:
        text = text[:_max].rstrip()
    config.orchestrator_user_instructions = text


def parse_bootstrap_llm_json(text: str) -> dict[str, Any]:
    import json

    from .llm import _json_extract

    data = json.loads(_json_extract(text))
    if not isinstance(data, dict):
        raise ValueError("bootstrap response must be a JSON object")
    return data
