from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any

from .council_config import AgentDef, CouncilConfigFile
from .config import Settings
from .llm import (
    ChatMsg,
    _msg_system,
    _msg_user,
    complete_chat,
    complete_structured_json,
)
from .plan_model import PlanSpec, plan_spec_json_schema_hint
from .plan_render import render_plan_md
from .session import ChatMessage, CouncilSession, SessionPhase, SessionStore
from .tools.fetch_url import fetch_url_text
from .tools.search import ddg_search

AGENT_TURN_SCHEMA = """
Return JSON only:
{
  "reaction": "string (short; reference other agents in this round when present)",
  "user_question": "string or null (at most one blocking question, else null)",
  "planner_note": "string (bullets for the final plan)"
}
""".strip()


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


def _search_only(settings: Settings, queries: list[str]) -> list[dict[str, str]]:
    all_rows: list[dict[str, str]] = []
    for q in queries[: settings.research_max_queries]:
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
) -> PlanSpec:
    system = "You are a planning writer for agentic software. Return JSON only. Use checklist items with done: false."
    user = f"""Create an implementation plan as JSON.

{plan_spec_json_schema_hint()}

## User request
{user_brief}

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


async def run_council_pipeline(
    settings: Settings,
    _store: SessionStore,
    session: CouncilSession,
    user_message: str,
    council: CouncilConfigFile,
) -> AsyncIterator[dict[str, Any]]:
    s = session
    s.error_message = None
    debaters = council.debating_agents
    if not debaters:
        s.phase = SessionPhase.error
        s.error_message = "No debating agents in council config"
        yield {"type": "error", "message": s.error_message}
        return

    try:
        # --- Awaiting user: run round 2 only, then plan ---
        if s.phase == SessionPhase.awaiting_user:
            s.messages.append(ChatMessage(role="user", content=user_message))
            s.user_answered_clarification = True
            s.pending_user_questions = []
            answer_ctx = f"\n[User answered clarification]\n{user_message}\n"
            prior_summary = _turns_to_summary(s.agent_turns) + answer_ctx
            s.phase = SessionPhase.discussion
            r = 2
            s.discussion_round = r
            yield {"type": "phase", "phase": SessionPhase.discussion.value, "round": r, "message": f"Round {r} (post-clarification)"}
            same_round = ""
            for ag in debaters:
                turn = await _agent_turn(
                    settings,
                    ag,
                    s.model,
                    s.user_brief,
                    s.research_brief,
                    prior_summary,
                    r,
                    same_round,
                )
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
                        meta={"planner_note": rec["planner_note"], "round": r, "user_question": uq_s},
                    )
                )
                same_round += f"### {ag.name}\n{turn.get('reaction', '')}\n"
                prior_summary = _turns_to_summary(s.agent_turns) + answer_ctx
                yield {
                    "type": "agent",
                    "round": r,
                    "agent_id": ag.id,
                    "name": ag.name,
                    "reaction": turn.get("reaction", ""),
                    "planner_note": turn.get("planner_note", ""),
                    "user_question": uq_s,
                }
        else:
            # --- New problem: set brief, research, round 1 ---
            s.user_brief = user_message.strip()
            if not (s.title or "").strip():
                s.title = (s.user_brief.split("\n")[0].strip() or "New plan")[:80]
            s.messages.append(ChatMessage(role="user", content=s.user_brief))
            s.agent_turns = []
            s.user_answered_clarification = False
            s.plan_markdown = ""
            s.last_consolidated_questions = []

            yield {"type": "phase", "phase": SessionPhase.research.value}
            sp = await _generate_search_plan(settings, s.user_brief, s.model)
            qlist = [str(x) for x in (sp.get("queries") or []) if str(x).strip()][: settings.research_max_queries]
            if not qlist and s.user_brief.strip():
                first = s.user_brief.strip().split("\n", 1)[0].strip()[:200]
                qlist = [first] if first else []
            urls = [str(u) for u in (sp.get("urls_to_fetch") or []) if str(u).strip().lower().startswith("http")][:2]

            sources = _search_only(settings, qlist) if qlist else []
            fetches: list[dict[str, Any]] = []
            for u in urls:
                fetches.append(await fetch_url_text(u, settings))
            s.research_sources = [
                {"title": r.get("title", ""), "href": r.get("href", ""), "body": (r.get("body", "") or "")[:400]}
                for r in sources
            ]
            s.research_brief = await _summarize_research(
                settings, s.user_brief, sources, fetches, s.model
            )
            s.messages.append(
                ChatMessage(
                    role="assistant",
                    content=s.research_brief,
                    agent_id="system",
                    agent_name="Research",
                    meta={"sources": s.research_sources},
                )
            )
            yield {
                "type": "research",
                "brief": s.research_brief,
                "sources": s.research_sources,
            }

            s.phase = SessionPhase.discussion
            prior_summary = ""
            r = 1
            s.discussion_round = r
            yield {"type": "phase", "phase": SessionPhase.discussion.value, "round": r, "message": f"Round {r}"}
            same_round = ""
            for ag in debaters:
                turn = await _agent_turn(
                    settings,
                    ag,
                    s.model,
                    s.user_brief,
                    s.research_brief,
                    prior_summary,
                    r,
                    same_round,
                )
                uq_s = turn.get("user_question")
                rec = {
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
                        meta={"planner_note": rec["planner_note"], "round": r, "user_question": uq_s},
                    )
                )
                same_round += f"### {ag.name}\n{turn.get('reaction', '')}\n"
                prior_summary = _turns_to_summary(s.agent_turns)
                yield {
                    "type": "agent",
                    "round": r,
                    "agent_id": ag.id,
                    "name": ag.name,
                    "reaction": turn.get("reaction", ""),
                    "planner_note": turn.get("planner_note", ""),
                    "user_question": uq_s,
                }

            qs: list[str] = []
            for t in s.agent_turns:
                if t.get("round") == 1 and t.get("user_question"):
                    qs.append(str(t["user_question"]))
            qs = _dedupe_qs(qs)
            if qs and not s.user_answered_clarification:
                s.last_consolidated_questions = qs
                s.pending_user_questions = qs
                s.phase = SessionPhase.awaiting_user
                yield {"type": "awaiting_user", "questions": qs}
                s.messages.append(
                    ChatMessage(
                        role="assistant",
                        content="A few quick clarifications would help:\n" + "\n".join(f"- {q}" for q in qs),
                        agent_id="facilitator",
                        agent_name="Facilitator",
                        meta={"questions": qs},
                    )
                )
                return

            # No blocking questions after round 1: second discussion round, then plan
            r2 = 2
            s.discussion_round = r2
            s.phase = SessionPhase.discussion
            yield {
                "type": "phase",
                "phase": SessionPhase.discussion.value,
                "round": r2,
                "message": f"Round {r2}",
            }
            prior = _turns_to_summary(s.agent_turns)
            same2 = ""
            for ag in debaters:
                turn2 = await _agent_turn(
                    settings,
                    ag,
                    s.model,
                    s.user_brief,
                    s.research_brief,
                    prior,
                    r2,
                    same2,
                )
                uq2 = turn2.get("user_question")
                rec2: dict[str, Any] = {
                    "round": r2,
                    "agent_id": ag.id,
                    "name": ag.name,
                    "reaction": turn2.get("reaction", ""),
                    "planner_note": turn2.get("planner_note", ""),
                    "user_question": uq2,
                }
                s.agent_turns.append(rec2)
                s.messages.append(
                    ChatMessage(
                        role="assistant",
                        content=turn2.get("reaction", ""),
                        agent_id=ag.id,
                        agent_name=ag.name,
                        meta={"planner_note": rec2["planner_note"], "round": r2, "user_question": uq2},
                    )
                )
                same2 += f"### {ag.name}\n{turn2.get('reaction', '')}\n"
                prior = _turns_to_summary(s.agent_turns)
                yield {
                    "type": "agent",
                    "round": r2,
                    "agent_id": ag.id,
                    "name": ag.name,
                    "reaction": turn2.get("reaction", ""),
                    "planner_note": turn2.get("planner_note", ""),
                    "user_question": uq2,
                }

    except Exception as e:  # noqa: BLE001
        s.phase = SessionPhase.error
        s.error_message = str(e)
        yield {"type": "error", "message": str(e)}
        return

    # Synthesizer + plan
    try:
        all_turns_txt = _turns_to_transcript(s.agent_turns)
        syn = council.synthesizer
        syn_text = "No synthesizer; see council detail."
        s.phase = SessionPhase.plan
        yield {"type": "phase", "phase": SessionPhase.plan.value, "message": "Synthesizing"}
        if syn:
            syn_text = await _synthesizer(
                settings,
                syn,
                s.model,
                s.user_brief,
                s.research_brief,
                all_turns_txt,
            )
            s.messages.append(
                ChatMessage(
                    role="assistant",
                    content=syn_text,
                    agent_id="synthesizer",
                    agent_name=syn.name,
                )
            )
            yield {"type": "synth", "summary": syn_text}

        yield {"type": "phase", "phase": SessionPhase.plan.value, "message": "Writing plan.md"}
        spec = await _plan_writer(
            settings,
            s.model,
            s.user_brief,
            s.research_brief,
            syn_text,
            all_turns_txt,
        )
        s.plan_markdown = render_plan_md(spec)
        s.plan_filename = _filename_from_title(spec.title)
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
        }
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001
        s.phase = SessionPhase.error
        s.error_message = str(e)
        yield {"type": "error", "message": str(e)}
