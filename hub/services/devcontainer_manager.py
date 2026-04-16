"""DevContainer manager — wraps devcontainer CLI + Docker SDK.

Handles container lifecycle: up, exec, stop, rebuild, inspect.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

import docker
import docker.errors

logger = logging.getLogger("hub.devcontainer_manager")

LineCallback = Callable[[str, str], Awaitable[None]]
"""Async callback invoked with (stream, line) where stream is 'stdout' or 'stderr'."""


class DevContainerManager:
    """Manages devcontainer lifecycle via CLI and Docker SDK."""

    def __init__(self) -> None:
        self._docker: docker.DockerClient | None = None

    @property
    def docker_client(self) -> docker.DockerClient:
        if self._docker is None:
            self._docker = docker.from_env()
        return self._docker

    async def _run_cmd(self, cmd: list[str], timeout: float = 300) -> tuple[int, str, str]:
        """Run a shell command asynchronously."""
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
        return proc.returncode or 0, stdout.decode(), stderr.decode()

    async def up(
        self,
        workspace_folder: str,
        *,
        build: bool = False,
        line_callback: LineCallback | None = None,
    ) -> dict[str, Any]:
        """Start a devcontainer (devcontainer up).

        When line_callback is provided, stderr (which carries devcontainer's
        progress log at default --log-level) and stdout are streamed to it
        line-by-line as the build progresses, enabling real-time dashboard
        progress. stdout is buffered so its final JSON can still be parsed.
        """
        cmd = ["devcontainer", "up", "--workspace-folder", workspace_folder]
        if build:
            cmd.append("--build")

        if line_callback is None:
            returncode, stdout, stderr = await self._run_cmd(cmd, timeout=600)
        else:
            returncode, stdout, stderr = await self._run_cmd_streaming(
                cmd, line_callback, timeout=600
            )
        if returncode != 0:
            raise RuntimeError(f"devcontainer up failed: {stderr}")

        # Parse JSON output from devcontainer up
        try:
            result = json.loads(stdout)
        except json.JSONDecodeError:
            result = {"raw_output": stdout}

        logger.info("devcontainer up succeeded for %s", workspace_folder)
        return result

    async def _run_cmd_streaming(
        self,
        cmd: list[str],
        line_callback: LineCallback,
        *,
        timeout: float,
    ) -> tuple[int, str, str]:
        """Like _run_cmd but streams lines to `line_callback` as they arrive.

        stdout is buffered (so the caller can parse JSON); stderr is also
        buffered and emitted line-by-line. Callback errors are suppressed.
        """
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_buf: list[str] = []
        stderr_buf: list[str] = []

        async def _pump(reader: asyncio.StreamReader, stream: str, buf: list[str]) -> None:
            while True:
                line = await reader.readline()
                if not line:
                    return
                text = line.decode("utf-8", errors="replace")
                buf.append(text)
                try:
                    await line_callback(stream, text)
                except Exception as exc:
                    logger.debug("up() line_callback failed: %s", exc)

        assert proc.stdout is not None and proc.stderr is not None
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _pump(proc.stdout, "stdout", stdout_buf),
                    _pump(proc.stderr, "stderr", stderr_buf),
                    proc.wait(),
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise TimeoutError(f"Command timed out after {timeout}s: {' '.join(cmd)}")

        return proc.returncode or 0, "".join(stdout_buf), "".join(stderr_buf)

    async def exec(
        self,
        workspace_folder: str,
        command: str | list[str],
        timeout: float = 120,
    ) -> tuple[int, str, str]:
        """Execute a command inside a devcontainer."""
        if isinstance(command, str):
            cmd_args = ["sh", "-c", command]
        else:
            cmd_args = command

        cmd = [
            "devcontainer", "exec",
            "--workspace-folder", workspace_folder,
            *cmd_args,
        ]
        return await self._run_cmd(cmd, timeout=timeout)

    async def stop(self, container_id: str) -> bool:
        """Stop a container by its Docker container ID."""
        try:
            container = self.docker_client.containers.get(container_id)
            container.stop(timeout=30)
            logger.info("Stopped container %s", container_id)
            return True
        except docker.errors.NotFound:
            logger.warning("Container %s not found", container_id)
            return False

    async def start(self, container_id: str) -> bool:
        """Start a stopped container."""
        try:
            container = self.docker_client.containers.get(container_id)
            container.start()
            logger.info("Started container %s", container_id)
            return True
        except docker.errors.NotFound:
            logger.warning("Container %s not found", container_id)
            return False

    async def remove(self, container_id: str, *, force: bool = False) -> bool:
        """Remove a container."""
        try:
            container = self.docker_client.containers.get(container_id)
            container.remove(force=force)
            logger.info("Removed container %s", container_id)
            return True
        except docker.errors.NotFound:
            logger.warning("Container %s not found for removal", container_id)
            return False

    async def inspect(self, container_id: str) -> dict[str, Any] | None:
        """Get Docker inspect data for a container."""
        try:
            container = self.docker_client.containers.get(container_id)
            return container.attrs  # type: ignore[return-value]
        except docker.errors.NotFound:
            return None

    def get_container_status(self, container_id: str) -> str:
        """Get the current status of a container (running, exited, etc.)."""
        try:
            container = self.docker_client.containers.get(container_id)
            return container.status  # type: ignore[return-value]
        except docker.errors.NotFound:
            return "not_found"

    def list_containers(self, label_filter: str | None = None) -> list[dict[str, Any]]:
        """List running containers, optionally filtered by label."""
        filters = {}
        if label_filter:
            filters["label"] = label_filter
        containers = self.docker_client.containers.list(all=True, filters=filters)
        return [
            {
                "id": c.short_id,
                "name": c.name,
                "status": c.status,
                "labels": c.labels,
                "image": str(c.image),
            }
            for c in containers
        ]

    def get_container_ip(self, container_id: str) -> str | None:
        """Get the IP address of a container on the bridge network."""
        try:
            container = self.docker_client.containers.get(container_id)
            networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
            for net_info in networks.values():
                ip = net_info.get("IPAddress")
                if ip:
                    return ip
        except docker.errors.NotFound:
            pass
        return None

    async def read_configuration(self, workspace_folder: str) -> dict[str, Any]:
        """Read devcontainer configuration without starting it."""
        cmd = ["devcontainer", "read-configuration", "--workspace-folder", workspace_folder]
        returncode, stdout, stderr = await self._run_cmd(cmd, timeout=30)
        if returncode != 0:
            raise RuntimeError(f"read-configuration failed: {stderr}")
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {"raw_output": stdout}
