"""Container management REST endpoints."""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import (
    ContainerCreate,
    ContainerRecord,
    ContainerStatus,
    ContainerUpdate,
    ProjectType,
    ResourceStats,
)
from hub.services.registry import InvalidStateTransition
from hub.services.tool_probe import has_claude_cli

logger = logging.getLogger("hub.routers.containers")

router = APIRouter(prefix="/api/containers", tags=["containers"])


@router.post("", response_model=ContainerRecord, status_code=201)
async def create_container(request: Request, req: ContainerCreate) -> ContainerRecord:
    """Register and optionally provision + start a new devcontainer."""
    registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr

    # Check if already registered
    existing = await registry.get_by_workspace(req.workspace_folder)
    if existing:
        raise HTTPException(409, f"Workspace already registered: {req.workspace_folder}")

    # GPU exclusivity: the host has a single GPU. A second GPU-enabled
    # container would silently compete for memory, so reject unless the
    # caller passes force_gpu=True.
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
        if gpu_owner and req.force_gpu:
            logger.warning(
                "GPU already owned by '%s' (%s); force_gpu=true — both will share the GPU.",
                gpu_owner.project_name,
                gpu_owner.workspace_folder,
            )

    # Register
    record = await registry.add(
        workspace_folder=req.workspace_folder,
        project_type=req.project_type.value,
        project_name=req.project_name,
        project_description=req.project_description,
        git_repo_url=req.git_repo_url,
        has_gpu=has_gpu,
    )

    # Provision
    if req.auto_provision:
        from bootstrapper.provision import TemplateError, provision

        try:
            provision(
                workspace=Path(req.workspace_folder),
                project_type=req.project_type.value,
                project_name=req.project_name,
                project_description=req.project_description,
            )
            logger.info("Provisioned workspace %s", req.workspace_folder)
        except TemplateError as exc:
            # Template problems are deterministic installation issues —
            # surface them as 422 so the UI can show a specific error.
            logger.error("Provisioning template error: %s", exc)
            await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
            raise HTTPException(422, f"Template error: {exc}")
        except Exception as exc:
            logger.error("Provisioning failed: %s", exc)
            await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
            raise HTTPException(500, f"Provisioning failed: {exc}")

    # Start
    if req.auto_start:
        import shutil

        if not shutil.which("devcontainer"):
            logger.warning(
                "devcontainer CLI not installed — container registered and provisioned "
                "but not started. Install with: npm install -g @devcontainers/cli"
            )
            await registry.update(record.id, container_status=ContainerStatus.STOPPED.value)
        else:
            # Stream build progress on build:{record_id} so the dashboard
            # Provisioner can render real devcontainer up output instead of
            # a placeholder progress bar.
            from hub.models.schemas import WSFrame
            from hub.routers import ws as ws_router

            # Channel is keyed by workspace_folder so the dashboard can
            # subscribe *before* POST returns with the new record_id.
            build_channel = f"build:{record.workspace_folder}"

            async def _emit_build_line(stream: str, text: str) -> None:
                await ws_router.manager.broadcast(
                    WSFrame(
                        channel=build_channel,
                        event="build_output",
                        data={
                            "record_id": record.id,
                            "workspace_folder": record.workspace_folder,
                            "stream": stream,
                            "text": text,
                        },
                    )
                )

            await registry.update(record.id, container_status=ContainerStatus.STARTING.value)
            await _emit_build_line("system", f"Starting devcontainer for {req.workspace_folder}\n")
            try:
                result = await devcontainer_mgr.up(
                    req.workspace_folder,
                    line_callback=_emit_build_line,
                )
                container_id = result.get("containerId", "")
                record = await registry.update(
                    record.id,
                    container_id=container_id,
                    container_status=ContainerStatus.RUNNING.value,
                )
                await _emit_build_line("system", "Container running.\n")
                logger.info("Started devcontainer %s for %s", container_id, req.workspace_folder)
            except Exception as exc:
                logger.error("devcontainer up failed: %s", exc)
                await registry.update(record.id, container_status=ContainerStatus.ERROR.value)
                await _emit_build_line("stderr", f"devcontainer up failed: {exc}\n")
                raise HTTPException(500, f"devcontainer up failed: {exc}")

    return record


@router.get("", response_model=list[ContainerRecord])
async def list_containers(request: Request) -> list[ContainerRecord]:
    """List all registered devcontainers."""
    return await request.app.state.registry.list_all()


@router.get("/{record_id}", response_model=ContainerRecord)
async def get_container(request: Request, record_id: int) -> ContainerRecord:
    """Get a specific container record."""
    try:
        return await request.app.state.registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container {record_id} not found")


@router.patch("/{record_id}", response_model=ContainerRecord)
async def update_container(
    request: Request, record_id: int, req: ContainerUpdate
) -> ContainerRecord:
    """Update container record fields."""
    try:
        fields = req.model_dump(exclude_none=True)
        return await request.app.state.registry.update(record_id, **fields)
    except KeyError:
        raise HTTPException(404, f"Container {record_id} not found")


@router.delete("/{record_id}")
async def delete_container(request: Request, record_id: int, force: bool = False) -> dict[str, Any]:
    """Unregister and optionally remove a devcontainer."""
    registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container {record_id} not found")

    if record.container_id:
        pty_registry = getattr(request.app.state, "pty_registry", None)
        if pty_registry is not None:
            await pty_registry.drop_by_container(record.container_id)
        await devcontainer_mgr.stop(record.container_id)
        if force:
            await devcontainer_mgr.remove(record.container_id, force=True)

    await registry.delete(record_id)
    return {"deleted": True, "id": record_id}


