from __future__ import annotations

import json
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .council_config import (
    CouncilConfigFile,
    ReferenceUrl,
    load_council_config,
    save_council_config,
)
from .councils import (
    delete_council,
    ensure_default_council_file,
    list_council_ids,
    load_council,
    new_orchestrator_only_council,
    validate_council_id,
)
from .council_versions import (
    add_council_version,
    delete_all_versions_for_council,
    delete_council_version,
    list_council_versions,
    load_council_version,
    save_council_with_backup,
    validate_version_id,
    write_council_without_backup,
)
from .council_bootstrap import (
    apply_council_bootstrap_patch,
    parse_bootstrap_llm_json,
    roster_json_for_prompt,
)
from .config import Settings, get_settings
from .tool_registry import tool_definitions_for_api
from .llm import (
    _msg_system,
    _msg_user,
    complete_chat,
    ollama_list_models,
    ollama_reachable,
)
from .orchestrator import run_council_pipeline
from .plan_refine import run_plan_refine
from .session import CouncilSession, SessionPhase, archive_current_plan
from .db import make_engine
from .session_persistence import DatabaseSessionStore, migrate_json_dir_to_db
from .user_preferences import load_preferences, save_preferences
from .prompt_catalog import (
    PIPELINE_PROMPT_META,
    format_council_bootstrap_user_template,
    format_refine_prompt_user_template,
    get_prompt,
    list_prompts_for_api,
    reset_prompt_overrides,
    save_prompt_override,
)

log = logging.getLogger(__name__)

_settings = get_settings()
_engine = make_engine(_settings.sqlite_path)
migrate_json_dir_to_db(_engine, _settings.sessions_data_dir)
store = DatabaseSessionStore(_engine)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    s = get_settings()
    ensure_default_council_file(s.councils_dir, s.council_config_path)
    p = s.councils_dir / "default.json"
    if not p.is_file() and s.council_config_path.is_file():
        p = s.council_config_path
    if p.is_file():
        try:
            load_council_config(p)
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Could not read council at %s: %s", p, e)
    else:
        log.warning(
            "No council config; add config/councils/default.json (or config/council.json for legacy default)."
        )
    yield


