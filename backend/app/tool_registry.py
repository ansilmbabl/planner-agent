"""Registered specialist-agent tools (extensible; keep ids stable in council JSON)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .council_config import AgentDef


@dataclass(frozen=True)
class AgentToolDefinition:
    id: str
    name: str
    description: str


# ids are API / JSON stable; add new tools here and document in Settings → Tools.
AGENT_TOOLS: tuple[AgentToolDefinition, ...] = (
    AgentToolDefinition(
        id="web_search",
        name="Web search",
        description=(
            "Search the public web via the app’s research provider (DuckDuckGo or Tavily). "
            "Useful when the research brief is thin or you need fresh queries the orchestrator did not run."
        ),
    ),
    AgentToolDefinition(
        id="fetch_url",
        name="Fetch URL",
        description=(
            "Retrieve plain text from specific https URLs for verification or quotes. "
            "Respects server size and timeout limits."
        ),
    ),
)

_ALL_IDS: frozenset[str] = frozenset(t.id for t in AGENT_TOOLS)
_BY_ID: dict[str, AgentToolDefinition] = {t.id: t for t in AGENT_TOOLS}


def all_agent_tool_ids() -> frozenset[str]:
    return _ALL_IDS


def tool_definitions_for_api() -> list[dict[str, str]]:
    return [{"id": t.id, "name": t.name, "description": t.description} for t in AGENT_TOOLS]


def effective_agent_tool_ids(agent: AgentDef) -> list[str]:
    """Tools exposed to this agent in prompts; empty means none."""
    if not agent.tools_enabled:
        return []
    raw = [str(x).strip() for x in (agent.tool_ids or []) if str(x).strip()]
    if not raw:
        return sorted(_ALL_IDS)
    known = [x for x in raw if x in _ALL_IDS]
    return sorted(frozenset(known))


def agent_tools_system_section(tool_ids: list[str]) -> str:
    """Markdown block appended to specialist system prompts (see orchestrator._agent_turn)."""
    if not tool_ids:
        return (
            "## Agent tools\n"
            "No external lookup tools are enabled for this role. Rely on the **Research brief**, "
            "prior rounds, and the user’s request."
        )
    lines = [
        "## Agent tools",
        "Capabilities **enabled for this role** (describe use in reasoning; orchestrator-driven research may already cover some needs):",
    ]
    for tid in tool_ids:
        d = _BY_ID.get(tid)
        if not d:
            continue
        lines.append(f"- **{d.name}** (`{d.id}`): {d.description}")
    lines.append(
        "If a capability is not listed here, do not assume you can invoke it; stay within context above."
    )
    return "\n".join(lines)
