"""Claude Code CLI relay — sends commands to Claude Code inside devcontainers.

Supports three modes, tried in order:
1. Via hive-agent HTTP API (preferred — lower latency, bidirectional).
2. Via `devcontainer exec` (only usable when the workspace has a real
   `.devcontainer/devcontainer.json` on the host, i.e. the container was
   started by the devcontainer CLI).
3. Via `docker exec` against the tracked container_id (works for any
   running Docker container — including ones started by plain
   `docker run`, which are common with VSCode-native devcontainers as
   well as discovered ad-hoc containers).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import httpx

from hub.services.devcontainer_manager import DevContainerManager

logger = logging.getLogger("hub.claude_relay")


class ClaudeRelay:
    """Relays commands to Claude Code CLI instances inside devcontainers."""

    def __init__(self, devcontainer_mgr: DevContainerManager) -> None:
        self._mgr = devcontainer_mgr
        self._http = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        await self._http.aclose()

    async def exec_via_agent(
        self,
        agent_host: str,
        agent_port: int,
        command: str,
        command_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute a command via the hive-agent HTTP API inside the container."""
        url = f"http://{agent_host}:{agent_port}/exec"
        payload: dict[str, Any] = {"command": command}
        if command_id:
            payload["command_id"] = command_id
        try:
            resp = await self._http.post(url, json=payload)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError as exc:
            logger.warning("Agent exec failed at %s: %s", url, exc)
            raise

    async def exec_via_devcontainer(
        self,
        workspace_folder: str,
        command: str,
        timeout: float = 120,
    ) -> tuple[int, str, str]:
        """Execute a command via devcontainer exec (fallback)."""
        return await self._mgr.exec(workspace_folder, command, timeout=timeout)

    @staticmethod
    def has_devcontainer_config(workspace_folder: str) -> bool:
        """True if the workspace has a real devcontainer.json on the host.

        `devcontainer exec` requires this file; pseudo paths like
        `/workspace/<name>` (assigned when discovering ad-hoc Docker
        containers) will fail with "Dev container config not found".
        """
        try:
            p = Path(workspace_folder)
        except (TypeError, ValueError):
            return False
        return (p / ".devcontainer" / "devcontainer.json").is_file()

    async def exec_via_docker(
        self,
        container_id: str,
        command: str,
        timeout: float = 120,
    ) -> tuple[int, str, str]:
        """Execute a command via `docker exec` against a running container.

        Uses `bash -lc` so the container's shell profile is sourced — this
        is important for PATH entries, HIVE_* env vars, and any
        alias/function set in /etc/profile.d. Falls back to `sh -c` if
        bash isn't available.
        """
        # Try bash first; if the container has no bash, retry with sh.
        # docker exec returncode 126/127 on "no such file"-style errors.
        cmd_bash = ["docker", "exec", "-i", container_id, "bash", "-lc", command]
        proc = await asyncio.create_subprocess_exec(
            *cmd_bash,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(
                f"docker exec timed out after {timeout}s in {container_id}"
            )
        rc = proc.returncode or 0
        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        # "exec: bash: not found" may appear on stdout (docker client side)
        # or stderr (container shell side) depending on OS / docker version.
        bash_missing = "bash" in (stderr + stdout).lower() and (
            "not found" in (stderr + stdout).lower()
            or "no such file" in (stderr + stdout).lower()
        )
        if rc in (126, 127) and bash_missing:
            # Retry with sh.
            cmd_sh = ["docker", "exec", "-i", container_id, "sh", "-c", command]
            proc = await asyncio.create_subprocess_exec(
                *cmd_sh,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )
            except asyncio.TimeoutError:
                proc.kill()
                raise TimeoutError(
                    f"docker exec (sh) timed out after {timeout}s in {container_id}"
                )
            rc = proc.returncode or 0
            stdout = stdout_b.decode("utf-8", errors="replace")
            stderr = stderr_b.decode("utf-8", errors="replace")
        return rc, stdout, stderr

    async def get_agent_status(self, agent_host: str, agent_port: int) -> dict[str, Any] | None:
        """Check hive-agent status inside a container."""
        url = f"http://{agent_host}:{agent_port}/health"
        try:
            resp = await self._http.get(url, timeout=5.0)
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPError, httpx.ConnectError):
            return None

    async def get_command_output(
        self,
        agent_host: str,
        agent_port: int,
        command_id: str,
    ) -> dict[str, Any] | None:
        """Get output for a running/completed command from the hive-agent."""
        url = f"http://{agent_host}:{agent_port}/output/{command_id}"
        try:
            resp = await self._http.get(url)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError:
            return None

    async def stream_command_output(
        self,
        agent_host: str,
        agent_port: int,
        command_id: str,
    ):
        """Stream output for a command from the hive-agent."""
        url = f"http://{agent_host}:{agent_port}/stream/{command_id}"
        async with self._http.stream("GET", url) as resp:
            async for line in resp.aiter_lines():
                yield line

    async def kill_command(
        self,
        agent_host: str,
        agent_port: int,
        command_id: str,
    ) -> bool:
        """Kill a running command in a container."""
        url = f"http://{agent_host}:{agent_port}/kill/{command_id}"
        try:
            resp = await self._http.post(url)
            resp.raise_for_status()
            return resp.json().get("killed", False)
        except httpx.HTTPError:
            return False