app = FastAPI(
    title="Planner Council API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:3000", "http://localhost:3000", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateSessionBody(BaseModel):
    model: str | None = Field(default=None, description="Ollama or provider model name")
    council_id: str = Field(
        default="default",
        description="Agent council (file config/councils/{id}.json)",
    )


class PostMessageBody(BaseModel):
    content: str
    model: str | None = None
    intent: Literal["new_run", "continue_plan"] = "new_run"


class RefinePlanBody(BaseModel):
    instruction: str = Field(..., min_length=1, description="What to change or improve in the plan")
    selection: str | None = Field(
        default=None,
        description="Optional excerpt from the plan to focus edits on",
    )
    agent_ids: list[str] = Field(
        default_factory=list,
        description='Ids to draw system prompts from: orchestrator id and council agent ids',
    )
    model: str | None = None


class PatchSessionBody(BaseModel):
    council_id: str | None = Field(
        default=None,
        description="Agent council for subsequent messages (config/councils/{id}.json)",
    )
    reference_urls: list[ReferenceUrl] | None = Field(
        default=None,
        description="Per-chat URLs to fetch into the research / context brief (same area as web search results).",
    )


class BuiltinPromptPutBody(BaseModel):
    key: str = Field(..., min_length=1)
    content: str = Field(default="", description="Empty string clears override for this key")


class RefinePromptBody(BaseModel):
    current_prompt: str = Field(default="", description="Existing text to improve or replace")
    instruction: str | None = Field(
        default=None,
        description="Optional tweaks; omit or empty for an automatic clarity pass",
    )
    context_label: str | None = Field(
        default=None,
        description="Short label for the model, e.g. orchestrator system",
    )
    model: str | None = Field(default=None, description="LLM id; default from provider settings if empty")


class PreferencesBody(BaseModel):
    research_provider: Literal["duckduckgo", "tavily"] | None = None
    tavily_api_key: str | None = Field(
        default=None,
        description="Stored API key for Tavily; empty string clears the stored override",
    )


class BulkDeleteSessionsBody(BaseModel):
    ids: list[str] = Field(..., min_length=1)


def _require_council_for_id(council_id: str) -> CouncilConfigFile:
    st = get_settings()
    try:
        return load_council(council_id, st.councils_dir, st.council_config_path)
    except FileNotFoundError as e:
        raise HTTPException(404, f"Unknown or missing council: {council_id!r}") from e
    except (OSError, json.JSONDecodeError) as e:
        raise HTTPException(500, f"Invalid council config: {e}") from e


async def _resolve_session_model_any(s: CouncilSession, model: str | None) -> str:
    settings = get_settings()
    m = (model or s.model or "").strip()
    if m:
        s.model = m
        return m
    if settings.llm_provider == "ollama":
        names = await ollama_list_models(settings.ollama_base_url)
        s.model = names[0] if names else settings.ollama_model
    elif settings.llm_provider == "openai":
        s.model = settings.openai_model
    else:
        s.model = settings.anthropic_model
    return s.model


async def _resolve_session_model(s: CouncilSession, body: PostMessageBody) -> str:
    return await _resolve_session_model_any(s, body.model)


@app.get("/api/councils", response_model=None)
async def list_councils() -> dict[str, Any]:
    s = get_settings()
    ensure_default_council_file(s.councils_dir, s.council_config_path)
    return {"councils": list_council_ids(s.councils_dir, s.council_config_path)}


class CreateCouncilBody(BaseModel):
    id: str = Field(..., min_length=1, max_length=64, description="New file config/councils/{id}.json")
    from_id: str = Field(
        default="default",
        description='Template council to copy, or "none" for orchestrator-only starter (add agents in UI).',
    )
    display_name: str | None = Field(
        default=None,
        max_length=200,
        description="Human-readable name stored in the council JSON (optional).",
    )
    notes: str | None = Field(default=None, max_length=12000)
    tags: list[str] = Field(default_factory=list, max_length=48)
    area: str | None = Field(default=None, max_length=500)
    autofill_prompts: bool = Field(
        default=False,
        description="If true, call the configured LLM to draft orchestrator and specialist system prompts.",
    )
    model: str | None = Field(
        default=None,
        description="Model id for autofill; provider default if omitted.",
    )

    @field_validator("tags", mode="before")
    @classmethod
    def _normalize_create_tags(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for x in v:
            if not isinstance(x, str):
                continue
            s = x.strip()[:80]
            if s:
                out.append(s)
            if len(out) >= 48:
                break
        return out


class RegenerateCouncilBody(BaseModel):
    model: str | None = Field(
        default=None,
        description="Model id for council bootstrap; provider default if omitted.",
    )


_NONE_TEMPLATE = frozenset({"", "none", "__none__"})


async def _autofill_new_council_prompts(
    cfg: CouncilConfigFile,
    *,
    council_id: str,
    display_name: str,
    notes: str,
    tags: list[str],
    area: str,
    template_label: str,
    model: str | None,
) -> tuple[bool, str | None]:
    try:
        s = get_settings()
        data_dir = s.sqlite_path.parent
        sys_p = get_prompt("council_bootstrap_system", data_dir)
        user_tpl = get_prompt("council_bootstrap_user_template", data_dir)
        if not (sys_p or "").strip():
            return False, "council_bootstrap_system prompt is empty"
        roster = roster_json_for_prompt(cfg)
        user_msg = format_council_bootstrap_user_template(
            user_tpl,
            council_id=council_id,
            display_name=display_name,
            notes=notes,
            tags=tags,
            area=area,
            template_source=template_label,
            roster_json=roster,
        )
        text = await complete_chat(
            s,
            [_msg_system(sys_p), _msg_user(user_msg)],
            model=model,
            temperature=0.25,
        )
        data = parse_bootstrap_llm_json(text)
        apply_council_bootstrap_patch(cfg, data)
        return True, None
    except Exception as e:
        log.warning("Council prompt autofill failed: %s", e)
        return False, str(e)


@app.post("/api/councils", response_model=None)
async def create_council(body: CreateCouncilBody) -> dict[str, Any]:
    s = get_settings()
    new_id = body.id.strip()
    raw_from = (body.from_id or "default").strip()
    use_orchestrator_only = raw_from.lower() in _NONE_TEMPLATE
    from_id = "default" if use_orchestrator_only else (raw_from or "default")
    if not validate_council_id(new_id):
        raise HTTPException(
            400,
            "Invalid id: use letters, numbers, _ or - only (1–64 chars, must start with letter or number)",
        )
    if not use_orchestrator_only:
        if not validate_council_id(from_id):
            raise HTTPException(400, "Invalid from_id")
        if new_id == from_id:
            raise HTTPException(400, "New id must differ from template from_id")
    target = s.councils_dir / f"{new_id}.json"
    if target.is_file():
        raise HTTPException(409, f"Council {new_id!r} already exists")
    try:
        if use_orchestrator_only:
            template = new_orchestrator_only_council()
            template_label = "none_orchestrator_only"
        else:
            template = load_council(from_id, s.councils_dir, s.council_config_path)
            template_label = from_id
    except FileNotFoundError as e:
        raise HTTPException(404, f"Template council not found: {from_id!r}") from e

    dn = (body.display_name or "").strip() or None
    notes_meta = (body.notes or "").strip() or None
    area_meta = (body.area or "").strip() or None
    template.display_name = dn
    template.notes = notes_meta
    template.tags = list(body.tags or [])
    template.area = area_meta

    autofill_applied = False
    autofill_error: str | None = None
    if body.autofill_prompts:
        label_for_llm = dn or new_id
        autofill_applied, autofill_error = await _autofill_new_council_prompts(
            template,
            council_id=new_id,
            display_name=label_for_llm,
            notes=notes_meta or "",
            tags=list(body.tags or []),
            area=area_meta or "",
            template_label=template_label,
            model=(body.model or "").strip() or None,
        )

    try:
        p = save_council_with_backup(
            new_id,
            s.councils_dir,
            s.council_config_path,
            template,
            s.sqlite_path.parent,
            backup_label="Initial council file",
        )
    except OSError as e:
        log.error("Could not create council file: %s", e)
        raise HTTPException(500, f"Could not create council: {e}") from e
    out: dict[str, Any] = {"status": "ok", "id": new_id, "path": str(p)}
    if body.autofill_prompts:
        out["autofill_applied"] = autofill_applied
        if autofill_error:
            out["autofill_error"] = autofill_error
    return out


@app.get("/api/councils/{council_id}", response_model=None)
async def get_council_by_id(council_id: str) -> dict[str, Any]:
    if not validate_council_id(council_id.strip() or ""):
        raise HTTPException(400, "Invalid council_id")
    c = _require_council_for_id(council_id)
    return c.model_dump(mode="json")


@app.put("/api/councils/{council_id}", response_model=None)
async def put_council_by_id(
    council_id: str, body: CouncilConfigFile
) -> dict[str, str]:
    s = get_settings()
    if not validate_council_id(council_id.strip() or ""):
        raise HTTPException(400, "Invalid council_id")
    try:
        p = save_council_with_backup(
            council_id.strip(),
            s.councils_dir,
            s.council_config_path,
            body,
            s.sqlite_path.parent,
            backup_label="Before save (editor)",
        )
    except OSError as e:
        log.error("Could not write council: %s", e)
        raise HTTPException(500, f"Could not save council: {e}") from e
    return {"status": "ok", "id": council_id, "path": str(p)}


@app.get("/api/councils/{council_id}/versions", response_model=None)
async def api_list_council_versions(council_id: str) -> dict[str, Any]:
    if not validate_council_id(council_id.strip() or ""):
        raise HTTPException(400, "Invalid council_id")
    try:
        rows = list_council_versions(get_settings().sqlite_path.parent, council_id.strip())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"versions": rows}


@app.delete("/api/councils/{council_id}/versions/{version_id}", response_model=None)
async def api_delete_council_version(council_id: str, version_id: str) -> dict[str, str]:
    s = get_settings()
    cid = council_id.strip()
    vid = version_id.strip()
    if not validate_council_id(cid):
        raise HTTPException(400, "Invalid council_id")
    if not validate_version_id(vid):
        raise HTTPException(400, "Invalid version_id")
    try:
        delete_council_version(s.sqlite_path.parent, cid, vid)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"status": "ok", "id": cid, "version_id": vid}


