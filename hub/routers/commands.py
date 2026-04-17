"""Command relay REST endpoints — send commands to Claude Code CLI inside devcontainers."""

from __future__ import annotations

import contextlib
import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import CommandRequest, CommandResponse
from hub.services import metrics

logger = logging.getLogger("hub.routers.commands")

router = APIRouter(prefix="/api/containers/{record_id}/commands", tags=["commands"])


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

    # Path 1: hive-agent reverse tunnel — the preferred path since M4.
    # Only available when the agent currently has a live WebSocket to
    # /api/agent/connect. The hub no longer reaches into the container
    # over a listener port.
    agent_error: str | None = None
    if relay.has_live_agent(record.container_id):
        command_id = req.command_id or uuid.uuid4().hex[:12]
        try:
            result = await relay.exec_via_agent(
                container_id=record.container_id,
                command=req.command,
                command_id=command_id,
            )
            metrics.commands_total.labels(relay_path="agent").inc()
            return CommandResponse(
                command_id=result["command_id"],
                pid=result.get("pid"),
                status="completed" if result.get("exit_code", 1) == 0 else "failed",
                relay_path="agent",
                exit_code=result.get("exit_code"),
            )
        except Exception as exc:
            agent_error = str(exc) or exc.__class__.__name__
            logger.info(
                "agent exec failed for container %s (%s), trying next path",
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
            metrics.commands_total.labels(relay_path="devcontainer_exec").inc()
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

    metrics.commands_total.labels(relay_path="docker_exec").inc()
    return CommandResponse(
        command_id=req.command_id or "exec",
        pid=None,
        status="completed" if returncode == 0 else "failed",
        relay_path="docker_exec",
        exit_code=returncode,
        stdout=stdout,
        stderr=stderr,
    )


@router.post("/{command_id}/kill")
async def kill_command(request: Request, record_id: int, command_id: str) -> dict[str, Any]:
    """Kill a running command via the agent reverse tunnel.

    Since M4 the hub no longer reaches into the container over a
    listener port. If no agent socket is currently live for this
    container, the kill is a no-op (returns ``killed=false``) — the
    caller should assume the command has already ended or the agent
    has disconnected.
    """
    registry = request.app.state.registry
    relay = request.app.state.claude_relay
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        raise HTTPException(400, "Container not started")

    killed = await relay.kill_via_agent(record.container_id, command_id)
    return {"killed": killed}
