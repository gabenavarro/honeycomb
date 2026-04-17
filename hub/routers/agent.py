"""WebSocket endpoint a ``hive-agent`` dials into.

Since M4, this is the *primary* command-dispatch path for the hub. A
hive-agent running inside a container opens a persistent WebSocket to
``/api/agent/connect`` and stays there for the lifetime of the
container. The hub pushes ``cmd_exec`` and ``cmd_kill`` frames down the
socket and consumes ``hello``, ``heartbeat``, ``ack``, ``output``, and
``done`` frames back from the agent.

Auth
----
The handshake honours the same bearer token as the rest of the hub
(``authenticate_websocket`` in :mod:`hub.auth`). The ``container_id``
comes from the ``?container=…`` query parameter. A missing or blank
value is rejected at accept time.

Frame routing
-------------
* ``hello`` is currently informational — we log it and continue.
* ``heartbeat`` is forwarded to :class:`HealthChecker` so the familiar
  "agent_status" column on the dashboard keeps updating. It also hits
  the registry so last-seen stays fresh.
* ``output`` / ``done`` / ``ack`` are dispatched to any
  :class:`AgentConnection` state that the commands router is awaiting,
  *and* fanned out on the ``cmd:<command_id>`` broadcast channel so the
  dashboard's per-command terminal pane receives them live.

Anything the hub doesn't understand is logged and dropped. The agent
is allowed to send a ``pong`` even though no code in this router
requests one yet — we're forgiving about forward-compatible frames.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from hub.auth import authenticate_websocket
from hub.models.agent_protocol import (
    AckFrame,
    DoneFrame,
    HeartbeatFrame,
    HelloFrame,
    OutputFrame,
    parse_frame,
)
from hub.models.schemas import AgentStatus, ProjectType, WSFrame
from hub.routers import ws as ws_router
from hub.services.agent_registry import AgentConnection

if TYPE_CHECKING:
    from hub.services.agent_registry import AgentRegistry
    from hub.services.health_checker import HealthChecker
    from hub.services.registry import Registry

logger = logging.getLogger("hub.routers.agent")

router = APIRouter(tags=["agent"])


@router.websocket("/api/agent/connect")
async def agent_connect(websocket: WebSocket) -> None:
    """WebSocket endpoint used by hive-agent instances inside containers.

    Query params:

    * ``token``      — bearer token (required; same as every other
                       WebSocket endpoint).
    * ``container``  — agent-declared container id. Blank/missing
                       rejects the handshake.
    """
    token = getattr(websocket.app.state, "auth_token", "")
    if not await authenticate_websocket(websocket, token):
        return

    container_id = (websocket.query_params.get("container") or "").strip()
    if not container_id:
        await websocket.accept()
        await websocket.send_text("sclosed:missing-container-id")
        await websocket.close(code=1008)
        return

    await websocket.accept()

    agent_registry: AgentRegistry = websocket.app.state.agent_registry
    registry: Registry = websocket.app.state.registry
    health_checker: HealthChecker = websocket.app.state.health_checker

    connection: AgentConnection = await agent_registry.register(container_id, websocket)
    logger.info(
        "agent_connected",
        extra={"container_id": container_id},
    )

    # Auto-register the container in the hub's SQLite registry if the
    # agent dialed in from a container we haven't seen. Pre-M4 this
    # happened at startup via an HTTP probe sweep; post-M4 the agent
    # initiates the connection, so "discovery" and "registration" are
    # the same event.
    await _auto_register_if_unknown(registry, container_id)

    await _update_registry_agent_status(registry, container_id, AgentStatus.IDLE)

    try:
        while True:
            raw = await websocket.receive_json()
            try:
                frame = parse_frame(raw)
            except ValidationError as exc:
                logger.warning(
                    "agent_frame_invalid",
                    extra={"container_id": container_id, "error": str(exc)[:400]},
                )
                continue

            if isinstance(frame, HelloFrame):
                # Kept informational for now. A future milestone can
                # use agent_version here to negotiate protocol features.
                logger.info(
                    "agent_hello",
                    extra={
                        "container_id": frame.container_id,
                        "agent_version": frame.agent_version,
                    },
                )
                continue

            if isinstance(frame, HeartbeatFrame):
                connection.mark_heartbeat()
                await health_checker.record_heartbeat(frame.container_id)
                try:
                    agent_status = AgentStatus(frame.status)
                except ValueError:
                    agent_status = AgentStatus.IDLE
                await _update_registry_agent_status(registry, frame.container_id, agent_status)
                await ws_router.manager.broadcast(
                    WSFrame(
                        channel=frame.container_id,
                        event="heartbeat",
                        data={
                            "container_id": frame.container_id,
                            "status": frame.status,
                            "session_info": frame.session_info,
                        },
                    )
                )
                continue

            if isinstance(frame, AckFrame):
                connection.deliver_ack(frame.command_id, frame.pid)
                continue

            if isinstance(frame, OutputFrame):
                connection.deliver_output(frame.command_id, frame.stream, frame.text)
                # Fan out on the per-command channel so the dashboard's
                # terminal pane can render the stream live. Matches the
                # pre-M4 contract exposed by /api/events.
                await ws_router.manager.broadcast(
                    WSFrame(
                        channel=f"cmd:{frame.command_id}",
                        event="command_output",
                        data={
                            "command_id": frame.command_id,
                            "stream": frame.stream,
                            "text": frame.text,
                        },
                    )
                )
                continue

            if isinstance(frame, DoneFrame):
                connection.deliver_done(frame)
                await ws_router.manager.broadcast(
                    WSFrame(
                        channel=f"cmd:{frame.command_id}",
                        event="command_done",
                        data={
                            "command_id": frame.command_id,
                            "exit_code": frame.exit_code,
                            "pid": frame.pid,
                            "reason": frame.reason,
                        },
                    )
                )
                continue

            # Any other frame type is either hub→agent (we shouldn't
            # receive it) or a future extension. Log and drop.
            logger.warning(
                "agent_frame_unexpected",
                extra={
                    "container_id": container_id,
                    "type": getattr(frame, "type", "?"),
                },
            )

    except WebSocketDisconnect as disc:
        logger.info(
            "agent_disconnected",
            extra={"container_id": container_id, "code": disc.code},
        )
    except Exception:
        logger.exception(
            "agent_connection_crashed",
            extra={"container_id": container_id},
        )
    finally:
        await connection.close(reason="socket-closed")
        await agent_registry.deregister(container_id, connection)
        await _update_registry_agent_status(registry, container_id, AgentStatus.UNREACHABLE)


async def _update_registry_agent_status(
    registry: Registry, container_id: str, status: AgentStatus
) -> None:
    """Best-effort push of the agent_status column; drop if the container isn't registered."""
    try:
        record = await registry.get_by_container_id(container_id)
    except Exception:
        return
    if record is None:
        return
    try:
        await registry.update(record.id, agent_status=status)
    except Exception as exc:
        logger.debug(
            "agent_status_update_failed",
            extra={"container_id": container_id, "error": str(exc)},
        )


