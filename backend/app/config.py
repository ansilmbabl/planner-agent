from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ollama_base_url: str = "http://127.0.0.1:11434"
    # Fallback only when no model is selected and /api/tags is empty; prefer UI + `ollama list`
    ollama_model: str = ""
    llm_provider: Literal["ollama", "openai", "anthropic"] = "ollama"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-3-5-sonnet-20241022"

    council_config_path: Path = Path(__file__).resolve().parents[2] / "config" / "council.json"
    """Legacy single file; new installs use councils_dir. Still used as fallback for 'default'."""

    councils_dir: Path = Path(__file__).resolve().parents[2] / "config" / "councils"
    research_max_queries: int = 3
    discussion_rounds: int = 2
    orchestration_max_steps: int = 24
    max_url_fetch_bytes: int = 200_000
    url_fetch_timeout_s: float = 15.0
    request_timeout_s: float = 120.0
    plan_json_retries: int = 2

    frontend_dist: Path | None = None
    # SQLite database for session persistence (replaces per-file JSON under sessions_data_dir)
    sqlite_path: Path = Path(__file__).resolve().parents[2] / "data" / "planner.db"
    # Legacy: JSON files here are imported once on startup if missing from the DB
    sessions_data_dir: Path = Path(__file__).resolve().parents[2] / "data" / "sessions"


def get_settings() -> Settings:
    return Settings()
