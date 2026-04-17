"""Shell command runner used by the hive-agent WebSocket client.

Spawns shell processes, captures their output line-by-line, streams each
line out through a user-supplied callback, and lets the caller kill
commands mid-flight. The module is deliberately decoupled from any
transport — :class:`CommandRunner` knows nothing about WebSockets, HTTP,
or the hub. :mod:`hive_agent.ws_client` owns the transport layer and
instantiates this class to do the actual work.

Invariants
----------
* ``_processes[cmd_id]`` is present exactly while a process is live.
* ``_completed[cmd_id]`` is True only after ``_collect_output`` has
  finished appending output; polling code should observe this flag
  rather than dict membership to know when to stop.

Dangling-task note
------------------
Each process gets an output-collector task. We keep strong references
on ``self._tasks`` because ``asyncio.create_task`` only holds weak
references; without this pin the interpreter has historically GC'd
pending tasks mid-flight (see the M1 CI fix). ``add_done_callback``
removes finished tasks from the set so it doesn't grow unbounded.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

logger = logging.getLogger("hive_agent.command_runner")

LineCallback = Callable[[str, str, str], Awaitable[None]]
"""Async callback: ``(command_id, stream, text) -> None`` invoked per output line.

``stream`` is one of ``stdout``, ``stderr``, or ``exit`` — the last of which
carries the returncode as the text.
"""

# Per-command output buffer cap. Prevents long-running commands (e.g.
# ``tail -f``) from growing unbounded in memory. Oldest lines are dropped
# when exceeded.
OUTPUT_BUFFER_MAX_LINES = 5000


class CommandRunner:
    """Manages running commands and their output streams."""

    def __init__(self, line_callback: LineCallback | None = None) -> None:
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._outputs: dict[str, deque[str]] = {}
        self._completed: dict[str, bool] = {}
        self._returncodes: dict[str, int] = {}
        self._line_callback = line_callback
        self._tasks: set[asyncio.Task[None]] = set()

    async def run(
        self,
        command: str,
        command_id: str | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Start ``command`` and return immediately with its pid + command_id."""
        cmd_id = command_id or uuid.uuid4().hex[:12]
        self._outputs[cmd_id] = deque(maxlen=OUTPUT_BUFFER_MAX_LINES)
        self._completed[cmd_id] = False

        merged_env = {**os.environ, **(env or {})}
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=merged_env,
        )
        self._processes[cmd_id] = process

        task = asyncio.create_task(self._collect_output(cmd_id, process))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

        return {"command_id": cmd_id, "pid": process.pid}

    async def _emit(self, cmd_id: str, stream: str, text: str) -> None:
        """Fire-and-forget callback emission. Errors are swallowed so a
        flaky transport can't crash the output pump."""
        if self._line_callback is None:
            return
        try:
            await self._line_callback(cmd_id, stream, text)
        except Exception as exc:
            logger.debug("line_callback_failed", extra={"command_id": cmd_id, "error": str(exc)})

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
            self._completed[cmd_id] = True
            self._returncodes[cmd_id] = returncode
            self._processes.pop(cmd_id, None)
            await self._emit(cmd_id, "exit", f"{returncode}")

    async def wait(self, cmd_id: str) -> int:
        """Block until the command has completed; return its exit code."""
        while not self._completed.get(cmd_id, False):
            await asyncio.sleep(0.05)
        return self._returncodes.get(cmd_id, -1)

    def get_output(self, cmd_id: str) -> list[str]:
        buffer = self._outputs.get(cmd_id)
        return list(buffer) if buffer is not None else []

    def is_running(self, cmd_id: str) -> bool:
        if self._completed.get(cmd_id, False):
            return False
        return cmd_id in self._processes

    def pid(self, cmd_id: str) -> int | None:
        proc = self._processes.get(cmd_id)
        return proc.pid if proc is not None else None

    def returncode(self, cmd_id: str) -> int | None:
        return self._returncodes.get(cmd_id)

    async def kill(self, cmd_id: str) -> bool:
        """Kill a running command. Returns True if a process was terminated."""
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
            self._processes.pop(cmd_id, None)

    def cleanup(self, cmd_id: str) -> None:
        self._outputs.pop(cmd_id, None)
        self._processes.pop(cmd_id, None)
        self._completed.pop(cmd_id, None)
        self._returncodes.pop(cmd_id, None)
