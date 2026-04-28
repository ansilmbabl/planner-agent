"""Timeline snapshots for council JSON (rollback, AI regenerate safety)."""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any, TypedDict

from .council_config import CouncilConfigFile, load_council_config, save_council_config
from .councils import resolve_council_path, validate_council_id

log = logging.getLogger(__name__)

MAX_VERSIONS_PER_COUNCIL = 100
_VERSION_ID_RE = re.compile(r"^[0-9]{10,20}_[a-f0-9]{8}$")


class VersionEntry(TypedDict):
    id: str
    label: str
    created_at: float


def _versions_dir(data_dir: Path, council_id: str) -> Path:
    return data_dir / "council_versions" / council_id


def _manifest_path(data_dir: Path, council_id: str) -> Path:
    return _versions_dir(data_dir, council_id) / "_manifest.json"


def _canonical_sig(cfg: CouncilConfigFile) -> str:
    return json.dumps(
        cfg.model_dump(mode="json"),
        sort_keys=True,
        ensure_ascii=False,
    )


def validate_version_id(version_id: str) -> bool:
    s = (version_id or "").strip()
    return bool(_VERSION_ID_RE.fullmatch(s))


def _read_manifest(data_dir: Path, council_id: str) -> list[VersionEntry]:
    p = _manifest_path(data_dir, council_id)
    if not p.is_file():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        rows = raw.get("versions")
        if not isinstance(rows, list):
            return []
        out: list[VersionEntry] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            vid = str(r.get("id", "")).strip()
            if not validate_version_id(vid):
                continue
            label = str(r.get("label", "") or "Snapshot")
            cat = r.get("created_at")
            created = float(cat) if isinstance(cat, (int, float)) else 0.0
            out.append({"id": vid, "label": label, "created_at": created})
        return out
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as e:
        log.warning("Could not read council version manifest %s: %s", p, e)
        return []


def _write_manifest(data_dir: Path, council_id: str, versions: list[VersionEntry]) -> None:
    d = _versions_dir(data_dir, council_id)
    d.mkdir(parents=True, exist_ok=True)
    p = _manifest_path(data_dir, council_id)
    p.write_text(
        json.dumps({"versions": versions}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _prune_old_files(data_dir: Path, council_id: str, keep_ids: set[str]) -> None:
    d = _versions_dir(data_dir, council_id)
    if not d.is_dir():
        return
    for f in d.glob("*.json"):
        if f.name == "_manifest.json":
            continue
        stem = f.stem
        if stem not in keep_ids and validate_version_id(stem):
            try:
                f.unlink()
            except OSError as e:
                log.warning("Could not remove old council version %s: %s", f, e)


def add_council_version(
    data_dir: Path,
    council_id: str,
    config: CouncilConfigFile,
    label: str,
) -> str:
    """Persist a snapshot; returns new version id."""
    if not validate_council_id(council_id):
        raise ValueError("invalid council id")
    vid = f"{int(time.time() * 1000)}_{secrets.token_hex(4)}"
    d = _versions_dir(data_dir, council_id)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{vid}.json"
    save_council_config(path, config)
    manifest = _read_manifest(data_dir, council_id)
    entry: VersionEntry = {
        "id": vid,
        "label": (label or "Snapshot").strip()[:200] or "Snapshot",
        "created_at": time.time(),
    }
    manifest.insert( 0, entry)
    manifest = manifest[:MAX_VERSIONS_PER_COUNCIL]
    keep = {e["id"] for e in manifest}
    _prune_old_files(data_dir, council_id, keep)
    _write_manifest(data_dir, council_id, manifest)
    return vid


def list_council_versions(data_dir: Path, council_id: str) -> list[dict[str, Any]]:
    if not validate_council_id(council_id):
        raise ValueError("invalid council id")
    manifest = _read_manifest(data_dir, council_id)
    # drop entries whose file is missing
    d = _versions_dir(data_dir, council_id)
    alive: list[VersionEntry] = []
    for e in manifest:
        p = d / f"{e['id']}.json"
        if p.is_file():
            alive.append(e)
    if len(alive) != len(manifest):
        keep = {x["id"] for x in alive}
        _prune_old_files(data_dir, council_id, keep)
        _write_manifest(data_dir, council_id, alive)
    return [
        {
            "id": e["id"],
            "label": e["label"],
            "created_at": e["created_at"],
        }
        for e in alive
    ]


def load_council_version(
    data_dir: Path, council_id: str, version_id: str
) -> CouncilConfigFile:
    if not validate_council_id(council_id) or not validate_version_id(version_id):
        raise FileNotFoundError("invalid id")
    p = _versions_dir(data_dir, council_id) / f"{version_id}.json"
    if not p.is_file():
        raise FileNotFoundError(version_id)
    return load_council_config(p)


def delete_council_version(data_dir: Path, council_id: str, version_id: str) -> None:
    if not validate_council_id(council_id) or not validate_version_id(version_id):
        raise ValueError("invalid id")
    p = _versions_dir(data_dir, council_id) / f"{version_id}.json"
    if p.is_file():
        p.unlink()
    manifest = _read_manifest(data_dir, council_id)
    manifest = [e for e in manifest if e["id"] != version_id]
    _write_manifest(data_dir, council_id, manifest)


def delete_all_versions_for_council(data_dir: Path, council_id: str) -> None:
    d = _versions_dir(data_dir, council_id)
    if d.is_dir():
        try:
            import shutil

            shutil.rmtree(d)
        except OSError as e:
            log.warning("Could not remove council versions dir %s: %s", d, e)


def save_council_with_backup(
    council_id: str,
    councils_dir: Path,
    legacy_council: Path,
    new_cfg: CouncilConfigFile,
    data_dir: Path,
    *,
    backup_label: str = "Before save",
) -> Path:
    """
    If the council file already exists and content changes, snapshot the previous file
    then write ``new_cfg`` to the live council path.
    """
    if not validate_council_id(council_id):
        raise ValueError("invalid council id")
    path = resolve_council_path(council_id, councils_dir, legacy_council)
    if path.is_file():
        try:
            old = load_council_config(path)
        except (OSError, json.JSONDecodeError, ValueError) as e:
            log.warning("Could not read existing council before save: %s", e)
            old = None
        if old is not None and _canonical_sig(old) != _canonical_sig(new_cfg):
            add_council_version(data_dir, council_id, old, backup_label)
    save_council_config(path, new_cfg)
    return path


def write_council_without_backup(
    council_id: str,
    councils_dir: Path,
    legacy_council: Path,
    new_cfg: CouncilConfigFile,
) -> Path:
    """Write live council file only (caller handled versioning)."""
    if not validate_council_id(council_id):
        raise ValueError("invalid council id")
    path = resolve_council_path(council_id, councils_dir, legacy_council)
    save_council_config(path, new_cfg)
    return path
