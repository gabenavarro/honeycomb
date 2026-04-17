"""Problems REST endpoints (M10)."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/problems", tags=["problems"])


@router.get("")
async def list_problems(request: Request) -> dict:
    """Return the current hub problem log, oldest-first.

    The log is a bounded ring buffer (256 entries); anything older has
    been evicted. Dashboards that want live updates subscribe to the
    ``problems`` WebSocket channel.
    """
    problem_log = request.app.state.problem_log
    return {"problems": [p.to_dict() for p in problem_log.list()]}


@router.delete("")
async def clear_problems(request: Request) -> dict:
    """Clear every entry from the problem log."""
    problem_log = request.app.state.problem_log
    problem_log.clear()
    return {"cleared": True}
