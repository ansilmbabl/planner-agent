from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AgentDef(BaseModel):
    id: str
    name: str
    title: str
    system_prompt: str
    tools_enabled: bool = True
    tool_ids: list[str] = Field(
        default_factory=list,
        description=(
            "Subset of server-registered tool ids (e.g. web_search, fetch_url). "
            "When tools_enabled is true and this is empty, all registered tools apply."
        ),
    )

    @field_validator("tool_ids", mode="before")
    @classmethod
    def _norm_tool_ids(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for x in v:
            if isinstance(x, str):
                s = x.strip()
                if s and s not in out:
                    out.append(s)
            if len(out) >= 24:
                break
        return out


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

    debating_agents: list[AgentDef] = Field(
        default_factory=list,
        description="User-defined agents the orchestrator invokes via call_agents (ids must be unique).",
    )
    orchestrator: AgentDef | None = Field(
        default=None,
        description="Routes each step. If omitted, the backend uses a built-in orchestrator prompt.",
    )

    @model_validator(mode="before")
    @classmethod
    def _merge_legacy_synthesizer_into_agents(cls, data: Any) -> Any:
        """Older council JSON used a separate synthesizer object; fold it into debating_agents."""
        if not isinstance(data, dict):
            return data
        syn = data.pop("synthesizer", None)
        agents: list[Any] = list(data.get("debating_agents") or [])
        if isinstance(syn, dict) and str(syn.get("id") or "").strip():
            sid = str(syn["id"]).strip()
            existing = {
                str(a.get("id", "")).strip()
                for a in agents
                if isinstance(a, dict)
            }
            if sid not in existing:
                agents.append(syn)
        data["debating_agents"] = agents
        return data
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
    display_name: str | None = Field(
        default=None,
        description="Human-readable name for UI and LLM bootstrap (file id is still the council id).",
    )
    notes: str | None = Field(
        default=None,
        description="Free-form notes; surfaced in settings and passed to council bootstrap prompts.",
    )
    tags: list[str] = Field(
        default_factory=list,
        description="Short labels for organization or prompt context (e.g. compliance, codegen).",
    )
    area: str | None = Field(
        default=None,
        description="Primary domain or mission (e.g. incident response, hiring).",
    )

    @field_validator("tags", mode="before")
    @classmethod
    def _normalize_tags(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for x in v:
            if not isinstance(x, str):
                continue
            s = x.strip()
            if not s:
                continue
            out.append(s[:80])
            if len(out) >= 48:
                break
        return out


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
