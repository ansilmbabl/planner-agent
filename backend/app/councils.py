from __future__ import annotations

import re
import shutil
from pathlib import Path

from .council_config import AgentDef, CouncilConfigFile, load_council_config, save_council_config

_COUNCIL_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


def validate_council_id(council_id: str) -> bool:
    s = (council_id or "").strip()
    return bool(s and _COUNCIL_ID_RE.match(s) and len(s) <= 64)


def list_council_ids(councils_dir: Path, legacy_council: Path) -> list[str]:
    """Return sorted council ids. Includes virtual 'default' if only legacy file exists."""
    ids: set[str] = set()
    if councils_dir.is_dir():
        for p in councils_dir.glob("*.json"):
            if p.is_file():
                stem = p.stem.strip()
                if validate_council_id(stem):
                    ids.add(stem)
    if not ids and legacy_council.is_file():
        ids.add("default")
    return sorted(ids, key=str.lower)


def resolve_council_path(
    council_id: str, councils_dir: Path, legacy_council: Path
) -> Path:
    if not validate_council_id(council_id):
        raise FileNotFoundError("invalid council id")
    p = councils_dir / f"{council_id}.json"
    if p.is_file():
        return p
    if council_id == "default" and legacy_council.is_file():
        return legacy_council
    raise FileNotFoundError(council_id)


def load_council(
    council_id: str, councils_dir: Path, legacy_council: Path
) -> CouncilConfigFile:
    path = resolve_council_path(council_id, councils_dir, legacy_council)
    return load_council_config(path)


def save_council(
    council_id: str,
    councils_dir: Path,
    config: CouncilConfigFile,
) -> Path:
    if not validate_council_id(council_id):
        raise ValueError("invalid council id")
    path = councils_dir / f"{council_id}.json"
    save_council_config(path, config)
    return path


def delete_council(
    council_id: str, councils_dir: Path, legacy_council: Path
) -> None:
    """Delete ``config/councils/{council_id}.json``.

    - Refuses if this would remove the only loadable council (see :func:`list_council_ids`).
    - Does not remove legacy ``council.json``; if ``default`` is only served from
      legacy, raises ``ValueError`` (nothing to delete under ``councils_dir``).
    """
    if not validate_council_id(council_id):
        raise ValueError("invalid council id")
    s = (council_id or "").strip()
    all_ids = list_council_ids(councils_dir, legacy_council)
    if len(all_ids) <= 1:
        raise ValueError("cannot delete the only council")
    if s not in all_ids:
        raise FileNotFoundError(s)
    path = councils_dir / f"{s}.json"
    if not path.is_file():
        if s == "default" and legacy_council.is_file():
            raise ValueError(
                "cannot delete default: it is not stored as config/councils/default.json"
            )
        raise FileNotFoundError(s)
    path.unlink()


def new_orchestrator_only_council() -> CouncilConfigFile:
    """Minimal council: default orchestrator + routing instructions, no specialists yet."""
    from .prompts.orchestrator import (
        DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
        DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS,
    )

    return CouncilConfigFile(
        debating_agents=[],
        synthesizer=None,
        orchestrator=AgentDef(
            id="orchestrator",
            name="Orchestrator",
            title="Council routing",
            system_prompt=DEFAULT_ORCHESTRATOR_SYSTEM_PROMPT,
            tools_enabled=False,
        ),
        orchestrator_user_instructions=DEFAULT_ORCHESTRATOR_USER_INSTRUCTIONS,
    )


def ensure_default_council_file(councils_dir: Path, legacy_council: Path) -> None:
    """Create config/councils/default.json from legacy config/council.json if missing."""
    councils_dir.mkdir(parents=True, exist_ok=True)
    target = councils_dir / "default.json"
    if target.is_file():
        return
    if legacy_council.is_file():
        shutil.copy2(legacy_council, target)