@app.post("/api/councils/{council_id}/versions/{version_id}/restore", response_model=None)
async def api_restore_council_version(council_id: str, version_id: str) -> dict[str, str]:
    s = get_settings()
    cid = council_id.strip()
    vid = version_id.strip()
    if not validate_council_id(cid):
        raise HTTPException(400, "Invalid council_id")
    if not validate_version_id(vid):
        raise HTTPException(400, "Invalid version_id")
    try:
        restored = load_council_version(s.sqlite_path.parent, cid, vid)
    except FileNotFoundError as e:
        raise HTTPException(404, f"Version not found: {vid!r}") from e
    current = _require_council_for_id(cid)
    add_council_version(
        s.sqlite_path.parent,
        cid,
        current,
        f"Before restore to {vid}",
    )
    try:
        p = write_council_without_backup(cid, s.councils_dir, s.council_config_path, restored)
    except OSError as e:
        raise HTTPException(500, f"Could not restore council: {e}") from e
    return {"status": "ok", "id": cid, "path": str(p), "restored_version": vid}


@app.post("/api/councils/{council_id}/regenerate", response_model=None)
async def api_regenerate_council_prompts(
    council_id: str,
    body: RegenerateCouncilBody = Body(default_factory=RegenerateCouncilBody),
) -> dict[str, Any]:
    s = get_settings()
    cid = council_id.strip()
    if not validate_council_id(cid):
        raise HTTPException(400, "Invalid council_id")
    cfg = _require_council_for_id(cid)
    data_dir = s.sqlite_path.parent
    add_council_version(data_dir, cid, cfg, "Before AI regenerate")
    work = cfg.model_copy(deep=True)
    dn = (work.display_name or "").strip() or cid
    notes_m = (work.notes or "").strip() or ""
    area_m = (work.area or "").strip() or ""
    tags_m = list(work.tags or [])
    autofill_applied, autofill_error = await _autofill_new_council_prompts(
        work,
        council_id=cid,
        display_name=dn,
        notes=notes_m,
        tags=tags_m,
        area=area_m,
        template_label="regenerate_existing",
        model=(body.model or "").strip() or None,
    )
    try:
        p = write_council_without_backup(cid, s.councils_dir, s.council_config_path, work)
    except OSError as e:
        raise HTTPException(500, f"Could not save council: {e}") from e
    out: dict[str, Any] = {
        "status": "ok",
        "id": cid,
        "path": str(p),
        "autofill_applied": autofill_applied,
    }
    if autofill_error:
        out["autofill_error"] = autofill_error
    return out


