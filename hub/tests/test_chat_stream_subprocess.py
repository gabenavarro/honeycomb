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

    # ── M34 additions ──────────────────────────────────────────────

    def test_quick_effort_adds_max_budget_flag(self) -> None:
        cmd = build_command(claude_session_id=None, effort="quick")
        assert "--max-budget-usd" in cmd
        assert cmd[cmd.index("--max-budget-usd") + 1] == "0.05"

    def test_standard_effort_no_extra_flags(self) -> None:
        cmd = build_command(claude_session_id=None, effort="standard")
        assert "--max-budget-usd" not in cmd
        assert "--append-system-prompt" not in cmd

    def test_deep_effort_no_flag(self) -> None:
        cmd = build_command(claude_session_id=None, effort="deep")
        assert "--max-budget-usd" not in cmd

    def test_max_effort_no_flag(self) -> None:
        cmd = build_command(claude_session_id=None, effort="max")
        assert "--max-budget-usd" not in cmd

    def test_model_flag_passed_through(self) -> None:
        cmd = build_command(claude_session_id=None, model="opus-4-7")
        assert "--model" in cmd
        assert cmd[cmd.index("--model") + 1] == "opus-4-7"

    def test_model_1m_alias_passed_through(self) -> None:
        cmd = build_command(claude_session_id=None, model="claude-opus-4-7[1m]")
        assert "--model" in cmd
        assert cmd[cmd.index("--model") + 1] == "claude-opus-4-7[1m]"

    def test_no_model_no_flag(self) -> None:
        cmd = build_command(claude_session_id=None)
        assert "--model" not in cmd

    def test_plan_mode_sets_permission_mode_plan(self) -> None:
        cmd = build_command(claude_session_id=None, mode="plan")
        assert "--permission-mode" in cmd
        assert cmd[cmd.index("--permission-mode") + 1] == "plan"

    def test_plan_mode_overrides_edit_auto(self) -> None:
        cmd = build_command(claude_session_id=None, mode="plan", edit_auto=True)
        assert cmd[cmd.index("--permission-mode") + 1] == "plan"

    def test_edit_auto_in_code_mode_sets_acceptEdits(self) -> None:
        cmd = build_command(claude_session_id=None, mode="code", edit_auto=True)
        assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"

    def test_code_mode_no_edit_auto_no_permission_flag(self) -> None:
        cmd = build_command(claude_session_id=None, mode="code", edit_auto=False)
        assert "--permission-mode" not in cmd

    def test_review_mode_appends_system_prompt(self) -> None:
        cmd = build_command(claude_session_id=None, mode="review")
        assert "--append-system-prompt" in cmd
        prompt = cmd[cmd.index("--append-system-prompt") + 1]
        assert "reviewing code" in prompt
        # Review uses the default permission chain (no edit_auto here)
        assert "--permission-mode" not in cmd

    def test_review_mode_with_edit_auto_sets_acceptEdits(self) -> None:
        cmd = build_command(claude_session_id=None, mode="review", edit_auto=True)
        assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"
        assert "--append-system-prompt" in cmd

    def test_resume_still_works_with_all_extras(self) -> None:
        cmd = build_command(
            claude_session_id="sess-001",
            effort="quick",
            model="sonnet-4-6",
            mode="plan",
            edit_auto=True,
        )
        assert "--resume" in cmd
        assert cmd[cmd.index("--resume") + 1] == "sess-001"
        assert "--max-budget-usd" in cmd
        assert "--model" in cmd
        assert cmd[cmd.index("--permission-mode") + 1] == "plan"  # plan wins


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

    @pytest.mark.asyncio
    async def test_run_passes_effort_max_to_user_prefix(self, tmp_path: Path) -> None:
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
        await session.run(
            user_text="please find the bug",
            claude_session_id=None,
            effort="max",
        )

        stdin_payload = log_path.read_text().strip()
        # The user text written to stdin is JSON; the inner content
        # should have the ultrathink prefix.
        import json as _json

        envelope = _json.loads(stdin_payload)
        assert envelope["type"] == "user"
        assert envelope["message"]["role"] == "user"
        assert envelope["message"]["content"].startswith("ultrathink.")
        assert "please find the bug" in envelope["message"]["content"]

    @pytest.mark.asyncio
    async def test_run_passes_model_and_mode_to_subprocess(self, tmp_path: Path) -> None:
        # Fake claude that records its argv to a file then exits.
        argv_log = tmp_path / "argv.log"
        fake_script = tmp_path / "claude"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            f'echo "$@" > {argv_log}\n'
            "cat - > /dev/null\n"  # consume stdin
            'echo \'{"type":"result","subtype":"success","is_error":false,"session_id":"s","uuid":"u","duration_ms":1}\'\n'
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-m",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        await session.run(
            user_text="hi",
            claude_session_id=None,
            effort="quick",
            model="sonnet-4-6",
            mode="review",
            edit_auto=True,
        )

        argv = argv_log.read_text().strip().split()
        # Ordered checks: model + permission_mode (acceptEdits because
        # review with edit_auto) + max-budget-usd (quick) + system prompt
        assert "--model" in argv
        assert argv[argv.index("--model") + 1] == "sonnet-4-6"
        assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
        assert argv[argv.index("--max-budget-usd") + 1] == "0.05"
        assert "--append-system-prompt" in argv


class TestApplyEffortPrefix:
    def test_standard_returns_text_unchanged(self) -> None:
        from hub.services.chat_stream import apply_effort_prefix

        assert apply_effort_prefix("hello", "standard") == "hello"

    def test_quick_returns_text_unchanged(self) -> None:
        # Quick uses the cost cap, not a prefix.
        from hub.services.chat_stream import apply_effort_prefix

        assert apply_effort_prefix("hello", "quick") == "hello"

    def test_deep_prepends_think_hard_keyword(self) -> None:
        from hub.services.chat_stream import apply_effort_prefix

        out = apply_effort_prefix("hello", "deep")
        assert out.startswith("think hard about this.")
        assert "hello" in out

    def test_max_prepends_ultrathink_keyword(self) -> None:
        from hub.services.chat_stream import apply_effort_prefix

        out = apply_effort_prefix("hello", "max")
        assert out.startswith("ultrathink.")
        assert "hello" in out

    def test_unknown_effort_passes_through(self) -> None:
        # Defensive: unrecognized effort doesn't raise; it's a no-op
        from hub.services.chat_stream import apply_effort_prefix

        assert apply_effort_prefix("hello", "wat") == "hello"
