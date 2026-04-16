"""Lightweight HTTP server inside the container that accepts commands from the hub.

Exposes endpoints for the hub to:
- Execute shell commands (including Claude Code CLI)
- Query agent status
- Stream command output
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from hive_agent.client import ContainerStatus

if TYPE_CHECKING:
    from hive_agent.client import HiveClient

logger = logging.getLogger("hive_agent.listener")

LineCallback = Callable[[str, str, str], Awaitable[None]]
"""Async callback: (command_id, stream, text) -> None, invoked per output line."""

# Per-command output buffer cap. Prevents long-running commands (e.g. `tail -f`)
# from growing unbounded in memory. When exceeded, oldest lines are dropped.
OUTPUT_BUFFER_MAX_LINES = 5000


class CommandRunner:
    """Manages running commands and their output streams.

    Invariants:
    - `_processes[cmd_id]` is present exactly while a process is live.
    - `_completed[cmd_id]` is True only after _collect_output has appended
      the final line; streamers must observe this flag (not dict membership)
      to know when it is safe to stop polling.
    """

    def __init__(self, line_callback: LineCallback | None = None) -> None:
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._outputs: dict[str, deque[str]] = {}
        self._completed: dict[str, bool] = {}
        self._line_callback = line_callback
        # Strong references to the collector tasks. asyncio.create_task only
        # holds weak refs, so a task can be GC'd mid-flight if nothing else
        # retains it — that dropped the output on CI runners and was the
        # root cause of the historical "Task was destroyed but it is pending!"
        # warning. Tasks remove themselves via add_done_callback on exit.
        self._tasks: set[asyncio.Task[None]] = set()

    async def run(self, command: str, command_id: str | None = None) -> dict[str, Any]:
        """Run a command and return immediately with a command_id for output streaming."""
        cmd_id = command_id or uuid.uuid4().hex[:12]
        self._outputs[cmd_id] = deque(maxlen=OUTPUT_BUFFER_MAX_LINES)
        self._completed[cmd_id] = False

        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ},
        )
        self._processes[cmd_id] = process

        task = asyncio.create_task(self._collect_output(cmd_id, process))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

        return {"command_id": cmd_id, "pid": process.pid}

    async def _emit(self, cmd_id: str, stream: str, text: str) -> None:
        """Fire-and-forget callback emission. Callback errors are swallowed
        so a flaky hub can't crash the agent's output pump."""
        if self._line_callback is None:
            return
        try:
            await self._line_callback(cmd_id, stream, text)
        except Exception as exc:
            logger.debug("line_callback failed for %s: %s", cmd_id, exc)

    async def _collect_output(self, cmd_id: str, process: asyncio.subprocess.Process) -> None:
        """Read process output line by line into the output buffer."""
        buffer = self._outputs.setdefault(cmd_id, deque(maxlen=OUTPUT_BUFFER_MAX_LINES))
        try:
            assert process.stdout is not None
            async for line in process.stdout:
                decoded = line.decode("utf-8", errors="replace")
                buffer.append(decoded)
                await self._emit(cmd_id, "stdout", decoded)
        except Exception as exc:
            msg = f"[hive-agent error] {exc}\n"
            buffer.append(msg)
            await self._emit(cmd_id, "stderr", msg)
        finally:
            returncode = await process.wait()
            # Mark completed BEFORE removing from _processes so the streamer
            # (which now checks _completed) never misses the final buffer.
            self._completed[cmd_id] = True
            self._processes.pop(cmd_id, None)
            await self._emit(cmd_id, "exit", f"{returncode}")

    async def stream_output(self, cmd_id: str):
        """Async generator that yields output lines as they arrive."""
        seen = 0
        while True:
            buffer = self._outputs.get(cmd_id)
            if buffer is None:
                return
            # Snapshot current length; deque is thread-safe for append/pop but
            # iteration during mutation raises, so slice through list().
            lines = list(buffer)
            while seen < len(lines):
                yield lines[seen]
                seen += 1
            if self._completed.get(cmd_id, False) and seen >= len(lines):
                break
            await asyncio.sleep(0.1)

    def get_output(self, cmd_id: str) -> list[str]:
        """Get all output collected so far for a command."""
        buffer = self._outputs.get(cmd_id)
        return list(buffer) if buffer is not None else []

    def is_running(self, cmd_id: str) -> bool:
        if self._completed.get(cmd_id, False):
            return False
        return cmd_id in self._processes

    async def kill(self, cmd_id: str) -> bool:
        """Kill a running command."""
        proc = self._processes.get(cmd_id)
        if proc is None:
            return False
        try:
            proc.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except TimeoutError:
                proc.kill()
            return True
        except ProcessLookupError:
            return False
        finally:
            # _collect_output's finally will clean up _processes after its own
            # wait() resolves. Pop here too so is_running() reflects the kill
            # immediately without relying on task scheduling.
            self._processes.pop(cmd_id, None)

    def cleanup(self, cmd_id: str) -> None:
        """Remove stored output for a completed command."""
        self._outputs.pop(cmd_id, None)
        self._processes.pop(cmd_id, None)
        self._completed.pop(cmd_id, None)


def create_app(hive_client: HiveClient) -> Starlette:
    """Create the Starlette app for the command listener.

    The CommandRunner is wired to push each output line back to the hub as a
    `command_output` event, enabling real-time terminal streaming on the
    dashboard (channel `cmd:{command_id}`). Local ring-buffered output
    remains available via /output and /stream as a fallback.
    """

    async def _push_line(command_id: str, stream: str, text: str) -> None:
        await hive_client.send_event(
            event_type="command_output",
            data={
                "command_id": command_id,
                "stream": stream,
                "text": text,
                "ts": datetime.now(UTC).isoformat(),
            },
        )

    runner = CommandRunner(line_callback=_push_line)

    async def health(request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "container_id": hive_client.container_id,
                "agent_status": hive_client.status.value,
            }
        )

    async def exec_command(request: Request) -> JSONResponse:
        body = await request.json()
        command = body.get("command")
        if not command:
            return JSONResponse({"error": "command is required"}, status_code=400)

        hive_client.status = ContainerStatus.BUSY
        result = await runner.run(command, command_id=body.get("command_id"))
        return JSONResponse(result, status_code=202)

    async def get_output(request: Request) -> JSONResponse:
        cmd_id = request.path_params["command_id"]
        return JSONResponse(
            {
                "command_id": cmd_id,
                "running": runner.is_running(cmd_id),
                "output": runner.get_output(cmd_id),
            }
        )

    async def stream_output(request: Request) -> StreamingResponse:
        cmd_id = request.path_params["command_id"]

        async def generate():
            async for line in runner.stream_output(cmd_id):
                yield line

        return StreamingResponse(generate(), media_type="text/plain")

    async def kill_command(request: Request) -> JSONResponse:
        cmd_id = request.path_params["command_id"]
        killed = await runner.kill(cmd_id)
        if killed:
            hive_client.status = ContainerStatus.IDLE
        return JSONResponse({"killed": killed})

    async def status(request: Request) -> JSONResponse:
        running_cmds = list(runner._processes.keys())
        return JSONResponse(
            {
                "container_id": hive_client.container_id,
                "status": hive_client.status.value,
                "running_commands": running_cmds,
            }
        )

    routes = [
        Route("/health", health, methods=["GET"]),
        Route("/exec", exec_command, methods=["POST"]),
        Route("/output/{command_id}", get_output, methods=["GET"]),
        Route("/stream/{command_id}", stream_output, methods=["GET"]),
        Route("/kill/{command_id}", kill_command, methods=["POST"]),
        Route("/status", status, methods=["GET"]),
    ]

    return Starlette(routes=routes)
