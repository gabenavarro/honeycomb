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

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
from collections.abc import Iterable
from dataclasses import dataclass
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


# ─── Subprocess driver (Phase 2) ──────────────────────────────────────────────


@dataclass(frozen=True)
class TurnResult:
    exit_code: int
    captured_claude_session_id: str | None
    forwarded_count: int


def build_command(
    claude_session_id: str | None,
    *,
    effort: str = "standard",
    model: str | None = None,
    mode: str = "code",
    edit_auto: bool = False,
    claude_binary: str = "claude",
) -> list[str]:
    """Build the argv for a single chat turn (M34 extended).

    Honors:
      - claude_session_id  → --resume <id>  (only on turn ≥2)
      - effort             → --max-budget-usd 0.05 when "quick"
                             (deep / max are handled by apply_effort_prefix
                              on the user text, not as a CLI flag — the
                              CLI doesn't expose a thinking-budget knob)
      - model              → --model <alias>
      - mode + edit_auto:
          - mode == "plan"          → --permission-mode plan  (precedence)
          - elif edit_auto          → --permission-mode acceptEdits
          - else                    → no --permission-mode flag (default)
        Plus mode == "review" appends a system-prompt nudge.
    """
    cmd = [
        claude_binary,
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--replay-user-messages",
    ]

    # Permission mode (Plan wins over edit_auto)
    if mode == "plan":
        cmd += ["--permission-mode", "plan"]
    elif edit_auto:
        cmd += ["--permission-mode", "acceptEdits"]

    # Model
    if model:
        cmd += ["--model", model]

    # Quick effort = dollar cap. Deep/Max use apply_effort_prefix instead.
    if effort == "quick":
        cmd += ["--max-budget-usd", "0.05"]

    # Review mode: append system-prompt nudge
    if mode == "review":
        cmd += [
            "--append-system-prompt",
            "You are reviewing code; suggest improvements without writing them.",
        ]

    # Resume (last so it groups visually with the rest of the session args)
    if claude_session_id:
        cmd += ["--resume", claude_session_id]

    return cmd


class ClaudeTurnSession:
    """Manages one ``claude --print`` invocation per user turn.

    Lifecycle:
      1. Caller instantiates with ``named_session_id`` + ``cwd`` +
         ``ws_manager``.
      2. Caller calls ``await run(user_text, claude_session_id)``:
         - Spawns the subprocess with cwd in the container's workspace.
         - Writes the user message JSON to stdin then closes stdin.
         - Reads stdout line-by-line, parses + filters + broadcasts.
         - Captures the Claude session_id from the init event for the
           caller to persist.
         - Awaits the subprocess to exit, returns a TurnResult.

      3. Caller may call ``await cancel()`` to send SIGTERM to the
         active subprocess (if any). Idempotent.

    The class is single-use — instantiate one per turn. (The
    Honeycomb-side ``named_session_id`` may have many turns over its
    lifetime; each turn gets a fresh ClaudeTurnSession.)
    """

    def __init__(
        self,
        *,
        named_session_id: str,
        cwd: str,
        ws_manager: Any,
        claude_binary: str = "claude",
    ) -> None:
        self.named_session_id = named_session_id
        self.cwd = cwd
        self.ws_manager = ws_manager
        self.claude_binary = claude_binary
        self._proc: asyncio.subprocess.Process | None = None
        self._cancelled = False

    async def run(
        self,
        *,
        user_text: str,
        claude_session_id: str | None,
    ) -> TurnResult:
        if shutil.which(self.claude_binary) is None and not self.claude_binary.startswith("/"):
            # Defensive: explicit path or PATH lookup must succeed.
            raise FileNotFoundError(f"claude binary not found: {self.claude_binary}")

        cmd = build_command(claude_session_id, claude_binary=self.claude_binary)
        logger.info(
            "chat_stream spawn: ns=%s cmd=%s cwd=%s resume=%s",
            self.named_session_id,
            " ".join(cmd),
            self.cwd,
            claude_session_id,
        )
        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            start_new_session=True,  # own process group so cancel() can kill all children
        )

        # Write the user message JSON, then close stdin to trigger EOF.
        user_payload = json.dumps(
            {"type": "user", "message": {"role": "user", "content": user_text}},
            separators=(",", ":"),
        )
        if self._proc.stdin is not None:
            self._proc.stdin.write(user_payload.encode("utf-8") + b"\n")
            await self._proc.stdin.drain()
            self._proc.stdin.close()

        captured_id: str | None = None
        forwarded = 0

        if self._proc.stdout is not None:
            async for raw_line in self._proc.stdout:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n")
                event = parse_line(line)
                if event is None:
                    continue
                if isinstance(event, SystemEvent) and event.subtype == "init":
                    captured_id = event.session_id
                if not should_forward(event):
                    continue
                await broadcast_event(
                    self.ws_manager,
                    named_session_id=self.named_session_id,
                    event=event,
                )
                forwarded += 1

        exit_code = await self._proc.wait()
        return TurnResult(
            exit_code=exit_code,
            captured_claude_session_id=captured_id,
            forwarded_count=forwarded,
        )

    async def cancel(self) -> None:
        """Terminate the subprocess (and its children) if running. Idempotent.

        Because the subprocess is spawned with ``start_new_session=True`` it
        leads its own process group. ``os.killpg`` sends the signal to the
        entire group so any child processes (e.g. a bash wrapper around claude)
        are terminated along with the leader — preventing orphaned grandchildren
        from keeping the stdout pipe open indefinitely.
        """
        self._cancelled = True
        proc = self._proc
        if proc is None or proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError, OSError):
                os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
