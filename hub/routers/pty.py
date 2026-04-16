"""PTY WebSocket endpoint.

Client → Server frames (text):
  "d<bytes>"       stdin data (everything after the "d" prefix)
  "r<cols>,<rows>" resize — e.g. "r80,24"
  "p"              ping (heartbeat from client)
  "k"              explicit kill (don't enter grace, close PTY now)

Server → Client frames (bytes):
  binary frames  — raw PTY output (what xterm.js attach addon expects)

Server → Client control frames (text, "s" prefix):
  "sreplay:<n>"    announces N bytes of scrollback are about to replay
  "sattached"      the PTY is attached and live
  "sreattached:<seconds_since_detach>"
  "sclosed:<reason>"
  "spong"          reply to client ping
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState

from hub.auth import authenticate_websocket

logger = logging.getLogger("hub.routers.pty")

router = APIRouter(tags=["pty"])


@router.websocket("/ws/pty/{record_id}")
async def pty_ws(
    websocket: WebSocket,
    record_id: int,
    cols: int = 80,
    rows: int = 24,
    cmd: str = "bash",
    label: str = "default",
) -> None:
    """Attach a browser WebSocket to a PTY inside a container.

    Query params:
      cols, rows — initial viewport size; client should immediately send
                   a resize frame if it has a more accurate number.
      cmd        — "bash" | "sh" | "claude" | anything else already on
                   PATH inside the container. We don't shell-quote args;
                   keep it simple — the client sends one token.
      label      — session label. The same label from the same
                   record_id attaches to the same PTY (reattach). New
                   labels spawn new PTYs.
    """
    token = getattr(websocket.app.state, "auth_token", "")
    if not await authenticate_websocket(websocket, token):
        return

    registry = websocket.app.state.registry
    pty_registry = websocket.app.state.pty_registry

    await websocket.accept()

    try:
        record = await registry.get(record_id)
    except KeyError:
        await _send_ctrl(websocket, "closed:container-not-found")
        await websocket.close(code=4404)
        return
    if not record.container_id:
        await _send_ctrl(websocket, "closed:container-not-started")
        await websocket.close(code=4409)
        return

    # Map friendly `cmd` names to safe invocations. `bash -l` gives a
    # login shell (loads /etc/profile, PATH, HIVE_* env) — matches what
    # the one-shot relay does. Fallback to sh if bash isn't present is
    # handled *inside* bash via `|| exec sh` chain below.
    command: list[str]
    cmd_clean = cmd.strip().lower()
    if cmd_clean in ("bash", ""):
        command = ["sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"]
    elif cmd_clean == "sh":
        command = ["sh", "-l"]
    elif cmd_clean == "claude":
        # Run claude interactively — full REPL, slash commands work.
        command = ["sh", "-c", "exec claude"]
    else:
        # Treat any other value as a literal binary to exec. Keep it
        # single-token; we deliberately don't parse shell syntax.
        command = ["sh", "-c", f"exec {cmd_clean}"]

    try:
        session, reattached = await pty_registry.get_or_create(
            record_id=record_id,
            session_label=label,
            container_id=record.container_id,
            command=command,
            cols=max(1, min(cols, 500)),
            rows=max(1, min(rows, 200)),
        )
    except Exception as exc:
        logger.exception("PTY create failed for record=%s: %s", record_id, exc)
        await _send_ctrl(websocket, f"closed:create-failed:{exc!s}"[:200])
        await websocket.close(code=4500)
        return

    # Single-writer discipline: displace any previously-attached client.
    # The reader loop itself stays put; only the callback swaps.
    async def _send_bytes(data: bytes) -> None:
        if websocket.client_state != WebSocketState.CONNECTED:
            return
        try:
            await websocket.send_bytes(data)
        except Exception:
            # Caller catches and detaches us.
            raise

    # If reattaching, replay the scrollback first so the user sees tail.
    if reattached:
        scrollback = session.snapshot_scrollback()
        since = session.seconds_since_detach()
        await _send_ctrl(websocket, f"reattached:{since:.0f}" if since else "reattached:0")
        if scrollback:
            await _send_ctrl(websocket, f"replay:{len(scrollback)}")
            with contextlib.suppress(Exception):
                await websocket.send_bytes(scrollback)
    else:
        await _send_ctrl(websocket, "attached")

    session.attach(_send_bytes)

    try:
        while True:
            msg = await websocket.receive()
            # FastAPI's receive() returns {"type": "websocket.receive", "text": ..., "bytes": ...}
            if msg.get("type") == "websocket.disconnect":
                break
            text = msg.get("text")
            data = msg.get("bytes")
            if text is not None:
                await _handle_text_frame(text, session, websocket)
            elif data is not None:
                # Binary frames are stdin data; avoids the "d" prefix
                # overhead for high-throughput paste.
                await session.write(data)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.info("PTY WS error on %s: %s", session.key, exc)
    finally:
        # Detach but don't kill — lets the user reopen the tab within
        # the grace window and see the session still alive.
        session.detach(schedule_evict=True)


async def _handle_text_frame(text: str, session: Any, ws: WebSocket) -> None:
    if not text:
        return
    tag = text[0]
    body = text[1:]
    if tag == "d":
        await session.write(body.encode("utf-8"))
    elif tag == "r":
        try:
            cols_str, rows_str = body.split(",", 1)
            await session.resize(int(cols_str), int(rows_str))
        except ValueError:
            pass
    elif tag == "p":
        await _send_ctrl(ws, "pong")
    elif tag == "k":
        # User explicitly killed the session — bypass grace period.
        await _send_ctrl(ws, "closed:killed")
        session.detach(schedule_evict=False)
        await session.close()
    # Unknown tags are silently ignored — keeps the protocol forward-compatible.


async def _send_ctrl(ws: WebSocket, msg: str) -> None:
    """Send a control frame (text, "s" prefix). Benign on close races."""
    with contextlib.suppress(Exception):
        await ws.send_text("s" + msg)
