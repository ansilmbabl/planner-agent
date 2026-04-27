from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .council_config import CouncilConfigFile, load_council_config, save_council_config
from .councils import (
    delete_council,
    ensure_default_council_file,
    list_council_ids,
    load_council,
    new_orchestrator_only_council,
    save_council,
    validate_council_id,
)
from .config import get_settings
from .llm import ollama_list_models, ollama_reachable
from .orchestrator import run_council_pipeline
from .plan_refine import run_plan_refine
from .session import CouncilSession, SessionPhase, archive_current_plan
from .db import make_engine
from .session_persistence import DatabaseSessionStore, migrate_json_dir_to_db
from .user_preferences import load_preferences, save_preferences

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
        description='Ids to draw system prompts from: "orchestrator", debater ids, "synthesizer"',
    )
    model: str | None = None


class PatchSessionBody(BaseModel):
    council_id: str = Field(
        ...,
        description="Agent council for subsequent messages (config/councils/{id}.json)",
    )


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


_NONE_TEMPLATE = frozenset({"", "none", "__none__"})


@app.post("/api/councils", response_model=None)
async def create_council(body: CreateCouncilBody) -> dict[str, str]:
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
        else:
            template = load_council(from_id, s.councils_dir, s.council_config_path)
    except FileNotFoundError as e:
        raise HTTPException(404, f"Template council not found: {from_id!r}") from e
    try:
        p = save_council(new_id, s.councils_dir, template)
    except OSError as e:
        log.error("Could not create council file: %s", e)
        raise HTTPException(500, f"Could not create council: {e}") from e
    return {"status": "ok", "id": new_id, "path": str(p)}


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
        p = save_council(council_id, s.councils_dir, body)
    except OSError as e:
        log.error("Could not write council: %s", e)
        raise HTTPException(500, f"Could not save council: {e}") from e
    return {"status": "ok", "id": council_id, "path": str(p)}


@app.delete("/api/councils/{council_id}", response_model=None)
async def delete_council_by_id(council_id: str) -> dict[str, str]:
    s = get_settings()
    ensure_default_council_file(s.councils_dir, s.council_config_path)
    if not validate_council_id(council_id.strip() or ""):
        raise HTTPException(400, "Invalid council_id")
    try:
        delete_council(council_id, s.councils_dir, s.council_config_path)
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
        p = save_council("default", s.councils_dir, body)
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
    cid = (body.council_id or "default").strip() or "default"
    if not validate_council_id(cid):
        raise HTTPException(
            400,
            "Invalid council_id (use a–z, 0–9, _ or -, max 64 chars)",
        )
    _require_council_for_id(cid)
    sess.council_id = cid
    store.save(sess)
    return {"id": sess.id, "council_id": sess.council_id}


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
            sess.agent_turns = []
            sess.pending_user_questions = []
            sess.user_answered_clarification = False
            sess.error_message = None
            sess.synthesizer_ran = False
            sess.last_synth_summary = ""
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
            sess.pending_user_questions = []
            sess.user_answered_clarification = False
            sess.error_message = None
            sess.synthesizer_ran = False
            sess.last_synth_summary = ""
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
            f"Plan refine runs only after a completed council (phase is {sess.phase.value}, expected done).",
        )
    if not (sess.plan_markdown or "").strip():
        raise HTTPException(400, "No plan content to refine")
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
