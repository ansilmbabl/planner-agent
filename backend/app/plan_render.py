from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from .plan_model import PlanSpec

_TEMPLATE_NAME = "plan.md.j2"


def _template_dir() -> Path:
    return Path(__file__).resolve().parent / "templates"


def render_plan_md(spec: PlanSpec) -> str:
    env = Environment(
        loader=FileSystemLoader(str(_template_dir())),
        autoescape=select_autoescape(enabled_extensions=()),
    )
    tpl = env.get_template(_TEMPLATE_NAME)
    return tpl.render(spec=spec).strip() + "\n"
