"""Discovery REST endpoints — surface unregistered workspaces and containers."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import (
    ContainerCandidate,
    ContainerRecord,
    ContainerStatus,
    DiscoverRegisterRequest,
    DiscoveryResponse,
    ProjectType,
    WorkspaceCandidate,
)
from hub.services.discovery import (
    _discover_roots,
    registered_filter_sets,
    scan_container_candidates,
    scan_workspace_candidates,
)
from hub.services.registry import InvalidStateTransition

logger = logging.getLogger("hub.routers.discover")

router = APIRouter(prefix="/api/discover", tags=["discover"])


@router.get("", response_model=DiscoveryResponse)
async def discover_all(request: Request) -> DiscoveryResponse:
    """One call returns both workspace and container candidates.

    The dashboard uses this composite endpoint so it can render both
    sections atomically — two separate requests would show a flicker as
    one pane populates before the other.
    """
    registry = request.app.state.registry
    agent_registry = getattr(request.app.state, "agent_registry", None)
    registered_folders, registered_container_ids = await registered_filter_sets(registry)

    # Workspace scan hits the filesystem; container scan hits Docker. They
    # don't share state, so run in parallel.
    workspace_task = asyncio.to_thread(scan_workspace_candidates, registered_folders)
    container_task = asyncio.create_task(
        scan_container_candidates(registered_container_ids, agent_registry=agent_registry)
    )
    workspaces, containers = await asyncio.gather(workspace_task, container_task)

    return DiscoveryResponse(
        workspaces=[WorkspaceCandidate(**ws.__dict__) for ws in workspaces],
        containers=[ContainerCandidate(**c.__dict__) for c in containers],
        discover_roots=[str(r) for r in _discover_roots()],
    )


@router.get("/workspaces", response_model=list[WorkspaceCandidate])
async def discover_workspaces(request: Request) -> list[WorkspaceCandidate]:
    """Unregistered workspace folders under HIVE_DISCOVER_ROOTS."""
    registry = request.app.state.registry
    registered_folders, _ = await registered_filter_sets(registry)
    workspaces = await asyncio.to_thread(scan_workspace_candidates, registered_folders)
    return [WorkspaceCandidate(**ws.__dict__) for ws in workspaces]


@router.get("/containers", response_model=list[ContainerCandidate])
async def discover_containers_endpoint(request: Request) -> list[ContainerCandidate]:
    """Unregistered running Docker containers."""
    registry = request.app.state.registry
    agent_registry = getattr(request.app.state, "agent_registry", None)
    _, registered_container_ids = await registered_filter_sets(registry)
    candidates = await scan_container_candidates(
        registered_container_ids, agent_registry=agent_registry
    )
    return [ContainerCandidate(**c.__dict__) for c in candidates]


@router.post("/register", response_model=ContainerRecord, status_code=201)
async def register_discovered(request: Request, req: DiscoverRegisterRequest) -> ContainerRecord:
    """Register a discovered candidate.

    Two shapes:
      • workspace_folder only → treat like a normal registration; caller
        can opt into provision/start.
      • container_id (with or without workspace_folder) → register a
        container that's already running; we skip provision/start by
        default and link the existing Docker container ID.
    """
    if not req.workspace_folder and not req.container_id:
        raise HTTPException(400, "Provide workspace_folder or container_id (or both).")

    registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr

    # Case 1: purely container-driven — look up the container to discover
    # its workspace folder if the caller didn't supply one.
    resolved_workspace = req.workspace_folder
    resolved_container_id: str | None = None

    if req.container_id:
        import docker
        import docker.errors

        try:
            client = docker.from_env()
            container = client.containers.get(req.container_id)
            resolved_container_id = container.short_id
            if not resolved_workspace:
                from hub.services.discovery import _infer_workspace_from_container

                resolved_workspace = _infer_workspace_from_container(container)
            if not resolved_workspace:
                # Fall back to a /workspace/<name> pseudo-path so we still
                # have a stable registry key. Better than rejecting the
                # register outright — the user may not care about the host
                # path if they only interact via the hub.
                resolved_workspace = f"/workspace/{container.name or container.short_id}"
        except docker.errors.NotFound:
            raise HTTPException(404, f"Container {req.container_id} not found")
        except docker.errors.DockerException as exc:
            raise HTTPException(502, f"Docker unavailable: {exc}")

    # Reject if already registered — caller should have filtered this but
    # two browser tabs can race.
    if await registry.get_by_workspace(resolved_workspace):
        raise HTTPException(409, f"Workspace already registered: {resolved_workspace}")
    if resolved_container_id and await registry.get_by_container_id(resolved_container_id):
        raise HTTPException(409, f"Container already registered: {resolved_container_id}")

    # GPU exclusivity applies the same way here.
    has_gpu = req.project_type == ProjectType.ML_CUDA
    if has_gpu:
        gpu_owner = await registry.get_gpu_owner()
        if gpu_owner and not req.force_gpu:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": (
                        "GPU already owned by a running container. Stop it first, "
                        "or retry with force_gpu=true."
                    ),
                    "gpu_owner": {
                        "id": gpu_owner.id,
                        "project_name": gpu_owner.project_name,
                        "workspace_folder": gpu_owner.workspace_folder,
                    },
                },
            )

    record = await registry.add(
        workspace_folder=resolved_workspace,
        project_type=req.project_type.value,
        project_name=req.project_name,
        project_description=req.project_description,
        has_gpu=has_gpu,
    )

    # Link the discovered container, transition to running via STARTING
    # per the state machine.
    if resolved_container_id:
        try:
            await registry.update(record.id, container_status=ContainerStatus.STARTING.value)
            record = await registry.update(
                record.id,
                container_id=resolved_container_id,
                container_status=ContainerStatus.RUNNING.value,
            )
        except InvalidStateTransition as exc:
            logger.warning("State machine rejected transition during register: %s", exc)

    # auto_provision / auto_start from the request, identical semantics to
    # the containers.create flow. Defaults are off for discovered
    # registrations (see DiscoverRegisterRequest).
    if req.auto_provision:
        from bootstrapper.provision import TemplateError, provision

        try:
            provision(
                workspace=Path(resolved_workspace),
                project_type=req.project_type.value,
                project_name=req.project_name,
                project_description=req.project_description,
            )
        except TemplateError as exc:
            await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
            raise HTTPException(422, f"Template error: {exc}")
        except Exception as exc:
            await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
            raise HTTPException(500, f"Provisioning failed: {exc}")

    if req.auto_start and not resolved_container_id:
        import shutil

        if not shutil.which("devcontainer"):
            await registry.update(record.id, container_status=ContainerStatus.STOPPED.value)
        else:
            await registry.update(record.id, container_status=ContainerStatus.STARTING.value)
            try:
                result = await devcontainer_mgr.up(resolved_workspace)
                record = await registry.update(
                    record.id,
                    container_id=result.get("containerId", ""),
                    container_status=ContainerStatus.RUNNING.value,
                )
            except Exception as exc:
                await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
                raise HTTPException(500, f"devcontainer up failed: {exc}")

    # Probe for Claude CLI presence. Non-fatal — missing CLI is the
    # common case and the UI renders an install gate when has_claude_cli
    # is false. Only probe if we have a live container_id.
    if record.container_id:
        from datetime import datetime as _dt

        from hub.services.tool_probe import has_claude_cli as _probe

        try:
            found = await _probe(record.container_id)
        except Exception as exc:
            logger.debug("Claude CLI probe failed for %s: %s", record.container_id, exc)
            found = False
        record = await registry.update(
            record.id,
            has_claude_cli=int(found),
            claude_cli_checked_at=_dt.now().isoformat(),
        )

    return record