@app.delete("/api/councils/{council_id}", response_model=None)
async def delete_council_by_id(council_id: str) -> dict[str, str]:
    s = get_settings()
    ensure_default_council_file(s.councils_dir, s.council_config_path)
    if not validate_council_id(council_id.strip() or ""):
        raise HTTPException(400, "Invalid council_id")
    try:
        delete_council(council_id, s.councils_dir, s.council_config_path)
        delete_all_versions_for_council(s.sqlite_path.parent, (council_id or "").strip())
    except ValueError as e:
        raise HTTPException(400, str(e) or "cannot delete") from e
    except FileNotFoundError as e:
        raise HTTPException(404, f"Unknown council: {council_id!r}") from e
    except OSError as e:
        log.error("Could not delete council: %s", e)
        raise HTTPException(500, f"Could not delete council: {e}") from e
    return {"status": "ok", "id": (council_id or "").strip()}


@app.get("/api/council", response_model=None)
async def get_council() -> dict[str, Any]:
    """Backward compatible: same as GET /api/councils/default."""
    c = _require_council_for_id("default")
    return c.model_dump(mode="json")


@app.put("/api/council", response_model=None)
async def put_council(body: CouncilConfigFile) -> dict[str, str]:
    """Backward compatible: same as PUT /api/councils/default."""
    s = get_settings()
    try:
        p = save_council_with_backup(
            "default",
            s.councils_dir,
            s.council_config_path,
            body,
            s.sqlite_path.parent,
            backup_label="Before save (editor)",
        )
    except OSError as e:
        log.error("Could not write council config: %s", e)
        raise HTTPException(500, f"Could not save council config: {e}") from e
    return {"status": "ok", "path": str(p), "id": "default"}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    settings = get_settings()
    h: dict[str, Any] = {
        "status": "ok",
        "service": "planner-council",
        "llm_provider": settings.llm_provider,
    }
    if settings.llm_provider == "ollama":
        h["ollama"] = await ollama_reachable(settings.ollama_base_url)
    h["persistence"] = "sqlite"
    prefs = load_preferences(settings.sqlite_path.parent)
    rp = str(prefs.get("research_provider") or settings.research_provider or "duckduckgo")
    if rp not in ("duckduckgo", "tavily"):
        rp = "duckduckgo"
    tkey = str(prefs.get("tavily_api_key") or settings.tavily_api_key or "").strip()
    h["research"] = {
        "provider": rp,
        "tavily_ready": rp != "tavily" or bool(tkey),
    }
    return h


