from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from .session import (
    ChatMessage,
    CouncilSession,
    SessionPhase,
    new_session_id,
)

log = logging.getLogger(__name__)


def _msg_to_dict(m: ChatMessage) -> dict[str, Any]:
    return {
        "role": m.role,
        "content": m.content,
        "agent_id": m.agent_id,
        "agent_name": m.agent_name,
        "meta": m.meta,
        "ts": m.ts,
    }


def _msg_from_dict(d: dict[str, Any]) -> ChatMessage:
    return ChatMessage(
        role=d.get("role", "user"),
        content=d.get("content", ""),
        agent_id=d.get("agent_id"),
        agent_name=d.get("agent_name"),
        meta=d.get("meta") or {},
        ts=float(d.get("ts", 0) or 0) or time.time(),
    )


def session_to_dict(s: CouncilSession) -> dict[str, Any]:
    p = s.phase
    pval = p.value if isinstance(p, SessionPhase) else str(p)
    return {
        "id": s.id,
        "title": s.title,
        "model": s.model,
        "created_ts": s.created_ts,
        "updated_ts": s.updated_ts,
        "phase": pval,
        "messages": [_msg_to_dict(m) for m in s.messages],
        "user_brief": s.user_brief,
        "research_brief": s.research_brief,
        "research_sources": s.research_sources,
        "discussion_round": s.discussion_round,
        "max_rounds": s.max_rounds,
        "agent_turns": s.agent_turns,
        "pending_user_questions": s.pending_user_questions,
        "last_consolidated_questions": s.last_consolidated_questions,
        "plan_markdown": s.plan_markdown,
        "plan_filename": s.plan_filename,
        "error_message": s.error_message,
        "user_answered_clarification": s.user_answered_clarification,
    }


def session_from_dict(d: dict[str, Any]) -> CouncilSession:
    raw_phase = d.get("phase", "idle")
    try:
        phase = SessionPhase(str(raw_phase))
    except ValueError:
        phase = SessionPhase.idle

    msgs = d.get("messages") or []
    if not isinstance(msgs, list):
        msgs = []
    return CouncilSession(
        id=str(d.get("id", "")),
        model=str(d.get("model", "")),
        title=str(d.get("title") or ""),
        created_ts=float(d.get("created_ts", 0) or time.time()),
        updated_ts=float(d.get("updated_ts", d.get("created_ts", 0)) or time.time()),
        phase=phase,
        messages=[_msg_from_dict(x) for x in msgs if isinstance(x, dict)],
        user_brief=str(d.get("user_brief") or ""),
        research_brief=str(d.get("research_brief") or ""),
        research_sources=list(d.get("research_sources") or []),
        discussion_round=int(d.get("discussion_round", 0) or 0),
        max_rounds=int(d.get("max_rounds", 2) or 2),
        agent_turns=list(d.get("agent_turns") or []),
        pending_user_questions=list(d.get("pending_user_questions") or []),
        last_consolidated_questions=list(d.get("last_consolidated_questions") or []),
        plan_markdown=str(d.get("plan_markdown") or ""),
        plan_filename=str(d.get("plan_filename") or "plan.md"),
        error_message=d.get("error_message"),
        user_answered_clarification=bool(d.get("user_answered_clarification", False)),
    )


