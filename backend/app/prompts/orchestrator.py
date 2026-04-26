from __future__ import annotations

# --- Defaults when council JSON omits orchestrator / user instruction blocks ---

DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT = """You are the Council Orchestrator for a structured multi-agent planning workflow.
You choose exactly ONE next step. You do not debate product details yourself.
Follow the routing guidelines in the user message, then output JSON matching the schema there."""

DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS = """How to choose the next step:
- call_agent: pick the specialist whose perspective is missing, weak, or contradicted. Use their `agent_id` from the roster.
- call_synthesizer: once enough debate exists to align views, before final planning (only if a synthesizer is available and has not run yet).
- ask_user: only for blocking ambiguities that must not be assumed; provide 1-3 concrete questions.
- ready_for_plan: when the council can produce a concrete implementation plan."""

ORCH_DECISION_SCHEMA = """
Return JSON only:
{
  "action": "call_agent" | "call_synthesizer" | "ask_user" | "ready_for_plan",
  "agent_id": null or string (required for call_agent; must be one of the listed ids),
  "questions": null or array of 1-3 strings (for ask_user),
  "reason": "one short sentence for debugging"
}
""".strip()

# Appended to council-defined orchestrator system_prompt so the model keeps JSON discipline.
ORCHESTRATOR_SYSTEM_JSON_SUFFIX = (
    "\n\nRespond with JSON only; follow the schema block in the user message."
)


def orchestrator_user_instructions_effective(custom: str | None) -> str:
    t = (custom or "").strip()
    return t if t else DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS


def build_orchestrator_user_message(
    *,
    user_brief: str,
    research_brief: str,
    transcript_summary: str,
    roster: str,
    id_list: str,
    synth_available: bool,
    synth_done: bool,
    step_n: int,
    max_steps: int,
    instructions: str | None,
) -> str:
    body = orchestrator_user_instructions_effective(instructions)
    summary = transcript_summary.strip() or "_(none yet)_"
    return f"""# Routing task

## User idea
{user_brief}

## Research
{research_brief}

## Orchestration step {step_n} / {max_steps}

### Specialist transcript (summary)
{summary}

## Roster (valid agent_id for call_agent)
{roster}

- `agent_id` must be one of: {id_list}
- Synthesizer available: {synth_available}
- Synthesizer already ran: {synth_done}

## Routing guidelines (editable in council JSON / UI)
{body}

{ORCH_DECISION_SCHEMA}
""".strip()