@app.get("/api/tools", response_model=None)
async def list_agent_tools() -> dict[str, Any]:
    """Stable ids + copy for Settings UI and council JSON tool_ids."""
    return {"tools": tool_definitions_for_api()}


@app.get("/api/preferences")
async def get_preferences_api() -> dict[str, Any]:
    s = get_settings()
    p = load_preferences(s.sqlite_path.parent)
    prov = str(p.get("research_provider") or s.research_provider or "duckduckgo")
    if prov not in ("duckduckgo", "tavily"):
        prov = "duckduckgo"
    fkey = str(p.get("tavily_api_key") or "").strip()
    ekey = str(s.tavily_api_key or "").strip()
    return {
        "research_provider": prov,
        "tavily_key_stored": bool(fkey),
        "tavily_key_from_env": bool(ekey),
    }


@app.put("/api/preferences")
async def put_preferences_api(body: PreferencesBody) -> dict[str, Any]:
    s = get_settings()
    raw = body.model_dump(exclude_unset=True)
    updates: dict[str, Any] = {}
    if "research_provider" in raw and raw["research_provider"] is not None:
        updates["research_provider"] = raw["research_provider"]
    if "tavily_api_key" in raw:
        v = raw["tavily_api_key"]
        if v is None:
            pass
        elif isinstance(v, str) and not v.strip():
            updates["tavily_api_key"] = None
        elif isinstance(v, str):
            updates["tavily_api_key"] = v.strip()
    save_preferences(s.sqlite_path.parent, updates)
    return await get_preferences_api()


@app.get("/api/builtin-prompts", response_model=None)
async def get_builtin_prompts() -> dict[str, Any]:
    s = get_settings()
    return {"prompts": list_prompts_for_api(s.sqlite_path.parent)}


@app.put("/api/builtin-prompts", response_model=None)
async def put_builtin_prompt(body: BuiltinPromptPutBody) -> dict[str, Any]:
    valid = {m["key"] for m in PIPELINE_PROMPT_META}
    if body.key not in valid:
        raise HTTPException(400, f"Unknown prompt key: {body.key!r}")
    if body.key == "refine_prompt_user_template":
        for needle in ("{{LABEL}}", "{{CURRENT_PROMPT}}", "{{INSTRUCTION}}"):
            if needle not in body.content:
                raise HTTPException(
                    400,
                    f"refine_prompt_user_template must contain placeholder {needle!r}",
                )
    s = get_settings()
    save_prompt_override(s.sqlite_path.parent, body.key, body.content)
    return {"status": "ok", "key": body.key}


@app.post("/api/builtin-prompts/reset", response_model=None)
async def post_builtin_prompts_reset() -> dict[str, Any]:
    s = get_settings()
    reset_prompt_overrides(s.sqlite_path.parent)
    return {"status": "ok", "prompts": list_prompts_for_api(s.sqlite_path.parent)}


def _strip_outer_fence(text: str) -> str:
    t = (text or "").strip()
    m = re.match(r"^```(?:\w+)?\s*\r?\n([\s\S]*?)\r?\n```\s*$", t)
    if m:
        return m.group(1).strip()
    return t


def _remove_section_echo_lines(text: str) -> str:
    """Drop lines that look like echoed template / section headers from sloppy completions."""
    noise = re.compile(
        r"^\s*-{3,}\s*(CURRENT\s+TEXT|USER\s+REQUEST|NEW\s+(TEXT|PROMPT)|UPDATED\s+PROMPT|"
        r"CHANGE\s+REQUEST|OUTPUT|REPLACEMENT|PREVIOUS\s+PROMPT)\s*-{3,}\s*$",
        re.IGNORECASE,
    )
    xmlish = re.compile(
        r"^\s*</?(previous_prompt|change_request|current_text|user_request)\s*/?>\s*$",
        re.IGNORECASE,
    )
    out: list[str] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if noise.match(s) or xmlish.match(s):
            continue
        if re.match(r"^#+\s*(Current|User|New|Updated|Output)\b", s, re.I):
            continue
        out.append(line)
    return "\n".join(out).strip()


