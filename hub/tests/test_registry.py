"""Tests for the SQLite container registry."""

from __future__ import annotations

import pytest
import pytest_asyncio

from hub.models.schemas import AgentStatus, ContainerStatus, ProjectType
from hub.services.registry import InvalidStateTransition, Registry


@pytest_asyncio.fixture
async def registry(tmp_path):
    db_path = tmp_path / "test_registry.db"
    reg = Registry(db_path=db_path)
    await reg.open()
    yield reg
    await reg.close()


class TestRegistry:
    @pytest.mark.asyncio
    async def test_add_and_get(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/home/user/project",
            project_type="ml-cuda",
            project_name="Test ML Project",
            project_description="A test project",
            git_repo_url="https://github.com/user/project",
            has_gpu=True,
        )
        assert record.id == 1
        assert record.workspace_folder == "/home/user/project"
        assert record.project_type == ProjectType.ML_CUDA
        assert record.project_name == "Test ML Project"
        assert record.has_gpu is True
        # Newly-added records start with the Claude CLI flag off; the
        # probe runs asynchronously after registration.
        assert record.has_claude_cli is False
        assert record.claude_cli_checked_at is None

        fetched = await registry.get(1)
        assert fetched.project_name == "Test ML Project"

    @pytest.mark.asyncio
    async def test_update_has_claude_cli(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/proj/claude",
            project_type="base",
            project_name="Claude Probe",
        )
        updated = await registry.update(
            record.id,
            has_claude_cli=1,
            claude_cli_checked_at="2026-04-14T12:00:00",
        )
        assert updated.has_claude_cli is True
        assert updated.claude_cli_checked_at is not None

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, registry: Registry) -> None:
        with pytest.raises(KeyError):
            await registry.get(999)

    @pytest.mark.asyncio
    async def test_get_by_workspace(self, registry: Registry) -> None:
        await registry.add(
            workspace_folder="/home/user/alpha",
            project_type="base",
            project_name="Alpha",
        )
        record = await registry.get_by_workspace("/home/user/alpha")
        assert record is not None
        assert record.project_name == "Alpha"

        missing = await registry.get_by_workspace("/nonexistent")
        assert missing is None

    @pytest.mark.asyncio
    async def test_list_all(self, registry: Registry) -> None:
        await registry.add(workspace_folder="/a", project_type="base", project_name="A")
        await registry.add(workspace_folder="/b", project_type="web-dev", project_name="B")
        await registry.add(workspace_folder="/c", project_type="compbio", project_name="C")

        all_records = await registry.list_all()
        assert len(all_records) == 3

    @pytest.mark.asyncio
    async def test_update(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/test",
            project_type="base",
            project_name="Original",
        )
        updated = await registry.update(
            record.id,
            project_name="Updated",
            container_id="abc123",
            container_status=ContainerStatus.RUNNING.value,
        )
        assert updated.project_name == "Updated"
        assert updated.container_id == "abc123"
        assert updated.container_status == ContainerStatus.RUNNING

    @pytest.mark.asyncio
    async def test_update_by_container_id(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/test",
            project_type="base",
            project_name="Test",
        )
        await registry.update(record.id, container_id="container-abc")

        updated = await registry.update_by_container_id(
            "container-abc", agent_status=AgentStatus.IDLE.value
        )
        assert updated is not None
        assert updated.agent_status == AgentStatus.IDLE

        # Nonexistent container
        result = await registry.update_by_container_id("nonexistent", agent_status="idle")
        assert result is None

    @pytest.mark.asyncio
    async def test_delete(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/delete-me",
            project_type="base",
            project_name="Delete Me",
        )
        deleted = await registry.delete(record.id)
        assert deleted is True

        deleted_again = await registry.delete(record.id)
        assert deleted_again is False

    @pytest.mark.asyncio
    async def test_gpu_owner(self, registry: Registry) -> None:
        # No GPU owner initially
        owner = await registry.get_gpu_owner()
        assert owner is None

        # Add a GPU container but don't start it
        record = await registry.add(
            workspace_folder="/ml",
            project_type="ml-cuda",
            project_name="ML",
            has_gpu=True,
        )
        owner = await registry.get_gpu_owner()
        assert owner is None  # Not running

        # Mark as running
        await registry.update(record.id, container_status="running")
        owner = await registry.get_gpu_owner()
        assert owner is not None
        assert owner.project_name == "ML"

    @pytest.mark.asyncio
    async def test_duplicate_workspace(self, registry: Registry) -> None:
        await registry.add(workspace_folder="/unique", project_type="base", project_name="First")
        import aiosqlite

        with pytest.raises(aiosqlite.IntegrityError):
            await registry.add(
                workspace_folder="/unique", project_type="base", project_name="Second"
            )


class TestStateMachine:
    @pytest.mark.asyncio
    async def test_error_to_running_rejected(self, registry: Registry) -> None:
        # ERROR → RUNNING must go through STARTING. Reject the direct jump.
        record = await registry.add(
            workspace_folder="/sm1", project_type="base", project_name="SM1"
        )
        await registry.update(record.id, container_status=ContainerStatus.ERROR.value)

        with pytest.raises(InvalidStateTransition):
            await registry.update(record.id, container_status=ContainerStatus.RUNNING.value)

    @pytest.mark.asyncio
    async def test_error_to_starting_to_running_allowed(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/sm2", project_type="base", project_name="SM2"
        )
        await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
        await registry.update(record.id, container_status=ContainerStatus.STARTING.value)
        updated = await registry.update(record.id, container_status=ContainerStatus.RUNNING.value)
        assert updated.container_status == ContainerStatus.RUNNING

    @pytest.mark.asyncio
    async def test_noop_same_state_is_dropped(self, registry: Registry) -> None:
        # Writing the same status repeatedly should not mutate updated_at when
        # no other fields changed.
        record = await registry.add(
            workspace_folder="/sm3", project_type="base", project_name="SM3"
        )
        first = await registry.update(record.id, container_status=ContainerStatus.RUNNING.value)
        second = await registry.update(record.id, container_status=ContainerStatus.RUNNING.value)
        assert first.updated_at == second.updated_at

    @pytest.mark.asyncio
    async def test_noop_same_state_other_fields_still_write(self, registry: Registry) -> None:
        # Same status + real field change: drop the status, commit the field.
        record = await registry.add(
            workspace_folder="/sm4", project_type="base", project_name="SM4"
        )
        await registry.update(record.id, container_status=ContainerStatus.RUNNING.value)
        updated = await registry.update(
            record.id,
            container_status=ContainerStatus.RUNNING.value,
            agent_port=9200,
        )
        assert updated.agent_port == 9200
