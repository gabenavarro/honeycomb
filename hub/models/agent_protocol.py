"""Wire protocol between the hub and a ``hive-agent`` running in a container.

Since M4 the agent dials the hub over WebSocket instead of running a
local HTTP server. Every message in either direction is a single JSON
frame with a ``type`` discriminator. Parsing is done via the discriminated
union below (``AgentFrame``) so a malformed frame raises
``pydantic.ValidationError`` at the edge instead of silently executing
a corrupt command.

Mirror of this file lives at ``hive-agent/hive_agent/protocol.py``. The
shapes must stay byte-compatible; a roundtrip test in each package
enforces that. Keep comments terse and duplicate any real documentation
rather than importing across packages — hive-agent is deliberately a
lightweight dependency.

Direction conventions:

* ``agent → hub``:  hello, heartbeat, ack, output, done
* ``hub → agent``:  cmd_exec, cmd_kill, pong

There is no bidirectional frame — each ``type`` belongs to exactly one
direction. Any frame arriving on the wrong side is a protocol error and
the receiver logs + drops it rather than trusting the payload.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter

# ── agent → hub ─────────────────────────────────────────────────────


class HelloFrame(BaseModel):
    """First frame the agent sends after the WebSocket is accepted.

    Gives the hub a chance to reject an agent whose container_id is
    unexpected or whose version skew is too wide. The hub replies
    either with the next directive (usually nothing — the socket just
    stays open) or closes the WS with a structured reason.
    """

    type: Literal["hello"] = "hello"
    container_id: str
    agent_version: str
    started_at: str  # ISO 8601, UTC
    hostname: str | None = None


class HeartbeatFrame(BaseModel):
    """Keepalive + status update. Sent on the heartbeat_interval."""

    type: Literal["heartbeat"] = "heartbeat"
    container_id: str
    status: Literal["idle", "busy", "error", "starting", "stopping"]
    session_info: dict[str, Any] = Field(default_factory=dict)


class AckFrame(BaseModel):
    """Agent's acknowledgement that a cmd_exec has been accepted."""

    type: Literal["ack"] = "ack"
    command_id: str
    pid: int | None = None


class OutputFrame(BaseModel):
    """A chunk of stdout or stderr from a running command."""

    type: Literal["output"] = "output"
    command_id: str
    stream: Literal["stdout", "stderr"]
    text: str


class DoneFrame(BaseModel):
    """Command finished. Sent exactly once per command_id."""

    type: Literal["done"] = "done"
    command_id: str
    exit_code: int
    pid: int | None = None
    reason: str | None = None  # "completed", "killed", "timeout"


# ── hub → agent ─────────────────────────────────────────────────────


class CmdExecFrame(BaseModel):
    """Hub is asking the agent to start a shell command.

    ``command`` is a bash string — interpretation is deliberately
    shell-style (users expect ``ls *.txt`` to glob etc.). The M5
    milestone adds a structured ``argv`` variant for callers that can
    produce it.
    """

    type: Literal["cmd_exec"] = "cmd_exec"
    command_id: str
    command: str
    env: dict[str, str] | None = None
    timeout_s: float | None = None


class CmdKillFrame(BaseModel):
    """Hub is asking the agent to stop a running command."""

    type: Literal["cmd_kill"] = "cmd_kill"
    command_id: str


class PongFrame(BaseModel):
    """Hub reply to an agent-originated ping.

    Rarely used today — heartbeats already prove liveness — but handy
    for round-trip timing diagnostics when debugging a slow link.
    """

    type: Literal["pong"] = "pong"


# ── Discriminated unions ────────────────────────────────────────────


AgentFrame = Annotated[
    HelloFrame
    | HeartbeatFrame
    | AckFrame
    | OutputFrame
    | DoneFrame
    | CmdExecFrame
    | CmdKillFrame
    | PongFrame,
    Field(discriminator="type"),
]


# TypeAdapters cache the validator so parse_frame() doesn't re-analyze
# the union on every call. Important because the hub is expected to
# process many output frames per second while a PTY or test command
# is running.
_FRAME_ADAPTER: TypeAdapter[AgentFrame] = TypeAdapter(AgentFrame)


def parse_frame(payload: object) -> AgentFrame:
    """Validate an incoming frame. Raises :class:`pydantic.ValidationError`."""
    return _FRAME_ADAPTER.validate_python(payload)
