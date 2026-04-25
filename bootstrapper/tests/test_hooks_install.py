"""Tests for the install.sh hooks-block merge logic."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MERGER = REPO / "bootstrapper" / "claude-hive-feature" / "hooks" / "merge_settings.py"


def _run_merge(home: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(MERGER), str(home / ".claude" / "settings.json")],
        capture_output=True,
        text=True,
    )


def test_merge_into_empty_home(tmp_path: Path) -> None:
    (tmp_path / ".claude").mkdir()
    result = _run_merge(tmp_path)
    assert result.returncode == 0, result.stderr

    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    pre = settings["hooks"]["PreToolUse"]
    post = settings["hooks"]["PostToolUse"]
    assert any("diff-pre" in h["hooks"][0]["command"] for h in pre)
    assert any("diff-post" in h["hooks"][0]["command"] for h in post)


def test_merge_preserves_existing_user_hooks(tmp_path: Path) -> None:
    settings_path = tmp_path / ".claude" / "settings.json"
    settings_path.parent.mkdir()
    settings_path.write_text(
        json.dumps(
            {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Bash",
                            "hooks": [{"type": "command", "command": "/usr/local/user-pre"}],
                        }
                    ]
                }
            }
        )
    )
    _run_merge(tmp_path)
    merged = json.loads(settings_path.read_text())
    pre = merged["hooks"]["PreToolUse"]
    matchers = [h.get("matcher") for h in pre]
    assert "Bash" in matchers
    assert "Edit|Write|MultiEdit" in matchers


def test_merge_is_idempotent(tmp_path: Path) -> None:
    (tmp_path / ".claude").mkdir()
    _run_merge(tmp_path)
    _run_merge(tmp_path)
    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    pre = settings["hooks"]["PreToolUse"]
    diff_pre_count = sum(
        1 for h in pre if any("diff-pre" in c.get("command", "") for c in h.get("hooks", []))
    )
    assert diff_pre_count == 1
