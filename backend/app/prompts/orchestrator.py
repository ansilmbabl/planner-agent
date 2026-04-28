from __future__ import annotations

# --- Defaults when council JSON omits orchestrator / user instruction blocks ---

DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT = """You are the Council Orchestrator for a multi-agent workflow.
You choose exactly ONE next step: run research, call one or more agents by id, ask the user, reply yourself, signal that the configured primary output should be produced, or end without an output.
You do not role-play as one of the council agents; you route and, when appropriate, answer the user directly.
Do not choose orchestrator_reply again after you have already given the user a complete answer for this message; use orchestrator_done instead.
Follow the routing guidelines in the user message, then output JSON matching the schema there."""

DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS = """How to choose the next step:
- run_research: web search + research brief refresh (use when facts, links, or recency matter). Run only when you decide it helps; agents and later output steps see the updated brief.
- call_agents: one or more agent ids in `agent_ids` from the roster. Parallel batches do not see each other in that step. Use several ids when perspectives are independent; one id when a single voice is enough. If the roster is empty, use orchestrator_reply instead of call_agents.
- orchestrator_reply: one direct answer to the user in chat (full answer in this step). Use when no agents are needed. If there are no agents configured, after a complete answer use orchestrator_done — do not chain another orchestrator_reply for the same user message.
- orchestrator_done: end this turn without producing the council's primary file (after a sufficient reply, or when no file is needed).
- ask_user: only for blocking ambiguities; provide 1-3 concrete questions.
- ready_for_plan / ready_for_artifact: when the council should produce its configured primary output (plan, report, or code per council settings), or when discussion is sufficient for that output.
- Legacy: `call_agent` with `agent_id` is treated like `call_agents` with a single id."""

ORCH_DECISION_SCHEMA = """
Return JSON only:
{
  "action": "call_agents" | "call_agent" | "run_research" | "orchestrator_reply" | "orchestrator_done" | "ask_user" | "ready_for_plan" | "ready_for_artifact",
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
    step_n: int,
    max_steps: int,
    instructions: str | None,
    prefer_research_when_helpful: bool,
) -> str:
    body = orchestrator_user_instructions_effective(instructions)
    summary = transcript_summary.strip() or "_(none yet)_"
    roster_block = (
        roster.strip()
        or "_(no agents in roster — use orchestrator_reply / orchestrator_done; "
        "use ready_for_plan or ready_for_artifact only when a primary output is appropriate.)_"
    )
    id_rule = (
        f"- Each id in `agent_ids` must be one of: {id_list}"
        if id_list.strip()
        else "- No agent ids are configured; do not use call_agents (use orchestrator_reply instead)."
    )
    research_hint = (
        "Council preference: lean toward `run_research` early when grounded facts, links, or "
        "recency would clearly improve your next reply, agent turns, or final output."
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

### Agent discussion (summary)
{summary}

## Roster (valid ids for call_agents / call_agent)
{roster_block}

{id_rule}

## Routing guidelines (editable in council JSON / UI)
{body}

{decision_schema}
""".strip()
