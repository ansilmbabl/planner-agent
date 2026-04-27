from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def preferences_path(data_dir: Path) -> Path:
    return data_dir / "preferences.json"


def load_preferences(data_dir: Path) -> dict[str, Any]:
    p = preferences_path(data_dir)
    if not p.is_file():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError, TypeError) as e:
        log.warning("Could not read preferences: %s", e)
        return {}


def save_preferences(data_dir: Path, updates: dict[str, Any]) -> dict[str, Any]:
    if not updates:
        return load_preferences(data_dir)
    p = preferences_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    current = load_preferences(data_dir)
    for k, v in updates.items():
        if v is None:
            current.pop(k, None)
        else:
            current[k] = v
    p.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
    return current
