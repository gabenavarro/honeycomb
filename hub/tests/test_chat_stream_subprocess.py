"""Subprocess driver for chat_stream (M33 Phase 2)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from hub.services.chat_stream import (
    ClaudeTurnSession,
    build_command,
)


class TestBuildCommand:
    def test_first_turn_no_resume(self) -> None:
        cmd = build_command(claude_session_id=None)
        assert cmd[0] == "claude"
        assert "--print" in cmd
        assert "--verbose" in cmd
        assert "--input-format" in cmd
        assert cmd[cmd.index("--input-format") + 1] == "stream-json"
        assert "--output-format" in cmd
        assert cmd[cmd.index("--output-format") + 1] == "stream-json"
        assert "--include-partial-messages" in cmd
        assert "--replay-user-messages" in cmd
        assert "--resume" not in cmd

    def test_subsequent_turn_passes_resume(self) -> None:
        cmd = build_command(claude_session_id="sess-001")
        assert "--resume" in cmd
        assert cmd[cmd.index("--resume") + 1] == "sess-001"


class TestClaudeTurnSession:
    @pytest.mark.asyncio
    async def test_run_pipes_user_message_and_broadcasts_events(self, tmp_path: Path) -> None:
        # Simulate a fake claude binary that emits a canned fixture.
        fake_script = tmp_path / "claude"
        fixture = Path(__file__).parent / "fixtures" / "chat_stream" / "simple_text.jsonl"
        fake_script.write_text(f"#!/usr/bin/env bash\ncat {fixture}\n")
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-abc",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )

        result = await session.run(user_text="hello", claude_session_id=None)

        # The fixture's init event session_id is "sess-001"
        assert result.captured_claude_session_id == "sess-001"
        assert result.exit_code == 0
        # Broadcasts: 11 forwarded events from the fixture (13 raw - 2 hook events)
        assert manager.broadcast.await_count == 11

    @pytest.mark.asyncio
    async def test_run_handles_invalid_json_lines_without_crashing(self, tmp_path: Path) -> None:
        # Fake claude that emits one valid + one garbage + one valid event
        fake_script = tmp_path / "claude"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            "cat <<'EOF'\n"
            '{"type":"system","subtype":"init","session_id":"s","uuid":"u-1"}\n'
            "this is not json\n"
            '{"type":"result","subtype":"success","is_error":false,"session_id":"s","uuid":"u-2","duration_ms":1}\n'
            "EOF\n"
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-x",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        result = await session.run(user_text="hi", claude_session_id=None)

        # Only the two valid events broadcast; the garbage line is silently dropped.
        assert manager.broadcast.await_count == 2
        assert result.exit_code == 0

    @pytest.mark.asyncio
    async def test_run_writes_user_message_to_stdin_then_closes(self, tmp_path: Path) -> None:
        # Fake claude that echoes its stdin to a file, then emits a result event.
        log_path = tmp_path / "stdin.log"
        fake_script = tmp_path / "claude"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            f"cat - > {log_path}\n"
            'echo \'{"type":"result","subtype":"success","is_error":false,"session_id":"s","uuid":"u","duration_ms":1}\'\n'
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-y",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        await session.run(user_text="hello there", claude_session_id=None)

        stdin_payload = log_path.read_text().strip()
        assert stdin_payload == '{"type":"user","message":{"role":"user","content":"hello there"}}'

    @pytest.mark.asyncio
    async def test_cancel_kills_active_subprocess(self, tmp_path: Path) -> None:
        # Fake claude that sleeps forever
        fake_script = tmp_path / "claude"
        fake_script.write_text("#!/usr/bin/env bash\nsleep 3600\n")
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-z",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )

        run_task = asyncio.create_task(session.run(user_text="x", claude_session_id=None))
        # Give the subprocess a moment to start
        await asyncio.sleep(0.1)
        await session.cancel()
        result = await run_task
        assert result.exit_code != 0  # killed → non-zero
