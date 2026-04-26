"""Chat-stream router (M33).

Two endpoints:
  - POST /api/named-sessions/{session_id}/turns       — start a chat turn
  - DELETE /api/named-sessions/{session_id}/turns/active — cancel in-flight

The POST endpoint validates the session exists + is kind="claude",
spawns a ClaudeTurnSession, and returns 202 Accepted while the
subprocess streams events on the chat:<session_id> WS channel.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from hub.routers.ws import manager as ws_manager
from hub.services.chat_stream import ClaudeTurnSession
from hub.services.named_sessions import (
    get_session,
    set_claude_session_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat-stream"])

# Active turn registry — one in-flight ClaudeTurnSession per
# named-session ID. Used by DELETE to cancel.
_active: dict[str, ClaudeTurnSession] = {}
# Keep task references to prevent them from being garbage-collected.
_tasks: dict[str, asyncio.Task[None]] = {}


class TurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    # M34: effort/model/mode/edit_auto wire to chat_stream.build_command
    effort: Literal["quick", "standard", "deep", "max"] = "standard"
    model: str | None = None
    mode: Literal["code", "review", "plan"] = "code"
    edit_auto: bool = False
    # M34: attachments accepted but unused server-side — the dashboard
    # appends @<path> references into `text` before sending. Field stays
    # for forward-compat (M35 may use it for richer context).
    attachments: list[str] = Field(default_factory=list)


@router.post(
    "/api/named-sessions/{session_id}/turns",
    status_code=202,
    response_model=dict,
)
async def post_turn(session_id: str, body: TurnRequest, request: Request) -> dict:
    registry = request.app.state.registry
    sess = await get_session(registry.engine, session_id=session_id)
    if sess is None:
        raise HTTPException(404, f"Session {session_id} not found")
    if sess.kind != "claude":
        raise HTTPException(409, "Turns are only valid on kind=claude sessions")

    container = await registry.get(sess.container_id)
    cwd = container.workspace_folder

    chat = ClaudeTurnSession(
        named_session_id=session_id,
        cwd=cwd,
        ws_manager=ws_manager,
        container_id=sess.container_id,
        artifacts_engine=registry.engine,
    )
    _active[session_id] = chat

    async def _drive() -> None:
        try:
            result = await chat.run(
                user_text=body.text,
                claude_session_id=sess.claude_session_id,
                effort=body.effort,
                model=body.model,
                mode=body.mode,
                edit_auto=body.edit_auto,
            )
            if result.captured_claude_session_id is not None:
                await set_claude_session_id(
                    registry.engine,
                    session_id=session_id,
                    claude_session_id=result.captured_claude_session_id,
                )
            logger.info(
                "chat turn done: ns=%s exit=%d forwarded=%d",
                session_id,
                result.exit_code,
                result.forwarded_count,
            )
        except Exception as exc:
            logger.exception("chat turn crashed: %s", exc)
        finally:
            _active.pop(session_id, None)
            _tasks.pop(session_id, None)

    task = asyncio.create_task(_drive())
    _tasks[session_id] = task
    return {"accepted": True, "session_id": session_id}


@router.delete(
    "/api/named-sessions/{session_id}/turns/active",
    status_code=204,
)
async def cancel_active_turn(session_id: str) -> None:
    chat = _active.get(session_id)
    if chat is None:
        # Idempotent — no in-flight turn to cancel is a 204.
        return
    await chat.cancel()
