from __future__ import annotations

from pathlib import Path

from sqlalchemy import Float, String, Text, create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class CouncilSessionRow(Base):
    __tablename__ = "council_sessions"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    payload: Mapped[str] = mapped_column(Text, nullable=False)
    updated_ts: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, index=True
    )


def sqlite_url(path: Path) -> str:
    p = path.expanduser().resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{p.as_posix()}"


def make_engine(sqlite_path: Path) -> Engine:
    return create_engine(
        sqlite_url(sqlite_path),
        connect_args={"check_same_thread": False},
        echo=False,
    )


def create_tables(engine: Engine) -> None:
    Base.metadata.create_all(engine)
