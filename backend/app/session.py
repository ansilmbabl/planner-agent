from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


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
    created_ts: float = field(default_factory=time.time)
    phase: SessionPhase = SessionPhase.idle
    messages: list[ChatMessage] = field(default_factory=list)
    user_brief: str = ""
    research_brief: str = ""
    research_sources: list[dict[str, str]] = field(default_factory=list)
    discussion_round: int = 0
    max_rounds: int = 2
    agent_turns: list[dict[str, Any]] = field(default_factory=list)
    pending_user_questions: list[str] = field(default_factory=list)
    last_consolidated_questions: list[str] = field(default_factory=list)
    plan_markdown: str = ""
    plan_filename: str = "plan.md"
    error_message: str | None = None
    user_answered_clarification: bool = False


def new_session_id() -> str:
    return secrets.token_urlsafe(12)


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, CouncilSession] = {}

    def create(self, model: str) -> CouncilSession:
        sid = new_session_id()
        s = CouncilSession(id=sid, model=model)
        self._sessions[sid] = s
        return s

    def get(self, session_id: str) -> CouncilSession | None:
        return self._sessions.get(session_id)
