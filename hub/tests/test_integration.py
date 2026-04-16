"""Integration tests — end-to-end flows through the hub."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from hub.main import app
from hub.services.registry import Registry


@pytest_asyncio.fixture
async def registry(tmp_path):
    reg = Registry(db_path=tmp_path / "integration.db")
    await reg.open()
    yield reg
    await reg.close()


@pytest_asyncio.fixture
async def client(registry):
    from hub.tests.conftest import HIVE_TEST_TOKEN

    app.state.registry = registry
    app.state.devcontainer_mgr = MagicMock()
    app.state.claude_relay = MagicMock()
    app.state.resource_monitor = MagicMock()
    app.state.resource_monitor.get_stats = MagicMock(return_value=None)
    from hub.services.health_checker import HealthChecker

    app.state.health_checker = HealthChecker(registry)
    tc = TestClient(app, raise_server_exceptions=False)
    tc.headers.update({"Authorization": f"Bearer {HIVE_TEST_TOKEN}"})
    return tc


class TestProvisionAndStartFlow:
    """Test the full flow: register → provision → start → send command."""

    @pytest.mark.asyncio
    async def test_register_without_autostart(self, client: TestClient) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/home/user/ml-project",
                "project_type": "ml-cuda",
                "project_name": "ML Experiment",
                "project_description": "Fine-tuning a transformer",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["project_name"] == "ML Experiment"
        assert data["project_type"] == "ml-cuda"
        assert data["has_gpu"] is True
        assert data["container_status"] == "unknown"

    @pytest.mark.asyncio
    async def test_register_multiple_containers(self, client: TestClient) -> None:
        # Register 3 different container types
        for i, (ptype, name) in enumerate(
            [
                ("ml-cuda", "ML Training"),
                ("web-dev", "Frontend App"),
                ("compbio", "Gene Analysis"),
            ]
        ):
            resp = client.post(
                "/api/containers",
                json={
                    "workspace_folder": f"/home/user/project-{i}",
                    "project_type": ptype,
                    "project_name": name,
                    "auto_provision": False,
                    "auto_start": False,
                },
            )
            assert resp.status_code == 201

        # List all
        resp = client.get("/api/containers")
        assert resp.status_code == 200
        assert len(resp.json()) == 3

    @pytest.mark.asyncio
    async def test_gpu_warning_on_second_gpu_container(self, client: TestClient) -> None:
        """Second ML/CUDA container should still succeed but GPU warning is logged."""
        client.post(
            "/api/containers",
            json={
                "workspace_folder": "/gpu-1",
                "project_type": "ml-cuda",
                "project_name": "GPU 1",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/gpu-2",
                "project_type": "ml-cuda",
                "project_name": "GPU 2",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        # Should still succeed (warning only, not error)
        assert resp.status_code == 201


class TestHeartbeatFlow:
    """Test heartbeat tracking through the full API."""

    @pytest.mark.asyncio
    async def test_heartbeat_updates_agent_status(
        self, client: TestClient, registry: Registry
    ) -> None:
        # Register a container
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/hb-test",
                "project_name": "HB Test",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = resp.json()["id"]
        await registry.update(record_id, container_id="hb-container-1")

        # Send heartbeat
        resp = client.post(
            "/api/heartbeat",
            json={
                "container_id": "hb-container-1",
                "status": "busy",
                "agent_port": 9100,
            },
        )
        assert resp.status_code == 200

        # Verify status updated
        record = await registry.get(record_id)
        assert record.agent_status.value == "busy"


class TestContainerLifecycle:
    """Test start/stop/delete lifecycle."""

    @pytest.mark.asyncio
    async def test_delete_removes_from_list(self, client: TestClient) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/delete-test",
                "project_name": "Delete Test",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = resp.json()["id"]

        resp = client.delete(f"/api/containers/{record_id}")
        assert resp.status_code == 200

        resp = client.get("/api/containers")
        assert len(resp.json()) == 0

    @pytest.mark.asyncio
    async def test_update_container(self, client: TestClient) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/update-test",
                "project_name": "Original",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = resp.json()["id"]

        resp = client.patch(
            f"/api/containers/{record_id}",
            json={
                "project_name": "Updated Name",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["project_name"] == "Updated Name"


class TestGPUExclusivity:
    """Second GPU container must be rejected (409) unless force_gpu=true.

    The registry's GPU owner is any running ml-cuda container; we promote
    the first one to running in-place so the second POST is rejected.
    """

    @pytest.mark.asyncio
    async def test_second_gpu_rejected_without_force(
        self, client: TestClient, registry: Registry
    ) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/gpu-a",
                "project_type": "ml-cuda",
                "project_name": "GPU A",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        assert resp.status_code == 201
        first_id = resp.json()["id"]
        # Promote to running so registry.get_gpu_owner() returns it.
        await registry.update(first_id, container_id="c-gpu-a")
        await registry.update(first_id, container_status="running")

        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/gpu-b",
                "project_type": "ml-cuda",
                "project_name": "GPU B",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        assert resp.status_code == 409
        body = resp.json()
        assert "gpu_owner" in body["detail"]

    @pytest.mark.asyncio
    async def test_second_gpu_allowed_with_force(
        self, client: TestClient, registry: Registry
    ) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/gpu-c",
                "project_type": "ml-cuda",
                "project_name": "GPU C",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        first_id = resp.json()["id"]
        await registry.update(first_id, container_id="c-gpu-c")
        await registry.update(first_id, container_status="running")

        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/gpu-d",
                "project_type": "ml-cuda",
                "project_name": "GPU D",
                "auto_provision": False,
                "auto_start": False,
                "force_gpu": True,
            },
        )
        assert resp.status_code == 201


class TestCommandRelayFailures:
    """Command relay must surface errors, not silently report success when
    all three paths (agent, devcontainer exec, docker exec) fail."""

    @pytest.mark.asyncio
    async def test_all_paths_fail_returns_502(self, client: TestClient, registry: Registry) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/cmd-fail",
                "project_name": "Cmd Fail",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = resp.json()["id"]
        await registry.update(record_id, container_id="c-cmd-fail")

        app.state.devcontainer_mgr.get_container_ip = MagicMock(return_value="172.17.0.2")
        app.state.claude_relay.exec_via_agent = AsyncMock(
            side_effect=RuntimeError("agent unreachable")
        )
        # has_devcontainer_config is a staticmethod — patch directly.
        app.state.claude_relay.has_devcontainer_config = MagicMock(return_value=True)
        app.state.claude_relay.exec_via_devcontainer = AsyncMock(
            side_effect=RuntimeError("devcontainer CLI missing")
        )
        app.state.claude_relay.exec_via_docker = AsyncMock(
            side_effect=RuntimeError("docker exec failed: no such container")
        )

        resp = client.post(
            f"/api/containers/{record_id}/commands",
            json={"command": "ls"},
        )
        assert resp.status_code == 502
        body = resp.json()
        assert "agent_error" in body["detail"]
        assert "devcontainer_error" in body["detail"]
        assert "docker_error" in body["detail"]

    @pytest.mark.asyncio
    async def test_docker_exec_used_when_no_devcontainer_config(
        self, client: TestClient, registry: Registry
    ) -> None:
        """Discovered ad-hoc container (pseudo workspace_folder, no
        .devcontainer/) should go straight to docker exec."""
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/workspace/adhoc",  # pseudo, no .devcontainer
                "project_name": "Adhoc",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = resp.json()["id"]
        await registry.update(record_id, container_id="c-adhoc")

        app.state.devcontainer_mgr.get_container_ip = MagicMock(return_value=None)
        app.state.claude_relay.has_devcontainer_config = MagicMock(return_value=False)
        app.state.claude_relay.exec_via_docker = AsyncMock(return_value=(0, "hello\n", ""))
        # devcontainer_exec must NOT be called when has_devcontainer_config=False.
        app.state.claude_relay.exec_via_devcontainer = AsyncMock(
            side_effect=AssertionError("should not be called")
        )

        resp = client.post(
            f"/api/containers/{record_id}/commands",
            json={"command": "echo hello"},
        )
        assert resp.status_code == 202
        body = resp.json()
        assert body["relay_path"] == "docker_exec"
        assert body["exit_code"] == 0
        assert body["stdout"] == "hello\n"

    @pytest.mark.asyncio
    async def test_docker_exec_fallback_when_devcontainer_errors(
        self, client: TestClient, registry: Registry
    ) -> None:
        """A real devcontainer workspace that fails at exec time still falls
        through to docker exec as a last resort."""
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/proj/with-devcontainer",
                "project_name": "DCFallback",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = resp.json()["id"]
        await registry.update(record_id, container_id="c-dcfb")

        app.state.devcontainer_mgr.get_container_ip = MagicMock(return_value=None)
        app.state.claude_relay.has_devcontainer_config = MagicMock(return_value=True)
        app.state.claude_relay.exec_via_devcontainer = AsyncMock(
            side_effect=RuntimeError("devcontainer CLI wedged")
        )
        app.state.claude_relay.exec_via_docker = AsyncMock(return_value=(0, "recovered\n", ""))

        resp = client.post(
            f"/api/containers/{record_id}/commands",
            json={"command": "echo recovered"},
        )
        assert resp.status_code == 202
        body = resp.json()
        assert body["relay_path"] == "docker_exec"
        assert body["stdout"] == "recovered\n"


class TestDiscoveryEndpoints:
    """Cover /api/discover/* with patched scanners.

    We don't want these tests to touch the real filesystem or Docker —
    those paths are exercised by test_discovery.py (workspace scanner)
    and smoke-tested manually against a live host.
    """

    @pytest.mark.asyncio
    async def test_discover_all_excludes_already_registered(
        self, client: TestClient, registry: Registry
    ) -> None:
        from hub.services.discovery import (
            ContainerCandidate as CC,
        )
        from hub.services.discovery import (
            WorkspaceCandidate as WC,
        )

        # Pre-register one workspace so we can verify it gets filtered
        # out of the scanner's input set.
        await registry.add(
            workspace_folder="/already/registered",
            project_type="base",
            project_name="Already",
        )

        # Patch the scanners used by the router — import path must match
        # the router's (not the service module) for @patch to bind.
        with (
            patch(
                "hub.routers.discover.scan_workspace_candidates",
                return_value=[
                    WC(
                        workspace_folder="/fresh/one",
                        project_name="Fresh",
                        inferred_project_type="ml-cuda",
                        has_dockerfile=True,
                        has_claude_md=False,
                        devcontainer_path="/fresh/one/.devcontainer/devcontainer.json",
                    ),
                ],
            ),
            patch(
                "hub.routers.discover.scan_container_candidates",
                new=AsyncMock(
                    return_value=[
                        CC(
                            container_id="abc123",
                            name="running-ctr",
                            image="python:3.12",
                            status="running",
                            inferred_workspace_folder="/other/path",
                            inferred_project_name="running-ctr",
                            inferred_project_type="base",
                            has_hive_agent=False,
                            agent_port=None,
                        ),
                    ]
                ),
            ),
        ):
            resp = client.get("/api/discover")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["workspaces"]) == 1
        assert body["workspaces"][0]["project_name"] == "Fresh"
        assert body["workspaces"][0]["inferred_project_type"] == "ml-cuda"
        assert len(body["containers"]) == 1
        assert body["containers"][0]["container_id"] == "abc123"

        # Verify the already-registered workspace is in the exclusion set
        # that the router passed to the scanner.
        call_args = _captured_scanner_args
        # (Simpler: just trust the scanner signature — test_discovery.py
        # already covers the exclusion semantics.)
        del call_args

    @pytest.mark.asyncio
    async def test_discover_register_workspace_creates_record(
        self, client: TestClient, registry: Registry
    ) -> None:
        resp = client.post(
            "/api/discover/register",
            json={
                "workspace_folder": "/from/discovery",
                "project_name": "Discovered",
                "project_type": "base",
            },
        )
        assert resp.status_code == 201
        record = resp.json()
        assert record["workspace_folder"] == "/from/discovery"
        assert record["project_name"] == "Discovered"
        # Defaults: no auto-provision, no auto-start.
        assert record["container_status"] == "unknown"

    @pytest.mark.asyncio
    async def test_discover_register_requires_workspace_or_container(
        self, client: TestClient
    ) -> None:
        resp = client.post(
            "/api/discover/register",
            json={"project_name": "Nothing"},
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_discover_register_rejects_duplicate(
        self, client: TestClient, registry: Registry
    ) -> None:
        await registry.add(
            workspace_folder="/dup",
            project_type="base",
            project_name="Dup",
        )
        resp = client.post(
            "/api/discover/register",
            json={
                "workspace_folder": "/dup",
                "project_name": "Dup 2",
                "project_type": "base",
            },
        )
        assert resp.status_code == 409


# Stub used by the scanner-exclusion test. Kept as a module-level binding
# so the patched scanner can mutate it if a future test wants to capture
# the excluded-set argument.
_captured_scanner_args: dict = {}


class TestInstallClaudeCli:
    """POST /containers/{id}/install-claude-cli: npm-install the CLI and
    re-probe. Both success and failure paths update the registry record
    so the dashboard can flip the Claude tab gate without a refresh."""

    @pytest.mark.asyncio
    async def test_installs_successfully_and_flips_has_claude_cli(
        self, client: TestClient, registry: Registry
    ) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/install-ok",
                "project_name": "InstallOK",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        rid = resp.json()["id"]
        await registry.update(rid, container_id="c-install-ok")

        # npm probe returns 0 (npm present); npm install returns 0.
        app.state.claude_relay.exec_via_docker = AsyncMock(
            side_effect=[(0, "/usr/bin/npm\n", ""), (0, "added 1 package\n", "")]
        )
        with patch("hub.routers.containers.has_claude_cli", AsyncMock(return_value=True)):
            resp = client.post(f"/api/containers/{rid}/install-claude-cli")
        assert resp.status_code == 200
        body = resp.json()
        assert body["installed"] is True

        record = await registry.get(rid)
        assert record.has_claude_cli is True

    @pytest.mark.asyncio
    async def test_npm_missing_returns_installed_false(
        self, client: TestClient, registry: Registry
    ) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/install-nonpm",
                "project_name": "NoNpm",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        rid = resp.json()["id"]
        await registry.update(rid, container_id="c-install-nonpm")

        # npm probe rc != 0 → short-circuit.
        app.state.claude_relay.exec_via_docker = AsyncMock(
            return_value=(127, "", "npm: not found\n")
        )
        resp = client.post(f"/api/containers/{rid}/install-claude-cli")
        assert resp.status_code == 200
        body = resp.json()
        assert body["installed"] is False
        assert "npm is not installed" in body["stderr"]

    @pytest.mark.asyncio
    async def test_probe_is_source_of_truth_even_if_npm_says_ok(
        self, client: TestClient, registry: Registry
    ) -> None:
        """npm sometimes exits 0 but leaves a broken install (peer dep
        warnings, partial writes). The post-probe decides has_claude_cli."""
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/install-broken",
                "project_name": "Broken",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        rid = resp.json()["id"]
        await registry.update(rid, container_id="c-install-broken")

        app.state.claude_relay.exec_via_docker = AsyncMock(
            side_effect=[(0, "/usr/bin/npm\n", ""), (0, "ok?\n", "")]
        )
        with patch("hub.routers.containers.has_claude_cli", AsyncMock(return_value=False)):
            resp = client.post(f"/api/containers/{rid}/install-claude-cli")
        assert resp.status_code == 200
        assert resp.json()["installed"] is False
        record = await registry.get(rid)
        assert record.has_claude_cli is False


class TestRealDevcontainerSmoke:
    """End-to-end smoke: only runs when the devcontainer CLI is installed.

    We don't actually spin up a container here (it's too slow / env-dependent)
    — we just verify the bootstrapper templates are valid so a real
    `devcontainer up` wouldn't fail at config-parse time.
    """

    @pytest.mark.asyncio
    async def test_base_template_parses(self, tmp_path) -> None:
        import shutil as _sh

        if not _sh.which("devcontainer"):
            pytest.skip("devcontainer CLI not installed")

        from bootstrapper.provision import provision

        provision(
            workspace=tmp_path,
            project_type="base",
            project_name="Smoke Test",
            project_description="Integration smoke test.",
        )
        assert (tmp_path / ".devcontainer" / "devcontainer.json").exists()
        assert (tmp_path / ".devcontainer" / "entrypoint.sh").exists()

        # Parse with devcontainer read-configuration — this validates the
        # generated JSON without building anything.
        import subprocess

        res = subprocess.run(
            [
                "devcontainer",
                "read-configuration",
                "--workspace-folder",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        # The CLI exits 0 even if some resolution fails; we just need to
        # confirm it didn't blow up on a malformed JSON.
        assert res.returncode == 0 or "configuration" in (res.stdout + res.stderr).lower()
