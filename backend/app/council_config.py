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


def load_council_config(path: Path) -> CouncilConfigFile:
    data = json.loads(path.read_text(encoding="utf-8"))
    return CouncilConfigFile.model_validate(data)
