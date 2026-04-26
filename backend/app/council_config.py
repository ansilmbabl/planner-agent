from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field


class AgentDef(BaseModel):
    id: str
    name: str
    title: str
    system_prompt: str
    tools_enabled: bool = True


class CouncilConfigFile(BaseModel):
    debating_agents: list[AgentDef] = Field(default_factory=list)
    synthesizer: AgentDef | None = None
    orchestrator: AgentDef | None = Field(
        default=None,
        description="Routes each step: which specialist, synthesizer, user, or plan. "
        "If omitted, the backend uses a built-in orchestrator prompt.",
    )
    orchestrator_user_instructions: str | None = Field(
        default=None,
        description="Inserted into the routing user message under 'Routing guidelines'. "
        "If omitted, backend/prompts/orchestrator.py defaults apply.",
    )
    initial_research: bool = Field(
        default=True,
        description="Soft preference for the orchestrator prompt only: if True, lean toward "
        "choosing run_research when grounding helps; if False, use run_research only when "
        "clearly needed. The orchestrator always decides each step; nothing runs before its first decision.",
    )


def load_council_config(path: Path) -> CouncilConfigFile:
    data = json.loads(path.read_text(encoding="utf-8"))
    return CouncilConfigFile.model_validate(data)


def save_council_config(path: Path, config: CouncilConfigFile) -> None:
    """Write council JSON; parent directory must exist."""
    text = json.dumps(
        config.model_dump(mode="json"),
        indent=2,
        ensure_ascii=False,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n", encoding="utf-8")
