from __future__ import annotations

AGENT_TURN_SCHEMA = """
Return JSON only:
{
  "reaction": "string (short; reference other agents in this round when present)",
  "user_question": "string or null (at most one blocking question, else null)",
  "planner_note": "string (bullets for the final plan)"
}
""".strip()