async def _auto_register_if_unknown(registry: Registry, container_id: str) -> None:
    """Insert a registry row for a container whose agent just dialed in.

    Best-effort: on any failure (Docker unreachable, label missing, race)
    we log and move on. The agent socket is still registered in
    :class:`AgentRegistry` regardless, so command relay works even for
    rows the hub didn't manage to materialize.
    """
    existing = None
    try:
        existing = await registry.get_by_container_id(container_id)
    except Exception as exc:
        logger.debug(
            "auto_register_lookup_failed",
            extra={"container_id": container_id, "error": str(exc)},
        )
    if existing is not None:
        return

    # Best-effort Docker lookup to pull metadata. If Docker is
    # unreachable (e.g. hub is running against a remote daemon that we
    # can't inspect), register a minimal pseudo row so the dashboard
    # still sees the container.
    workspace: str | None = None
    project_name = container_id
    project_type = ProjectType.BASE
    try:
        import docker as _docker

        client = _docker.from_env()
        container = client.containers.get(container_id)
        labels = container.labels or {}
        workspace = labels.get("devcontainer.local_folder") or labels.get(
            "com.docker.compose.project.working_dir"
        )
        if not workspace:
            for mount in container.attrs.get("Mounts", []) or []:
                if mount.get("Type") == "bind":
                    dest = mount.get("Destination") or ""
                    if dest.startswith("/workspace") or dest == "/workspaces":
                        workspace = mount.get("Source")
                        break
        project_name = container.name or container_id
    except Exception as exc:
        logger.debug(
            "auto_register_docker_inspect_failed",
            extra={"container_id": container_id, "error": str(exc)},
        )

    if not workspace:
        workspace = f"/workspace/{project_name}"

    try:
        await registry.add(
            workspace_folder=workspace,
            project_type=project_type,
            project_name=project_name,
            project_description=f"Auto-registered via agent connect ({container_id})",
        )
        record = await registry.get_by_workspace(workspace)
        if record is not None:
            await registry.update(
                record.id,
                container_id=container_id,
                container_status="running",
            )
        logger.info(
            "agent_connect_auto_registered",
            extra={"container_id": container_id, "workspace": workspace},
        )
    except Exception as exc:
        logger.info(
            "auto_register_skipped",
            extra={"container_id": container_id, "error": str(exc)},
        )