def _extract_refined_prompt(raw: str) -> str | None:
    """Pull text between <<<PROMPT_START>>> and <<<PROMPT_END>>>; tolerate minor model mistakes."""
    t = _strip_outer_fence((raw or "").strip())
    if not t:
        return None
    full = re.search(
        r"<<<PROMPT_START>>>\s*(.*?)\s*<<<PROMPT_END>>>",
        t,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if full:
        inner = full.group(1).strip()
        return inner or None
    partial = re.search(
        r"<<<PROMPT_START>>>\s*(.*)",
        t,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if partial:
        rest = partial.group(1).strip()
        if "<<<PROMPT_END>>>" in rest:
            rest = rest.split("<<<PROMPT_END>>>", 1)[0].strip()
        rest = _remove_section_echo_lines(rest)
        rest = re.sub(
            r"^(?:here(?:'s| is)\s+)?(?:the\s+)?(?:updated|new|revised)\s+prompt\s*:[ \t]*\n?",
            "",
            rest,
            count=1,
            flags=re.IGNORECASE,
        ).strip()
        return rest or None
    loose = _remove_section_echo_lines(t)
    loose = re.sub(
        r"^(?:here(?:'s| is)\s+)?(?:the\s+)?(?:updated|new|revised)\s+prompt\s*:[ \t]*\n?",
        "",
        loose,
        count=1,
        flags=re.IGNORECASE,
    ).strip()
    if loose and "<<" not in loose:
        low = loose.lower()
        if (
            "</previous_prompt>" in low
            or "<change_request>" in low
            or "--- user request ---" in low
            or "--- current text ---" in low
        ):
            return None
        return loose
    return None


async def _resolve_refiner_model(settings: Settings, requested: str | None) -> str:
    m = (requested or "").strip()
    if m:
        return m
    if settings.llm_provider == "ollama":
        names = await ollama_list_models(settings.ollama_base_url)
        return names[0] if names else (settings.ollama_model or "").strip() or "llama3.2"
    if settings.llm_provider == "openai":
        return (settings.openai_model or "").strip() or "gpt-4o-mini"
    return (settings.anthropic_model or "").strip() or "claude-3-5-sonnet-20241022"


@app.post("/api/refine-prompt", response_model=None)
async def refine_prompt_api(body: RefinePromptBody) -> dict[str, Any]:
    settings = get_settings()
    data_dir = settings.sqlite_path.parent
    model = await _resolve_refiner_model(settings, body.model)
    label = (body.context_label or "prompt block").strip()
    ins = (body.instruction or "").strip()
    if not ins:
        ins = (get_prompt("refine_prompt_default_instruction", data_dir) or "").strip()
    if not ins:
        ins = "Polish for clarity; keep intent and hard constraints."

    system = (get_prompt("refine_prompt_system", data_dir) or "").strip()
    if not system:
        raise HTTPException(
            500,
            "Pipeline default refine_prompt_system is empty. Reset or fix Pipeline defaults.",
        )
    tmpl = (get_prompt("refine_prompt_user_template", data_dir) or "").strip()
    if not tmpl:
        raise HTTPException(
            500,
            "Pipeline default refine_prompt_user_template is empty. Reset or fix Pipeline defaults.",
        )
    for needle in ("{{LABEL}}", "{{CURRENT_PROMPT}}", "{{INSTRUCTION}}"):
        if needle not in tmpl:
            raise HTTPException(
                500,
                f"refine_prompt_user_template must include placeholder {needle!r}. Fix under Pipeline defaults.",
            )
    user = format_refine_prompt_user_template(
        tmpl,
        label=label,
        current_prompt=body.current_prompt,
        instruction=ins,
    )
    try:
        raw = await complete_chat(
            settings,
            [_msg_system(system), _msg_user(user)],
            model=model,
            temperature=0.15,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, str(e)) from e
    refined = _extract_refined_prompt(raw or "")
    if not refined:
        raise HTTPException(
            500,
            "Could not read a refined prompt (expected <<<PROMPT_START>>> … <<<PROMPT_END>>>). "
            "Try again or use a stronger model.",
        )
    return {"refined": refined, "model": model}


@app.get("/api/models")
async def list_models() -> dict[str, Any]:
    settings = get_settings()
    if settings.llm_provider == "ollama":
        # Single /api/tags fetch — avoids duplicate GETs that could disagree (e.g. first timing out, second OK).
        probe = await ollama_reachable(settings.ollama_base_url)
        names = [n for n in (probe.get("models") or []) if isinstance(n, str) and n.strip()]
        if not names:
            err = (
                probe.get("error")
                or "No models listed. On the Ollama host, run: ollama pull <name>, then refresh."
            )
            return {
                "models": [],
                "default": settings.ollama_model,
                "provider": "ollama",
                "hint": err,
                "ollama": probe,
            }
        default_name = names[0]
        return {
            "models": names,
            "default": default_name,
            "provider": "ollama",
            "ollama": {
                "reachable": True,
                "model_count": len(names),
                "base_url": probe.get("base_url"),
                "models": names,
            },
        }
    if settings.llm_provider == "openai":
        return {"models": [settings.openai_model], "default": settings.openai_model, "provider": "openai"}
    return {"models": [settings.anthropic_model], "default": settings.anthropic_model, "provider": "anthropic"}


@app.post("/api/sessions", response_model=None)
async def create_session(body: CreateSessionBody = Body(...)) -> JSONResponse:
    st = get_settings()
    m = (body.model or "").strip() if body.model else ""
    if not m:
        if st.llm_provider == "ollama":
            names = await ollama_list_models(st.ollama_base_url)
            m = names[0] if names else st.ollama_model
        elif st.llm_provider == "openai":
            m = st.openai_model
        else:
            m = st.anthropic_model
    council_id = (body.council_id or "default").strip() or "default"
    if not validate_council_id(council_id):
        raise HTTPException(400, "Invalid council_id (use a–z, 0–9, _ or -, max 64 chars)")
    _require_council_for_id(council_id)
    sess = store.create(m, council_id=council_id)
    return JSONResponse(
        {
            "id": sess.id,
            "title": getattr(sess, "title", "") or "",
            "model": sess.model,
            "council_id": sess.council_id,
            "phase": sess.phase.value,
        }
    )


@app.get("/api/sessions", response_model=None)
async def list_sessions() -> list[dict[str, Any]]:
    return store.list_metadata()


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    if not store.get(session_id):
        raise HTTPException(404, "Session not found")
    ok = store.delete(session_id)
    return {"deleted": ok}


@app.post("/api/sessions/bulk-delete")
async def bulk_delete_sessions(body: BulkDeleteSessionsBody) -> dict[str, Any]:
    deleted = 0
    missing: list[str] = []
    seen: set[str] = set()
    for raw_id in body.ids:
        sid = str(raw_id or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        if store.delete(sid):
            deleted += 1
        else:
            missing.append(sid)
    return {"deleted": deleted, "missing": missing}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    return {
        "id": sess.id,
        "title": getattr(sess, "title", "") or "",
        "model": sess.model,
        "council_id": getattr(sess, "council_id", "default") or "default",
        "phase": sess.phase.value,
        "created_ts": getattr(sess, "created_ts", 0),
        "updated_ts": getattr(sess, "updated_ts", 0),
        "user_brief": sess.user_brief,
        "plan_iteration_message": getattr(sess, "plan_iteration_message", "") or "",
        "research_brief": sess.research_brief,
        "research_sources": sess.research_sources,
        "pending_user_questions": sess.pending_user_questions,
        "plan_markdown": sess.plan_markdown,
        "plan_filename": sess.plan_filename,
        "artifact_kind": str(getattr(sess, "artifact_kind", "") or ""),
        "reference_urls": list(getattr(sess, "reference_urls", None) or []),
        "plan_versions": list(getattr(sess, "plan_versions", None) or []),
        "error_message": sess.error_message,
        "messages": [
            {
                "role": m.role,
                "content": m.content,
                "agent_id": m.agent_id,
                "agent_name": m.agent_name,
                "meta": m.meta,
            }
            for m in sess.messages
        ],
    }


@app.patch("/api/sessions/{session_id}", response_model=None)
async def patch_session(session_id: str, body: PatchSessionBody) -> dict[str, Any]:
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    if body.council_id is None and body.reference_urls is None:
        raise HTTPException(
            400,
            "Provide council_id and/or reference_urls",
        )
    if body.council_id is not None:
        cid = (body.council_id or "default").strip() or "default"
        if not validate_council_id(cid):
            raise HTTPException(
                400,
                "Invalid council_id (use a–z, 0–9, _ or -, max 64 chars)",
            )
        _require_council_for_id(cid)
        sess.council_id = cid
    if body.reference_urls is not None:
        sess.reference_urls = [
            r.model_dump(mode="json", exclude_none=True) for r in body.reference_urls
        ]
    store.save(sess)
    return {
        "id": sess.id,
        "council_id": sess.council_id,
        "reference_urls": list(getattr(sess, "reference_urls", None) or []),
    }


@app.post("/api/sessions/{session_id}/message", response_class=StreamingResponse)
async def post_message(session_id: str, body: PostMessageBody) -> StreamingResponse:
    settings = get_settings()
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(400, "Message content is required")
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    c = _require_council_for_id(
        (getattr(sess, "council_id", None) or "default").strip() or "default"
    )

    if body.intent == "continue_plan" and sess.phase != SessionPhase.done:
        raise HTTPException(
            400,
            "intent=continue_plan is only valid after a finished council run (phase done).",
        )

    if sess.phase == SessionPhase.done:
        if body.intent == "continue_plan":
            if (sess.plan_markdown or "").strip():
                archive_current_plan(sess, "before_continue_chat")
            sess.phase = SessionPhase.idle
            sess.plan_markdown = ""
            sess.artifact_kind = ""
            sess.agent_turns = []
            sess.pending_user_questions = []
            sess.user_answered_clarification = False
            sess.error_message = None
            sess.discussion_round = 0
            sess.last_consolidated_questions = []
        else:
            if (sess.plan_markdown or "").strip():
                archive_current_plan(sess, "before_new_run")
            sess.phase = SessionPhase.idle
            sess.user_brief = ""
            sess.plan_iteration_message = ""
            sess.research_brief = ""
            sess.research_sources = []
            sess.agent_turns = []
            sess.messages = []
            sess.plan_markdown = ""
            sess.artifact_kind = ""
            sess.pending_user_questions = []
            sess.user_answered_clarification = False
            sess.error_message = None
            sess.discussion_round = 0
            sess.last_consolidated_questions = []

    if sess.phase == SessionPhase.error:
        sess.phase = SessionPhase.idle
        sess.error_message = None

    if sess.phase not in (SessionPhase.idle, SessionPhase.awaiting_user):
        raise HTTPException(409, f"Session busy or invalid state: {sess.phase.value}")

    model = await _resolve_session_model(sess, body)
    if not model:
        raise HTTPException(400, "Model name required for this session")

    async def gen() -> Any:
        try:
            yield f"data: {json.dumps({'type': 'plan_snapshot', 'plan_markdown': sess.plan_markdown, 'plan_filename': sess.plan_filename, 'plan_versions': list(getattr(sess, 'plan_versions', None) or [])})}\n\n"
            async for ev in run_council_pipeline(
                settings,
                store,
                sess,
                content,
                c,
                continue_from_plan=body.intent == "continue_plan",
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            try:
                store.save(sess)
            except Exception as e:  # noqa: BLE001
                log.warning("Could not persist session: %s", e)
        yield f"data: {json.dumps({'type': 'stream_end'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8")


@app.post("/api/sessions/{session_id}/refine-plan", response_class=StreamingResponse)
async def refine_plan_stream(session_id: str, body: RefinePlanBody) -> StreamingResponse:
    settings = get_settings()
    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "instruction is required")
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    if sess.phase != SessionPhase.done:
        raise HTTPException(
            409,
            f"Output refine runs only after a completed council (phase is {sess.phase.value}, expected done).",
        )
    if not (sess.plan_markdown or "").strip():
        raise HTTPException(400, "No artifact content to refine")
    c = _require_council_for_id(
        (getattr(sess, "council_id", None) or "default").strip() or "default"
    )
    model = await _resolve_session_model_any(sess, body.model)
    if not model:
        raise HTTPException(400, "Model name required for this session")

    selection = (body.selection or "").strip() or None
    agent_ids = [str(x).strip() for x in (body.agent_ids or []) if str(x).strip()]

    async def gen() -> Any:
        try:
            async for ev in run_plan_refine(
                settings,
                store,
                sess,
                c,
                instruction=instruction,
                selection=selection,
                agent_ids=agent_ids,
                model=model,
            ):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            try:
                store.save(sess)
            except Exception as e:  # noqa: BLE001
                log.warning("Could not persist session: %s", e)
        yield f"data: {json.dumps({'type': 'stream_end'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8")


# Optional: serve Vite dist
def _mount_static() -> None:
    settings = get_settings()
    p = settings.frontend_dist
    if p and Path(p).is_dir():
        app.mount("/", StaticFiles(directory=str(p), html=True), name="static")
        return


# Only mount if env points to built frontend (production)
try:
    if get_settings().frontend_dist and Path(get_settings().frontend_dist).is_dir():
        _mount_static()
except Exception:  # noqa: BLE001
    pass
