"""Chat-stream service (M33) — Phase 1: parser + filter + broadcaster.

This module owns the *pure-function* layer. Subprocess management
arrives in Phase 2 (Task 3) which will sit on top of these helpers.

Layer design:
  - parse_line(str) -> CliEnvelope | None      (defensive — never raises)
  - should_forward(CliEnvelope) -> bool        (drops hook noise)
  - broadcast_event(manager, ns_id, event)     (publishes on chat:<ns_id>)
  - extract_claude_session_id(events)          (init event helper)
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from typing import Any

from hub.models.chat_events import (
    CliEnvelope,
    SystemEvent,
    parse_cli_event,
)
from hub.models.schemas import WSFrame

logger = logging.getLogger(__name__)


# Subtypes of system events that survive filtering. Hook lifecycle
# events are noisy and irrelevant to the chat surface.
_FORWARDED_SYSTEM_SUBTYPES = frozenset({"init", "status"})


def parse_line(line: str) -> CliEnvelope | None:
    """Parse a single line of `claude` stream-json output.

    Returns None on:
      - empty / whitespace lines
      - JSON syntax errors
      - validation errors (unknown ``type``, malformed payload)

    Never raises. Callers iterate the subprocess stdout and feed
    each line here; failures are logged but never crash the service.
    """
    s = line.strip()
    if not s:
        return None
    try:
        raw = json.loads(s)
    except json.JSONDecodeError:
        logger.debug("chat_stream parse_line: invalid JSON: %r", s[:200])
        return None
    try:
        return parse_cli_event(raw)
    except Exception as exc:  # pydantic ValidationError + future surprises
        logger.debug("chat_stream parse_line: validation failed: %s", exc)
        return None


def should_forward(event: CliEnvelope) -> bool:
    """Decide whether this event should be broadcast to the dashboard.

    All non-system events are forwarded. System events are forwarded
    only for ``init`` (carries the Claude session_id, model, tools)
    and ``status`` (requesting / streaming pings). Hook lifecycle
    events are dropped — they're noisy and the chat surface doesn't
    render them.
    """
    if isinstance(event, SystemEvent):
        return event.subtype in _FORWARDED_SYSTEM_SUBTYPES
    return True


def extract_claude_session_id(events: Iterable[CliEnvelope]) -> str | None:
    """Find the first ``system.init`` event and return its session_id.

    Used by the subprocess driver to capture the Claude-side session ID
    on the first turn so subsequent turns can pass ``--resume <id>``.
    """
    for ev in events:
        if isinstance(ev, SystemEvent) and ev.subtype == "init":
            return ev.session_id
    return None


async def broadcast_event(
    manager: Any,
    *,
    named_session_id: str,
    event: CliEnvelope,
) -> None:
    """Publish ``event`` on the ``chat:<named_session_id>`` channel.

    The frame's ``event`` field is the CLI envelope's top-level
    ``type`` (``"system" | "stream_event" | "user" | "assistant" |
    "rate_limit_event" | "result"``) and ``data`` is the full
    ``event.model_dump(mode="json")`` so the dashboard can parse it
    via the same Pydantic-equivalent TS types.

    Best-effort — broadcast failures are logged and swallowed so a
    flaky WebSocket can't kill the subprocess pipeline.
    """
    frame = WSFrame(
        channel=f"chat:{named_session_id}",
        event=event.type,
        data=event.model_dump(mode="json"),
    )
    try:
        await manager.broadcast(frame)
    except Exception as exc:
        logger.warning(
            "chat_stream broadcast failed (channel=%s, type=%s): %s",
            frame.channel,
            event.type,
            exc,
        )
