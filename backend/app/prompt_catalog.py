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
        "key": "artifact_report_system",
        "category": "Artifact — report",
        "title": "Report writer — system message",
        "description": "Used when council output_mode is report; produces markdown prose.",
    },
    {
        "key": "artifact_report_user_suffix",
        "category": "Artifact — report",
        "title": "Report writer — closing rules",
        "description": "Appended after transcript and research in the report user message.",
    },
    {
        "key": "artifact_code_system",
        "category": "Artifact — code",
        "title": "Code writer — system message",
        "description": "Used when council output_mode is code; single-file body, no chit-chat.",
    },
    {
        "key": "artifact_code_user_suffix",
        "category": "Artifact — code",
        "title": "Code writer — closing rules",
        "description": "Appended after context in the code generation user message.",
    },
    {
        "key": "plan_refine_user_suffix",
        "category": "Plan refine",
        "title": "Refine plan — output rules (user message tail)",
        "description": "Appended when using Plan tab → Refine with LLM.",
    },
    {
        "key": "refine_prompt_system",
        "category": "Prompt polish (settings)",
        "title": "Refine field with model — system message",
        "description": (
            "Used when using Settings → Refine with model on council or pipeline text fields. "
            "Must instruct the model to wrap output in <<<PROMPT_START>>> … <<<PROMPT_END>>>."
        ),
    },
    {
        "key": "refine_prompt_user_template",
        "category": "Prompt polish (settings)",
        "title": "Refine field with model — user message template",
        "description": (
            "Must contain exactly these placeholders: {{LABEL}}, {{CURRENT_PROMPT}}, {{INSTRUCTION}}. "
            "Filled with field context, existing text, and the user tweak (or default polish instruction)."
        ),
    },
    {
        "key": "refine_prompt_default_instruction",
        "category": "Prompt polish (settings)",
        "title": "Refine field — default change request",
        "description": (
            "Used when the user leaves tweaks empty in Refine with model (automatic clarity pass)."
        ),
    },
    {
        "key": "council_bootstrap_system",
        "category": "Council bootstrap",
        "title": "New council — LLM system (prompt autofill)",
        "description": (
            "Used when creating a council with “Autofill prompts with LLM”. "
            "Instructs the model to return one JSON object only (orchestrator, agents[], "
            "orchestrator_user_instructions for routing guidelines)."
        ),
    },
    {
        "key": "council_bootstrap_user_template",
        "category": "Council bootstrap",
        "title": "New council — user message template",
        "description": (
            "Filled with {{COUNCIL_ID}}, {{DISPLAY_NAME}}, {{NOTES}}, {{TAGS}}, {{AREA}}, "
            "{{TEMPLATE_SOURCE}}, {{ROSTER_JSON}}. Model returns orchestrator, agents[], and "
            "orchestrator_user_instructions (routing guidelines for the user message)."
        ),
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
    from .prompts.refine_inline import (
        REFINE_PROMPT_DEFAULT_INSTRUCTION,
        REFINE_PROMPT_SYSTEM,
        REFINE_PROMPT_USER_TEMPLATE,
    )

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
        "artifact_report_system": (
            "You write clear, well-structured Markdown reports for technical readers. "
            "No JSON. Use headings, bullets, and short paragraphs."
        ),
        "artifact_report_user_suffix": (
            "Deliver a complete report in Markdown. Cite constraints from the research brief. "
            "End with open questions or risks if relevant."
        ),
        "artifact_code_system": (
            "You output a single program or script as raw source code only. "
            "No markdown fences, no explanation before or after the code unless the user instructions require it."
        ),
        "artifact_code_user_suffix": (
            "Output only the file body. Use the filename hint only for language choice if helpful."
        ),
        "refine_prompt_system": REFINE_PROMPT_SYSTEM.strip(),
        "refine_prompt_user_template": REFINE_PROMPT_USER_TEMPLATE.strip(),
        "refine_prompt_default_instruction": REFINE_PROMPT_DEFAULT_INSTRUCTION.strip(),
        "council_bootstrap_system": (
            "You help author multi-agent council configuration. Reply with a single JSON object only "
            "(no prose before or after). If you use a markdown fence, the fenced content must be raw JSON. "
            "Keys use ASCII; specialist ids must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}. "
            "Do not put the orchestrator id inside agents[]—use the top-level orchestrator object for routing. "
            "Include orchestrator_user_instructions: practical routing guidelines injected into each orchestrator "
            "user turn (when to call which specialist id, research, ask_user, etc.)."
        ),
        "council_bootstrap_user_template": _default_council_bootstrap_user_template(),
    }


