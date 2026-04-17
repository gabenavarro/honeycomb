"""Live PTY session inventory per container (M16).

The dashboard's nested sub-tab strip asks "which sessions are alive for
this container, and when did each attach last?" via this endpoint so a
reload can re-render its state without client-side bookkeeping of
every session it has ever spawned.

This is read-only. Session creation happens implicitly when a browser
opens ``/ws/pty/{record_id}?label=<new_uuid>``; the PTY registry creates
the session on first connect. Session deletion happens when the browser
sends the ``k`` kill frame on that same WebSocket (see
hub/routers/pty.py). This router stays a thin read view over
``PtyRegistry.all()``.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/containers", tags=["sessions"])


@router.get("/{record_id}/sessions")
async def list_sessions(record_id: int, request: Request) -> dict:
    """Return the live PTY sessions whose record_id matches.

    Each entry carries:

    - ``session_id`` — the label the browser used on the PTY socket.
      Stable across reattach. Nameless sessions use the raw UUID here.
    - ``attached`` — whether a WebSocket is currently reading output.
    - ``detached_for_seconds`` — float; null while attached. Used by
      the UI to annotate idle sessions.
    """
    pty_registry = request.app.state.pty_registry
    items: list[dict] = []
    for session in pty_registry.all():
        sid_record, session_id = session.key
        if sid_record != record_id:
            continue
        items.append(
            {
                "session_id": session_id,
                "container_id": session.container_id,
                "cols": session.cols,
                "rows": session.rows,
                "attached": session._attached is not None,
                "detached_for_seconds": session.seconds_since_detach(),
            }
        )
    return {"sessions": items}
