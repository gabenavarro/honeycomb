"""Subprocess driver for chat_stream (M33 Phase 2)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from hub.db.migrations_runner import apply_migrations_sync
from hub.services.artifacts import list_artifacts
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


class TestBuildSpawnCommand:
    """M37-hotfix: `ClaudeTurnSession._build_spawn_command` wraps the
    plain claude argv with `docker exec -i -w <cwd> <container_id>`
    when ``docker_container_id`` is set. The hub runs on the host but
    the workspace path (e.g. ``/workspace/gnbio``) only exists inside
    the container — host-side spawn fails with FileNotFoundError. This
    helper makes the same M33 ClaudeTurnSession work for both
    container-attached and host-only deployments.
    """

    def test_no_docker_container_id_returns_argv_unchanged(self) -> None:
        session = ClaudeTurnSession(
            named_session_id="ns",
            cwd="/host/path",
            ws_manager=AsyncMock(),
        )
        cmd = ["claude", "--print", "--output-format", "stream-json"]
        spawn_cmd, spawn_cwd = session._build_spawn_command(cmd)
        assert spawn_cmd == cmd
        assert spawn_cwd == "/host/path"

    def test_with_docker_container_id_wraps_with_docker_exec(self) -> None:
        session = ClaudeTurnSession(
            named_session_id="ns",
            cwd="/workspace/gnbio",
            ws_manager=AsyncMock(),
            docker_container_id="7202c6deb33b",
        )
        cmd = ["claude", "--print", "--output-format", "stream-json"]
        spawn_cmd, spawn_cwd = session._build_spawn_command(cmd)
        assert spawn_cmd == [
            "docker",
            "exec",
            "-i",
            "-w",
            "/workspace/gnbio",
            "7202c6deb33b",
            "claude",
            "--print",
            "--output-format",
            "stream-json",
        ]
        # Docker exec owns the cwd inside the container; the host
        # subprocess cwd is left unset so it inherits the hub's cwd.
        assert spawn_cwd is None


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


# ─── M35 hook pipeline integration tests ─────────────────────────────


@pytest_asyncio.fixture
async def registry_engine(tmp_path: Path):
    """Fresh registry DB seeded with one container row (id=1).

    Mirrors the fixture pattern in test_artifacts_service.py /
    test_artifacts_endpoint.py so the chat_stream hook persistence path
    has a real container_id to FK against.
    """
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    sync_engine = sa.create_engine(f"sqlite:///{db_path}")
    with sync_engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-20T00:00:00','2026-04-20T00:00:00')",
            ),
        )
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    yield eng
    await eng.dispose()


def _write_fake_claude(script_path: Path, stdout_lines: list[str]) -> None:
    """Write a fake claude binary that emits the given NDJSON lines.

    Mirrors the inline ``cat <<'EOF'`` pattern used by the existing
    subprocess tests above.
    """
    body = "\n".join(stdout_lines)
    script_path.write_text(
        "#!/usr/bin/env bash\n"
        "cat - > /dev/null\n"  # consume stdin so we don't block
        "cat <<'EOF'\n"
        f"{body}\n"
        "EOF\n"
    )
    script_path.chmod(0o755)


class TestArtifactHookPipeline:
    @pytest.mark.asyncio
    async def test_snippet_hook_records_artifact_after_run(
        self, tmp_path: Path, registry_engine
    ) -> None:
        # Three text_deltas that, concatenated, form a 3-line python fence.
        fake_script = tmp_path / "claude"
        _write_fake_claude(
            fake_script,
            [
                '{"type":"system","subtype":"init","session_id":"sess-snip","uuid":"u-1"}',
                '{"type":"stream_event","event":{"type":"content_block_start","index":0,'
                '"content_block":{"type":"text","text":""}},"session_id":"sess-snip","uuid":"u-2"}',
                '{"type":"stream_event","event":{"type":"content_block_delta","index":0,'
                '"delta":{"type":"text_delta","text":"Here:\\n```python\\nimport os\\n"}},'
                '"session_id":"sess-snip","uuid":"u-3"}',
                '{"type":"stream_event","event":{"type":"content_block_delta","index":0,'
                '"delta":{"type":"text_delta","text":"print(os.getcwd())\\nos.exit(0)\\n```\\n"}},'
                '"session_id":"sess-snip","uuid":"u-4"}',
                '{"type":"result","subtype":"success","is_error":false,'
                '"session_id":"sess-snip","uuid":"u-5","duration_ms":1}',
            ],
        )

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-snip",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
            container_id=1,
            artifacts_engine=registry_engine,
        )
        result = await session.run(user_text="hi", claude_session_id=None)
        assert result.exit_code == 0

        artifacts = await list_artifacts(registry_engine, container_id=1)
        snippets = [a for a in artifacts if a.type == "snippet"]
        assert len(snippets) == 1
        assert snippets[0].metadata is not None
        assert snippets[0].metadata["language"] == "python"
        assert snippets[0].metadata["line_count"] == 3

    @pytest.mark.asyncio
    async def test_subagent_hook_records_artifact_with_source_message_id(
        self, tmp_path: Path, registry_engine
    ) -> None:
        # content_block_start carrying a Task tool_use.
        fake_script = tmp_path / "claude"
        _write_fake_claude(
            fake_script,
            [
                '{"type":"system","subtype":"init","session_id":"sess-sub","uuid":"u-1"}',
                '{"type":"stream_event","event":{"type":"content_block_start","index":0,'
                '"content_block":{"type":"tool_use","id":"tu-task-42","name":"Task",'
                '"input":{"subagent_type":"general-purpose","description":"Find bug",'
                '"prompt":"Find the bug in main.py"}}},'
                '"session_id":"sess-sub","uuid":"u-2"}',
                '{"type":"result","subtype":"success","is_error":false,'
                '"session_id":"sess-sub","uuid":"u-3","duration_ms":1}',
            ],
        )

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-sub",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
            container_id=1,
            artifacts_engine=registry_engine,
        )
        result = await session.run(user_text="hi", claude_session_id=None)
        assert result.exit_code == 0

        artifacts = await list_artifacts(registry_engine, container_id=1)
        subagents = [a for a in artifacts if a.type == "subagent"]
        assert len(subagents) == 1
        assert subagents[0].source_message_id == "tu-task-42"
        assert subagents[0].metadata is not None
        assert subagents[0].metadata["subagent_type"] == "general-purpose"

    @pytest.mark.asyncio
    async def test_record_artifact_failure_does_not_break_run(
        self,
        tmp_path: Path,
        registry_engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Same snippet-emitting fixture as test 1, but record_artifact blows up.
        fake_script = tmp_path / "claude"
        _write_fake_claude(
            fake_script,
            [
                '{"type":"system","subtype":"init","session_id":"sess-fail","uuid":"u-1"}',
                '{"type":"stream_event","event":{"type":"content_block_delta","index":0,'
                '"delta":{"type":"text_delta","text":"```python\\na=1\\nb=2\\nc=3\\n```"}},'
                '"session_id":"sess-fail","uuid":"u-2"}',
                '{"type":"result","subtype":"success","is_error":false,'
                '"session_id":"sess-fail","uuid":"u-3","duration_ms":1}',
            ],
        )

        async def _boom(*args: object, **kwargs: object) -> None:
            raise RuntimeError("boom")

        # Patch the symbol the chat_stream module already imported, not
        # the original definition site — the module-local binding is what
        # _apply_artifact_hooks actually calls.
        monkeypatch.setattr("hub.services.chat_stream.record_artifact", _boom)

        # We can't use pytest's `caplog` here: the registry_engine fixture
        # runs Alembic migrations which load alembic.ini via logging.config
        # .fileConfig — that not only swaps the root handlers (dropping
        # pytest's LogCaptureHandler) but also flips disabled=True on every
        # pre-existing logger (including hub.services.chat_stream). We
        # re-enable the chat_stream logger and attach our own buffer
        # handler to verify the warning still fires.
        import logging as _logging

        records: list[_logging.LogRecord] = []

        class _Capture(_logging.Handler):
            def emit(self, record: _logging.LogRecord) -> None:
                records.append(record)

        captured = _Capture(level=_logging.WARNING)
        chat_logger = _logging.getLogger("hub.services.chat_stream")
        prior_disabled = chat_logger.disabled
        chat_logger.disabled = False
        chat_logger.addHandler(captured)
        try:
            manager = AsyncMock()
            session = ClaudeTurnSession(
                named_session_id="ns-fail",
                cwd="/tmp",
                ws_manager=manager,
                claude_binary=str(fake_script),
                container_id=1,
                artifacts_engine=registry_engine,
            )
            result = await session.run(user_text="hi", claude_session_id=None)
        finally:
            chat_logger.removeHandler(captured)
            chat_logger.disabled = prior_disabled

        # Run completes cleanly even though record_artifact raised.
        assert result.exit_code == 0
        # Nothing landed because every record_artifact attempt blew up.
        artifacts = await list_artifacts(registry_engine, container_id=1)
        assert artifacts == []
        # Failure was logged at WARNING level via the artifact-hook handler.
        assert any("artifact hook failed" in r.getMessage() for r in records)