def _default_council_bootstrap_user_template() -> str:
    return (
        "You are drafting system prompts for a multi-agent council (orchestrator routes; specialists answer).\n\n"
        "Context:\n"
        "- Council file id: {{COUNCIL_ID}}\n"
        "- Display name: {{DISPLAY_NAME}}\n"
        "- Area / domain: {{AREA}}\n"
        "- Tags: {{TAGS}}\n"
        "- Notes: {{NOTES}}\n"
        "- Template copied from: {{TEMPLATE_SOURCE}}\n\n"
        "Current roster (JSON). Each specialist has a stable id used in call_agents. "
        "You may refresh prompts for existing ids and add **new** specialists with new ids when the mission "
        "needs more roles. New ids: lowercase snake_case or similar (letters, digits, underscore, hyphen; "
        "1–64 chars; start with letter or digit). Do not duplicate the orchestrator id in agents[].\n\n"
        "ROSTER:\n"
        "{{ROSTER_JSON}}\n\n"
        "Return **only** one JSON object with this shape:\n"
        "{\n"
        '  "orchestrator_user_instructions": "required: routing guidelines for the orchestrator user message '
        "(when to use call_agents with which ids, run_research, ask_user, orchestrator_reply, etc.). "
        'List every specialist id you include in agents[] and how to combine them.",\n'
        '  "orchestrator": {\n'
        '    "system_prompt": "optional full orchestrator system prompt",\n'
        '    "name": "optional",\n'
        '    "title": "optional",\n'
        '    "tools_enabled": false\n'
        "  },\n"
        '  "agents": [\n'
        "    {\n"
        '      "id": "existing_or_new_specialist_id",\n'
        '      "system_prompt": "required non-empty specialist system prompt",\n'
        '      "name": "optional display name",\n'
        '      "title": "optional short mandate line",\n'
        '      "tools_enabled": true\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        "Rules:\n"
        "- **orchestrator_user_instructions** must be substantive prose (not empty). Align it with the final "
        "specialist roster you output: mention each specialist id by name and typical call patterns, plus any "
        "mission-specific priorities from display name / area / notes / tags.\n"
        "- If ROSTER lists specialists, include one agents[] entry per listed specialist id with tailored "
        "system_prompt (you may refine name/title).\n"
        "- If ROSTER has **no** specialists (orchestrator only), propose 2–5 agents[] entries with new ids and "
        "cohesive roles aligned with display name, area, notes, and tags.\n"
        "- Differentiate roles: each specialist should have a clear, non-overlapping mandate.\n"
        "- Orchestrator system_prompt should stress JSON routing discipline and how to invoke the specialist ids.\n"
        "- Prefer concise, operational prompts; scale wording if the domain requires depth.\n"
    )


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


def format_refine_prompt_user_template(
    template: str,
    *,
    label: str,
    current_prompt: str,
    instruction: str,
) -> str:
    """Substitute placeholders in refine_prompt_user_template (see prompts/refine_inline.py)."""
    return (
        template.replace("{{LABEL}}", label)
        .replace("{{CURRENT_PROMPT}}", current_prompt)
        .replace("{{INSTRUCTION}}", instruction)
    )


def format_council_bootstrap_user_template(
    template: str,
    *,
    council_id: str,
    display_name: str,
    notes: str,
    tags: list[str],
    area: str,
    template_source: str,
    roster_json: str,
) -> str:
    """Substitute placeholders in council_bootstrap_user_template."""

    def nz(s: str | None) -> str:
        t = (s or "").strip()
        return t if t else "(none)"

    tags_s = ", ".join(tags) if tags else "(none)"
    return (
        template.replace("{{COUNCIL_ID}}", nz(council_id))
        .replace("{{DISPLAY_NAME}}", nz(display_name))
        .replace("{{NOTES}}", nz(notes))
        .replace("{{TAGS}}", tags_s)
        .replace("{{AREA}}", nz(area))
        .replace("{{TEMPLATE_SOURCE}}", nz(template_source))
        .replace("{{ROSTER_JSON}}", roster_json)
    )


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


def _assert_pipeline_prompt_registry() -> None:
    defaults_keys = frozenset(_defaults().keys())
    meta_keys = frozenset(m["key"] for m in PIPELINE_PROMPT_META)
    for key in sorted(meta_keys - defaults_keys):
        log.error(
            "PIPELINE_PROMPT_META defines %r but _defaults() has no entry — fix prompt_catalog._defaults",
            key,
        )
    for key in sorted(defaults_keys - meta_keys):
        log.warning(
            "Default prompt %r has no PIPELINE_PROMPT_META row — UI will use category 'Other'",
            key,
        )


_assert_pipeline_prompt_registry()
