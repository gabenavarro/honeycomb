"""Read-only router for the M27 Claude diff changelog.

Events arrive via the agent WebSocket, not REST — there is no POST
endpoint here. The dashboard reads via GET, then subscribes to the
``diff-events:<container_id>`` WS channel for live updates."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import DiffEvent
from hub.services.diff_events import list_events

router = APIRouter(tags=["diff-events"])


async def _lookup_container_record(registry, record_id: int) -> None:
    try:
        await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")


@router.get(
    "/api/containers/{record_id}/diff-events",
    response_model=list[DiffEvent],
)
async def list_diff_events(record_id: int, request: Request) -> list[DiffEvent]:
    """Return the last 200 diff events for ``record_id``, newest first."""
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    return await list_events(registry.engine, container_id=record_id)
