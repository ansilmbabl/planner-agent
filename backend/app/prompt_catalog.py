"""Editable built-in pipeline prompts (overridable via data/prompt_overrides.json)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, TypedDict

log = logging.getLogger(__name__)

_OVERRIDES: dict[str, str] | None = None
_OVERRIDES_PATH: Path | None = None


class PromptMeta(TypedDict):
    key: str
    category: str
    title: str
    description: str


PIPELINE_PROMPT_META: list[PromptMeta] = [
    {
        "key": "plan_writer_system",
        "category": "Plan writer",
        "title": "Plan writer — system message",
        "description": (
            "Used when generating structured plan.json → plan.md after debate. "
            "Tells the model to return JSON matching the schema block in the user message."
        ),
    },
    {
        "key": "plan_json_schema_hint",
        "category": "Plan writer",
        "title": "Plan writer — JSON schema / field instructions",
        "description": (
            "Inserted into the plan writer user message. Defines the expected JSON shape "
            "(title, phases, checklist, etc.)."
        ),
    },
    {
        "key": "plan_writer_user_footer",
        "category": "Plan writer",
        "title": "Plan writer — closing instruction",
        "description": "Appended at the end of the plan writer user message after council context.",
    },
    {
        "key": "orchestrator_json_suffix",
        "category": "Orchestrator",
        "title": "Orchestrator — system suffix (JSON discipline)",
        "description": (
            "Appended to the council orchestrator system prompt so the model keeps returning "
            "structured routing JSON."
        ),
    },
    {
        "key": "orchestrator_decision_schema",
        "category": "Orchestrator",
        "title": "Orchestrator — action JSON schema (user message)",
        "description": (
            "Inserted into every routing user turn. Defines call_agents, run_research, etc. "
            "Keep valid ids aligned with your council roster."
        ),
    },
    {
        "key": "debate_turn_schema",
        "category": "Specialists",
        "title": "Specialist turn — JSON schema",
        "description": (
            "Appended to each specialist system prompt. Controls reaction / planner_note / "
            "user_question shape."
        ),
    },
    {
        "key": "plan_refine_user_suffix",
        "category": "Plan refine",
        "title": "Refine plan — output rules (user message tail)",
        "description": "Appended when using Plan tab → Refine with LLM.",
    },
    {
        "key": "research_planner_system",
        "category": "Research",
        "title": "Research planner — system message",
        "description": "First step of run_research: choose search queries and URLs to fetch.",
    },
    {
        "key": "research_planner_user_suffix",
        "category": "Research",
        "title": "Research planner — instructions after the idea block",
        "description": (
            "Follows the user idea in the research planner user message (queries / urls_to_fetch rules)."
        ),
    },
    {
        "key": "research_summarizer_system",
        "category": "Research",
        "title": "Research summarizer — system message",
        "description": "Turns raw search hits + fetches into the research brief.",
    },
    {
        "key": "research_summarizer_user_closing",
        "category": "Research",
        "title": "Research summarizer — closing instruction",
        "description": "Last line of the summarizer user message (after results and fetches).",
    },
]


def _defaults() -> dict[str, str]:
    from .plan_model import plan_spec_json_schema_hint
    from .prompts.debate import AGENT_TURN_SCHEMA
    from .prompts.orchestrator import ORCHESTRATOR_SYSTEM_JSON_SUFFIX, ORCH_DECISION_SCHEMA
    from .prompts.plan_refine import PLAN_REFINE_USER_SUFFIX

    return {
        "plan_writer_system": (
            "You are a planning writer for agentic software. Return JSON only. "
            "Use checklist items with done: false."
        ),
        "plan_json_schema_hint": plan_spec_json_schema_hint(),
        "plan_writer_user_footer": (
            "Be specific: file paths, phases, and acceptance-relevant details."
        ),
        "orchestrator_json_suffix": ORCHESTRATOR_SYSTEM_JSON_SUFFIX.strip(),
        "orchestrator_decision_schema": ORCH_DECISION_SCHEMA,
        "debate_turn_schema": AGENT_TURN_SCHEMA,
        "plan_refine_user_suffix": PLAN_REFINE_USER_SUFFIX.strip(),
        "research_planner_system": "You are a research planner. Return JSON only.",
        "research_planner_user_suffix": (
            'Return JSON: {"queries": ["q1", ...], "urls_to_fetch": []}\n'
            "- queries: 1-3 short web search queries, or fewer if the idea is fully specified.\n"
            "- urls_to_fetch: 0-2 full https URLs to read for context, or []."
        ),
        "research_summarizer_system": (
            "You are a research summarizer. Output a tight bullet brief; cite page titles. No JSON."
        ),
        "research_summarizer_user_closing": (
            "Write 5-10 bullets; note assumptions."
        ),
    }


def overrides_path(data_dir: Path) -> Path:
    return data_dir / "prompt_overrides.json"


def _read_overrides_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        out: dict[str, str] = {}
        for k, v in raw.items():
            if isinstance(k, str) and isinstance(v, str):
                out[k.strip()] = v
        return out
    except (OSError, json.JSONDecodeError, TypeError) as e:
        log.warning("Could not read prompt overrides: %s", e)
        return {}


def clear_prompt_cache() -> None:
    global _OVERRIDES, _OVERRIDES_PATH
    _OVERRIDES = None
    _OVERRIDES_PATH = None


def _merged(data_dir: Path) -> dict[str, str]:
    global _OVERRIDES, _OVERRIDES_PATH
    path = overrides_path(data_dir)
    if _OVERRIDES is not None and _OVERRIDES_PATH == path:
        base = _defaults()
        base.update(_OVERRIDES)
        return base
    _OVERRIDES = _read_overrides_file(path)
    _OVERRIDES_PATH = path
    base = _defaults()
    base.update(_OVERRIDES)
    return base


def get_prompt(key: str, data_dir: Path | None = None) -> str:
    if data_dir is None:
        from .config import get_settings

        data_dir = get_settings().sqlite_path.parent
    m = _merged(data_dir)
    if key in m and (m[key] or "").strip():
        return m[key]
    return _defaults().get(key, "")


def save_prompt_override(data_dir: Path, key: str, content: str) -> None:
    path = overrides_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    cur = _read_overrides_file(path)
    if not content.strip():
        cur.pop(key, None)
    else:
        cur[key] = content
    path.write_text(json.dumps(cur, indent=2, ensure_ascii=False), encoding="utf-8")
    clear_prompt_cache()


def reset_prompt_overrides(data_dir: Path) -> None:
    path = overrides_path(data_dir)
    if path.is_file():
        path.unlink()
    clear_prompt_cache()


def list_prompts_for_api(data_dir: Path) -> list[dict[str, Any]]:
    merged = _merged(data_dir)
    meta_by_key = {m["key"]: m for m in PIPELINE_PROMPT_META}
    out: list[dict[str, Any]] = []
    for key in sorted(_defaults().keys()):
        meta = meta_by_key.get(key, {})
        raw = _read_overrides_file(overrides_path(data_dir))
        out.append(
            {
                "key": key,
                "category": meta.get("category", "Other"),
                "title": meta.get("title", key),
                "description": meta.get("description", ""),
                "content": merged.get(key, ""),
                "is_default": key not in raw,
            }
        )
    return out
