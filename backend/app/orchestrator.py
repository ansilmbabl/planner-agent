from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

from .council_config import AgentDef, CouncilConfigFile
from .config import Settings
from .prompts.debate import AGENT_TURN_SCHEMA
from .prompts.orchestrator import (
    DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
    ORCHESTRATOR_SYSTEM_JSON_SUFFIX,
    build_orchestrator_user_message,
)
from .llm import (
    ChatMsg,
    _msg_system,
    _msg_user,
    complete_chat,
    complete_structured_json,
)
from .plan_model import PlanSpec, plan_spec_json_schema_hint
from .plan_render import render_plan_md
from .session import (
    ChatMessage,
    CouncilSession,
    SessionPhase,
    SessionStore,
    archive_current_plan,
)
from .tools.fetch_url import fetch_url_text
from .tools.search import ddg_search, tavily_search
from .user_preferences import load_preferences

log = logging.getLogger(__name__)

RESEARCH_PENDING_PLACEHOLDER = (
    "_(No web research yet for this message — the orchestrator may choose `run_research` next, "
    "or answer / call agents if that is sufficient.)_"
)


def council_prompt_brief(s: CouncilSession) -> str:
    """Full idea text for council prompts, including a chat follow-up when iterating on a plan."""
    base = (s.user_brief or "").strip()
    extra = (getattr(s, "plan_iteration_message", None) or "").strip()
    if not extra:
        return base
    return (
        f"{base}\n\n---\n**User follow-up (incorporate into the revised plan):**\n{extra}\n"
    )


def effective_orchestrator(council: CouncilConfigFile) -> AgentDef:
    o = council.orchestrator
    if o is not None:
        return o
    return AgentDef(
        id="orchestrator",
        name="Orchestrator",
        title="Council routing",
        system_prompt=DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
        tools_enabled=False,
    )


def _debater_by_id(debaters: list[AgentDef], agent_id: str) -> AgentDef | None:
    for a in debaters:
        if a.id == agent_id:
            return a
    return None


def _call_counts(agent_turns: list[dict[str, Any]], debater_ids: set[str]) -> dict[str, int]:
    c = {i: 0 for i in debater_ids}
    for t in agent_turns:
        aid = str(t.get("agent_id", ""))
        if aid in c:
            c[aid] += 1
    return c


def _pick_least_called_debater(debaters: list[AgentDef], agent_turns: list[dict[str, Any]]) -> AgentDef:
    ids = {a.id for a in debaters}
    c = _call_counts(agent_turns, ids)
    return min(debaters, key=lambda a: (c.get(a.id, 0), a.id))


