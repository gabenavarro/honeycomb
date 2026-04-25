"""Unix-socket listener for the M27 diff_event submission path.

Runs alongside the main WS loop. Hook scripts (or the
``hive-agent submit-diff`` CLI) connect to this socket and write a
single JSON line per event; we parse and forward to the hub via
``submit_diff``.

Frame on the socket is one JSON object per line:

    {"tool": "Edit", "path": "/...", "diff": "...",
     "tool_use_id": "...", "claude_session_id": "..." | null,
     "added_lines": int, "removed_lines": int,
     "timestamp": "..."}

Anything malformed is logged and dropped — the calling hook is not
in a position to recover.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


SubmitDiff = Callable[..., Awaitable[None]]


class SocketListener:
    """Async Unix-socket server that forwards JSON-line submissions
    to the supplied ``submit_diff`` coroutine."""

    def __init__(self, *, socket_path: Path, submit_diff: SubmitDiff) -> None:
        self._socket_path = Path(socket_path)
        self._submit_diff = submit_diff
        self._server: asyncio.AbstractServer | None = None
        self._stop_event = asyncio.Event()

    async def serve(self) -> None:
        if self._socket_path.exists():
            self._socket_path.unlink()
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)

        self._server = await asyncio.start_unix_server(
            self._handle_client, path=str(self._socket_path)
        )
        os.chmod(self._socket_path, 0o660)

        logger.info("socket_listener_started: %s", self._socket_path)
        try:
            await self._stop_event.wait()
        finally:
            self._server.close()
            await self._server.wait_closed()
            with contextlib.suppress(OSError, FileNotFoundError):
                self._socket_path.unlink()

    def stop(self) -> None:
        self._stop_event.set()

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    return
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError as exc:
                    logger.warning("socket_listener_bad_json: %s", exc)
                    continue
                if not isinstance(payload, dict):
                    logger.warning("socket_listener_non_object_payload")
                    continue
                await self._dispatch(payload)
        finally:
            writer.close()
            await writer.wait_closed()

    async def _dispatch(self, payload: dict[str, Any]) -> None:
        try:
            await self._submit_diff(
                tool=payload["tool"],
                path=payload["path"],
                diff=payload["diff"],
                tool_use_id=payload["tool_use_id"],
                claude_session_id=payload.get("claude_session_id"),
                added_lines=int(payload.get("added_lines", 0)),
                removed_lines=int(payload.get("removed_lines", 0)),
                timestamp=payload["timestamp"],
            )
        except KeyError as exc:
            logger.warning("socket_listener_missing_field: %s", exc)
        except Exception as exc:
            logger.warning("socket_listener_dispatch_failed: %s", exc)
