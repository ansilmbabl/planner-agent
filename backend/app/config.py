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
    ollama_model: str = "llama3.2"
    llm_provider: Literal["ollama", "openai", "anthropic"] = "ollama"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-3-5-sonnet-20241022"

    council_config_path: Path = Path(__file__).resolve().parents[2] / "config" / "council.json"
    research_max_queries: int = 3
    discussion_rounds: int = 2
    max_url_fetch_bytes: int = 200_000
    url_fetch_timeout_s: float = 15.0
    request_timeout_s: float = 120.0
    plan_json_retries: int = 2

    frontend_dist: Path | None = None


def get_settings() -> Settings:
    return Settings()
