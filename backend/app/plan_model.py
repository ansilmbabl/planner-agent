from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class NonGoal(BaseModel):
    item: str


class ConstraintItem(BaseModel):
    description: str


class TechRow(BaseModel):
    component: str
    choice: str
    rationale: str


class DataModelItem(BaseModel):
    name: str
    details: str


class PhaseItem(BaseModel):
    name: str
    deliverables: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)


class FileMapItem(BaseModel):
    path: str
    responsibility: str


class FlowItem(BaseModel):
    description: str
    mermaid: str | None = None


class TestingItem(BaseModel):
    item: str


class OpItem(BaseModel):
    name: str
    value: str


class ChecklistItem(BaseModel):
    task: str
    done: bool = False


class OpenQuestionItem(BaseModel):
    question: str


class PlanSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str
    problem_and_success: str
    non_goals: list[NonGoal] = Field(default_factory=list)
    constraints: list[ConstraintItem] = Field(default_factory=list)
    proposed_approach: str
    tech_stack: list[TechRow] = Field(default_factory=list)
    data_model_and_interfaces: list[DataModelItem] = Field(default_factory=list)
    phases: list[PhaseItem] = Field(default_factory=list)
    file_map: list[FileMapItem] = Field(default_factory=list)
    key_flows: list[FlowItem] = Field(default_factory=list)
    testing: list[TestingItem] = Field(default_factory=list)
    operations: list[OpItem] = Field(default_factory=list)
    open_questions: list[OpenQuestionItem] = Field(default_factory=list)
    checklist: list[ChecklistItem] = Field(default_factory=list)

    @classmethod
    def from_llm_dict(cls, d: dict[str, Any]) -> PlanSpec:
        return cls.model_validate(d)


def plan_spec_json_schema_hint() -> str:
    return """
Return a single JSON object with these keys (use arrays of objects or strings as shown):
{
  "title": "string",
  "problem_and_success": "string (measurable where possible)",
  "non_goals": [{"item": "string"}],
  "constraints": [{"description": "string"}],
  "proposed_approach": "string",
  "tech_stack": [{"component": "string", "choice": "string", "rationale": "string"}],
  "data_model_and_interfaces": [{"name": "string", "details": "string"}],
  "phases": [{
    "name": "string",
    "deliverables": ["string"],
    "risks": ["string"],
    "out_of_scope": ["string"]
  }],
  "file_map": [{"path": "string", "responsibility": "string"}],
  "key_flows": [{"description": "string", "mermaid": "string|null"}],
  "testing": [{"item": "string"}],
  "operations": [{"name": "string", "value": "string"}],
  "open_questions": [{"question": "string"}],
  "checklist": [{"task": "string", "done": false}]
}
""".strip()
