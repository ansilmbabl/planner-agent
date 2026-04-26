from __future__ import annotations

# --- Defaults when council JSON omits orchestrator / user instruction blocks ---

DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT = """You are the Council Orchestrator for a structured multi-agent planning workflow.
You choose the next step (which may run multiple specialists in parallel). You do not debate product details yourself.
Follow the routing guidelines in the user message, then output JSON matching the schema there."""

DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS = """How to choose the next step:
- call_agents: one or more specialist ids in `agent_ids`. Independent perspectives run in parallel (they do not see each other's outputs in this batch). Use several ids when angles are independent; one id when order or a single voice matters more.
- call_synthesizer: once enough debate exists to align views, before final planning (only if a synthesizer is available and has not run yet).
- ask_user: only for blocking ambiguities that must not be assumed; provide 1-3 concrete questions.
- ready_for_plan: when the council can produce a concrete implementation plan.
- Legacy: `call_agent` with `agent_id` is treated like `call_agents` with a single id."""

ORCH_DECISION_SCHEMA = """
Return JSON only:
{
  "action": "call_agents" | "call_agent" | "call_synthesizer" | "ask_user" | "ready_for_plan",
  "agent_ids": null or non-empty array of distinct strings (for call_agents; each must be a listed id),
  "agent_id": null or string (legacy for call_agent only; same as agent_ids with one element),
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

## Roster (valid ids for call_agents / call_agent)
{roster}

- Each id in `agent_ids` must be one of: {id_list}
- Synthesizer available: {synth_available}
- Synthesizer already ran: {synth_done}

## Routing guidelines (editable in council JSON / UI)
{body}

{ORCH_DECISION_SCHEMA}
""".strip()
