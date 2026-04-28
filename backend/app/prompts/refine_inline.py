"""Defaults for Settings UI → “Refine with model” (POST /api/refine-prompt).

The user message template must include these placeholders literally:
  {{LABEL}}           — where the prompt is used (e.g. orchestrator system)
  {{CURRENT_PROMPT}} — existing field text (may be empty)
  {{INSTRUCTION}}    — user tweaks or the default polish instruction
"""

REFINE_PROMPT_SYSTEM = """You rewrite system prompts and instruction blocks for other LLMs.
Your reply MUST contain NOTHING except these three parts in order:
1) The exact line: <<<PROMPT_START>>>
2) The full replacement prompt text (plain text only)
3) The exact line: <<<PROMPT_END>>>
Do not repeat the old prompt as a quote. Do not add commentary, headings, or markdown fences.
Do not echo section labels like USER REQUEST or CURRENT TEXT.
Inside the markers there must be only the final prompt the app will store."""

REFINE_PROMPT_USER_TEMPLATE = """Role / where this text is used: {{LABEL}}

<previous_prompt>
{{CURRENT_PROMPT}}
</previous_prompt>

<change_request>
{{INSTRUCTION}}
</change_request>

Produce the single revised prompt between <<<PROMPT_START>>> and <<<PROMPT_END>>> as instructed."""

REFINE_PROMPT_DEFAULT_INSTRUCTION = (
    "Polish for clarity and impact; keep the same role, intent, and hard constraints. "
    "Tighten wording; remove redundancy; do not add unrelated requirements."
)
