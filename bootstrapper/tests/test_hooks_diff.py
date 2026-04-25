"""Hook-script tests for the M27 diff_event capture path."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOKS_DIR = REPO_ROOT / "bootstrapper" / "claude-hive-feature" / "hooks"
DIFF_PRE = HOOKS_DIR / "diff-pre"
DIFF_POST = HOOKS_DIR / "diff-post"


def _run_hook(
    script: Path,
    payload: dict,
    *,
    staging_dir: Path,
    hive_agent: Path | None = None,
    log_file: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["HIVE_DIFF_STAGING"] = str(staging_dir)
    if hive_agent is not None:
        env["HIVE_AGENT_BIN"] = str(hive_agent)
    if log_file is not None:
        env["HIVE_AGENT_LOG"] = str(log_file)
    return subprocess.run(
        ["python3", str(script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )


@pytest.fixture
def staging(tmp_path: Path) -> Path:
    s = tmp_path / "staging"
    s.mkdir()
    return s


@pytest.fixture
def fake_hive_agent(tmp_path: Path) -> Path:
    """A shim that records its argv + stdin to a JSON file so the
    test can assert on what the hook would have shipped."""
    script = tmp_path / "hive-agent"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "with open(os.environ['HIVE_AGENT_LOG'], 'a') as f:\n"
        "    f.write(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read()}) + '\\n')\n"
        "sys.exit(0)\n"
    )
    script.chmod(0o755)
    return script


def _calls(log_file: Path) -> list[dict]:
    if not log_file.exists():
        return []
    return [json.loads(line) for line in log_file.read_text().splitlines() if line.strip()]


def test_diff_pre_snapshots_existing_file(staging: Path, tmp_path: Path) -> None:
    target = tmp_path / "foo.py"
    target.write_text("hello\n")
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_1",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    result = _run_hook(DIFF_PRE, payload, staging_dir=staging)
    assert result.returncode == 0, result.stderr
    snapshot = staging / "toolu_1.before"
    assert snapshot.read_text() == "hello\n"


def test_diff_pre_no_file_no_snapshot(staging: Path, tmp_path: Path) -> None:
    payload = {
        "tool_name": "Write",
        "tool_use_id": "toolu_2",
        "tool_input": {"file_path": str(tmp_path / "absent.py")},
        "session_id": "sess",
    }
    result = _run_hook(DIFF_PRE, payload, staging_dir=staging)
    assert result.returncode == 0
    assert not (staging / "toolu_2.before").exists()


def test_diff_post_normal_edit(staging: Path, tmp_path: Path, fake_hive_agent: Path) -> None:
    target = tmp_path / "foo.py"
    (staging / "toolu_3.before").write_text("a\nb\n")
    target.write_text("a\nB\n")
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_3",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    result = _run_hook(
        DIFF_POST,
        payload,
        staging_dir=staging,
        hive_agent=fake_hive_agent,
        log_file=log,
    )
    assert result.returncode == 0, result.stderr
    calls = _calls(log)
    assert len(calls) == 1
    argv = calls[0]["argv"]
    assert "submit-diff" in argv
    assert "--tool" in argv and argv[argv.index("--tool") + 1] == "Edit"
    assert "--path" in argv and argv[argv.index("--path") + 1] == str(target)
    # Stdin contains the unified diff.
    assert "--- " in calls[0]["stdin"] or "@@" in calls[0]["stdin"]
    # Pre-snapshot is cleaned up after submission.
    assert not (staging / "toolu_3.before").exists()


def test_diff_post_write_to_new_file_treated_as_insert(
    staging: Path, tmp_path: Path, fake_hive_agent: Path
) -> None:
    target = tmp_path / "new.py"
    target.write_text("brand\nnew\n")
    payload = {
        "tool_name": "Write",
        "tool_use_id": "toolu_4",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    result = _run_hook(
        DIFF_POST,
        payload,
        staging_dir=staging,
        hive_agent=fake_hive_agent,
        log_file=log,
    )
    assert result.returncode == 0
    calls = _calls(log)
    assert len(calls) == 1
    assert "+brand" in calls[0]["stdin"]


def test_diff_post_noop_skips_submit(staging: Path, tmp_path: Path, fake_hive_agent: Path) -> None:
    target = tmp_path / "foo.py"
    target.write_text("same\n")
    (staging / "toolu_5.before").write_text("same\n")
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_5",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    result = _run_hook(
        DIFF_POST,
        payload,
        staging_dir=staging,
        hive_agent=fake_hive_agent,
        log_file=log,
    )
    assert result.returncode == 0
    assert _calls(log) == []


def test_diff_post_binary_skipped(staging: Path, tmp_path: Path, fake_hive_agent: Path) -> None:
    target = tmp_path / "blob.bin"
    target.write_bytes(b"\x00\x01\x02" + b"x" * 1024)
    (staging / "toolu_6.before").write_bytes(b"\x00\x01\x03" + b"x" * 1024)
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_6",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    result = _run_hook(
        DIFF_POST,
        payload,
        staging_dir=staging,
        hive_agent=fake_hive_agent,
        log_file=log,
    )
    assert result.returncode == 0
    assert _calls(log) == []


def test_diff_post_oversize_marker(staging: Path, tmp_path: Path, fake_hive_agent: Path) -> None:
    target = tmp_path / "big.txt"
    huge = "X" * (260 * 1024)
    (staging / "toolu_7.before").write_text("")
    target.write_text(huge)
    payload = {
        "tool_name": "Write",
        "tool_use_id": "toolu_7",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    result = _run_hook(
        DIFF_POST,
        payload,
        staging_dir=staging,
        hive_agent=fake_hive_agent,
        log_file=log,
    )
    assert result.returncode == 0
    calls = _calls(log)
    assert len(calls) == 1
    assert "[diff exceeds 256 KiB cap; not stored]" in calls[0]["stdin"]
