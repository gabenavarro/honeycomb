#!/usr/bin/env python3
"""Idempotently merge the M27 hooks block into a user's
~/.claude/settings.json.

Adds an entry to ``hooks.PreToolUse`` and ``hooks.PostToolUse`` that
points at /usr/local/share/honeycomb/hooks/diff-{pre,post}. Existing
user hooks (other matchers, other commands) are preserved. If our
own entry is already present, the script is a no-op.

Usage:

    python3 merge_settings.py /path/to/settings.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

INSTALL_DIR = "/usr/local/share/honeycomb/hooks"
MATCHER = "Edit|Write|MultiEdit"


def _ensure_entry(items: list[dict], command: str) -> list[dict]:
    for entry in items:
        if entry.get("matcher") != MATCHER:
            continue
        for cmd in entry.get("hooks", []):
            if cmd.get("command") == command:
                return items
    items.append(
        {
            "matcher": MATCHER,
            "hooks": [{"type": "command", "command": command}],
        }
    )
    return items


def main(target: Path) -> int:
    settings: dict = {}
    if target.exists():
        try:
            settings = json.loads(target.read_text())
        except json.JSONDecodeError:
            settings = {}
    settings.setdefault("hooks", {})
    settings["hooks"].setdefault("PreToolUse", [])
    settings["hooks"].setdefault("PostToolUse", [])

    settings["hooks"]["PreToolUse"] = _ensure_entry(
        settings["hooks"]["PreToolUse"], f"{INSTALL_DIR}/diff-pre"
    )
    settings["hooks"]["PostToolUse"] = _ensure_entry(
        settings["hooks"]["PostToolUse"], f"{INSTALL_DIR}/diff-post"
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(settings, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: merge_settings.py <path/to/settings.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
