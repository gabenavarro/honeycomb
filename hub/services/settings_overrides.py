"""Persistent overrides for mutable ``HiveSettings`` fields (M10).

The Settings view in the dashboard lets the user edit a *subset* of the
hub's configuration at runtime — specifically the fields that do not
require a restart to take effect:

- ``log_level``
- ``discover_roots``
- ``metrics_enabled``

Non-mutable fields (bind address, port, auth token, …) are exposed
read-only in the UI and ignored by this module.

Overrides are JSON-persisted at ``~/.config/honeycomb/settings.json``
(mode 0600) and layered on top of the env-driven ``HiveSettings`` at
read time. The file is optional; a missing or unreadable file yields an
empty overrides set.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
from typing import Any

MUTABLE_FIELDS: frozenset[str] = frozenset(
    {
        "log_level",
        "discover_roots",
        "metrics_enabled",
    }
)


def overrides_path() -> Path:
    """Resolve the overrides file location. Honours ``XDG_CONFIG_HOME``."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "honeycomb" / "settings.json"


def load_overrides(path: Path | None = None) -> dict[str, Any]:
    """Return the on-disk overrides dict, or ``{}`` if the file is
    missing or unreadable. Non-mutable keys are discarded defensively.
    """
    target = path or overrides_path()
    if not target.exists():
        return {}
    try:
        raw = json.loads(target.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in MUTABLE_FIELDS}


def save_overrides(overrides: dict[str, Any], path: Path | None = None) -> None:
    """Persist ``overrides`` to disk, creating parents if needed. Only
    mutable fields are kept — anything else in the dict is silently
    dropped.
    """
    target = path or overrides_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    clean = {k: v for k, v in overrides.items() if k in MUTABLE_FIELDS}
    target.write_text(json.dumps(clean, indent=2, sort_keys=True))
    # Best-effort; on Windows/WSL chmod may be a no-op.
    with contextlib.suppress(OSError):
        target.chmod(0o600)
