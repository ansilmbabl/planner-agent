from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AgentDef(BaseModel):
    id: str
    name: str
    title: str
    system_prompt: str
    tools_enabled: bool = True


class ReferenceUrl(BaseModel):
    """HTTPS URLs the user adds for research; text is merged into the research brief during the run."""

    url: str = Field(..., min_length=1, description="https URL to fetch (plain text excerpt)")
    label: str | None = Field(
        default=None,
        description="Optional heading in the brief; defaults to the URL.",
    )
    placement: Literal["session_start", "after_research", "before_artifact"] = Field(
        default="session_start",
        description="When to fetch and append: start of run, after web research step, or before the final artifact.",
    )


class CouncilConfigFile(BaseModel):
    model_config = ConfigDict(extra="ignore")

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
    output_mode: Literal["plan", "report", "code", "conversation", "none"] = Field(
        default="plan",
        description="Primary artifact: structured plan (JSON→markdown), prose report, code file, "
        "conversation-only (no file; orchestrator_done), or none (nil — no deliverable).",
    )
    output_instructions: str | None = Field(
        default=None,
        description="Extra instructions for report/code generation (audience, sections, language, etc.).",
    )
    artifact_filename: str | None = Field(
        default=None,
        description="Suggested download name for report or code (e.g. report.md, main.py).",
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
