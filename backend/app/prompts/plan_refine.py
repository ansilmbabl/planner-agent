"""Instructions appended when editing the session primary output after the main council run."""

PLAN_REFINE_USER_SUFFIX = """
Output requirements:
- Return ONLY the full revised document as Markdown (one document).
- Preserve useful structure (headings, tables, lists) unless the user asked to change it.
- Do not add a preamble like "Here is the revised document" or wrap the entire document in a fenced code block.
- If the user selected an excerpt, treat that passage as the focus of edits while keeping the rest consistent.
""".strip()