def _normalize_orch_decision(
    data: dict[str, Any],
    debaters: list[AgentDef],
    agent_turns: list[dict[str, Any]],
    synth_available: bool,
    synth_done: bool,
    max_parallel: int,
) -> tuple[str, list[str], list[str], str]:
    debater_ids = {a.id for a in debaters}
    cap = max(1, min(max_parallel, len(debaters) or 1))
    reason = str(data.get("reason", "")).strip() or "(no reason)"
    raw = str(data.get("action", "")).strip().lower().replace("-", "_")
    aliases = {
        "callagent": "call_agents",
        "call_agent": "call_agents",
        "invoke_agent": "call_agents",
        "agent": "call_agents",
        "callagents": "call_agents",
        "parallel": "call_agents",
        "parallel_agents": "call_agents",
        "synthesizer": "call_synthesizer",
        "synth": "call_synthesizer",
        "merge": "call_synthesizer",
        "human": "ask_user",
        "hitl": "ask_user",
        "askuser": "ask_user",
        "user": "ask_user",
        "plan": "ready_for_plan",
        "finish": "ready_for_plan",
        "done": "ready_for_plan",
        "write_plan": "ready_for_plan",
        "reply": "orchestrator_reply",
        "answer": "orchestrator_reply",
        "direct_reply": "orchestrator_reply",
        "answer_user": "orchestrator_reply",
        "orchestratoranswer": "orchestrator_reply",
        "end_turn": "orchestrator_done",
        "end_without_plan": "orchestrator_done",
        "conversation_done": "orchestrator_done",
        "complete_without_plan": "orchestrator_done",
        "research": "run_research",
        "web_research": "run_research",
        "refresh_research": "run_research",
        "search_web": "run_research",
    }
    action = aliases.get(raw, raw)
    if action == "call_agent":
        action = "call_agents"

    qs_raw = data.get("questions")
    questions: list[str] = []
    if isinstance(qs_raw, list):
        questions = [str(q).strip() for q in qs_raw if str(q).strip()]
    elif qs_raw is not None and str(qs_raw).strip():
        questions = [str(qs_raw).strip()]

    agent_ids_out: list[str] = []
    seen_ids: set[str] = set()
    raw_ids = data.get("agent_ids")
    if isinstance(raw_ids, list):
        for x in raw_ids:
            s = str(x).strip()
            if s in debater_ids and s not in seen_ids:
                seen_ids.add(s)
                agent_ids_out.append(s)
    agent_id = data.get("agent_id")
    if agent_id is not None and str(agent_id).strip():
        aid = str(agent_id).strip()
        if aid in debater_ids and aid not in seen_ids:
            seen_ids.add(aid)
            agent_ids_out.append(aid)
    agent_ids_out = agent_ids_out[:cap]

    if action not in (
        "call_agents",
        "call_synthesizer",
        "ask_user",
        "ready_for_plan",
        "orchestrator_reply",
        "orchestrator_done",
        "run_research",
    ):
        action = "call_agents"
        agent_ids_out = []
    if action == "call_synthesizer" and not synth_available:
        action = "call_agents"
        agent_ids_out = []
    if action == "call_synthesizer" and synth_done:
        action = "ready_for_plan"
        agent_ids_out = []
    if action == "ask_user" and not questions:
        questions = [
            "What is the most important constraint or scope decision we should lock before planning?"
        ]

    if action in (
        "ask_user",
        "ready_for_plan",
        "call_synthesizer",
        "orchestrator_done",
        "orchestrator_reply",
        "run_research",
    ):
        agent_ids_out = []
    elif action == "call_agents":
        if not debaters:
            action = "orchestrator_reply"
            agent_ids_out = []
        elif not agent_ids_out:
            agent_ids_out = [_pick_least_called_debater(debaters, agent_turns).id]

    return action, agent_ids_out, questions, reason


async def _orchestrator_decide(
    settings: Settings,
    orch: AgentDef,
    model: str,
    user_brief: str,
    research_brief: str,
    transcript_summary: str,
    debaters: list[AgentDef],
    synth_available: bool,
    synth_done: bool,
    step_n: int,
    max_steps: int,
    council: CouncilConfigFile,
) -> dict[str, Any]:
    id_list = ", ".join(a.id for a in debaters)
    roster = "\n".join(f"- `{a.id}` — {a.name} ({a.title})" for a in debaters)
    user = build_orchestrator_user_message(
        user_brief=user_brief,
        research_brief=research_brief,
        transcript_summary=transcript_summary,
        roster=roster,
        id_list=id_list,
        synth_available=synth_available,
        synth_done=synth_done,
        step_n=step_n,
        max_steps=max_steps,
        instructions=council.orchestrator_user_instructions,
        prefer_research_when_helpful=council.initial_research,
    )
    system = orch.system_prompt.strip() + ORCHESTRATOR_SYSTEM_JSON_SUFFIX
    return await complete_structured_json(settings, system, user, model=model)


async def _orchestrator_reply_text(
    settings: Settings,
    orch: AgentDef,
    model: str,
    user_brief: str,
    research_brief: str,
    transcript_summary: str,
) -> str:
    system = (
        orch.system_prompt.strip()
        + "\n\nFor this turn you answer the user directly. Be clear and helpful; markdown is fine. "
        "Do not output JSON."
    )
    user = f"""## User request
{user_brief}

## Research context
{research_brief}

## Notes from this session so far
{transcript_summary.strip() or '_(none)_'}

Answer the user now."""
    return await complete_chat(
        settings,
        [_msg_system(system), _msg_user(user)],
        model=model,
        temperature=0.3,
    )


