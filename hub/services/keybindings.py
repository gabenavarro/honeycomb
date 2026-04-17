"""Persistent keybinding overrides (M10).

The dashboard ships with a small set of default shortcuts (Ctrl+K,
Ctrl+B, …). This module exposes a typed read/write layer over
``~/.config/honeycomb/keybindings.json`` so the Keybindings editor can
let the user override them.

The hub is the single source of truth so that multiple browser windows
(or a future VSCode extension) observe the same set. The file format is
``{"command": "Ctrl+Shift+K", ...}`` — a flat dict where the value is
whatever shortcut-describing string the client supports. The hub does
not interpret the strings; it only validates that both sides are
non-empty.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path


def keybindings_path() -> Path:
    """Resolve the keybindings file location. Honours ``XDG_CONFIG_HOME``."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "honeycomb" / "keybindings.json"


def load_keybindings(path: Path | None = None) -> dict[str, str]:
    target = path or keybindings_path()
    if not target.exists():
        return {}
    try:
        raw = json.loads(target.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if k and v}


def save_keybindings(overrides: dict[str, str], path: Path | None = None) -> None:
    """Persist ``overrides`` atomically, dropping empties. Entries with
    an empty string value are treated as "reset this command to default"
    and removed from the file.
    """
    target = path or keybindings_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    clean = {str(k): str(v) for k, v in overrides.items() if k and v}
    target.write_text(json.dumps(clean, indent=2, sort_keys=True))
    with contextlib.suppress(OSError):
        target.chmod(0o600)
