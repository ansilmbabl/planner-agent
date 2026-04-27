from __future__ import annotations

# --- Defaults when council JSON omits orchestrator / user instruction blocks ---

DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT = """You are the Council Orchestrator for a structured multi-agent planning workflow.
You choose the next step (which may run multiple specialists in parallel, answer the user yourself, or finish without a plan).
You do not role-play product debate as a specialist; you route and, when appropriate, answer directly.
Do not choose orchestrator_reply again after you have already given the user a complete answer for this message; use orchestrator_done instead.
Follow the routing guidelines in the user message, then output JSON matching the schema there."""

DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS = """How to choose the next step:
- run_research: web search + research brief refresh (use when facts, links, or recency matter). Run only when you decide it helps; specialists and plan writer see the updated brief.
- call_agents: one or more specialist ids in `agent_ids`. Independent perspectives run in parallel (they do not see each other's outputs in this batch). Use several ids when angles are independent; one id when order or a single voice matters more. Skip when no specialists are listed — use orchestrator_reply instead.
- orchestrator_reply: one direct answer to the user in chat (put the full answer in this single step). Use for greetings, who/what questions, and clarifications that do not need specialists. If there are no specialists configured, your next action after a complete answer must be orchestrator_done — never chain another orchestrator_reply for the same user message.
- orchestrator_done: end this turn without writing plan.md (immediately after a sufficient orchestrator_reply, or when no plan is needed).
- call_synthesizer: once enough debate exists to align views, before final planning (only if a synthesizer is available and has not run yet).
- ask_user: only for blocking ambiguities that must not be assumed; provide 1-3 concrete questions.
- ready_for_plan: when the user wants a concrete implementation plan and the council is ready to write plan.md.
- Legacy: `call_agent` with `agent_id` is treated like `call_agents` with a single id."""

ORCH_DECISION_SCHEMA = """
Return JSON only:
{
  "action": "call_agents" | "call_agent" | "run_research" | "orchestrator_reply" | "orchestrator_done" | "call_synthesizer" | "ask_user" | "ready_for_plan",
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
    prefer_research_when_helpful: bool,
) -> str:
    body = orchestrator_user_instructions_effective(instructions)
    summary = transcript_summary.strip() or "_(none yet)_"
    roster_block = (
        roster.strip()
        or "_(no specialists configured — use orchestrator_reply / orchestrator_done; "
        "use ready_for_plan only if the user wants an implementation plan written to plan.md.)_"
    )
    id_rule = (
        f"- Each id in `agent_ids` must be one of: {id_list}"
        if id_list.strip()
        else "- No specialist ids are configured; do not use call_agents (use orchestrator_reply instead)."
    )
    research_hint = (
        "Council preference: lean toward `run_research` early when grounded facts, links, or "
        "recency would clearly improve your next reply, specialist turns, or planning."
        if prefer_research_when_helpful
        else "Council preference: use `run_research` only when the user clearly needs external "
        "verification, citations, or up-to-date web facts; otherwise prefer orchestrator_reply or "
        "call_agents when sufficient."
    )
    from ..prompt_catalog import get_prompt

    decision_schema = get_prompt("orchestrator_decision_schema").strip() or ORCH_DECISION_SCHEMA
    return f"""# Routing task

## User idea
{user_brief}

## Research context (may be empty until you run run_research)
{research_brief}

### How to use research
{research_hint}

## Orchestration step {step_n} / {max_steps}

### Specialist transcript (summary)
{summary}

## Roster (valid ids for call_agents / call_agent)
{roster_block}

{id_rule}
- Synthesizer available: {synth_available}
- Synthesizer already ran: {synth_done}

## Routing guidelines (editable in council JSON / UI)
{body}

{decision_schema}
""".strip()
