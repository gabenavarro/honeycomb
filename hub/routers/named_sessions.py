"""CRUD router for persistent named sessions (M26).

Two path shapes:

- Container-scoped list + create at
  ``/api/containers/{record_id}/named-sessions``
- Session-scoped rename + delete at
  ``/api/named-sessions/{session_id}``

The split mirrors REST convention (GET/POST are collection ops;
PATCH/DELETE are on the individual resource) and keeps the
frontend's ``renameNamedSession`` / ``deleteNamedSession`` wrappers
container-agnostic.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import NamedSession, NamedSessionCreate, NamedSessionPatch
from hub.routers.ws import WSFrame
from hub.routers.ws import manager as ws_manager
from hub.services.named_sessions import (
    SessionNotFound,
    create_session,
    delete_session,
    list_sessions,
    patch_session,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["named-sessions"])


async def _broadcast_sessions_list(engine, container_id: int) -> None:
    """Re-query the full named-sessions list for ``container_id`` and
    publish it on the ``sessions:<container_id>`` channel. Best-effort
    — broadcast failures are logged and swallowed so CRUD success is
    independent of WS health. Event name is always ``list``; clients
    replace the TanStack Query cache wholesale."""
    try:
        sessions = await list_sessions(engine, container_id=container_id)
        frame = WSFrame(
            channel=f"sessions:{container_id}",
            event="list",
            data=[s.model_dump(mode="json") for s in sessions],
        )
        await ws_manager.broadcast(frame)
    except Exception as exc:
        logger.warning(
            "Failed to broadcast sessions list for container %s: %s",
            container_id,
            exc,
        )


async def _lookup_container_record(registry, record_id: int) -> None:
    """Verify the container exists (404 otherwise). We don't need its
    fields — just the existence check before hitting the sessions
    table."""
    try:
        await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")


@router.get(
    "/api/containers/{record_id}/named-sessions",
    response_model=list[NamedSession],
)
async def list_named_sessions(record_id: int, request: Request) -> list[NamedSession]:
    """List all persistent sessions for a container, oldest first."""
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    return await list_sessions(registry.engine, container_id=record_id)


@router.post(
    "/api/containers/{record_id}/named-sessions",
    response_model=NamedSession,
)
async def create_named_session_endpoint(
    record_id: int, request: Request, body: NamedSessionCreate
) -> NamedSession:
    """Create a new session row. Server generates ``session_id``."""
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    return await create_session(
        registry.engine,
        container_id=record_id,
        name=body.name,
        kind=body.kind,
    )


@router.patch(
    "/api/named-sessions/{session_id}",
    response_model=NamedSession,
)
async def rename_named_session_endpoint(
    session_id: str, request: Request, body: NamedSessionPatch
) -> NamedSession:
    """Partial update (M26; M28 adds optional ``position``).

    Empty body → 422. ``SessionNotFound`` → 404. Otherwise returns
    the updated row (with renumbered position if ``position`` was
    set).
    """
    if body.name is None and body.position is None:
        raise HTTPException(422, "patch requires at least one field")
    registry = request.app.state.registry
    try:
        return await patch_session(
            registry.engine,
            session_id=session_id,
            name=body.name,
            position=body.position,
        )
    except SessionNotFound:
        raise HTTPException(404, f"Session {session_id} not found")


@router.delete("/api/named-sessions/{session_id}", status_code=204)
async def delete_named_session_endpoint(session_id: str, request: Request) -> None:
    """Delete a session. Idempotent — 204 even when the row didn't exist."""
    registry = request.app.state.registry
    await delete_session(registry.engine, session_id=session_id)