@router.post("/{record_id}/start")
async def start_container(request: Request, record_id: int) -> ContainerRecord:
    """Start a stopped devcontainer."""
    import shutil

    if not shutil.which("devcontainer"):
        raise HTTPException(
            400, "devcontainer CLI not installed. Run: npm install -g @devcontainers/cli"
        )

    registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    # Mark STARTING first so ERROR → RUNNING goes through the valid path
    # (ERROR → STARTING → RUNNING). No-op if already STARTING.
    with contextlib.suppress(InvalidStateTransition):
        record = await registry.update(record.id, container_status=ContainerStatus.STARTING.value)

    if record.container_id:
        await devcontainer_mgr.start(record.container_id)
    else:
        result = await devcontainer_mgr.up(record.workspace_folder)
        record = await registry.update(record.id, container_id=result.get("containerId", ""))

    return await registry.update(record.id, container_status=ContainerStatus.RUNNING.value)


@router.post("/{record_id}/stop")
async def stop_container(request: Request, record_id: int) -> ContainerRecord:
    """Stop a running devcontainer."""
    registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if record.container_id:
        # Evict PTY sessions before stopping the container — otherwise
        # the pump threads block on dead sockets and zombie WS stay open.
        pty_registry = getattr(request.app.state, "pty_registry", None)
        if pty_registry is not None:
            dropped = await pty_registry.drop_by_container(record.container_id)
            if dropped:
                logger.info("Stopped %d PTY session(s) before container stop", dropped)
        await devcontainer_mgr.stop(record.container_id)

    return await registry.update(record.id, container_status=ContainerStatus.STOPPED.value)


@router.post("/{record_id}/rebuild")
async def rebuild_container(request: Request, record_id: int) -> ContainerRecord:
    """Rebuild a devcontainer (devcontainer up --build)."""
    registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    await registry.update(record.id, container_status=ContainerStatus.STARTING.value)
    result = await devcontainer_mgr.up(record.workspace_folder, build=True)
    container_id = result.get("containerId", record.container_id)
    return await registry.update(
        record.id,
        container_id=container_id,
        container_status=ContainerStatus.RUNNING.value,
    )


@router.get("/{record_id}/resources", response_model=ResourceStats | None)
async def get_resources(request: Request, record_id: int) -> ResourceStats | None:
    """Get resource usage for a container."""
    registry = request.app.state.registry
    resource_monitor = request.app.state.resource_monitor
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        return None
    return resource_monitor.get_stats(record.container_id)


@router.get(
    "/{record_id}/resources/history",
    response_model=list[ResourceStats],
)
async def get_resources_history(request: Request, record_id: int) -> list[ResourceStats]:
    """Return the last 60 resource samples (5 min at 5s cadence) for
    the given container.

    Returns an empty list when the container was just registered and
    hasn't been sampled yet, when its container_id is still unset, or
    after ``clear_history`` was called. An empty buffer is a valid
    state — clients render a muted "Collecting…" placeholder rather
    than treating it as an error.
    """
    registry = request.app.state.registry
    resource_monitor = request.app.state.resource_monitor
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        return []
    return resource_monitor.get_history(record.container_id)


@router.post("/{record_id}/install-claude-cli")
async def install_claude_cli(request: Request, record_id: int) -> dict[str, Any]:
    """Install the Claude Code CLI inside the container via npm.

    Runs a single `npm install -g @anthropic-ai/claude-code` through the
    docker_exec relay. We cap the timeout at 180s — typical installs
    finish in 30–60s but first-time npm on a fresh Alpine can take
    longer. After install we re-probe and update the registry so the
    dashboard's Claude tab flips from the install-gate to the active
    input without a manual refresh.
    """
    from datetime import datetime as _dt

    registry = request.app.state.registry
    relay = request.app.state.claude_relay
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container {record_id} not found")

    if not record.container_id:
        raise HTTPException(400, "Container has no Docker ID — not started?")

    # Ensure npm is present first — on minimal base images it isn't, and
    # we want a readable error instead of a 180s timeout.
    try:
        rc_npm, _, _ = await relay.exec_via_docker(
            record.container_id, "command -v npm", timeout=10
        )
    except Exception as exc:
        raise HTTPException(502, f"docker exec failed: {exc}")
    if rc_npm != 0:
        return {
            "installed": False,
            "stderr": (
                "npm is not installed in this container. Install Node.js first "
                "(e.g. `apk add nodejs npm` or `apt-get install -y nodejs npm`)."
            ),
            "exit_code": rc_npm,
        }

    try:
        rc, stdout, stderr = await relay.exec_via_docker(
            record.container_id,
            "npm install -g @anthropic-ai/claude-code",
            timeout=180,
        )
    except Exception as exc:
        raise HTTPException(502, f"docker exec failed: {exc}")

    # Re-probe regardless of rc — npm sometimes reports 0 but leaves a
    # broken install, and occasionally non-zero for warnings only. The
    # probe is the source of truth.
    found = await has_claude_cli(record.container_id)
    await registry.update(
        record.id,
        has_claude_cli=int(found),
        claude_cli_checked_at=_dt.now().isoformat(),
    )

    return {
        "installed": found,
        "exit_code": rc,
        "stdout": stdout[-2000:] if stdout else "",
        "stderr": stderr[-2000:] if stderr else "",
    }
