"""Resource monitor — polls docker stats and nvidia-smi for container resource usage."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime
from typing import Any

import docker
import docker.errors

from hub.models.schemas import ResourceStats

logger = logging.getLogger("hub.resource_monitor")


class ResourceMonitor:
    """Monitors CPU, memory, and GPU usage per container."""

    def __init__(self, poll_interval: float = 5.0) -> None:
        self.poll_interval = poll_interval
        self._docker: docker.DockerClient | None = None
        self._stats_cache: dict[str, ResourceStats] = {}
        self._poll_task: asyncio.Task[None] | None = None

    @property
    def docker_client(self) -> docker.DockerClient:
        if self._docker is None:
            self._docker = docker.from_env()
        return self._docker

    def get_stats(self, container_id: str) -> ResourceStats | None:
        """Get the latest cached stats for a container."""
        return self._stats_cache.get(container_id)

    def get_all_stats(self) -> dict[str, ResourceStats]:
        """Get all cached stats."""
        return dict(self._stats_cache)

    async def start(self, container_ids: list[str] | None = None) -> None:
        """Start the polling loop."""
        self._poll_task = asyncio.create_task(self._poll_loop(container_ids))
        logger.info("Resource monitor started (interval=%ss)", self.poll_interval)

    async def stop(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None

    def _get_container_stats(self, container_id: str) -> dict[str, Any] | None:
        """Get docker stats for a single container (sync, called in executor)."""
        try:
            container = self.docker_client.containers.get(container_id)
            stats = container.stats(stream=False)
            return stats
        except docker.errors.NotFound:
            return None
        except Exception as exc:
            logger.debug("Stats fetch failed for %s: %s", container_id, exc)
            return None

    def _parse_docker_stats(self, container_id: str, raw: dict[str, Any]) -> ResourceStats:
        """Parse raw docker stats into a ResourceStats model."""
        # CPU calculation
        cpu_delta = raw.get("cpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0) - raw.get(
            "precpu_stats", {}
        ).get("cpu_usage", {}).get("total_usage", 0)
        system_delta = raw.get("cpu_stats", {}).get("system_cpu_usage", 0) - raw.get(
            "precpu_stats", {}
        ).get("system_cpu_usage", 0)
        num_cpus = raw.get("cpu_stats", {}).get("online_cpus", 1)
        cpu_percent = (cpu_delta / system_delta * num_cpus * 100.0) if system_delta > 0 else 0.0

        # Memory calculation
        mem_stats = raw.get("memory_stats", {})
        memory_usage = mem_stats.get("usage", 0)
        memory_limit = mem_stats.get("limit", 0)
        cache = mem_stats.get("stats", {}).get("cache", 0)
        memory_mb = (memory_usage - cache) / (1024 * 1024)
        memory_limit_mb = memory_limit / (1024 * 1024)
        memory_percent = (memory_mb / memory_limit_mb * 100) if memory_limit_mb > 0 else 0.0

        return ResourceStats(
            container_id=container_id,
            cpu_percent=round(cpu_percent, 2),
            memory_mb=round(memory_mb, 2),
            memory_limit_mb=round(memory_limit_mb, 2),
            memory_percent=round(memory_percent, 2),
            timestamp=datetime.now(),
        )

    async def _poll_gpu(self) -> dict[str, float] | None:
        """Query nvidia-smi for GPU stats."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode != 0:
                return None
            parts = stdout.decode().strip().split(",")
            if len(parts) >= 3:
                return {
                    "gpu_utilization": float(parts[0].strip()),
                    "gpu_memory_mb": float(parts[1].strip()),
                    "gpu_memory_total_mb": float(parts[2].strip()),
                }
        except (TimeoutError, FileNotFoundError):
            pass
        return None

    async def poll_once(self, container_ids: list[str]) -> dict[str, ResourceStats]:
        """Poll stats for the given container IDs once."""
        loop = asyncio.get_event_loop()
        gpu_stats = await self._poll_gpu()

        for cid in container_ids:
            raw = await loop.run_in_executor(None, self._get_container_stats, cid)
            if raw is None:
                continue
            stats = self._parse_docker_stats(cid, raw)

            # Attach GPU stats if available
            if gpu_stats:
                stats.gpu_utilization = gpu_stats["gpu_utilization"]
                stats.gpu_memory_mb = gpu_stats["gpu_memory_mb"]
                stats.gpu_memory_total_mb = gpu_stats["gpu_memory_total_mb"]

            self._stats_cache[cid] = stats

        return {cid: self._stats_cache[cid] for cid in container_ids if cid in self._stats_cache}

    async def _poll_loop(self, container_ids: list[str] | None = None) -> None:
        """Continuously poll stats."""
        while True:
            try:
                ids = container_ids
                if ids is None:
                    # Poll all running containers
                    containers = self.docker_client.containers.list()
                    ids = [c.short_id for c in containers]
                if ids:
                    await self.poll_once(ids)
            except Exception as exc:
                logger.debug("Poll cycle failed: %s", exc)
            await asyncio.sleep(self.poll_interval)
