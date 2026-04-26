"""Pydantic models for the chat-stream CLI envelope (M33)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from hub.models.chat_events import (
    RateLimitEvent,
    ResultEvent,
    StreamEvent,
    SystemEvent,
    UserEvent,
    parse_cli_event,
)


class TestSystemEvent:
    def test_init_subtype(self) -> None:
        raw = {
            "type": "system",
            "subtype": "init",
            "cwd": "/repos/foo",
            "session_id": "abc-123",
            "tools": ["Bash", "Edit"],
            "model": "claude-opus-4-7",
            "permissionMode": "default",
            "uuid": "u-1",
        }
        ev = SystemEvent.model_validate(raw)
        assert ev.type == "system"
        assert ev.subtype == "init"
        assert ev.session_id == "abc-123"
        assert ev.cwd == "/repos/foo"

    def test_status_subtype(self) -> None:
        raw = {
            "type": "system",
            "subtype": "status",
            "status": "requesting",
            "uuid": "u-2",
            "session_id": "abc-123",
        }
        ev = SystemEvent.model_validate(raw)
        assert ev.subtype == "status"
        assert ev.status == "requesting"

    def test_hook_subtypes_accepted(self) -> None:
        for subtype in ("hook_started", "hook_response"):
            raw = {
                "type": "system",
                "subtype": subtype,
                "hook_id": "h-1",
                "hook_name": "PostToolUse",
                "uuid": "u-3",
                "session_id": "abc-123",
            }
            ev = SystemEvent.model_validate(raw)
            assert ev.subtype == subtype


class TestStreamEvent:
    def test_message_start(self) -> None:
        raw = {
            "type": "stream_event",
            "event": {
                "type": "message_start",
                "message": {
                    "model": "claude-opus-4-7",
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "usage": {"input_tokens": 10, "output_tokens": 0},
                },
            },
            "session_id": "abc-123",
            "uuid": "u-1",
        }
        ev = StreamEvent.model_validate(raw)
        assert ev.event.type == "message_start"
        assert ev.event.message.id == "msg_1"

    def test_content_block_delta_text(self) -> None:
        raw = {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            },
            "session_id": "abc-123",
            "uuid": "u-2",
        }
        ev = StreamEvent.model_validate(raw)
        assert ev.event.type == "content_block_delta"
        assert ev.event.delta.type == "text_delta"
        assert ev.event.delta.text == "Hello"

    def test_content_block_start_tool_use(self) -> None:
        raw = {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_xyz",
                    "name": "Bash",
                    "input": {},
                },
            },
            "session_id": "abc-123",
            "uuid": "u-3",
        }
        ev = StreamEvent.model_validate(raw)
        assert ev.event.type == "content_block_start"
        assert ev.event.content_block.type == "tool_use"
        assert ev.event.content_block.name == "Bash"

    def test_content_block_start_thinking(self) -> None:
        raw = {
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "thinking", "thinking": ""},
            },
            "session_id": "abc-123",
            "uuid": "u-4",
        }
        ev = StreamEvent.model_validate(raw)
        assert ev.event.content_block.type == "thinking"

    def test_message_stop(self) -> None:
        raw = {
            "type": "stream_event",
            "event": {"type": "message_stop"},
            "session_id": "abc-123",
            "uuid": "u-5",
        }
        ev = StreamEvent.model_validate(raw)
        assert ev.event.type == "message_stop"


class TestResultEvent:
    def test_success(self) -> None:
        raw = {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "1, 2, 3.",
            "session_id": "abc-123",
            "duration_ms": 5315,
            "duration_api_ms": 5288,
            "num_turns": 1,
            "stop_reason": "end_turn",
            "total_cost_usd": 0.14,
            "usage": {"input_tokens": 6, "output_tokens": 13},
            "uuid": "u-6",
        }
        ev = ResultEvent.model_validate(raw)
        assert ev.subtype == "success"
        assert ev.is_error is False
        assert ev.total_cost_usd == 0.14


class TestCliEnvelope:
    def test_parse_dispatches_by_type(self) -> None:
        # Discriminated union routes by `type`.
        sys_raw = {"type": "system", "subtype": "init", "session_id": "s", "uuid": "u"}
        assert isinstance(parse_cli_event(sys_raw), SystemEvent)

        stream_raw = {
            "type": "stream_event",
            "event": {"type": "message_stop"},
            "session_id": "s",
            "uuid": "u",
        }
        assert isinstance(parse_cli_event(stream_raw), StreamEvent)

        rate_raw = {
            "type": "rate_limit_event",
            "rate_limit_info": {"status": "allowed", "resetsAt": 0},
            "session_id": "s",
            "uuid": "u",
        }
        assert isinstance(parse_cli_event(rate_raw), RateLimitEvent)

        result_raw = {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "session_id": "s",
            "uuid": "u",
            "duration_ms": 1,
        }
        assert isinstance(parse_cli_event(result_raw), ResultEvent)

    def test_unknown_type_raises(self) -> None:
        with pytest.raises(ValidationError):
            parse_cli_event({"type": "wat", "session_id": "s", "uuid": "u"})

    def test_user_replayed(self) -> None:
        raw = {
            "type": "user",
            "message": {"role": "user", "content": "hi"},
            "session_id": "s",
            "uuid": "u",
        }
        ev = parse_cli_event(raw)
        assert isinstance(ev, UserEvent)
        assert ev.message.role == "user"
