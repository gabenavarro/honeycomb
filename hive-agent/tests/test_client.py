"""Tests for the hive-agent HTTP client."""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from hive_agent.client import ContainerStatus, HiveClient


@pytest.fixture
def hub_url() -> str:
    return "http://test-hub:8420"


@pytest.fixture
def client(hub_url: str) -> HiveClient:
    return HiveClient(
        hub_url=hub_url,
        container_id="test-container",
        heartbeat_interval=0.1,
        agent_port=9100,
    )


class TestHiveClient:
    def test_initial_status(self, client: HiveClient) -> None:
        assert client.status == ContainerStatus.STARTING

    def test_status_setter(self, client: HiveClient) -> None:
        client.status = ContainerStatus.BUSY
        assert client.status == ContainerStatus.BUSY

    def test_build_heartbeat_payload(self, client: HiveClient) -> None:
        client.status = ContainerStatus.IDLE
        client.set_session_info({"session_id": "abc123"})
        payload = client._build_heartbeat_payload()
        assert payload == {
            "container_id": "test-container",
            "status": "idle",
            "agent_port": 9100,
            "session_info": {"session_id": "abc123"},
        }

    @pytest.mark.asyncio
    @respx.mock
    async def test_send_heartbeat_success(self, client: HiveClient, hub_url: str) -> None:
        respx.post(f"{hub_url}/api/heartbeat").respond(200, json={"ok": True})
        await client.start()
        try:
            result = await client._send_heartbeat()
            assert result is True
        finally:
            await client.stop()

    @pytest.mark.asyncio
    @respx.mock
    async def test_send_heartbeat_failure(self, client: HiveClient, hub_url: str) -> None:
        respx.post(f"{hub_url}/api/heartbeat").respond(500)
        await client.start()
        try:
            result = await client._send_heartbeat()
            assert result is False
        finally:
            await client.stop()

    @pytest.mark.asyncio
    @respx.mock
    async def test_send_event(self, client: HiveClient, hub_url: str) -> None:
        route = respx.post(f"{hub_url}/api/events").respond(200, json={"ok": True})
        await client.start()
        try:
            result = await client.send_event("command_completed", {"exit_code": 0})
            assert result is True
            assert route.called
            body = route.calls[0].request.content
            import json
            parsed = json.loads(body)
            assert parsed["container_id"] == "test-container"
            assert parsed["event_type"] == "command_completed"
        finally:
            await client.stop()

    @pytest.mark.asyncio
    @respx.mock
    async def test_start_sets_idle(self, client: HiveClient, hub_url: str) -> None:
        respx.post(f"{hub_url}/api/heartbeat").respond(200, json={"ok": True})
        await client.start()
        try:
            assert client.status == ContainerStatus.IDLE
        finally:
            await client.stop()

    @pytest.mark.asyncio
    @respx.mock
    async def test_stop_cancels_heartbeat(self, client: HiveClient, hub_url: str) -> None:
        respx.post(f"{hub_url}/api/heartbeat").respond(200, json={"ok": True})
        await client.start()
        assert client._heartbeat_task is not None
        await client.stop()
        assert client._heartbeat_task is None
        assert client._http is None
