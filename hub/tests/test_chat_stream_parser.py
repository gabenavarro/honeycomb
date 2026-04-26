"""Parser + filter + broadcast helpers for chat_stream (M33)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from hub.models.chat_events import (
    ResultEvent,
    StreamEvent,
    SystemEvent,
)
from hub.services.chat_stream import (
    broadcast_event,
    extract_claude_session_id,
    parse_line,
    should_forward,
)

FIXTURES = Path(__file__).parent / "fixtures" / "chat_stream"


def load_fixture(name: str) -> list[str]:
    return (FIXTURES / name).read_text().splitlines()


def parse_lines(name: str):
    out = []
    for line in load_fixture(name):
        if not line.strip():
            continue
        ev = parse_line(line)
        if ev is not None:
            out.append(ev)
    return out


class TestParseLine:
    def test_returns_envelope_for_valid_json(self) -> None:
        line = '{"type":"system","subtype":"init","session_id":"s","uuid":"u"}'
        ev = parse_line(line)
        assert isinstance(ev, SystemEvent)

    def test_returns_none_for_invalid_json(self) -> None:
        assert parse_line("not json") is None
        assert parse_line("") is None

    def test_returns_none_for_unknown_type(self) -> None:
        line = '{"type":"unknown_type","session_id":"s","uuid":"u"}'
        assert parse_line(line) is None


class TestShouldForward:
    def test_init_forwarded(self) -> None:
        ev = SystemEvent.model_validate(
            {"type": "system", "subtype": "init", "session_id": "s", "uuid": "u"}
        )
        assert should_forward(ev) is True

    def test_status_forwarded(self) -> None:
        ev = SystemEvent.model_validate(
            {
                "type": "system",
                "subtype": "status",
                "status": "requesting",
                "session_id": "s",
                "uuid": "u",
            }
        )
        assert should_forward(ev) is True

    def test_hook_started_dropped(self) -> None:
        ev = SystemEvent.model_validate(
            {"type": "system", "subtype": "hook_started", "session_id": "s", "uuid": "u"}
        )
        assert should_forward(ev) is False

    def test_hook_response_dropped(self) -> None:
        ev = SystemEvent.model_validate(
            {"type": "system", "subtype": "hook_response", "session_id": "s", "uuid": "u"}
        )
        assert should_forward(ev) is False

    def test_stream_event_forwarded(self) -> None:
        ev = StreamEvent.model_validate(
            {
                "type": "stream_event",
                "event": {"type": "message_stop"},
                "session_id": "s",
                "uuid": "u",
            }
        )
        assert should_forward(ev) is True

    def test_result_forwarded(self) -> None:
        ev = ResultEvent.model_validate(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "session_id": "s",
                "uuid": "u",
                "duration_ms": 1,
            }
        )
        assert should_forward(ev) is True


class TestExtractClaudeSessionId:
    def test_extracts_from_init(self) -> None:
        events = parse_lines("simple_text.jsonl")
        sid = extract_claude_session_id(events)
        assert sid == "sess-001"

    def test_returns_none_when_no_init(self) -> None:
        events = [
            StreamEvent.model_validate(
                {
                    "type": "stream_event",
                    "event": {"type": "message_stop"},
                    "session_id": "x",
                    "uuid": "u",
                }
            )
        ]
        assert extract_claude_session_id(events) is None


class TestFixtureFilters:
    def test_simple_text_drops_hook_noise(self) -> None:
        events = parse_lines("simple_text.jsonl")
        forwarded = [e for e in events if should_forward(e)]
        # 13 raw events; 2 hook events dropped → 11 forwarded
        assert len(events) == 13
        assert len(forwarded) == 11
        # No hook subtype survives
        for ev in forwarded:
            if isinstance(ev, SystemEvent):
                assert ev.subtype not in ("hook_started", "hook_response")


class TestBroadcastEvent:
    @pytest.mark.asyncio
    async def test_broadcasts_with_correct_channel_and_envelope(self) -> None:
        manager = AsyncMock()
        ev = StreamEvent.model_validate(
            {
                "type": "stream_event",
                "event": {"type": "message_stop"},
                "session_id": "sess-001",
                "uuid": "u",
            }
        )
        await broadcast_event(manager, named_session_id="ns-abc", event=ev)
        assert manager.broadcast.await_count == 1
        frame = manager.broadcast.await_args.args[0]
        assert frame.channel == "chat:ns-abc"
        assert frame.event == "stream_event"
        # Frame data is the model dump; spot check a couple keys
        assert frame.data["type"] == "stream_event"
        assert frame.data["event"]["type"] == "message_stop"
