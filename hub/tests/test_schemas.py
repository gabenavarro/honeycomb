"""Tests for Pydantic schemas."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from hub.models.schemas import (
    CommandRequest,
    ContainerCreate,
    HeartbeatPayload,
    ProjectType,
    WSFrame,
)


class TestContainerCreate:
    def test_valid(self) -> None:
        req = ContainerCreate(
            workspace_folder="/home/user/project",
            project_type=ProjectType.ML_CUDA,
            project_name="My ML Project",
            project_description="A cool project",
        )
        assert req.project_type == ProjectType.ML_CUDA
        assert req.auto_provision is True
        assert req.auto_start is True

    def test_defaults(self) -> None:
        req = ContainerCreate(
            workspace_folder="/test",
            project_name="Test",
        )
        assert req.project_type == ProjectType.BASE
        assert req.project_description == ""
        assert req.git_repo_url is None

    def test_empty_name_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ContainerCreate(workspace_folder="/test", project_name="")


class TestHeartbeatPayload:
    def test_valid(self) -> None:
        hb = HeartbeatPayload(
            container_id="abc123",
            status="idle",
            agent_port=9100,
        )
        assert hb.session_info == {}

    def test_with_session_info(self) -> None:
        hb = HeartbeatPayload(
            container_id="abc123",
            status="busy",
            session_info={"session_id": "xyz"},
        )
        assert hb.session_info["session_id"] == "xyz"


class TestCommandRequest:
    def test_valid(self) -> None:
        req = CommandRequest(command="echo hello")
        assert req.command_id is None

    def test_empty_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CommandRequest(command="")


class TestWSFrame:
    def test_serialization(self) -> None:
        frame = WSFrame(channel="container-1", event="output", data="hello world")
        dumped = frame.model_dump_json()
        assert "container-1" in dumped
        assert "output" in dumped
