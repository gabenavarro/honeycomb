"""Health checker — marks containers as errored when heartbeats are missed."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta

from hub.services.registry import Registry

logger = logging.getLogger("hub.health_checker")

HEARTBEAT_TIMEOUT_SECONDS = 15
# How long to wait after container registration before demanding a heartbeat.
# Protects against marking just-started containers unreachable while hive-agent
# is still booting. Crosses into "misconfigured" territory after this window.
INITIAL_HEARTBEAT_GRACE_SECONDS = 60


class HealthChecker:
    """Periodically checks container heartbeat freshness and marks stale ones."""

    def __init__(self, registry: Registry, check_interval: float = 10.0) -> None:
        self._registry = registry
        self._check_interval = check_interval
        self._last_heartbeat: dict[str, datetime] = {}
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None

    async def record_heartbeat(self, container_id: str) -> None:
        """Called when a heartbeat is received from a container."""
        async with self._lock:
            self._last_heartbeat[container_id] = datetime.now()

    async def forget(self, container_id: str) -> None:
        """Drop tracking for a container (e.g. on deletion)."""
        async with self._lock:
            self._last_heartbeat.pop(container_id, None)

    async def start(self) -> None:
        self._task = asyncio.create_task(self._check_loop())
        logger.info(
            "Health checker started (interval=%ss, timeout=%ss, grace=%ss)",
            self._check_interval,
            HEARTBEAT_TIMEOUT_SECONDS,
            INITIAL_HEARTBEAT_GRACE_SECONDS,
        )

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _check_loop(self) -> None:
        while True:
            try:
                await self._check_all()
            except Exception as exc:
                logger.debug("Health check cycle failed: %s", exc)
            await asyncio.sleep(self._check_interval)

    async def _snapshot_heartbeats(self) -> dict[str, datetime]:
        async with self._lock:
            return dict(self._last_heartbeat)

    async def _check_all(self) -> None:
        """Check all running containers for stale heartbeats."""
        records = await self._registry.list_all()
        heartbeats = await self._snapshot_heartbeats()
        now = datetime.now()
        timeout = timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
        grace = timedelta(seconds=INITIAL_HEARTBEAT_GRACE_SECONDS)

        for record in records:
            if record.container_status.value != "running":
                continue

            container_id = record.container_id
            if not container_id:
                continue

            last_hb = heartbeats.get(container_id)
            if last_hb is None:
                # No heartbeat ever received. Use registration time as the
                # grace-period anchor — if the container has been "running"
                # longer than the grace window without a heartbeat, the agent
                # is presumed misconfigured and the container is marked
                # unreachable.
                reference = record.updated_at or record.created_at
                if now - reference > grace and record.agent_status.value != "unreachable":
                    logger.warning(
                        "Container %s (%s) has never sent a heartbeat after %ss — marking unreachable",
                        container_id,
                        record.project_name,
                        INITIAL_HEARTBEAT_GRACE_SECONDS,
                    )
                    await self._registry.update(
                        record.id,
                        agent_status="unreachable",
                    )
                continue

            if now - last_hb > timeout:
                if record.agent_status.value != "unreachable":
                    logger.warning(
                        "Container %s (%s) missed heartbeat — marking unreachable",
                        container_id,
                        record.project_name,
                    )
                    await self._registry.update(
                        record.id,
                        agent_status="unreachable",
                    )
            elif record.agent_status.value == "unreachable":
                logger.info(
                    "Container %s (%s) heartbeat resumed",
                    container_id,
                    record.project_name,
                )
                await self._registry.update(
                    record.id,
                    agent_status="idle",
                )
