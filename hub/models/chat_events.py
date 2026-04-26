"""Pydantic models for the `claude --output-format stream-json
--include-partial-messages` CLI envelope (M33).

The CLI emits one JSON object per line. Each line has a top-level
``type`` discriminator with these values:

  - "system"            (subtype: init / status / hook_started / hook_response)
  - "stream_event"      (event.type: Anthropic API SSE deltas)
  - "user"              (replayed user input — only with --replay-user-messages)
  - "assistant"         (complete assistant message snapshot)
  - "rate_limit_event"  (rate-limit info)
  - "result"            (terminal turn summary)

This module models the CLI envelope. The hub forwards a filtered
subset (init + stream_event + user + result + error) to the
dashboard on the chat:<session_id> WS channel.

Models accept extra fields (``model_config = ConfigDict(extra="allow")``)
because the CLI is evolving — we don't want a schema bump every time
Anthropic adds a new optional field. Required fields are enforced;
unknown fields ride through.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

# ─── Inner Anthropic API SSE shapes (nested under stream_event.event) ─────────


class AnthropicMessageStub(BaseModel):
    """Subset of Anthropic message fields the dashboard cares about.

    `content` accepts either a list of content blocks (assistant
    messages) or a plain string (user messages — Anthropic's API
    accepts both shapes). Permissive ``Any`` typing on list items so
    new content-block subtypes don't break parsing.
    """

    model_config = ConfigDict(extra="allow")

    id: str | None = None
    type: Literal["message"] = "message"
    role: Literal["assistant", "user"]
    content: list[Any] | str | None = None
    stop_reason: str | None = None
    usage: dict[str, Any] | None = None


class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str


class InputJsonDelta(BaseModel):
    type: Literal["input_json_delta"] = "input_json_delta"
    partial_json: str


class ThinkingDelta(BaseModel):
    type: Literal["thinking_delta"] = "thinking_delta"
    thinking: str


ContentBlockDeltaInner = Annotated[
    TextDelta | InputJsonDelta | ThinkingDelta,
    Field(discriminator="type"),
]


class TextBlock(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["text"] = "text"
    text: str = ""


class ToolUseBlock(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any] = Field(default_factory=dict)


class ThinkingBlock(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["thinking"] = "thinking"
    thinking: str = ""


ContentBlock = Annotated[
    TextBlock | ToolUseBlock | ThinkingBlock,
    Field(discriminator="type"),
]


class MessageStartEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["message_start"] = "message_start"
    message: AnthropicMessageStub


class ContentBlockStartEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["content_block_start"] = "content_block_start"
    index: int
    content_block: ContentBlock


class ContentBlockDeltaEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["content_block_delta"] = "content_block_delta"
    index: int
    delta: ContentBlockDeltaInner


class ContentBlockStopEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["content_block_stop"] = "content_block_stop"
    index: int


class MessageDeltaEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["message_delta"] = "message_delta"
    delta: dict[str, Any] = Field(default_factory=dict)
    usage: dict[str, Any] | None = None


class MessageStopEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["message_stop"] = "message_stop"


StreamEventInner = Annotated[
    MessageStartEvent
    | ContentBlockStartEvent
    | ContentBlockDeltaEvent
    | ContentBlockStopEvent
    | MessageDeltaEvent
    | MessageStopEvent,
    Field(discriminator="type"),
]


# ─── CLI envelope (top-level `type` discriminator) ────────────────────────────


class SystemEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["system"] = "system"
    subtype: Literal["init", "status", "hook_started", "hook_response"]
    session_id: str
    uuid: str
    # init-specific
    cwd: str | None = None
    tools: list[str] | None = None
    model: str | None = None
    permission_mode: str | None = Field(None, alias="permissionMode")
    # status-specific
    status: str | None = None
    # hook-specific
    hook_id: str | None = None
    hook_name: str | None = None


class StreamEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["stream_event"] = "stream_event"
    event: StreamEventInner
    session_id: str
    uuid: str
    parent_tool_use_id: str | None = None


class UserEvent(BaseModel):
    """Replayed user input — only emitted with --replay-user-messages."""

    model_config = ConfigDict(extra="allow")
    type: Literal["user"] = "user"
    message: AnthropicMessageStub
    session_id: str
    uuid: str


class AssistantEvent(BaseModel):
    """Complete assistant message snapshot — fired alongside stream_event
    deltas when --include-partial-messages is set. Useful as authoritative
    end-of-turn state. The dashboard mostly ignores these in favor of the
    incremental stream_event flow."""

    model_config = ConfigDict(extra="allow")
    type: Literal["assistant"] = "assistant"
    message: AnthropicMessageStub
    session_id: str
    uuid: str
    parent_tool_use_id: str | None = None


class RateLimitEvent(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["rate_limit_event"] = "rate_limit_event"
    rate_limit_info: dict[str, Any]
    session_id: str
    uuid: str


class ResultEvent(BaseModel):
    """Terminal turn summary — last event before subprocess exit."""

    model_config = ConfigDict(extra="allow")
    type: Literal["result"] = "result"
    subtype: str  # success / error_max_turns / etc.
    is_error: bool
    session_id: str
    uuid: str
    duration_ms: int
    duration_api_ms: int | None = None
    num_turns: int | None = None
    result: str | None = None
    stop_reason: str | None = None
    total_cost_usd: float | None = None
    usage: dict[str, Any] | None = None


CliEnvelope = Annotated[
    SystemEvent | StreamEvent | UserEvent | AssistantEvent | RateLimitEvent | ResultEvent,
    Field(discriminator="type"),
]


_envelope_adapter: TypeAdapter[CliEnvelope] = TypeAdapter(CliEnvelope)


def parse_cli_event(raw: dict[str, Any]) -> CliEnvelope:
    """Validate a single line of CLI output. Raises pydantic.ValidationError
    on unknown ``type`` or malformed payload — caller is responsible for
    catching + logging."""
    return _envelope_adapter.validate_python(raw)