class FileSessionStore:
    """In-memory cache + one JSON file per session under data_dir."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._cache: dict[str, CouncilSession] = {}
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, session_id: str) -> Path:
        return self.data_dir / f"{session_id}.json"

    def create(self, model: str) -> CouncilSession:
        sid = new_session_id()
        t = time.time()
        s = CouncilSession(id=sid, model=model, created_ts=t, updated_ts=t)
        self._cache[sid] = s
        self.save(s)
        return s

    def get(self, session_id: str) -> CouncilSession | None:
        if session_id in self._cache:
            return self._cache[session_id]
        p = self._path(session_id)
        if not p.is_file():
            return None
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            s = session_from_dict(d)
            if s.id != session_id:
                s.id = session_id
            self._cache[session_id] = s
            return s
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as e:
            log.warning("Failed to load session %s: %s", session_id, e)
            return None

    def save(self, s: CouncilSession) -> None:
        s.updated_ts = time.time()
        self._cache[s.id] = s
        p = self._path(s.id)
        try:
            p.write_text(
                json.dumps(session_to_dict(s), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError as e:
            log.error("Failed to save session %s: %s", s.id, e)
            raise

    def delete(self, session_id: str) -> bool:
        self._cache.pop(session_id, None)
        p = self._path(session_id)
        if p.is_file():
            p.unlink()
            return True
        return False

    def list_metadata(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for p in self.data_dir.glob("*.json"):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
                title = d.get("title") or ""
                if not str(title).strip():
                    ub = d.get("user_brief") or ""
                    title = (str(ub).split("\n")[0].strip() or "Untitled")[:60]
                out.append(
                    {
                        "id": d.get("id", p.stem),
                        "title": str(title)[:80],
                        "model": d.get("model", ""),
                        "phase": d.get("phase", "idle"),
                        "created_ts": float(d.get("created_ts", 0) or 0),
                        "updated_ts": float(d.get("updated_ts", d.get("created_ts", 0)) or 0),
                        "has_plan": bool((d.get("plan_markdown") or "").strip()),
                    }
                )
            except (OSError, json.JSONDecodeError, TypeError, ValueError):
                continue
        out.sort(key=lambda x: -float(x.get("updated_ts", 0) or 0))
        return out


def migrate_json_dir_to_db(engine: Any, data_dir: Path) -> int:
    """One-time: import legacy *.json session files (skip if id already in DB)."""
    from sqlalchemy.orm import sessionmaker

    from .db import CouncilSessionRow, create_tables

    create_tables(engine)
    if not data_dir.is_dir():
        return 0
    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
    n = 0
    for p in sorted(data_dir.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError) as e:
            log.warning("Skip legacy file %s: %s", p, e)
            continue
        sid = str(d.get("id", p.stem))
        d["id"] = sid
        with SessionLocal() as sess:
            if sess.get(CouncilSessionRow, sid) is not None:
                continue
        try:
            cs = session_from_dict(d)
        except (TypeError, ValueError) as e:
            log.warning("Invalid session in %s: %s", p, e)
            continue
        try:
            payload = json.dumps(session_to_dict(cs), ensure_ascii=False)
        except (TypeError, ValueError) as e:
            log.warning("Could not serialize session %s: %s", sid, e)
            continue
        t = float(cs.updated_ts)
        with SessionLocal() as sess:
            try:
                sess.add(CouncilSessionRow(id=sid, payload=payload, updated_ts=t))
                sess.commit()
            except Exception:  # noqa: BLE001
                sess.rollback()
        n += 1
    if n:
        log.info("Imported %d legacy JSON session file(s) from %s", n, data_dir)
    return n


class DatabaseSessionStore:
    """Persist sessions in SQLite (single table, JSON payload per row)."""

    def __init__(self, engine: Any) -> None:
        from sqlalchemy.orm import sessionmaker

        from .db import CouncilSessionRow, create_tables

        self._SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
        create_tables(engine)
        self._engine = engine
        self._SessionRow = CouncilSessionRow
        self._cache: dict[str, CouncilSession] = {}

    def create(self, model: str) -> CouncilSession:
        sid = new_session_id()
        t = time.time()
        s = CouncilSession(id=sid, model=model, created_ts=t, updated_ts=t)
        self._cache[sid] = s
        self.save(s)
        return s

    def get(self, session_id: str) -> CouncilSession | None:
        if session_id in self._cache:
            return self._cache[session_id]
        with self._SessionLocal() as sess:
            row = sess.get(self._SessionRow, session_id)
        if row is None:
            return None
        try:
            d = json.loads(row.payload)
            s = session_from_dict(d)
            if s.id != session_id:
                s.id = session_id
            self._cache[session_id] = s
            return s
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            log.warning("Failed to load session %s: %s", session_id, e)
            return None

    def save(self, s: CouncilSession) -> None:
        s.updated_ts = time.time()
        self._cache[s.id] = s
        payload = json.dumps(session_to_dict(s), ensure_ascii=False)
        with self._SessionLocal() as sess:
            row = sess.get(self._SessionRow, s.id)
            if row is None:
                sess.add(
                    self._SessionRow(
                        id=s.id, payload=payload, updated_ts=float(s.updated_ts)
                    )
                )
            else:
                row.payload = payload
                row.updated_ts = float(s.updated_ts)
            try:
                sess.commit()
            except Exception as e:  # noqa: BLE001
                log.error("Failed to save session %s: %s", s.id, e)
                raise

    def delete(self, session_id: str) -> bool:
        self._cache.pop(session_id, None)
        with self._SessionLocal() as sess:
            row = sess.get(self._SessionRow, session_id)
            if row is None:
                return False
            sess.delete(row)
            sess.commit()
        return True

    def list_metadata(self) -> list[dict[str, Any]]:
        from sqlalchemy import select

        out: list[dict[str, Any]] = []
        with self._SessionLocal() as sess:
            q = select(self._SessionRow).order_by(
                self._SessionRow.updated_ts.desc()
            )
            rows = sess.execute(q).scalars().all()
        for row in rows:
            try:
                d = json.loads(row.payload)
            except (json.JSONDecodeError, TypeError) as e:
                log.warning("Bad payload for session %s: %s", row.id, e)
                continue
            title = d.get("title") or ""
            if not str(title).strip():
                ub = d.get("user_brief") or ""
                title = (str(ub).split("\n")[0].strip() or "Untitled")[:60]
            out.append(
                {
                    "id": d.get("id", row.id),
                    "title": str(title)[:80],
                    "model": d.get("model", ""),
                    "phase": d.get("phase", "idle"),
                    "created_ts": float(d.get("created_ts", 0) or 0),
                    "updated_ts": float(d.get("updated_ts", d.get("created_ts", 0)) or 0),
                    "has_plan": bool((d.get("plan_markdown") or "").strip()),
                }
            )
        return out
