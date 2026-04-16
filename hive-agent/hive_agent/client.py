"""HTTP client that connects to the Claude Hive hub.

Sends heartbeats, reports container status, and relays Claude Code CLI session state.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
from enum import Enum
from typing import Any

import httpx

logger = logging.getLogger("hive_agent.client")


class ContainerStatus(str, Enum):
    IDLE = "idle"
    BUSY = "busy"
    ERROR = "error"
    STARTING = "starting"
    STOPPING = "stopping"


class HiveClient:
    """Async HTTP client that maintains a heartbeat connection to the hub."""

    def __init__(
        self,
        hub_url: str | None = None,
        container_id: str | None = None,
        heartbeat_interval: float = 5.0,
        agent_port: int | None = None,
    ) -> None:
        self.hub_url = (hub_url or os.environ.get("HIVE_HUB_URL", "http://host.docker.internal:8420")).rstrip("/")
        self.container_id = container_id or os.environ.get("HIVE_CONTAINER_ID", socket.gethostname())
        self.heartbeat_interval = heartbeat_interval
        self.agent_port = agent_port or int(os.environ.get("HIVE_AGENT_PORT", "9100"))
        self._status = ContainerStatus.STARTING
        self._session_info: dict[str, Any] = {}
        self._http: httpx.AsyncClient | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None

    @property
    def status(self) -> ContainerStatus:
        return self._status

    @status.setter
    def status(self, value: ContainerStatus) -> None:
        self._status = value
        logger.info("Status changed to %s", value)

    def set_session_info(self, info: dict[str, Any]) -> None:
        """Update Claude Code CLI session info reported in heartbeats."""
        self._session_info = info

    async def start(self) -> None:
        """Start the HTTP client and begin heartbeat loop."""
        self._http = httpx.AsyncClient(timeout=10.0)
        self._status = ContainerStatus.IDLE
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("Hive client started — hub=%s, container=%s", self.hub_url, self.container_id)

    async def stop(self) -> None:
        """Stop the heartbeat loop and close the HTTP client."""
        self._status = ContainerStatus.STOPPING
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None
        if self._http:
            await self._http.aclose()
            self._http = None
        logger.info("Hive client stopped")

    def _build_heartbeat_payload(self) -> dict[str, Any]:
        return {
            "container_id": self.container_id,
            "status": self._status.value,
            "agent_port": self.agent_port,
            "session_info": self._session_info,
        }

    async def _send_heartbeat(self) -> bool:
        """Send a single heartbeat to the hub. Returns True on success."""
        if not self._http:
            return False
        try:
            resp = await self._http.post(
                f"{self.hub_url}/api/heartbeat",
                json=self._build_heartbeat_payload(),
            )
            resp.raise_for_status()
            return True
        except (httpx.HTTPError, httpx.StreamError) as exc:
            logger.warning("Heartbeat failed: %s", exc)
            return False

    async def _heartbeat_loop(self) -> None:
        """Send heartbeats at the configured interval."""
        consecutive_failures = 0
        max_failures = 5
        while True:
            success = await self._send_heartbeat()
            if success:
                consecutive_failures = 0
            else:
                consecutive_failures += 1
                if consecutive_failures >= max_failures:
                    logger.error(
                        "Hub unreachable after %d consecutive failures, continuing to retry",
                        consecutive_failures,
                    )
            await asyncio.sleep(self.heartbeat_interval)

    async def send_event(self, event_type: str, data: dict[str, Any]) -> bool:
        """Send a one-off event to the hub (e.g., command completed, error occurred)."""
        if not self._http:
            return False
        try:
            resp = await self._http.post(
                f"{self.hub_url}/api/events",
                json={
                    "container_id": self.container_id,
                    "event_type": event_type,
                    "data": data,
                },
            )
            resp.raise_for_status()
            return True
        except (httpx.HTTPError, httpx.StreamError) as exc:
            logger.warning("Event send failed: %s", exc)
            return False
