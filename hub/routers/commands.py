"""Command relay REST endpoints — send commands to Claude Code CLI inside devcontainers."""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from hub.models.schemas import CommandOutput, CommandRequest, CommandResponse

logger = logging.getLogger("hub.routers.commands")

router = APIRouter(prefix="/api/containers/{record_id}/commands", tags=["commands"])


def _get_agent_host(request: Request, container_id: str) -> str | None:
    """Resolve the container's IP address for agent communication."""
    devcontainer_mgr = request.app.state.devcontainer_mgr
    return devcontainer_mgr.get_container_ip(container_id)


@router.post("", response_model=CommandResponse, status_code=202)
async def exec_command(request: Request, record_id: int, req: CommandRequest) -> CommandResponse:
    """Execute a command in a devcontainer's Claude Code CLI."""
    registry = request.app.state.registry
    relay = request.app.state.claude_relay
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container {record_id} not found")

    if not record.container_id:
        raise HTTPException(400, "Container has no Docker ID — not started?")

    # Path 1: hive-agent — only usable if the agent port answered a recent
    # health probe AND we can resolve the container's IP.
    agent_host = _get_agent_host(request, record.container_id)
    agent_error: str | None = None
    if agent_host:
        try:
            result = await relay.exec_via_agent(
                agent_host=agent_host,
                agent_port=record.agent_port,
                command=req.command,
                command_id=req.command_id,
            )
            return CommandResponse(
                command_id=result["command_id"],
                pid=result.get("pid"),
                status="dispatched_via_agent",
                relay_path="agent",
            )
        except Exception as exc:
            agent_error = str(exc) or exc.__class__.__name__
            logger.info(
                "Agent unavailable at %s:%d for container %s (%s), trying next path",
                agent_host,
                record.agent_port,
                record_id,
                agent_error,
            )

    # Path 2: devcontainer exec — only when the workspace_folder is a real
    # host path with a devcontainer.json. Discovered ad-hoc containers get
    # pseudo paths like /workspace/<name> for which this path always errors.
    devcontainer_error: str | None = None
    if relay.has_devcontainer_config(record.workspace_folder):
        try:
            returncode, stdout, stderr = await relay.exec_via_devcontainer(
                record.workspace_folder, req.command
            )
            if returncode != 0:
                logger.warning(
                    "devcontainer exec failed (rc=%d) for container %s: %s",
                    returncode,
                    record_id,
                    (stderr or "").strip()[:500],
                )
            return CommandResponse(
                command_id=req.command_id or "exec",
                pid=None,
                status="completed" if returncode == 0 else "failed",
                relay_path="devcontainer_exec",
                exit_code=returncode,
                stdout=stdout,
                stderr=stderr,
            )
        except Exception as exc:
            devcontainer_error = str(exc) or exc.__class__.__name__
            logger.info(
                "devcontainer exec failed for container %s (%s), trying docker exec",
                record_id,
                devcontainer_error,
            )
    else:
        devcontainer_error = (
            f"No devcontainer.json at {record.workspace_folder} — path skipped (use docker exec)."
        )

    # Path 3: docker exec — works for any running container we have the
    # container_id for. Last resort but the most permissive.
    try:
        returncode, stdout, stderr = await relay.exec_via_docker(record.container_id, req.command)
    except Exception as exc:
        logger.error("docker exec failed for container %s: %s", record_id, exc)
        # Mark the record as errored — if docker can't exec the container,
        # something is genuinely wrong (missing, not running, permission).
        with contextlib.suppress(Exception):
            await registry.update(record.id, container_status="error")
        detail = {
            "message": "All relay paths failed.",
            "agent_error": agent_error,
            "devcontainer_error": devcontainer_error,
            "docker_error": str(exc) or exc.__class__.__name__,
        }
        raise HTTPException(status_code=502, detail=detail)

    if returncode != 0:
        logger.warning(
            "docker exec failed (rc=%d) for container %s: %s",
            returncode,
            record_id,
            (stderr or "").strip()[:500],
        )

    return CommandResponse(
        command_id=req.command_id or "exec",
        pid=None,
        status="completed" if returncode == 0 else "failed",
        relay_path="docker_exec",
        exit_code=returncode,
        stdout=stdout,
        stderr=stderr,
    )


@router.get("/{command_id}", response_model=CommandOutput)
async def get_command_output(request: Request, record_id: int, command_id: str) -> CommandOutput:
    """Get output for a running or completed command."""
    registry = request.app.state.registry
    relay = request.app.state.claude_relay
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        raise HTTPException(400, "Container not started")

    agent_host = _get_agent_host(request, record.container_id)
    if not agent_host:
        raise HTTPException(400, "Cannot resolve container IP")

    result = await relay.get_command_output(agent_host, record.agent_port, command_id)
    if result is None:
        raise HTTPException(404, f"Command {command_id} not found")

    return CommandOutput(**result)


@router.get("/{command_id}/stream")
async def stream_command_output(
    request: Request, record_id: int, command_id: str
) -> StreamingResponse:
    """Stream output for a command in real-time."""
    registry = request.app.state.registry
    relay = request.app.state.claude_relay
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        raise HTTPException(400, "Container not started")

    agent_host = _get_agent_host(request, record.container_id)
    if not agent_host:
        raise HTTPException(400, "Cannot resolve container IP")

    async def generate():
        async for line in relay.stream_command_output(agent_host, record.agent_port, command_id):
            yield line + "\n"

    return StreamingResponse(generate(), media_type="text/plain")


@router.post("/{command_id}/kill")
async def kill_command(request: Request, record_id: int, command_id: str) -> dict[str, Any]:
    """Kill a running command."""
    registry = request.app.state.registry
    relay = request.app.state.claude_relay
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        raise HTTPException(400, "Container not started")

    agent_host = _get_agent_host(request, record.container_id)
    if not agent_host:
        return {"killed": False}

    killed = await relay.kill_command(agent_host, record.agent_port, command_id)
    return {"killed": killed}