async def _run_synthesizer_step(
    settings: Settings,
    session: CouncilSession,
    council: CouncilConfigFile,
) -> AsyncIterator[dict[str, Any]]:
    s = session
    syn = council.synthesizer
    if not syn or s.synthesizer_ran:
        return
    all_turns_txt = _turns_to_transcript(s.agent_turns)
    syn_text = await _synthesizer(
        settings,
        syn,
        s.model,
        council_prompt_brief(s),
        s.research_brief,
        all_turns_txt,
    )
    s.synthesizer_ran = True
    s.last_synth_summary = syn_text
    s.messages.append(
        ChatMessage(
            role="assistant",
            content=syn_text,
            agent_id=syn.id,
            agent_name=syn.name,
        )
    )
    yield {"type": "synth", "summary": syn_text}


def _dedupe_qs(questions: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for q in questions:
        k = re.sub(r"\s+", " ", (q or "").strip().lower())
        if not k or k in seen:
            continue
        seen.add(k)
        out.append((q or "").strip())
    return out


def _filename_from_title(title: str) -> str:
    t = re.sub(r"[^\w\s-]", "", (title or "plan"))[:60]
    t = re.sub(r"[-\s]+", "-", t).strip("-").lower() or "plan"
    return f"{t}.md"


async def _generate_search_plan(
    settings: Settings, user_brief: str, model: str
) -> dict[str, Any]:
    system = "You are a research planner. Return JSON only."
    user = f"""User idea:
{user_brief}

Return JSON: {{"queries": ["q1", ...], "urls_to_fetch": []}}
- queries: 1-3 short web search queries, or fewer if the idea is fully specified.
- urls_to_fetch: 0-2 full https URLs to read for context, or [].
"""
    return await complete_structured_json(settings, system, user, model=model)


def _effective_research_provider(settings: Settings) -> tuple[str, str]:
    prefs = load_preferences(settings.sqlite_path.parent)
    raw = str(prefs.get("research_provider") or "").strip().lower()
    base = str(settings.research_provider or "duckduckgo").strip().lower()
    provider = raw if raw in ("duckduckgo", "tavily") else base
    if provider not in ("duckduckgo", "tavily"):
        provider = "duckduckgo"
    key = str(prefs.get("tavily_api_key") or settings.tavily_api_key or "").strip()
    return provider, key


def _search_only(settings: Settings, queries: list[str]) -> list[dict[str, str]]:
    provider, tavily_key = _effective_research_provider(settings)
    all_rows: list[dict[str, str]] = []
    for q in queries[: settings.research_max_queries]:
        if provider == "tavily" and tavily_key:
            all_rows.extend(tavily_search(tavily_key, q, max_results=3))
        else:
            if provider == "tavily" and not tavily_key:
                log.warning("research_provider=tavily but no API key; using DuckDuckGo")
            all_rows.extend(ddg_search(q, max_results=3))
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for r in all_rows:
        h = r.get("href", "")
        if h and h in seen:
            continue
        if h:
            seen.add(h)
        unique.append(r)
    return unique


async def _summarize_research(
    settings: Settings,
    user_brief: str,
    sources: list[dict[str, str]],
    fetches: list[dict[str, Any]],
    model: str,
) -> str:
    src_txt = "\n".join(
        f"- {s.get('title','')}: {s.get('href','')}\n  {s.get('body','')[:300]}"
        for s in sources[:12]
    )
    fetch_txt = "\n\n".join(
        f"URL: {f.get('url')}\nExcerpt: {f.get('excerpt','')[:4000]}"
        for f in fetches
        if f.get("ok")
    )
    system = "You are a research summarizer. Output a tight bullet brief; cite page titles. No JSON."
    user = f"Idea:\n{user_brief}\n\nSearch results:\n{src_txt}\n\nFetches:\n{fetch_txt or '(none)'}\n\nWrite 5-10 bullets; note assumptions."
    return await complete_chat(
        settings,
        [_msg_system(system), _msg_user(user)],
        model=model,
        temperature=0.2,
    )


async def _run_web_research_phase(settings: Settings, s: CouncilSession) -> None:
    """Search, optional URL fetches, summarize; updates s.research_sources and s.research_brief."""
    brief = council_prompt_brief(s)
    sp = await _generate_search_plan(settings, brief, s.model)
    qlist = [
        str(x)
        for x in (sp.get("queries") or [])
        if str(x).strip()
    ][: settings.research_max_queries]
    if not qlist and brief.strip():
        first = brief.strip().split("\n", 1)[0].strip()[:200]
        qlist = [first] if first else []
    urls = [
        str(u)
        for u in (sp.get("urls_to_fetch") or [])
        if str(u).strip().lower().startswith("http")
    ][:2]

    sources = _search_only(settings, qlist) if qlist else []
    fetches: list[dict[str, Any]] = []
    for u in urls:
        fetches.append(await fetch_url_text(u, settings))
    s.research_sources = [
        {
            "title": r.get("title", ""),
            "href": r.get("href", ""),
            "body": (r.get("body", "") or "")[:400],
        }
        for r in sources
    ]
    s.research_brief = await _summarize_research(
        settings, brief, sources, fetches, s.model
    )


def _build_agent_user_payload(
    agent: AgentDef,
    user_brief: str,
    research_brief: str,
    prior_rounds_summary: str,
    round_index: int,
    same_round_prior: str,
) -> str:
    return f"""# Council

**Round** {round_index} — **{agent.name}** ({agent.title})

## User's idea
{user_brief}

## Research brief
{research_brief}

## Prior rounds
{prior_rounds_summary or '_(none)_'}

## This round (agents before you)
{same_round_prior or '_(none — you are first in this round)_'}

{AGENT_TURN_SCHEMA}
""".strip()


async def _agent_turn(
    settings: Settings,
    agent: AgentDef,
    model: str,
    user_brief: str,
    research_brief: str,
    prior_summary: str,
    r: int,
    same_round: str,
) -> dict[str, Any]:
    system = agent.system_prompt + "\n" + AGENT_TURN_SCHEMA
    user = _build_agent_user_payload(
        agent, user_brief, research_brief, prior_summary, r, same_round
    )
    data = await complete_structured_json(settings, system, user, model=model)
    uq = data.get("user_question")
    uq_s: str | None
    if uq is None or (isinstance(uq, str) and not uq.strip()) or str(uq).lower() in ("null", "none"):
        uq_s = None
    else:
        uq_s = str(uq).strip()
    return {
        "reaction": str(data.get("reaction", "")).strip(),
        "user_question": uq_s,
        "planner_note": str(data.get("planner_note", "")).strip(),
    }


async def _synthesizer(
    settings: Settings,
    syn: AgentDef,
    model: str,
    user_brief: str,
    research_brief: str,
    all_turns: str,
) -> str:
    system = syn.system_prompt
    user = f"""# Align views (no new product debate)

User idea:
{user_brief}

Research:
{research_brief}

Council transcript:
{all_turns}

Return JSON: {{"aligned_summary": "5-8 bullets: agreements, tensions, direction"}}
"""
    d = await complete_structured_json(settings, system, user, model=model)
    return str(d.get("aligned_summary", "")).strip()


async def _plan_writer(
    settings: Settings,
    model: str,
    user_brief: str,
    research_brief: str,
    syn_summary: str,
    all_turns: str,
    *,
    prior_plan_markdown: str | None = None,
) -> PlanSpec:
    system = "You are a planning writer for agentic software. Return JSON only. Use checklist items with done: false."
    prior = (prior_plan_markdown or "").strip()
    prior_block = (
        f"## Prior plan (revise — user asked for improvements; keep what still applies)\n{prior[:24_000]}"
        if prior
        else "## Prior plan\n_(none — first version)_"
    )
    user = f"""Create an implementation plan as JSON.

{plan_spec_json_schema_hint()}

## User request
{user_brief}

{prior_block}

## Research
{research_brief}

## Synthesized alignment
{syn_summary}

## Council detail
{all_turns[:14_000]}

Be specific: file paths, phases, and acceptance-relevant details.
"""
    raw = await complete_structured_json(settings, system, user, model=model)
    return PlanSpec.from_llm_dict(raw)


def _turns_to_summary(agent_turns: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"R{t.get('round')}-{t.get('agent_id')}: {t.get('reaction')}\n  note: {t.get('planner_note')}"
        for t in agent_turns
    )


def _turns_to_transcript(agent_turns: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        f"### R{t['round']} {t['name']}\n{t['reaction']}\n**Planner note:**\n{t['planner_note']}"
        for t in agent_turns
    )


async def _orchestrate_discussion_loop(
    settings: Settings,
    s: CouncilSession,
    council: CouncilConfigFile,
    debaters: list[AgentDef],
    orch: AgentDef,
    *,
    extra_transcript_prefix: str = "",
) -> AsyncIterator[dict[str, Any]]:
    max_steps = max(6, settings.orchestration_max_steps)
    recent_keys: list[str] = []

    step_n = 0
    while True:
        step_n += 1
        if step_n > max_steps:
            yield {
                "type": "phase",
                "phase": SessionPhase.discussion.value,
                "message": "Orchestration step limit reached; wrapping up.",
            }
            if not debaters:
                s.skip_implementation_plan = True
            break

        transcript = (
            extra_transcript_prefix + "\n" + _turns_to_summary(s.agent_turns)
        ).strip()
        raw = await _orchestrator_decide(
            settings,
            orch,
            s.model,
            council_prompt_brief(s),
            s.research_brief,
            transcript,
            debaters,
            council.synthesizer is not None,
            s.synthesizer_ran,
            step_n,
            max_steps,
            council,
        )
        action, agent_ids, questions, reason = _normalize_orch_decision(
            raw,
            debaters,
            s.agent_turns,
            council.synthesizer is not None,
            s.synthesizer_ran,
            settings.orchestration_max_parallel_agents,
        )
        key = f"{action}:{','.join(sorted(agent_ids))}"
        recent_keys.append(key)
        if len(recent_keys) > 12:
            recent_keys.pop(0)
        orch_reply_stuck = (
            len(recent_keys) >= 3
            and len(set(recent_keys[-3:])) == 1
            and recent_keys[-1].startswith("orchestrator_reply:")
        )
        if orch_reply_stuck:
            action = "orchestrator_done"
            s.skip_implementation_plan = True
            agent_ids = []
            reason = "(auto: stopping repeated orchestrator_reply)"
        elif len(recent_keys) >= 6 and len(set(recent_keys[-6:])) == 1:
            if not debaters:
                action = "orchestrator_done"
                s.skip_implementation_plan = True
                agent_ids = []
                reason = "(auto: breaking orchestration loop)"
            else:
                action = "ready_for_plan"
                agent_ids = []
                reason = "(auto: breaking decision loop)"

        yield {
            "type": "orchestrator",
            "action": action,
            "reason": reason,
            "agent_ids": agent_ids,
            "step": step_n,
        }

        if action == "ask_user":
            qs = _dedupe_qs(questions)[:3]
            if not qs:
                qs = [
                    "What is the most important constraint or scope decision "
                    "we should lock before planning?"
                ]
            s.last_consolidated_questions = qs
            s.pending_user_questions = qs
            s.phase = SessionPhase.awaiting_user
            yield {"type": "awaiting_user", "questions": qs}
            s.messages.append(
                ChatMessage(
                    role="assistant",
                    content="The orchestrator needs your input:\n"
                    + "\n".join(f"- {q}" for q in qs),
                    agent_id="orchestrator",
                    agent_name="Orchestrator",
                    meta={"questions": qs, "action": "ask_user"},
                )
            )
            return

        if action == "orchestrator_done":
            s.skip_implementation_plan = True
            break

        if action == "orchestrator_reply":
            reply = (
                await _orchestrator_reply_text(
                    settings,
                    orch,
                    s.model,
                    council_prompt_brief(s),
                    s.research_brief,
                    transcript,
                )
            ).strip()
            if reply:
                s.messages.append(
                    ChatMessage(
                        role="assistant",
                        content=reply,
                        agent_id=orch.id,
                        agent_name=orch.name,
                        meta={"action": "orchestrator_reply"},
                    )
                )
                yield {"type": "orchestrator_reply", "content": reply}
                # Orchestrator-only: one assistant reply completes the turn (model often
                # re-picks orchestrator_reply instead of orchestrator_done).
                if not debaters:
                    s.skip_implementation_plan = True
                    break
            continue

        if action == "run_research":
            await _run_web_research_phase(settings, s)
            s.messages.append(
                ChatMessage(
                    role="assistant",
                    content=s.research_brief,
                    agent_id="system",
                    agent_name="Research",
                    meta={"sources": s.research_sources, "trigger": "orchestrator"},
                )
            )
            yield {
                "type": "research",
                "brief": s.research_brief,
                "sources": s.research_sources,
            }
            continue

        if action == "ready_for_plan":
            break

        if action == "call_synthesizer":
            async for ev in _run_synthesizer_step(settings, s, council):
                yield ev
            continue

        if action == "call_agents":
            agents_to_run = [
                ag for i in agent_ids if (ag := _debater_by_id(debaters, i)) is not None
            ]
            if not agents_to_run:
                continue
            s.discussion_round += 1
            r = s.discussion_round
            tasks = [
                _agent_turn(
                    settings,
                    ag,
                    s.model,
                    council_prompt_brief(s),
                    s.research_brief,
                    transcript,
                    r,
                    "",
                )
                for ag in agents_to_run
            ]
            turns = await asyncio.gather(*tasks)
            for ag, turn in zip(agents_to_run, turns):
                uq_s = turn.get("user_question")
                rec: dict[str, Any] = {
                    "round": r,
                    "agent_id": ag.id,
                    "name": ag.name,
                    "reaction": turn.get("reaction", ""),
                    "planner_note": turn.get("planner_note", ""),
                    "user_question": uq_s,
                }
                s.agent_turns.append(rec)
                s.messages.append(
                    ChatMessage(
                        role="assistant",
                        content=turn.get("reaction", ""),
                        agent_id=ag.id,
                        agent_name=ag.name,
                        meta={
                            "planner_note": rec["planner_note"],
                            "round": r,
                            "user_question": uq_s,
                            "parallel_batch": True,
                        },
                    )
                )
                yield {
                    "type": "agent",
                    "round": r,
                    "agent_id": ag.id,
                    "name": ag.name,
                    "reaction": turn.get("reaction", ""),
                    "planner_note": turn.get("planner_note", ""),
                    "user_question": uq_s,
                }

    if s.phase == SessionPhase.awaiting_user:
        return
    async for ev in _run_synthesizer_step(settings, s, council):
        yield ev


async def run_council_pipeline(
    settings: Settings,
    _store: SessionStore,
    session: CouncilSession,
    user_message: str,
    council: CouncilConfigFile,
    *,
    continue_from_plan: bool = False,
) -> AsyncIterator[dict[str, Any]]:
    s = session
    s.error_message = None
    s.skip_implementation_plan = False
    debaters = council.debating_agents
    orch = effective_orchestrator(council)

    try:
        if s.phase == SessionPhase.awaiting_user:
            s.messages.append(ChatMessage(role="user", content=user_message))
            s.user_answered_clarification = True
            s.pending_user_questions = []
            s.phase = SessionPhase.discussion
            extra = f"\n[User clarification]\n{user_message}\n"
            yield {
                "type": "phase",
                "phase": SessionPhase.discussion.value,
                "message": "Resuming after your input",
            }
            async for ev in _orchestrate_discussion_loop(
                settings,
                s,
                council,
                debaters,
                orch,
                extra_transcript_prefix=extra,
            ):
                yield ev
            if s.phase == SessionPhase.awaiting_user:
                return
        else:
            if continue_from_plan:
                s.plan_iteration_message = user_message.strip()
                s.messages.append(
                    ChatMessage(
                        role="user",
                        content=user_message.strip(),
                        meta={"kind": "plan_iteration"},
                    )
                )
                s.agent_turns = []
                s.user_answered_clarification = False
                s.last_consolidated_questions = []
                s.synthesizer_ran = False
                s.last_synth_summary = ""
                s.discussion_round = 0
                s.phase = SessionPhase.discussion
                yield {
                    "type": "phase",
                    "phase": SessionPhase.discussion.value,
                    "message": "Continuing session — routing next step with your new input",
                }
            else:
                s.plan_iteration_message = ""
                s.user_brief = user_message.strip()
                if not (s.title or "").strip():
                    s.title = (s.user_brief.split("\n")[0].strip() or "New plan")[:80]
                s.messages.append(ChatMessage(role="user", content=s.user_brief))
                s.agent_turns = []
                s.user_answered_clarification = False
                if (s.plan_markdown or "").strip():
                    archive_current_plan(s, "before_new_run")
                s.plan_markdown = ""
                s.last_consolidated_questions = []
                s.synthesizer_ran = False
                s.last_synth_summary = ""
                s.discussion_round = 0

                s.research_sources = []
                s.research_brief = RESEARCH_PENDING_PLACEHOLDER
                s.phase = SessionPhase.discussion
                yield {
                    "type": "phase",
                    "phase": SessionPhase.discussion.value,
                    "message": "Orchestrator routing — choosing the next step",
                }
            async for ev in _orchestrate_discussion_loop(
                settings, s, council, debaters, orch
            ):
                yield ev
            if s.phase == SessionPhase.awaiting_user:
                return

    except Exception as e:  # noqa: BLE001
        s.phase = SessionPhase.error
        s.error_message = str(e)
        yield {"type": "error", "message": str(e)}
        return

    if s.phase == SessionPhase.awaiting_user:
        return

    if s.skip_implementation_plan:
        s.phase = SessionPhase.done
        s.plan_iteration_message = ""
        yield {"type": "done"}
        return

    try:
        all_turns_txt = _turns_to_transcript(s.agent_turns)
        syn_text = (
            (s.last_synth_summary or "").strip()
            if council.synthesizer
            else "No synthesizer; see council detail."
        )
        if council.synthesizer and not syn_text:
            syn_text = "No synthesizer; see council detail."

        s.phase = SessionPhase.plan
        yield {
            "type": "phase",
            "phase": SessionPhase.plan.value,
            "message": "Writing plan.md",
        }
        prior_md: str | None = None
        if (getattr(s, "plan_iteration_message", None) or "").strip() and s.plan_versions:
            prior_md = str(s.plan_versions[-1].get("markdown") or "").strip() or None
        spec = await _plan_writer(
            settings,
            s.model,
            council_prompt_brief(s),
            s.research_brief,
            syn_text,
            all_turns_txt,
            prior_plan_markdown=prior_md,
        )
        s.plan_markdown = render_plan_md(spec)
        s.plan_filename = _filename_from_title(spec.title)
        s.plan_iteration_message = ""
        s.phase = SessionPhase.done
        s.messages.append(
            ChatMessage(
                role="assistant",
                content="`plan.md` is ready. Download below.",
                agent_id="planner",
                agent_name="Planner",
                meta={"filename": s.plan_filename},
            )
        )
        yield {
            "type": "plan",
            "content": s.plan_markdown,
            "filename": s.plan_filename,
            "plan_versions": list(getattr(s, "plan_versions", None) or []),
        }
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001
        s.phase = SessionPhase.error
        s.error_message = str(e)
        yield {"type": "error", "message": str(e)}
