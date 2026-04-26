from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

# Cap stored archived plans per session to keep JSON payloads bounded.
_MAX_PLAN_VERSIONS = 100


class SessionPhase(str, Enum):
    idle = "idle"
    research = "research"
    discussion = "discussion"
    awaiting_user = "awaiting_user"
    plan = "plan"
    done = "done"
    error = "error"


@dataclass
class ChatMessage:
    role: str
    content: str
    agent_id: str | None = None
    agent_name: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)


@dataclass
class CouncilSession:
    id: str
    model: str
    """Which agent council JSON to use (config/councils/{id}.json)."""
    council_id: str = "default"
    title: str = ""
    created_ts: float = field(default_factory=time.time)
    updated_ts: float = field(default_factory=time.time)
    phase: SessionPhase = SessionPhase.idle
    messages: list[ChatMessage] = field(default_factory=list)
    user_brief: str = ""
    # Follow-up message when improving the plan from chat; merged into prompts, then cleared.
    plan_iteration_message: str = ""
    research_brief: str = ""
    research_sources: list[dict[str, str]] = field(default_factory=list)
    discussion_round: int = 0
    max_rounds: int = 2
    agent_turns: list[dict[str, Any]] = field(default_factory=list)
    pending_user_questions: list[str] = field(default_factory=list)
    last_consolidated_questions: list[str] = field(default_factory=list)
    plan_markdown: str = ""
    plan_filename: str = "plan.md"
    # Prior snapshots, oldest first: filename, markdown, created_ts, source.
    plan_versions: list[dict[str, Any]] = field(default_factory=list)
    error_message: str | None = None
    user_answered_clarification: bool = False
    synthesizer_ran: bool = False
    last_synth_summary: str = ""
    # When True after orchestration, skip synthesizer + plan.md and end after chat.
    skip_implementation_plan: bool = False


def new_session_id() -> str:
    return secrets.token_urlsafe(12)


def archive_current_plan(s: CouncilSession, source: str) -> None:
    """Append the current plan to plan_versions before it is replaced or cleared."""
    md = (s.plan_markdown or "").strip()
    if not md:
        return
    s.plan_versions.append(
        {
            "filename": (s.plan_filename or "plan.md").strip() or "plan.md",
            "markdown": s.plan_markdown,
            "created_ts": time.time(),
            "source": (source or "").strip() or "unknown",
        }
    )
    if len(s.plan_versions) > _MAX_PLAN_VERSIONS:
        s.plan_versions = s.plan_versions[-_MAX_PLAN_VERSIONS:]


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, CouncilSession] = {}

    def create(self, model: str, council_id: str = "default") -> CouncilSession:
        sid = new_session_id()
        s = CouncilSession(id=sid, model=model, council_id=council_id or "default")
        self._sessions[sid] = s
        return s

    def get(self, session_id: str) -> CouncilSession | None:
        return self._sessions.get(session_id)
