"""Tests for `hive-agent submit-diff`."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path

import pytest
from click.testing import CliRunner
from hive_agent.cli import main


@pytest.mark.asyncio
async def test_submit_diff_writes_jsonl_to_socket(tmp_path: Path) -> None:
    sock_path = tmp_path / "agent.sock"

    received: list[dict] = []

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        line = await reader.readline()
        received.append(json.loads(line.decode()))
        writer.close()

    server = await asyncio.start_unix_server(handler, path=str(sock_path))
    os.chmod(sock_path, 0o660)
    serve_task = asyncio.create_task(server.serve_forever())

    runner = CliRunner()
    diff_text = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n"
    result = await asyncio.to_thread(
        runner.invoke,
        main,
        [
            "submit-diff",
            "--tool",
            "Edit",
            "--path",
            "/workspace/foo.py",
            "--tool-use-id",
            "toolu_1",
            "--added-lines",
            "1",
            "--removed-lines",
            "1",
            "--timestamp",
            "2026-04-23T07:38:00Z",
            "--socket",
            str(sock_path),
            "--diff",
            "-",
        ],
        input=diff_text,
    )
    assert result.exit_code == 0, result.output

    server.close()
    await server.wait_closed()
    serve_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await serve_task

    assert len(received) == 1
    assert received[0]["tool"] == "Edit"
    assert received[0]["path"] == "/workspace/foo.py"
    assert received[0]["diff"] == diff_text
    assert received[0]["added_lines"] == 1


def test_submit_diff_missing_socket_exits_nonzero(tmp_path: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(
        main,
        [
            "submit-diff",
            "--tool",
            "Edit",
            "--path",
            "/x",
            "--tool-use-id",
            "t1",
            "--timestamp",
            "2026-04-23T07:38:00Z",
            "--socket",
            str(tmp_path / "does-not-exist.sock"),
            "--diff",
            "-",
        ],
        input="empty",
    )
    assert result.exit_code != 0
