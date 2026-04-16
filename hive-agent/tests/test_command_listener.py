"""Tests for the command listener HTTP server."""

from __future__ import annotations

import pytest
from hive_agent.client import ContainerStatus, HiveClient
from hive_agent.command_listener import CommandRunner, create_app
from starlette.testclient import TestClient


@pytest.fixture
def hive_client() -> HiveClient:
    client = HiveClient(
        hub_url="http://test-hub:8420",
        container_id="test-container",
        agent_port=9100,
    )
    client._status = ContainerStatus.IDLE
    return client


@pytest.fixture
def app(hive_client: HiveClient) -> TestClient:
    starlette_app = create_app(hive_client)
    return TestClient(starlette_app)


class TestHealthEndpoint:
    def test_health_returns_ok(self, app: TestClient, hive_client: HiveClient) -> None:
        resp = app.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["container_id"] == "test-container"
        assert data["agent_status"] == "idle"


class TestStatusEndpoint:
    def test_status_returns_container_info(self, app: TestClient) -> None:
        resp = app.get("/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["container_id"] == "test-container"
        assert data["status"] == "idle"
        assert data["running_commands"] == []


class TestExecEndpoint:
    def test_exec_requires_command(self, app: TestClient) -> None:
        resp = app.post("/exec", json={})
        assert resp.status_code == 400
        assert "command is required" in resp.json()["error"]

    def test_exec_returns_command_id(self, app: TestClient) -> None:
        resp = app.post("/exec", json={"command": "echo hello"})
        assert resp.status_code == 202
        data = resp.json()
        assert "command_id" in data
        assert "pid" in data

    def test_exec_accepts_custom_command_id(self, app: TestClient) -> None:
        resp = app.post("/exec", json={"command": "echo hello", "command_id": "my-cmd"})
        assert resp.status_code == 202
        assert resp.json()["command_id"] == "my-cmd"


class TestOutputEndpoint:
    def test_get_output_empty(self, app: TestClient) -> None:
        resp = app.get("/output/nonexistent")
        assert resp.status_code == 200
        data = resp.json()
        assert data["running"] is False
        assert data["output"] == []

    def test_get_output_after_exec(self, app: TestClient) -> None:
        # Execute a fast command
        exec_resp = app.post("/exec", json={"command": "echo hello"})
        cmd_id = exec_resp.json()["command_id"]

        # Give the process a moment to complete
        import time

        time.sleep(0.5)

        resp = app.get(f"/output/{cmd_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert any("hello" in line for line in data["output"])


class TestKillEndpoint:
    def test_kill_nonexistent(self, app: TestClient) -> None:
        resp = app.post("/kill/nonexistent")
        assert resp.status_code == 200
        assert resp.json()["killed"] is False


class TestCommandRunner:
    @pytest.mark.asyncio
    async def test_run_captures_output(self) -> None:
        runner = CommandRunner()
        result = await runner.run("echo test-output", command_id="t1")
        assert result["command_id"] == "t1"

        # Wait for process to complete
        import asyncio

        await asyncio.sleep(0.5)

        output = runner.get_output("t1")
        assert any("test-output" in line for line in output)
        assert not runner.is_running("t1")

    @pytest.mark.asyncio
    async def test_cleanup(self) -> None:
        runner = CommandRunner()
        await runner.run("echo cleanup-test", command_id="t2")

        import asyncio

        await asyncio.sleep(0.5)

        runner.cleanup("t2")
        assert runner.get_output("t2") == []

    @pytest.mark.asyncio
    async def test_kill_running_process(self) -> None:
        runner = CommandRunner()
        await runner.run("sleep 60", command_id="t3")

        import asyncio

        await asyncio.sleep(0.2)

        assert runner.is_running("t3")
        killed = await runner.kill("t3")
        assert killed is True
        assert not runner.is_running("t3")
