from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .council_config import load_council_config
from .config import get_settings
from .llm import ollama_list_models, ollama_reachable
from .orchestrator import run_council_pipeline
from .session import CouncilSession, SessionPhase
from .session_persistence import FileSessionStore

log = logging.getLogger(__name__)

store = FileSessionStore(get_settings().sessions_data_dir)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    s = get_settings()
    p = s.council_config_path
    if p.is_file():
        load_council_config(p)
    else:
        log.warning("Missing council config at %s; create config/council.json", p)
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


class PostMessageBody(BaseModel):
    content: str
    model: str | None = None


def _require_council():
    s = get_settings()
    p = s.council_config_path
    if not p.is_file():
        raise HTTPException(500, f"Council config missing: {p}")
    return load_council_config(p)


async def _resolve_session_model(s: CouncilSession, body: PostMessageBody) -> str:
    settings = get_settings()
    m = (body.model or s.model or "").strip()
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
    return h


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
    _require_council()
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
    sess = store.create(m)
    return JSONResponse(
        {
            "id": sess.id,
            "title": getattr(sess, "title", "") or "",
            "model": sess.model,
            "phase": sess.phase.value,
        }
    )


@app.get("/api/sessions", response_model=None)
async def list_sessions() -> list[dict[str, Any]]:
    return store.list_metadata()


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    if not store.get(session_id) and not (get_settings().sessions_data_dir / f"{session_id}.json").is_file():
        raise HTTPException(404, "Session not found")
    ok = store.delete(session_id)
    return {"deleted": ok}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")
    return {
        "id": sess.id,
        "title": getattr(sess, "title", "") or "",
        "model": sess.model,
        "phase": sess.phase.value,
        "created_ts": getattr(sess, "created_ts", 0),
        "updated_ts": getattr(sess, "updated_ts", 0),
        "user_brief": sess.user_brief,
        "research_brief": sess.research_brief,
        "research_sources": sess.research_sources,
        "pending_user_questions": sess.pending_user_questions,
        "plan_markdown": sess.plan_markdown,
        "plan_filename": sess.plan_filename,
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


@app.post("/api/sessions/{session_id}/message", response_class=StreamingResponse)
async def post_message(session_id: str, body: PostMessageBody) -> StreamingResponse:
    c = _require_council()
    settings = get_settings()
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(400, "Message content is required")
    sess = store.get(session_id)
    if not sess:
        raise HTTPException(404, "Session not found")

    if sess.phase == SessionPhase.done:
        sess.phase = SessionPhase.idle
        sess.user_brief = ""
        sess.research_brief = ""
        sess.research_sources = []
        sess.agent_turns = []
        sess.messages = []
        sess.plan_markdown = ""
        sess.pending_user_questions = []
        sess.user_answered_clarification = False
        sess.error_message = None

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
            async for ev in run_council_pipeline(settings, store, sess, content, c):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            try:
                store.save(sess)
            except OSError as e:
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
