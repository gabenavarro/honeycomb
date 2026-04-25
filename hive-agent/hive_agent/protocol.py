"""Wire protocol between ``hive-agent`` and the Claude Hive hub (agent side).

This file is a byte-compatible mirror of ``hub/models/agent_protocol.py``.
hive-agent is deliberately a lightweight package — it does not depend on
the hub — so the protocol definitions are duplicated here. Changes in
either file must land in both; a roundtrip test in each package catches
accidental drift.

Direction conventions (must match the hub copy):

* ``agent → hub``:  hello, heartbeat, ack, output, done, diff_event
* ``hub → agent``:  cmd_exec, cmd_kill, pong
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter

# ── agent → hub ─────────────────────────────────────────────────────


class HelloFrame(BaseModel):
    type: Literal["hello"] = "hello"
    container_id: str
    agent_version: str
    started_at: str
    hostname: str | None = None


class HeartbeatFrame(BaseModel):
    type: Literal["heartbeat"] = "heartbeat"
    container_id: str
    status: Literal["idle", "busy", "error", "starting", "stopping"]
    session_info: dict[str, Any] = Field(default_factory=dict)


class AckFrame(BaseModel):
    type: Literal["ack"] = "ack"
    command_id: str
    pid: int | None = None


class OutputFrame(BaseModel):
    type: Literal["output"] = "output"
    command_id: str
    stream: Literal["stdout", "stderr"]
    text: str


class DoneFrame(BaseModel):
    type: Literal["done"] = "done"
    command_id: str
    exit_code: int
    pid: int | None = None
    reason: str | None = None


class DiffEventFrame(BaseModel):
    type: Literal["diff_event"] = "diff_event"
    container_id: str
    tool_use_id: str
    claude_session_id: str | None = None
    tool: Literal["Edit", "Write", "MultiEdit"]
    path: str
    diff: str
    added_lines: int = 0
    removed_lines: int = 0
    timestamp: str


# ── hub → agent ─────────────────────────────────────────────────────


class CmdExecFrame(BaseModel):
    type: Literal["cmd_exec"] = "cmd_exec"
    command_id: str
    command: str
    env: dict[str, str] | None = None
    timeout_s: float | None = None


class CmdKillFrame(BaseModel):
    type: Literal["cmd_kill"] = "cmd_kill"
    command_id: str


class PongFrame(BaseModel):
    type: Literal["pong"] = "pong"


AgentFrame = Annotated[
    HelloFrame
    | HeartbeatFrame
    | AckFrame
    | OutputFrame
    | DoneFrame
    | DiffEventFrame
    | CmdExecFrame
    | CmdKillFrame
    | PongFrame,
    Field(discriminator="type"),
]


_FRAME_ADAPTER: TypeAdapter[AgentFrame] = TypeAdapter(AgentFrame)


def parse_frame(payload: object) -> AgentFrame:
    """Validate an incoming frame. Raises :class:`pydantic.ValidationError`."""
    return _FRAME_ADAPTER.validate_python(payload)
