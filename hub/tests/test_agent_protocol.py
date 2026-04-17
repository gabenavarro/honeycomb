"""Tests for hub/models/agent_protocol.py and its mirror in hive-agent.

The two modules define the wire shapes of every frame exchanged between
the hub and a hive-agent. They must stay byte-compatible. Each test here
serialises a frame on one side and parses it on the other; any drift
between the two definitions shows up immediately.
"""

from __future__ import annotations

import hive_agent.protocol as agent_protocol
import pytest
from pydantic import ValidationError

from hub.models import agent_protocol as hub_protocol


def test_hello_roundtrip() -> None:
    src = hub_protocol.HelloFrame(
        container_id="c1",
        agent_version="0.4.0",
        started_at="2026-04-16T12:00:00+00:00",
        hostname="c1.local",
    )
    agent_parsed = agent_protocol.parse_frame(src.model_dump(mode="json"))
    assert isinstance(agent_parsed, agent_protocol.HelloFrame)
    assert agent_parsed.container_id == "c1"
    assert agent_parsed.agent_version == "0.4.0"


def test_heartbeat_roundtrip_agent_to_hub() -> None:
    src = agent_protocol.HeartbeatFrame(
        container_id="c1", status="idle", session_info={"commands": 0}
    )
    hub_parsed = hub_protocol.parse_frame(src.model_dump(mode="json"))
    assert isinstance(hub_parsed, hub_protocol.HeartbeatFrame)
    assert hub_parsed.status == "idle"
    assert hub_parsed.session_info == {"commands": 0}


def test_cmd_exec_roundtrip_hub_to_agent() -> None:
    src = hub_protocol.CmdExecFrame(
        command_id="abc", command="echo hi", env={"FOO": "bar"}, timeout_s=60.0
    )
    agent_parsed = agent_protocol.parse_frame(src.model_dump(mode="json"))
    assert isinstance(agent_parsed, agent_protocol.CmdExecFrame)
    assert agent_parsed.command == "echo hi"
    assert agent_parsed.env == {"FOO": "bar"}


def test_output_roundtrip() -> None:
    src = agent_protocol.OutputFrame(command_id="abc", stream="stdout", text="hello world\n")
    hub_parsed = hub_protocol.parse_frame(src.model_dump(mode="json"))
    assert isinstance(hub_parsed, hub_protocol.OutputFrame)
    assert hub_parsed.text == "hello world\n"


def test_done_roundtrip() -> None:
    src = agent_protocol.DoneFrame(command_id="abc", exit_code=0, pid=1234, reason="completed")
    hub_parsed = hub_protocol.parse_frame(src.model_dump(mode="json"))
    assert isinstance(hub_parsed, hub_protocol.DoneFrame)
    assert hub_parsed.exit_code == 0
    assert hub_parsed.reason == "completed"


def test_unknown_type_is_rejected() -> None:
    with pytest.raises(ValidationError):
        hub_protocol.parse_frame({"type": "nope"})


def test_missing_type_is_rejected() -> None:
    with pytest.raises(ValidationError):
        hub_protocol.parse_frame({"command_id": "abc"})


def test_heartbeat_status_enum_is_enforced() -> None:
    with pytest.raises(ValidationError):
        hub_protocol.parse_frame({"type": "heartbeat", "container_id": "c1", "status": "nonsense"})


def test_output_stream_enum_is_enforced() -> None:
    with pytest.raises(ValidationError):
        hub_protocol.parse_frame(
            {"type": "output", "command_id": "x", "stream": "log", "text": "t"}
        )
