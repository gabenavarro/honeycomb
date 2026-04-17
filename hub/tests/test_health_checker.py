"""Tests for the health checker service."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
import pytest_asyncio

from hub.services.health_checker import (
    HEARTBEAT_TIMEOUT_SECONDS,
    INITIAL_HEARTBEAT_GRACE_SECONDS,
    HealthChecker,
)
from hub.services.registry import Registry


@pytest_asyncio.fixture
async def registry(tmp_path):
    reg = Registry(db_path=tmp_path / "test.db")
    await reg.open()
    yield reg
    await reg.close()


@pytest_asyncio.fixture
async def checker(registry):
    hc = HealthChecker(registry, check_interval=60)  # Don't auto-loop in tests
    yield hc


class TestHealthChecker:
    @pytest.mark.asyncio
    async def test_record_heartbeat(self, checker: HealthChecker) -> None:
        await checker.record_heartbeat("container-1")
        assert "container-1" in checker._last_heartbeat

    @pytest.mark.asyncio
    async def test_healthy_container_stays_healthy(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        record = await registry.add(
            workspace_folder="/test",
            project_type="base",
            project_name="Test",
        )
        await registry.update(
            record.id,
            container_id="c1",
            container_status="running",
            agent_status="idle",
        )
        await checker.record_heartbeat("c1")

        await checker._check_all()

        updated = await registry.get(record.id)
        assert updated.agent_status.value == "idle"

    @pytest.mark.asyncio
    async def test_stale_heartbeat_marks_unreachable(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        record = await registry.add(
            workspace_folder="/stale",
            project_type="base",
            project_name="Stale",
        )
        await registry.update(
            record.id,
            container_id="c2",
            container_status="running",
            agent_status="idle",
        )
        # Set heartbeat to past
        checker._last_heartbeat["c2"] = datetime.now() - timedelta(
            seconds=HEARTBEAT_TIMEOUT_SECONDS + 5
        )

        await checker._check_all()

        updated = await registry.get(record.id)
        assert updated.agent_status.value == "unreachable"

    @pytest.mark.asyncio
    async def test_resumed_heartbeat_clears_unreachable(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        record = await registry.add(
            workspace_folder="/resume",
            project_type="base",
            project_name="Resume",
        )
        await registry.update(
            record.id,
            container_id="c3",
            container_status="running",
            agent_status="unreachable",
        )
        # Fresh heartbeat
        await checker.record_heartbeat("c3")

        await checker._check_all()

        updated = await registry.get(record.id)
        assert updated.agent_status.value == "idle"

    @pytest.mark.asyncio
    async def test_stopped_containers_ignored(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        record = await registry.add(
            workspace_folder="/stopped",
            project_type="base",
            project_name="Stopped",
        )
        await registry.update(
            record.id,
            container_id="c4",
            container_status="stopped",
            agent_status="idle",
        )
        checker._last_heartbeat["c4"] = datetime.now() - timedelta(seconds=300)

        await checker._check_all()

        updated = await registry.get(record.id)
        # Should remain idle, not marked unreachable (container is stopped)
        assert updated.agent_status.value == "idle"

    @pytest.mark.asyncio
    async def test_never_heartbeat_marked_unreachable_after_grace(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        record = await registry.add(
            workspace_folder="/never",
            project_type="base",
            project_name="Never",
        )
        past = (datetime.now() - timedelta(seconds=INITIAL_HEARTBEAT_GRACE_SECONDS + 5)).isoformat()
        # Post-M7 the registry exposes a SQLAlchemy AsyncEngine instead
        # of an aiosqlite connection. We back-date `created_at` through
        # a raw Core update so the health-checker sees a row that's
        # already past the grace window.
        import sqlalchemy as sa

        from hub.db.schema import containers

        async with registry.engine.begin() as conn:
            await conn.execute(
                sa.update(containers)
                .where(containers.c.id == record.id)
                .values(
                    container_id="c-never",
                    container_status="running",
                    agent_status="idle",
                    created_at=past,
                    updated_at=past,
                )
            )

        await checker._check_all()

        updated = await registry.get(record.id)
        assert updated.agent_status.value == "unreachable"

    @pytest.mark.asyncio
    async def test_never_heartbeat_in_grace_stays_idle(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        record = await registry.add(
            workspace_folder="/booting",
            project_type="base",
            project_name="Booting",
        )
        await registry.update(
            record.id,
            container_id="c-boot",
            container_status="running",
            agent_status="idle",
        )

        await checker._check_all()

        updated = await registry.get(record.id)
        # Within grace window: no heartbeat yet, but not marked unreachable
        assert updated.agent_status.value == "idle"

    @pytest.mark.asyncio
    async def test_agent_not_expected_stays_idle_forever(
        self, registry: Registry, checker: HealthChecker
    ) -> None:
        """M13: records registered via the Discover tab without
        provisioning set ``agent_expected=False``. The health checker
        must NEVER mark these records unreachable, even well past the
        grace window, because no hive-agent was ever installed.
        """
        record = await registry.add(
            workspace_folder="/bare",
            project_type="base",
            project_name="Bare",
            agent_expected=False,
        )
        past = (
            datetime.now() - timedelta(seconds=INITIAL_HEARTBEAT_GRACE_SECONDS + 600)
        ).isoformat()
        import sqlalchemy as sa

        from hub.db.schema import containers

        async with registry.engine.begin() as conn:
            await conn.execute(
                sa.update(containers)
                .where(containers.c.id == record.id)
                .values(
                    container_id="c-bare",
                    container_status="running",
                    agent_status="idle",
                    created_at=past,
                    updated_at=past,
                )
            )

        await checker._check_all()

        updated = await registry.get(record.id)
        assert updated.agent_status.value == "idle"
        assert updated.agent_expected is False
