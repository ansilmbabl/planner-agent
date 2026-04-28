from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any

from .council_config import AgentDef, CouncilConfigFile
from .config import Settings
from .llm import ChatMsg, _msg_system, _msg_user, complete_chat
from .orchestrator import effective_orchestrator
from .prompt_catalog import get_prompt
from .session import (
    ChatMessage,
    CouncilSession,
    SessionPhase,
    SessionStore,
    archive_current_plan,
)


_FENCE_RE = re.compile(
    r"^\s*```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$", re.IGNORECASE
)


def strip_outer_markdown_fence(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return t
    m = _FENCE_RE.match(t)
    if m:
        return m.group(1).strip()
    return t


def _personas_for_refine(
    council: CouncilConfigFile, agent_ids: list[str]
) -> tuple[list[AgentDef], list[str]]:
    """Resolve requested ids to AgentDef list (deduped, stable order)."""
    seen: set[str] = set()
    out: list[AgentDef] = []
    labels: list[str] = []

    def add(a: AgentDef | None, label: str) -> None:
        if not a or a.id in seen:
            return
        seen.add(a.id)
        out.append(a)
        labels.append(label)

    for raw in agent_ids:
        rid = (raw or "").strip()
        if not rid:
            continue
        low = rid.lower()
        if low == "orchestrator":
            add(effective_orchestrator(council), effective_orchestrator(council).name)
        elif low == "synthesizer":
            for d in council.debating_agents:
                if d.id == rid:
                    add(d, d.name)
                    break
        else:
            for d in council.debating_agents:
                if d.id == rid:
                    add(d, d.name)
                    break

    if not out:
        o = effective_orchestrator(council)
        add(o, o.name)

    return out, labels


def _build_refine_system_prompt(personas: list[AgentDef]) -> str:
    parts: list[str] = []
    for i, p in enumerate(personas):
        parts.append(
            f"## Persona {i + 1}: {p.name} ({p.id})\n"
            f"{(p.system_prompt or '').strip() or '(no system prompt)'}"
        )
    parts.append(
        "## Task\n"
        "You are revising the session's primary output (plan, report, or prose — stored like plan.md). "
        "Apply the user's instruction faithfully. Output a single Markdown document only."
    )
    return "\n\n".join(parts)


def _build_refine_user_message(
    plan_md: str,
    instruction: str,
    selection: str | None,
) -> str:
    blocks = [
        "Below is the current primary output in full.",
        "--- BEGIN DOCUMENT ---",
        plan_md.rstrip(),
        "--- END DOCUMENT ---",
    ]
    sel = (selection or "").strip()
    if sel:
        blocks.extend(
            [
                "--- USER-SELECTED EXCERPT (prioritize this passage; keep the rest coherent) ---",
                sel,
                "--- END EXCERPT ---",
            ]
        )
    blocks.extend(
        [
            "--- USER INSTRUCTION ---",
            instruction.strip(),
            "--- END INSTRUCTION ---",
            "",
            get_prompt("plan_refine_user_suffix"),
        ]
    )
    return "\n".join(blocks)


async def run_plan_refine(
    settings: Settings,
    _store: SessionStore,
    session: CouncilSession,
    council: CouncilConfigFile,
    *,
    instruction: str,
    selection: str | None,
    agent_ids: list[str],
    model: str,
) -> AsyncIterator[dict[str, Any]]:
    s = session
    s.error_message = None
    plan_in = (s.plan_markdown or "").strip()
    if not plan_in:
        yield {
            "type": "error",
            "message": "No output to refine — run the council until a primary file exists.",
        }
        return
    if s.phase != SessionPhase.done:
        yield {
            "type": "error",
            "message": f"Refine is only available after a finished run (phase is {s.phase.value}, expected done).",
        }
        return

    personas, labels = _personas_for_refine(council, agent_ids)
    system = _build_refine_system_prompt(personas)
    user_msg = _build_refine_user_message(plan_in, instruction, selection)

    yield {
        "type": "phase",
        "phase": "plan_refine",
        "message": f"Refining output with: {', '.join(labels)}",
    }

    try:
        raw = await complete_chat(
            settings,
            [_msg_system(system), _msg_user(user_msg)],
            model,
            temperature=0.25,
        )
        new_md = strip_outer_markdown_fence(raw)
        if not new_md.strip():
            yield {"type": "error", "message": "Model returned empty text."}
            return

        archive_current_plan(s, "before_refine")
        s.plan_markdown = new_md
        s.plan_iteration_message = ""
        summary = (
            f"Output refined ({', '.join(labels)}).\n\n"
            f"_Instruction:_ {(instruction or '').strip()[:400]}"
            + ("…" if len((instruction or "").strip()) > 400 else "")
        )
        s.messages.append(
            ChatMessage(
                role="user",
                content=f"[Refine output] {(instruction or '').strip()[:2000]}",
                agent_id=None,
                agent_name=None,
                meta={"kind": "plan_refine_request", "agent_ids": [p.id for p in personas]},
            )
        )
        s.messages.append(
            ChatMessage(
                role="assistant",
                content=summary,
                agent_id="plan_refine",
                agent_name="Output refine",
                meta={
                    "kind": "plan_refine",
                    "personas": labels,
                },
            )
        )
        ak = str(getattr(s, "artifact_kind", "") or "").strip() or "plan"
        yield {
            "type": "plan",
            "content": s.plan_markdown,
            "filename": s.plan_filename or "plan.md",
            "plan_versions": list(getattr(s, "plan_versions", None) or []),
            "artifact_kind": ak,
        }
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001
        # Keep phase `done` and existing plan on refine failure.
        yield {"type": "error", "message": str(e)}
