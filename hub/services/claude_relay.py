"""Claude Code CLI relay — sends commands to Claude Code inside devcontainers.

Three relay paths, tried in order of preference:

1. **Agent reverse tunnel** (since M4). The hub dispatches a
   ``cmd_exec`` frame over the WebSocket the agent dialed back into
   ``/api/agent/connect`` and awaits the matching ``done`` frame. No
   network reach into the container, no open listener.
2. **``devcontainer exec``** — only usable when the workspace has a
   real ``.devcontainer/devcontainer.json`` on the host, i.e. the
   container was started by the devcontainer CLI.
3. **``docker exec``** against the tracked ``container_id`` — works
   for any running Docker container, including ones started by plain
   ``docker run`` (common for VSCode-native devcontainers and
   discovered ad-hoc containers).

The commands router uses :meth:`ClaudeRelay.has_live_agent` to pick
between the paths, so retry on agent disconnect / reconnect happens
naturally: the next exec goes over the freshly reconnected socket.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from hub.services.devcontainer_manager import DevContainerManager

if TYPE_CHECKING:
    from hub.services.agent_registry import AgentRegistry

logger = logging.getLogger("hub.claude_relay")


# How long we wait for the agent to respond with a `done` frame after
# dispatching a cmd_exec. Mirrors the default docker/devcontainer exec
# timeout so UX is consistent across all three paths.
AGENT_EXEC_TIMEOUT_S = 120.0


class ClaudeRelay:
    """Relays commands to Claude Code CLI instances inside devcontainers."""

    def __init__(
        self,
        devcontainer_mgr: DevContainerManager,
        agent_registry: AgentRegistry | None = None,
    ) -> None:
        self._mgr = devcontainer_mgr
        self._agent_registry = agent_registry

    async def close(self) -> None:
        # No persistent HTTP client to tear down since M4. Method kept
        # so lifespan callers don't have to special-case.
        return

    # ── path 1: agent reverse tunnel ───────────────────────────────

    def has_live_agent(self, container_id: str | None) -> bool:
        """True when a hive-agent WebSocket is registered for the container."""
        if not container_id or self._agent_registry is None:
            return False
        return self._agent_registry.has_live_connection(container_id)

    async def exec_via_agent(
        self,
        container_id: str,
        command: str,
        command_id: str,
        timeout_s: float = AGENT_EXEC_TIMEOUT_S,
    ) -> dict[str, Any]:
        """Dispatch ``command`` to the agent and await its ``done`` frame.

        Returns a dict shaped like the old HTTP response so the commands
        router doesn't need to care which path ran:

        ``{command_id, pid, exit_code, reason, stream_output_task}``

        where ``stream_output_task`` is an awaitable the caller can use
        to drain ``(stream, text)`` pairs as they arrive (each pair is
        already broadcast on ``cmd:<id>`` by the agent router).
        """
        if self._agent_registry is None:
            raise RuntimeError("agent_registry not configured")
        connection = self._agent_registry.get(container_id)
        if connection is None or connection.closed:
            raise RuntimeError(f"no live agent for container {container_id}")

        pending = await connection.send_exec(command_id, command, timeout_s=timeout_s)
        try:
            done = await asyncio.wait_for(pending.done, timeout=timeout_s)
        except TimeoutError as exc:
            # Best-effort cancel on the agent. The caller gets a
            # TimeoutError; output already broadcast on cmd:<id> is kept.
            import contextlib as _contextlib

            with _contextlib.suppress(Exception):
                await connection.send_kill(command_id)
            raise TimeoutError(
                f"agent exec timed out after {timeout_s}s in {container_id}"
            ) from exc

        return {
            "command_id": done.command_id,
            "pid": done.pid,
            "exit_code": done.exit_code,
            "reason": done.reason,
        }

    async def kill_via_agent(self, container_id: str, command_id: str) -> bool:
        """Send a cmd_kill frame to the agent. Returns True if a socket was live."""
        if self._agent_registry is None:
            return False
        connection = self._agent_registry.get(container_id)
        if connection is None or connection.closed:
            return False
        await connection.send_kill(command_id)
        return True

    # ── path 2: devcontainer exec ──────────────────────────────────

    async def exec_via_devcontainer(
        self,
        workspace_folder: str,
        command: str,
        timeout: float = 120,
    ) -> tuple[int, str, str]:
        """Execute a command via devcontainer exec."""
        return await self._mgr.exec(workspace_folder, command, timeout=timeout)

    @staticmethod
    def has_devcontainer_config(workspace_folder: str) -> bool:
        """True if the workspace has a real ``.devcontainer/devcontainer.json``.

        ``devcontainer exec`` requires this file; pseudo paths like
        ``/workspace/<name>`` (assigned when discovering ad-hoc Docker
        containers) will fail with "Dev container config not found".
        """
        try:
            p = Path(workspace_folder)
        except (TypeError, ValueError):
            return False
        return (p / ".devcontainer" / "devcontainer.json").is_file()

    # ── path 3: docker exec ────────────────────────────────────────

    async def exec_via_docker(
        self,
        container_id: str,
        command: str,
        timeout: float = 120,
    ) -> tuple[int, str, str]:
        """Execute a command via ``docker exec`` against a running container.

        Uses ``bash -lc`` so the container's shell profile is sourced — this
        matters for PATH entries, HIVE_* env vars, and any alias/function
        set in ``/etc/profile.d``. Falls back to ``sh -c`` if bash isn't
        available.
        """
        cmd_bash = ["docker", "exec", "-i", container_id, "bash", "-lc", command]
        proc = await asyncio.create_subprocess_exec(
            *cmd_bash,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            proc.kill()
            raise TimeoutError(f"docker exec timed out after {timeout}s in {container_id}")
        rc = proc.returncode or 0
        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        bash_missing = "bash" in (stderr + stdout).lower() and (
            "not found" in (stderr + stdout).lower() or "no such file" in (stderr + stdout).lower()
        )
        if rc in (126, 127) and bash_missing:
            cmd_sh = ["docker", "exec", "-i", container_id, "sh", "-c", command]
            proc = await asyncio.create_subprocess_exec(
                *cmd_sh,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except TimeoutError:
                proc.kill()
                raise TimeoutError(f"docker exec (sh) timed out after {timeout}s in {container_id}")
            rc = proc.returncode or 0
            stdout = stdout_b.decode("utf-8", errors="replace")
            stderr = stderr_b.decode("utf-8", errors="replace")
        return rc, stdout, stderr
