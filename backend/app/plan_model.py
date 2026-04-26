from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def _str_list_to_objects(items: Any, key: str) -> list[Any]:
    """LLMs often return ['a','b'] instead of [{key: 'a'}, {key: 'b'}]."""
    if items is None:
        return []
    if not isinstance(items, list):
        return []
    out: list[Any] = []
    for el in items:
        if isinstance(el, str):
            s = el.strip()
            if s:
                out.append({key: s})
        elif isinstance(el, dict):
            out.append(el)
    return out


def _normalize_operations(items: Any) -> list[dict[str, Any]]:
    """LLMs often return ['task a', 'task b'] instead of [{name, value}, ...]."""
    if items is None:
        return []
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for el in items:
        if isinstance(el, str):
            s = el.strip()
            if s:
                out.append({"name": s, "value": ""})
        elif isinstance(el, dict):
            row = dict(el)
            name = str(row.get("name", "") or "").strip()
            value = str(row.get("value", "") or "").strip()
            if not name:
                for alt in ("description", "item", "title", "task"):
                    v = row.get(alt)
                    if v is not None and str(v).strip():
                        name = str(v).strip()
                        break
            if not value:
                for alt in ("detail", "notes", "body"):
                    v = row.get(alt)
                    if v is not None and str(v).strip():
                        value = str(v).strip()
                        break
            if name or value:
                out.append({"name": name or value, "value": value if name else ""})
    return out


def _normalize_tech_stack(items: Any) -> list[dict[str, Any]]:
    """LLMs often omit choice or rationale on tech_stack rows; fill defaults."""
    if items is None:
        return []
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for el in items:
        if not isinstance(el, dict):
            continue
        row = dict(el)
        if "component" not in row or row.get("component") is None:
            row["component"] = ""
        else:
            row["component"] = str(row["component"]).strip()
        for key in ("choice", "rationale"):
            if key not in row or row.get(key) is None:
                row[key] = ""
            else:
                row[key] = str(row[key]).strip()
        out.append(row)
    return out


class NonGoal(BaseModel):
    item: str


class ConstraintItem(BaseModel):
    description: str


class TechRow(BaseModel):
    component: str
    choice: str = ""
    rationale: str = ""


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
        d = _normalize_plan_spec_dict(d)
        return cls.model_validate(d)


def _normalize_plan_spec_dict(d: Any) -> dict[str, Any]:
    """Coerce common LLM mistakes (string arrays instead of object arrays) before Pydantic."""
    if not isinstance(d, dict):
        return {}
    d = {k: v for k, v in d.items()}
    d["non_goals"] = _str_list_to_objects(d.get("non_goals"), "item")
    d["constraints"] = _str_list_to_objects(d.get("constraints"), "description")
    d["open_questions"] = _str_list_to_objects(d.get("open_questions"), "question")
    d["testing"] = _str_list_to_objects(d.get("testing"), "item")
    d["operations"] = _normalize_operations(d.get("operations"))
    d["tech_stack"] = _normalize_tech_stack(d.get("tech_stack"))
    # Checklist: sometimes list of task strings
    ch = d.get("checklist")
    if isinstance(ch, list):
        ch_out: list[Any] = []
        for el in ch:
            if isinstance(el, str) and el.strip():
                ch_out.append({"task": el.strip(), "done": False})
            else:
                ch_out.append(el)
        d["checklist"] = ch_out
    return d


def plan_spec_json_schema_hint() -> str:
    return """
Return a single JSON object with these keys.
For non_goals, constraints, open_questions, testing, and operations you may use either an array of objects (preferred) or a simple array of strings (each string is coerced).

{
  "title": "string",
  "problem_and_success": "string (measurable where possible)",
  "non_goals": [{"item": "string"}],
  "constraints": [{"description": "string"}],
  "proposed_approach": "string",
  "tech_stack": [{"component": "string", "choice": "string", "rationale": "string (optional, defaults to empty)"}],
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
