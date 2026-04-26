# M33 — Chat Surface (anatomy + streaming) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current PTY-pane chat surface with a structured chat thread (workspace pill + mode toggle + tab strip + streaming message list + composer) wired to live `claude --output-format stream-json`. Render per-tool color identity (Bash blue / Edit blue / Read orange / Write green / Task red / Todo blue / Thinking orange) for all eight tool types. Hover-action bar (Retry / Fork / Copy / Edit) and Code/Review/Plan mode toggle persist per chat. PTY view stays as the fallback for `kind="shell"` named-sessions; only `kind="claude"` flows through the new chat surface.

**Architecture:** Hub spawns `claude --print --verbose --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages` per user turn (one subprocess per turn — simpler lifetime model than persistent stdin). Stdout is line-buffered JSON; the hub parses each line, filters noisy hook events, and broadcasts the relevant frames on the multiplexed WebSocket channel `chat:<session_id>` (mirrors M27/M30 channel pattern). The dashboard's `useChatStream(sessionId)` hook subscribes to that channel via the existing `useHiveWebSocket`, mutates a TanStack Query cache, and the `<ChatStream>` component re-renders incrementally. Composer effort/model controls render visually but are inert in M33 — they gain real semantics in M34. Mode toggle (Code/Review/Plan) persists in `localStorage:hive:chat:<id>:mode`; mode-specific behavior is M34.

**Tech Stack:** FastAPI + asyncio.subprocess (hub), Pydantic v2 discriminated unions for stream-json envelope, existing `ConnectionManager` from `hub/routers/ws.py` for broadcast, React 19 + TanStack Query v5 (dashboard), `useHiveWebSocket` (M21), `react-diff-view` (M27 — reused for `MessageToolEdit`), Vitest + `@testing-library/react`, Playwright + `@axe-core/playwright`, M31 semantic Tailwind tokens (`bg-card`, `text-claude`, `bg-tool`, `bg-edit`, `bg-read`, `bg-write`, `bg-task`, `bg-think`).

**Branch:** `m33-chat-surface` (to be created from `main` at the start of Task 0).

**Spec:** [docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md](../specs/2026-04-26-dashboard-redesign-design.md) — M33 section (lines 745–804) + section 3 chat anatomy v2 (lines 154–239) + Architecture → Chat stream wire format (lines 480–523).

**Visual reference:** `.superpowers/brainstorm/95298-1777173712/content/04-chat-anatomy-v2.html` (locked design).

---

## Decisions made up front

These decisions are locked at plan time so the implementer doesn't have to think about them mid-task:

### Stream-json wire format — corrected from spec

The spec's "Chat stream wire format" section (lines 480–523) describes Anthropic-API-style events (`message_start` / `content_block_delta` etc.) as top-level types. **That's wrong.** What `claude --output-format stream-json --include-partial-messages` actually emits is a CLI envelope with these top-level `type` values:

| CLI envelope `type` | Subtypes / nested shape                                                                                                                                | What it carries                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `system`            | `subtype: "init" \| "status" \| "hook_started" \| "hook_response"`                                                                                     | Session init (model, tools, session_id, cwd), status pings, in-container hook lifecycle                                            |
| `stream_event`      | `event: { type: "message_start" \| "content_block_start" \| "content_block_delta" \| "content_block_stop" \| "message_delta" \| "message_stop", ... }` | The Anthropic-API SSE deltas, one per line — this is what drives incremental rendering                                             |
| `user`              | `message: { role: "user", content: ... }`                                                                                                              | Replayed user input (when `--replay-user-messages` is set)                                                                         |
| `assistant`         | `message: { id, role, content: [...], stop_reason, usage }`                                                                                            | Complete assistant message snapshot — emitted alongside stream_event deltas. Useful as authoritative state at the end of the turn. |
| `rate_limit_event`  | `rate_limit_info: { status, resetsAt, ... }`                                                                                                           | Rate-limit notifications                                                                                                           |
| `result`            | `subtype: "success" \| "error_max_turns" \| ...`, `result`, `duration_ms`, `total_cost_usd`, `usage`, `modelUsage`                                     | Terminal turn summary                                                                                                              |

Tool calls do NOT have their own top-level event. They appear as `content_block` entries inside `stream_event` with `content_block.type === "tool_use"`. The eight tool types (Bash / Edit / Read / Write / Task / TodoWrite / Grep / WebFetch / etc.) are derived from `content_block.name`. Thinking blocks are `content_block.type === "thinking"`.

### Subprocess lifetime — spawn per turn

**One `claude --print` subprocess per user turn.** Spawned when the user sends a message; exits when the response completes (after `result` event). The first turn creates a new Claude session ID (captured from the `system.subtype="init"` event); subsequent turns invoke `claude --print --resume <session_id>` so context is preserved. The Claude CLI's `--input-format stream-json` "realtime streaming input" mode would let us keep one subprocess alive across turns, but per-turn spawn is dramatically simpler (no stdin lifecycle, no zombie subprocess on dashboard refresh) and adds at most ~500 ms latency per turn — acceptable for M33.

### Subprocess invocation — exact command

```bash
claude --print \
  --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --replay-user-messages \
  [--resume <claude_session_id>]   # only on turn ≥2
```

User input is fed via stdin as a single line of JSON: `{"type":"user","message":{"role":"user","content":"<text>"}}`. Then stdin is closed (EOF). Subprocess emits stream-json on stdout until `result` event then exits.

`--no-session-persistence` is NOT set — we WANT Claude to persist its own session so `--resume` works. The hub records the `session_id` from the init event and stashes it on the named-session row (or a sidecar table; see Decision below).

### Session ID mapping

Honeycomb's named-session has its own `session_id` (UUID hex, set in M26). Claude's CLI also has a `session_id` (different UUID format). M33 stores the **Claude session_id** as a sidecar column `claude_session_id` on the `named_sessions` table (Alembic migration). When the user sends turn N≥2, the hub looks up `claude_session_id` for the named-session and passes it via `--resume`. If empty, the subprocess creates a fresh Claude session and the hub captures the new `session_id` from the init event.

### Per-turn input contract

The dashboard sends the user message via REST: `POST /api/named-sessions/{session_id}/turns` with body `{ "text": "...", "attachments": [...] }`. The hub spawns the subprocess, writes the user JSON to stdin, closes stdin, and broadcasts the stream-json output on `chat:<session_id>`. Returns 202 Accepted immediately (the WS does the streaming).

For M33: `attachments` is an empty list — composer renders the attachment chip UI but doesn't actually attach files yet. File attachment is a future ticket (out of M33 scope).

### Mode toggle — Code/Review/Plan

For M33, the toggle is **purely persistence**. The active mode is stored in `localStorage:hive:chat:<session_id>:mode` as `"code" | "review" | "plan"`. The composer foot displays the active mode label. **No backend semantics yet** — the hub doesn't read the mode and the spawned subprocess doesn't get a mode-derived flag. M34 wires mode-specific behavior (e.g., Plan mode invokes `claude --permission-mode plan`).

### Hover action bar — Retry/Fork/Copy/Edit

- **Retry** — re-sends the current user message; the assistant response immediately below is replaced (UI-side: drop the assistant turn from cache, re-issue POST /turns with the same text).
- **Fork** — creates a new named-session via existing API (`POST /api/containers/{cid}/named-sessions` with `kind: "claude"`). Stores the parent session ID + the message ID at which the fork branched in `localStorage:hive:chat:<new_id>:fork-from = { parent: <old_id>, at_message: <msg_id> }`. The new chat tab opens with a "Forked from … at HH:MM" banner. M33 doesn't replay the parent's turns into the new session — that's a deeper feature deferred. The fork is essentially a fresh chat with metadata about its origin.
- **Copy** — copies the message text to clipboard (browser `navigator.clipboard.writeText`).
- **Edit** — only on user messages. Re-issues POST /turns with the edited text and replaces the existing user message + drops everything after it from the cache.

### Effort + Model UI

The composer foot renders the four-segment Effort control (`Quick · Standard · Deep · Max`) and the Model chip (`★ Sonnet 4.6 ▾`). **Both are visually present but inert in M33** — clicking the Effort chip cycles the highlight without sending anything to the hub; clicking the Model chip opens a placeholder picker that says "Model selection arrives in M34". Persistence: the active Effort is stored in `localStorage:hive:chat:<id>:effort` and Model in `localStorage:hive:chat:<id>:model` so the M34 implementation has the storage shape ready. Default values: `effort = "standard"`, `model = "sonnet-4-6"`.

### Tool color tokens

M31 already defined these in `dashboard/src/index.css` `@theme`:

| Tool                             | Token           | Tailwind utility                                  |
| -------------------------------- | --------------- | ------------------------------------------------- |
| Bash                             | `--color-tool`  | `text-tool` / `bg-tool`                           |
| Edit / MultiEdit                 | `--color-edit`  | `text-edit` / `bg-edit`                           |
| Read                             | `--color-read`  | `text-read` / `bg-read`                           |
| Write                            | `--color-write` | `text-write` / `bg-write`                         |
| Task (subagent)                  | `--color-task`  | `text-task` / `bg-task`                           |
| TodoWrite                        | `--color-todo`  | (NEW — M33 adds; defaults to `--color-tool` blue) |
| Thinking                         | `--color-think` | `text-think` / `bg-think`                         |
| Generic / Grep / Glob / WebFetch | `--color-tool`  | falls back to bash blue                           |

**M33 adds `--color-todo` to `index.css`** if not present (mirrors `--color-tool` blue in dark, `--color-edit` blue in light). This is a token-table extension, not a milestone-blocking decision — the implementer adds it in Task 6 when scaffolding component types.

### Hook noise filter

`claude --print` emits a torrent of `system.subtype="hook_started"` / `"hook_response"` events for every PreToolUse/PostToolUse hook the user has installed. **The hub filters these out before broadcasting** — only `system.subtype` in `{"init", "status"}` are forwarded. Tool execution still surfaces via the `stream_event.content_block` entries.

### Out of scope for M33 (deferred)

- **Real Effort semantics** (M34 wires `thinking.budget_tokens`)
- **Real model picker** (M34 wires the model arg)
- **Slash commands grammar** (M34)
- **Mode-specific behavior** (M34 wires Plan mode → `--permission-mode plan` etc.)
- **File attachments in composer** (out of M33; composer renders chip UI but doesn't upload)
- **Library artifact synthesis from chat** (M35)
- **Mobile breakpoints** (M36 — chat surface should work on desktop now)
- **Persistent stream-json subprocess** (per-turn spawn for M33; persistent is a future optimization)
- **Chat history navigation** (the History button in the header is rendered but inert; M35 wires it to the artifact store)

---

## File Structure

### Backend — create

- `hub/models/chat_events.py` — Pydantic discriminated union for the CLI envelope shape (`SystemEvent`, `StreamEvent`, `UserEvent`, `AssistantEvent`, `RateLimitEvent`, `ResultEvent`) + nested `StreamEventInner` union (message*start/content_block*\*/message_delta/message_stop).
- `hub/services/chat_stream.py` — `ChatStreamSession` class that spawns one subprocess per turn, parses line-buffered JSON, filters hook events, broadcasts on `chat:<session_id>`. Module-level registry `active_streams: dict[str, ChatStreamSession]` keyed by named-session_id.
- `hub/routers/chat_stream.py` — `POST /api/named-sessions/{session_id}/turns` (start a turn) + `DELETE /api/named-sessions/{session_id}/turns/active` (cancel in-flight turn) + `GET /api/named-sessions/{session_id}/claude-session` (debug: read the captured Claude session_id).
- `hub/db/migrations/versions/<rev>_add_claude_session_id.py` — Alembic migration adding `claude_session_id TEXT NULL` to `named_sessions`.
- `hub/services/named_sessions.py` — extend `_row_to_model` + `NamedSession` schema to include `claude_session_id`. Add helper `set_claude_session_id(engine, session_id, claude_session_id)`.
- `hub/tests/test_chat_stream_service.py` — parser unit tests against canned fixtures (sample stream-json from real `claude` invocations, stored as `hub/tests/fixtures/chat_stream/*.jsonl`).
- `hub/tests/test_chat_stream_endpoint.py` — endpoint tests mocking the subprocess (asyncio.subprocess) and verifying broadcast frames.
- `hub/tests/fixtures/chat_stream/` — directory with `simple_text.jsonl`, `bash_tool.jsonl`, `edit_tool.jsonl`, `multi_block.jsonl`, `hook_noise.jsonl`, `with_thinking.jsonl` (each captured from a real `claude` invocation, then trimmed to relevant events).

### Backend — modify

- `hub/main.py` — register the new chat_stream router.
- `hub/models/schemas.py` — add `claude_session_id: str | None = None` to `NamedSession`.

### Frontend — create

- `dashboard/src/hooks/useChatStream.ts` — TanStack Query cache + WS subscription for `chat:<session_id>`.
- `dashboard/src/components/chat/types.ts` — TypeScript types mirroring hub's chat_events shape.
- `dashboard/src/components/chat/ChatThread.tsx` — top-level container.
- `dashboard/src/components/chat/ChatHeader.tsx` — workspace pill + mode toggle + model chip + actions.
- `dashboard/src/components/chat/ChatTabStrip.tsx` — chat tab list within the active workspace.
- `dashboard/src/components/chat/ChatStream.tsx` — virtualized message list, auto-scroll on streaming.
- `dashboard/src/components/chat/ChatComposer.tsx` — multi-line textarea + foot row.
- `dashboard/src/components/chat/ModeToggle.tsx` — Code/Review/Plan segmented control.
- `dashboard/src/components/chat/ModelChip.tsx` — model picker chip (M33: opens placeholder).
- `dashboard/src/components/chat/EffortControl.tsx` — Quick/Standard/Deep/Max segmented control.
- `dashboard/src/components/chat/MessageActions.tsx` — hover bar (Retry/Fork/Copy/Edit).
- `dashboard/src/components/chat/messages/MessageUser.tsx`
- `dashboard/src/components/chat/messages/MessageAssistantText.tsx`
- `dashboard/src/components/chat/messages/MessageThinking.tsx`
- `dashboard/src/components/chat/messages/MessageToolBash.tsx`
- `dashboard/src/components/chat/messages/MessageToolEdit.tsx`
- `dashboard/src/components/chat/messages/MessageToolRead.tsx`
- `dashboard/src/components/chat/messages/MessageToolWrite.tsx`
- `dashboard/src/components/chat/messages/MessageToolTask.tsx`
- `dashboard/src/components/chat/messages/MessageToolTodo.tsx`
- `dashboard/src/components/chat/messages/MessageToolGeneric.tsx`
- `dashboard/src/components/chat/messages/ToolBlockChrome.tsx` — shared header chrome (icon + name + status + duration) used by all tool messages.
- `dashboard/src/lib/chatApi.ts` — REST wrappers for `POST /turns`, `DELETE /turns/active`.
- `dashboard/src/components/chat/__tests__/*.test.tsx` — vitest per component.
- `dashboard/src/hooks/__tests__/useChatStream.test.tsx`
- `dashboard/tests/e2e/chat-stream.spec.ts` — Playwright happy path with mocked WS frames.

### Frontend — modify

- `dashboard/src/components/routes/ChatsRoute.tsx` — branch on `activeSession.kind`: render `ChatThread` for `"claude"`, keep `SessionSplitArea` (PTY) for `"shell"`.
- `dashboard/src/lib/types.ts` — add `kind: "shell" | "claude"` reflection on `NamedSession` if not already there; add `claude_session_id` field.
- `dashboard/src/index.css` — add `--color-todo: #79c0ff` (dark) + light variant.

---

## Task 0: Verify branch + create feature branch

- [ ] **Step 1: Confirm clean main**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git status -s
git log --oneline -3
```

Expected:

- On `main`
- Status clean except `?? .claude/settings.json`
- Recent log shows `Merge M32: layout shell` (or later)

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b m33-chat-surface
```

- [ ] **Step 3: Verify the `claude` CLI is available + supports the required flags**

```bash
claude --version
claude --help 2>&1 | grep -E "include-partial-messages|input-format|output-format|replay-user-messages"
```

Expected: version `2.x.x` (Claude Code), all four flags listed.

- [ ] **Step 4: Capture sample fixtures (one-time setup)**

This generates the JSONL fixtures Task 1's tests will assert against.

```bash
mkdir -p /home/gnava/repos/honeycomb/hub/tests/fixtures/chat_stream

# simple_text.jsonl — just text response, no tools
echo '{"type":"user","message":{"role":"user","content":"Reply with the literal text: hello world"}}' \
  | claude --print --verbose --include-partial-messages --replay-user-messages \
           --input-format stream-json --output-format stream-json \
  > /home/gnava/repos/honeycomb/hub/tests/fixtures/chat_stream/simple_text.jsonl
```

(The implementer does NOT need to capture every fixture — Task 1 specifies the fixture content inline. This step just confirms the CLI invocation works locally.)

---

## Task 1: chat_events.py Pydantic models + tests

**Files:**

- Create: `hub/models/chat_events.py`
- Create: `hub/tests/test_chat_events_models.py`

The hub broadcasts the inner `stream_event.event` shape to the dashboard (so the dashboard parses Anthropic-API-style events directly), but the parser needs to accept the FULL CLI envelope to sieve out hook noise + capture the Claude session_id. Define both layers.

- [ ] **Step 1: Write the failing test**

Create `hub/tests/test_chat_events_models.py`:

```python
"""Pydantic models for the chat-stream CLI envelope (M33)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from hub.models.chat_events import (
    AssistantEvent,
    CliEnvelope,
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
```

- [ ] **Step 2: Run, expect FAIL (no module)**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_events_models.py -q
```

Expected: FAIL `ModuleNotFoundError: hub.models.chat_events`.

- [ ] **Step 3: Implement chat_events.py**

Create `hub/models/chat_events.py`:

```python
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

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


# ─── Inner Anthropic API SSE shapes (nested under stream_event.event) ─────────


class AnthropicMessageStub(BaseModel):
    """Subset of Anthropic message fields the dashboard cares about."""

    model_config = ConfigDict(extra="allow")

    id: str
    type: Literal["message"] = "message"
    role: Literal["assistant", "user"]
    content: list[Any] = Field(default_factory=list)
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
    Union[TextDelta, InputJsonDelta, ThinkingDelta],
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
    Union[TextBlock, ToolUseBlock, ThinkingBlock],
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
    Union[
        MessageStartEvent,
        ContentBlockStartEvent,
        ContentBlockDeltaEvent,
        ContentBlockStopEvent,
        MessageDeltaEvent,
        MessageStopEvent,
    ],
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
    permissionMode: str | None = None
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
    Union[SystemEvent, StreamEvent, UserEvent, AssistantEvent, RateLimitEvent, ResultEvent],
    Field(discriminator="type"),
]


_envelope_adapter: TypeAdapter[CliEnvelope] = TypeAdapter(CliEnvelope)


def parse_cli_event(raw: dict[str, Any]) -> CliEnvelope:
    """Validate a single line of CLI output. Raises pydantic.ValidationError
    on unknown ``type`` or malformed payload — caller is responsible for
    catching + logging."""
    return _envelope_adapter.validate_python(raw)
```

- [ ] **Step 4: Run tests, expect 11/11 PASS**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_events_models.py -v
```

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/models/chat_events.py hub/tests/test_chat_events_models.py
git commit -m "feat(m33): chat_events Pydantic models for stream-json envelope

Discriminated union over the CLI's six top-level types (system,
stream_event, user, assistant, rate_limit_event, result). Stream
events nest the Anthropic SSE shapes (message_start /
content_block_start / content_block_delta / content_block_stop /
message_delta / message_stop) with content blocks split by type
(text / tool_use / thinking) and deltas split by type
(text_delta / input_json_delta / thinking_delta).

extra='allow' on every model so CLI evolution doesn't bump us.
Discriminators are enforced; unknown fields ride through."
```

If pre-commit ruff/mypy fails, fix and re-stage.

---

## Task 2: chat_stream.py parser + filter + broadcaster (no subprocess yet)

**Files:**

- Create: `hub/services/chat_stream.py` (initial — parser + filter + broadcast helpers)
- Create: `hub/tests/test_chat_stream_parser.py`
- Create: `hub/tests/fixtures/chat_stream/simple_text.jsonl` (canned fixture)

The service is built in two layers: this task is the pure-function parser/filter/broadcast helpers (no subprocess management). Task 3 adds the subprocess lifetime layer on top.

- [ ] **Step 1: Capture a small fixture**

Create `hub/tests/fixtures/chat_stream/simple_text.jsonl` with this content (a captured + trimmed real claude output — copy verbatim):

```jsonl
{"type":"system","subtype":"init","cwd":"/repos/foo","session_id":"sess-001","tools":["Bash","Edit"],"model":"claude-opus-4-7","permissionMode":"default","uuid":"u-1"}
{"type":"system","subtype":"status","status":"requesting","uuid":"u-2","session_id":"sess-001"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":6,"output_tokens":1}}},"session_id":"sess-001","uuid":"u-3"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"sess-001","uuid":"u-4"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}},"session_id":"sess-001","uuid":"u-5"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world."}},"session_id":"sess-001","uuid":"u-6"}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"sess-001","uuid":"u-7"}
{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Hello world."}],"stop_reason":"end_turn","usage":{"input_tokens":6,"output_tokens":3}},"session_id":"sess-001","uuid":"u-8"}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}},"session_id":"sess-001","uuid":"u-9"}
{"type":"stream_event","event":{"type":"message_stop"},"session_id":"sess-001","uuid":"u-10"}
{"type":"system","subtype":"hook_started","hook_id":"h-1","hook_name":"Stop","uuid":"u-11","session_id":"sess-001"}
{"type":"system","subtype":"hook_response","hook_id":"h-1","hook_name":"Stop","output":"{}","uuid":"u-12","session_id":"sess-001"}
{"type":"result","subtype":"success","is_error":false,"result":"Hello world.","session_id":"sess-001","duration_ms":1500,"num_turns":1,"stop_reason":"end_turn","total_cost_usd":0.001,"uuid":"u-13"}
```

This fixture intentionally includes hook noise that the filter should drop.

- [ ] **Step 2: Write the failing test**

Create `hub/tests/test_chat_stream_parser.py`:

```python
"""Parser + filter + broadcast helpers for chat_stream (M33)."""

from __future__ import annotations

import json
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
            {"type": "system", "subtype": "status", "status": "requesting", "session_id": "s", "uuid": "u"}
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
            {"type": "result", "subtype": "success", "is_error": False, "session_id": "s", "uuid": "u", "duration_ms": 1}
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
                {"type": "stream_event", "event": {"type": "message_stop"}, "session_id": "x", "uuid": "u"}
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
```

- [ ] **Step 3: Run, expect FAIL (no module)**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_parser.py -q
```

- [ ] **Step 4: Implement chat_stream.py (parser layer only)**

Create `hub/services/chat_stream.py`:

```python
"""Chat-stream service (M33) — Phase 1: parser + filter + broadcaster.

This module owns the *pure-function* layer. Subprocess management
arrives in Phase 2 (Task 3) which will sit on top of these helpers.

Layer design:
  - parse_line(str) → CliEnvelope | None      (defensive — never raises)
  - should_forward(CliEnvelope) → bool        (drops hook noise)
  - broadcast_event(manager, ns_id, event)    (publishes on chat:<ns_id>)
  - extract_claude_session_id(events)         (init event helper)
"""

from __future__ import annotations

import json
import logging
from typing import Iterable

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
    manager,
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
```

- [ ] **Step 5: Run tests, expect 14/14 PASS**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_parser.py -v
```

- [ ] **Step 6: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/chat_stream.py \
        hub/tests/test_chat_stream_parser.py \
        hub/tests/fixtures/chat_stream/simple_text.jsonl
git commit -m "feat(m33): chat_stream parser + filter + broadcaster

Pure-function layer of the chat-stream service. parse_line never
raises; should_forward drops hook lifecycle noise; broadcast_event
publishes on chat:<named_session_id> with the CLI envelope as
data and the top-level type as the WS frame event.

Subprocess management lands in Task 3 on top of these helpers."
```

---

## Task 3: chat_stream subprocess driver + tests

**Files:**

- Modify: `hub/services/chat_stream.py` (add subprocess driver class)
- Create: `hub/tests/test_chat_stream_subprocess.py`

This adds the asyncio.subprocess layer that spawns `claude --print`, pipes stdin/stdout, calls `parse_line` on each output line, filters via `should_forward`, and broadcasts via `broadcast_event`.

- [ ] **Step 1: Write the failing test**

Create `hub/tests/test_chat_stream_subprocess.py`:

```python
"""Subprocess driver for chat_stream (M33 Phase 2)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from hub.services.chat_stream import (
    ClaudeTurnSession,
    build_command,
)


class TestBuildCommand:
    def test_first_turn_no_resume(self) -> None:
        cmd = build_command(claude_session_id=None)
        assert cmd[0] == "claude"
        assert "--print" in cmd
        assert "--verbose" in cmd
        assert "--input-format" in cmd
        assert cmd[cmd.index("--input-format") + 1] == "stream-json"
        assert "--output-format" in cmd
        assert cmd[cmd.index("--output-format") + 1] == "stream-json"
        assert "--include-partial-messages" in cmd
        assert "--replay-user-messages" in cmd
        assert "--resume" not in cmd

    def test_subsequent_turn_passes_resume(self) -> None:
        cmd = build_command(claude_session_id="sess-001")
        assert "--resume" in cmd
        assert cmd[cmd.index("--resume") + 1] == "sess-001"


class TestClaudeTurnSession:
    @pytest.mark.asyncio
    async def test_run_pipes_user_message_and_broadcasts_events(self, tmp_path: Path) -> None:
        # Simulate a fake claude binary that emits a canned fixture.
        fake_script = tmp_path / "claude"
        fixture = Path(__file__).parent / "fixtures" / "chat_stream" / "simple_text.jsonl"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            f"cat {fixture}\n"
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-abc",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )

        result = await session.run(user_text="hello", claude_session_id=None)

        # The fixture's init event session_id is "sess-001"
        assert result.captured_claude_session_id == "sess-001"
        assert result.exit_code == 0
        # Broadcasts: 11 forwarded events from the fixture (13 raw - 2 hook events)
        assert manager.broadcast.await_count == 11

    @pytest.mark.asyncio
    async def test_run_handles_invalid_json_lines_without_crashing(
        self, tmp_path: Path
    ) -> None:
        # Fake claude that emits one valid + one garbage + one valid event
        fake_script = tmp_path / "claude"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            "cat <<'EOF'\n"
            '{"type":"system","subtype":"init","session_id":"s","uuid":"u-1"}\n'
            "this is not json\n"
            '{"type":"result","subtype":"success","is_error":false,"session_id":"s","uuid":"u-2","duration_ms":1}\n'
            "EOF\n"
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-x",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        result = await session.run(user_text="hi", claude_session_id=None)

        # Only the two valid events broadcast; the garbage line is silently dropped.
        assert manager.broadcast.await_count == 2
        assert result.exit_code == 0

    @pytest.mark.asyncio
    async def test_run_writes_user_message_to_stdin_then_closes(
        self, tmp_path: Path
    ) -> None:
        # Fake claude that echoes its stdin to a file, then emits a result event.
        log_path = tmp_path / "stdin.log"
        fake_script = tmp_path / "claude"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            f'cat - > {log_path}\n'
            'echo \'{"type":"result","subtype":"success","is_error":false,"session_id":"s","uuid":"u","duration_ms":1}\'\n'
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-y",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        await session.run(user_text="hello there", claude_session_id=None)

        stdin_payload = log_path.read_text().strip()
        assert stdin_payload == '{"type":"user","message":{"role":"user","content":"hello there"}}'

    @pytest.mark.asyncio
    async def test_cancel_kills_active_subprocess(self, tmp_path: Path) -> None:
        # Fake claude that sleeps forever
        fake_script = tmp_path / "claude"
        fake_script.write_text("#!/usr/bin/env bash\nsleep 3600\n")
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-z",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        import asyncio

        run_task = asyncio.create_task(session.run(user_text="x", claude_session_id=None))
        # Give the subprocess a moment to start
        await asyncio.sleep(0.1)
        await session.cancel()
        result = await run_task
        assert result.exit_code != 0  # killed → non-zero
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_subprocess.py -q
```

- [ ] **Step 3: Append the subprocess driver to chat_stream.py**

Append to `hub/services/chat_stream.py` (after `broadcast_event`):

```python


# ─── Subprocess driver (Phase 2) ──────────────────────────────────────────────


import asyncio
import json
import shutil
from dataclasses import dataclass


@dataclass(frozen=True)
class TurnResult:
    exit_code: int
    captured_claude_session_id: str | None
    forwarded_count: int


def build_command(claude_session_id: str | None, claude_binary: str = "claude") -> list[str]:
    """Build the argv for a single chat turn.

    The first turn (no resume) creates a new Claude session; subsequent
    turns resume that session so context is preserved.
    """
    cmd = [
        claude_binary,
        "--print",
        "--verbose",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--replay-user-messages",
    ]
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
        ws_manager,
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
        )

        # Write the user message JSON, then close stdin to trigger EOF.
        user_payload = json.dumps(
            {"type": "user", "message": {"role": "user", "content": user_text}}
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
        """Terminate the subprocess if running. Idempotent."""
        self._cancelled = True
        proc = self._proc
        if proc is None or proc.returncode is not None:
            return
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
```

- [ ] **Step 4: Run tests, expect 7/7 PASS**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_subprocess.py -v
```

If a `pytest-asyncio` config issue surfaces, ensure `pyproject.toml` has `asyncio_mode = "auto"` (other tests already use this — verify by running `uv run pytest tests -q` and seeing all green).

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/chat_stream.py hub/tests/test_chat_stream_subprocess.py
git commit -m "feat(m33): chat_stream subprocess driver

ClaudeTurnSession spawns one claude --print invocation per user
turn, pipes the user message to stdin (then closes), reads stdout
line-by-line with the Phase 1 parser/filter, and broadcasts every
forwarded event on chat:<named_session_id>.

Captures the Claude session_id from the init event so the caller
can persist it for --resume on the next turn. cancel() is
idempotent and uses SIGTERM with a 2s grace before SIGKILL."
```

---

## Task 4: routes + DB migration + named_sessions extension

**Files:**

- Create: `hub/routers/chat_stream.py`
- Modify: `hub/main.py` (register router)
- Modify: `hub/models/schemas.py` (add `claude_session_id` to `NamedSession`)
- Modify: `hub/services/named_sessions.py` (set/get helpers)
- Create: `hub/db/migrations/versions/<rev>_add_claude_session_id.py` (Alembic migration)
- Create: `hub/tests/test_chat_stream_endpoint.py`

- [ ] **Step 1: Generate the Alembic migration scaffold**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run alembic -c db/alembic.ini revision -m "m33 add claude_session_id to named_sessions"
```

This creates a new file under `hub/db/migrations/versions/`. Open it and replace the `upgrade()` / `downgrade()` bodies:

```python
def upgrade() -> None:
    op.add_column(
        "named_sessions",
        sa.Column("claude_session_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("named_sessions", "claude_session_id")
```

- [ ] **Step 2: Apply migration locally**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run alembic -c db/alembic.ini upgrade head
```

Expected: clean upgrade. Verify the column landed:

```bash
sqlite3 ~/.config/honeycomb/registry.db ".schema named_sessions" | grep claude_session_id
```

- [ ] **Step 3: Extend NamedSession schema + service helpers**

In `hub/models/schemas.py`, find `class NamedSession(BaseModel):` and add the field:

```python
class NamedSession(BaseModel):
    session_id: str
    container_id: int
    name: str
    kind: str
    position: int
    created_at: str
    updated_at: str
    claude_session_id: str | None = None  # M33 — captured from `claude --print` init event
```

In `hub/services/named_sessions.py`, update `_row_to_model`:

```python
def _row_to_model(row) -> NamedSession:
    return NamedSession(
        session_id=row["session_id"],
        container_id=row["container_id"],
        name=row["name"],
        kind=row["kind"],
        position=row["position"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        claude_session_id=row["claude_session_id"],
    )
```

Update every SELECT in the file to include `claude_session_id` in its column list (search for `"SELECT session_id, container_id"` and add `, claude_session_id` everywhere).

Add a new helper at the bottom of the file:

```python
async def set_claude_session_id(
    engine: AsyncEngine,
    *,
    session_id: str,
    claude_session_id: str,
) -> None:
    """Persist the Claude-side session ID captured from the init event.

    Idempotent: callers pass the same value across turns; if already
    set we skip the write.
    """
    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                "UPDATE named_sessions SET claude_session_id = :csid, "
                "    updated_at = :ua "
                "WHERE session_id = :sid AND (claude_session_id IS NULL OR claude_session_id != :csid)"
            ),
            {"sid": session_id, "csid": claude_session_id, "ua": datetime.now().isoformat()},
        )


async def get_session(
    engine: AsyncEngine,
    *,
    session_id: str,
) -> NamedSession | None:
    """Fetch one session by ID, or None if missing."""
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    sa.text(
                        "SELECT session_id, container_id, name, kind, position, "
                        "       created_at, updated_at, claude_session_id "
                        "FROM named_sessions WHERE session_id = :sid"
                    ),
                    {"sid": session_id},
                )
            )
            .mappings()
            .first()
        )
    return _row_to_model(row) if row is not None else None
```

- [ ] **Step 4: Write the failing endpoint test**

Create `hub/tests/test_chat_stream_endpoint.py`:

```python
"""Endpoint tests for the chat-stream router (M33)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from hub.services.named_sessions import create_session, get_session


@pytest.mark.asyncio
async def test_post_turn_404_unknown_session(client: AsyncClient) -> None:
    resp = await client.post("/api/named-sessions/does-not-exist/turns", json={"text": "hi"})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_post_turn_422_empty_text(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="t", kind="claude"
    )
    resp = await client.post(f"/api/named-sessions/{sess.session_id}/turns", json={"text": ""})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_turn_409_only_for_claude_kind(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="shell", kind="shell"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns", json={"text": "hi"}
    )
    assert resp.status_code == 409  # not a claude session


@pytest.mark.asyncio
async def test_post_turn_spawns_and_returns_202(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": "claude-sess-xyz", "forwarded_count": 5}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns", json={"text": "hello"}
        )
    assert resp.status_code == 202

    # ClaudeTurnSession.run was awaited with the user text
    fake_session.run.assert_awaited_once()
    call_kwargs = fake_session.run.await_args.kwargs
    assert call_kwargs["user_text"] == "hello"
    assert call_kwargs["claude_session_id"] is None  # first turn

    # Captured session ID was persisted
    refreshed = await get_session(registry_engine, session_id=sess.session_id)
    assert refreshed is not None
    assert refreshed.claude_session_id == "claude-sess-xyz"


@pytest.mark.asyncio
async def test_post_turn_passes_resume_on_subsequent_turns(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    # Pre-populate the captured Claude session id
    from hub.services.named_sessions import set_claude_session_id

    await set_claude_session_id(
        registry_engine, session_id=sess.session_id, claude_session_id="prev-claude-id"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": "prev-claude-id", "forwarded_count": 1}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns", json={"text": "follow-up"}
        )
    assert resp.status_code == 202
    call_kwargs = fake_session.run.await_args.kwargs
    assert call_kwargs["claude_session_id"] == "prev-claude-id"


@pytest.mark.asyncio
async def test_delete_active_turn_cancels(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    fake_session = AsyncMock()
    # Make run() hang so we can cancel it
    import asyncio

    started = asyncio.Event()
    finished = asyncio.Event()

    async def slow_run(**_):
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            finished.set()
            raise
        return type("R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0})()

    fake_session.run = slow_run

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        # POST /turns kicks off the background task
        post_task = asyncio.create_task(
            client.post(f"/api/named-sessions/{sess.session_id}/turns", json={"text": "hi"})
        )
        await started.wait()
        # Now cancel
        cancel_resp = await client.delete(f"/api/named-sessions/{sess.session_id}/turns/active")
    assert cancel_resp.status_code == 204
    # Cleanup
    fake_session.cancel.assert_awaited()
    post_task.cancel()
    try:
        await post_task
    except (asyncio.CancelledError, Exception):
        pass
```

(The fixture `registered_container` + `registry_engine` already exist in `hub/tests/conftest.py`. The `client` fixture provides an `AsyncClient` with the FastAPI app mounted. Verify these exist via `grep -n "def client\|def registered_container\|def registry_engine" hub/tests/conftest.py` — if any are missing, the test file's imports surface that immediately.)

- [ ] **Step 5: Run tests, expect FAIL (no router)**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_endpoint.py -v
```

- [ ] **Step 6: Implement routers/chat_stream.py**

Create `hub/routers/chat_stream.py`:

```python
"""Chat-stream router (M33).

Two endpoints:
  - POST /api/named-sessions/{session_id}/turns       — start a chat turn
  - DELETE /api/named-sessions/{session_id}/turns/active — cancel in-flight

The POST endpoint validates the session exists + is kind="claude",
spawns a ClaudeTurnSession, and returns 202 Accepted while the
subprocess streams events on the chat:<session_id> WS channel.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from hub.routers.ws import manager as ws_manager
from hub.services.chat_stream import ClaudeTurnSession
from hub.services.named_sessions import (
    get_session,
    set_claude_session_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat-stream"])

# Active turn registry — one in-flight ClaudeTurnSession per
# named-session ID. Used by DELETE to cancel.
_active: dict[str, ClaudeTurnSession] = {}


class TurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    # M33: attachments are accepted but unused (composer UI parity).
    attachments: list[str] = Field(default_factory=list)


@router.post(
    "/api/named-sessions/{session_id}/turns",
    status_code=202,
    response_model=dict,
)
async def post_turn(session_id: str, body: TurnRequest, request: Request) -> dict:
    registry = request.app.state.registry
    sess = await get_session(registry.engine, session_id=session_id)
    if sess is None:
        raise HTTPException(404, f"Session {session_id} not found")
    if sess.kind != "claude":
        raise HTTPException(409, "Turns are only valid on kind=claude sessions")

    container = await registry.get(sess.container_id)
    cwd = container.workspace_folder

    chat = ClaudeTurnSession(
        named_session_id=session_id,
        cwd=cwd,
        ws_manager=ws_manager,
    )
    _active[session_id] = chat

    async def _drive() -> None:
        try:
            result = await chat.run(
                user_text=body.text,
                claude_session_id=sess.claude_session_id,
            )
            if result.captured_claude_session_id is not None:
                await set_claude_session_id(
                    registry.engine,
                    session_id=session_id,
                    claude_session_id=result.captured_claude_session_id,
                )
            logger.info(
                "chat turn done: ns=%s exit=%d forwarded=%d",
                session_id,
                result.exit_code,
                result.forwarded_count,
            )
        except Exception as exc:
            logger.exception("chat turn crashed: %s", exc)
        finally:
            _active.pop(session_id, None)

    asyncio.create_task(_drive())
    return {"accepted": True, "session_id": session_id}


@router.delete(
    "/api/named-sessions/{session_id}/turns/active",
    status_code=204,
)
async def cancel_active_turn(session_id: str) -> None:
    chat = _active.get(session_id)
    if chat is None:
        # Idempotent — no in-flight turn to cancel is a 204.
        return
    await chat.cancel()
```

In `hub/main.py`, register the router. Find the existing `app.include_router(...)` calls and add:

```python
from hub.routers import chat_stream as chat_stream_router

app.include_router(chat_stream_router.router)
```

- [ ] **Step 7: Run tests, expect 6/6 PASS**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_endpoint.py -v
uv run pytest tests/test_chat_stream_subprocess.py tests/test_chat_stream_parser.py tests/test_chat_events_models.py -q
```

Full chat_stream module suite green.

- [ ] **Step 8: Run the full hub suite to confirm no regressions from the schema change**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

If any existing named-sessions test fails because `_row_to_model` now expects a `claude_session_id` column that older DB rows don't have, the SELECT updates from Step 3 should have covered it — re-grep all SELECT statements to be sure.

- [ ] **Step 9: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/chat_stream.py hub/main.py \
        hub/models/schemas.py hub/services/named_sessions.py \
        hub/db/migrations/versions/*claude_session_id*.py \
        hub/tests/test_chat_stream_endpoint.py
git commit -m "feat(m33): chat_stream router + Alembic migration + session helpers

POST /api/named-sessions/{id}/turns spawns a ClaudeTurnSession
and returns 202; the WebSocket carries the streaming output.
DELETE /turns/active cancels the in-flight subprocess (idempotent).

Schema: claude_session_id TEXT NULL on named_sessions for --resume
on multi-turn chats; captured from the init event after the first
turn. Service helpers: set_claude_session_id (idempotent UPDATE)
and get_session (single-row fetch).

Active turns tracked in a module-level dict keyed by
named_session_id — one in-flight subprocess per chat session."
```

---

## Task 5: useChatStream hook + tests

**Files:**

- Create: `dashboard/src/hooks/useChatStream.ts`
- Create: `dashboard/src/hooks/__tests__/useChatStream.test.tsx`
- Create: `dashboard/src/components/chat/types.ts` (TypeScript mirror of hub's chat_events shape)
- Modify: `dashboard/src/lib/types.ts` (add `claude_session_id` field on NamedSession)

The hook subscribes to `chat:<session_id>` and reduces the incoming events into a `ChatTurn[]` array via TanStack Query's `setQueryData`. Pattern mirrors M30's `useDiffEvents`.

- [ ] **Step 1: Create the TypeScript types**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/types.ts`:

```ts
/** TypeScript mirror of hub/models/chat_events.py (M33).
 *
 * Shapes match what the hub broadcasts on chat:<session_id>. The
 * hub uses Pydantic discriminated unions; here we use TS unions
 * with `type` discriminators.
 */

// ─── Anthropic API SSE inner shapes ──────────────────────────────────────────

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant" | "user";
  content: ContentBlock[];
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface TextDelta {
  type: "text_delta";
  text: string;
}
export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}
export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}
export type ContentBlockDeltaInner = TextDelta | InputJsonDelta | ThinkingDelta;

// ─── stream_event.event variants ─────────────────────────────────────────────

export interface MessageStartEvent {
  type: "message_start";
  message: AnthropicMessage;
}
export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}
export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: ContentBlockDeltaInner;
}
export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}
export interface MessageDeltaEvent {
  type: "message_delta";
  delta: Record<string, unknown>;
  usage?: Record<string, unknown>;
}
export interface MessageStopEvent {
  type: "message_stop";
}
export type StreamEventInner =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

// ─── CLI envelope ────────────────────────────────────────────────────────────

export interface SystemEvent {
  type: "system";
  subtype: "init" | "status"; // hook subtypes are filtered server-side
  session_id: string;
  uuid: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  permissionMode?: string;
  status?: string;
}

export interface StreamEvent {
  type: "stream_event";
  event: StreamEventInner;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export interface UserEventEnv {
  type: "user";
  message: AnthropicMessage;
  session_id: string;
  uuid: string;
}

export interface AssistantEventEnv {
  type: "assistant";
  message: AnthropicMessage;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export interface RateLimitEventEnv {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
  session_id: string;
  uuid: string;
}

export interface ResultEventEnv {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  uuid: string;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string | null;
  stop_reason?: string | null;
  total_cost_usd?: number | null;
  usage?: Record<string, unknown>;
}

export type ChatCliEvent =
  | SystemEvent
  | StreamEvent
  | UserEventEnv
  | AssistantEventEnv
  | RateLimitEventEnv
  | ResultEventEnv;

// ─── Reduced "turn" shape — what useChatStream's reducer produces ────────────

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  id: string; // user msg → "user-<uuid>"; assistant msg → message_id
  role: ChatRole;
  blocks: ChatBlock[]; // accumulated content blocks
  streaming: boolean; // true until message_stop fires
  startedAt: string; // ISO 8601
  stoppedAt?: string;
  /** For user messages, the original text (mirror of blocks[0].text). */
  text?: string;
  /** Result event metadata when present (cost, duration, stop_reason). */
  result?: {
    duration_ms: number;
    total_cost_usd: number | null;
    stop_reason: string | null;
  };
}

export type ChatBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool_use";
      tool: string;
      id: string;
      input: Record<string, unknown>;
      partialJson: string;
      complete: boolean;
    }
  | { kind: "thinking"; thinking: string };
```

- [ ] **Step 2: Update the existing NamedSession TS type**

In `/home/gnava/repos/honeycomb/dashboard/src/lib/types.ts`, find the NamedSession interface and add:

```ts
export interface NamedSession {
  // ... existing fields
  claude_session_id?: string | null;
}
```

- [ ] **Step 3: Write the failing test**

Create `/home/gnava/repos/honeycomb/dashboard/src/hooks/__tests__/useChatStream.test.tsx`:

```tsx
/** useChatStream hook tests (M33). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStream } from "../useChatStream";
import type { ChatCliEvent, StreamEvent } from "../../components/chat/types";

// In-memory mock of useHiveWebSocket.
type Listener = (frame: { channel: string; event: string; data: ChatCliEvent }) => void;
const listeners = new Map<string, Set<Listener>>();
const subscribed = new Set<string>();

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    subscribe: (channels: string[]) => channels.forEach((c) => subscribed.add(c)),
    unsubscribe: (channels: string[]) => channels.forEach((c) => subscribed.delete(c)),
    onChannel: (channel: string, cb: Listener) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
  }),
}));

function emit(channel: string, event: ChatCliEvent): void {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of set) cb({ channel, event: event.type, data: event });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  listeners.clear();
  subscribed.clear();
});
afterEach(() => {
  listeners.clear();
});

describe("useChatStream", () => {
  it("subscribes to chat:<id> on mount, unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useChatStream("ns-abc"), { wrapper });
    expect(subscribed.has("chat:ns-abc")).toBe(true);
    unmount();
    expect(subscribed.has("chat:ns-abc")).toBe(false);
  });

  it("does not subscribe when sessionId is null", () => {
    renderHook(() => useChatStream(null), { wrapper });
    expect(subscribed.size).toBe(0);
  });

  it("appends a user turn when a 'user' event arrives", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "user",
        message: {
          id: "msg-u1",
          type: "message",
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        session_id: "claude-s",
        uuid: "u-1",
      });
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].role).toBe("user");
    expect(result.current.turns[0].text).toBe("hi");
  });

  it("starts an assistant turn on message_start", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      const ev: StreamEvent = {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg-1", type: "message", role: "assistant", content: [] },
        },
        session_id: "claude-s",
        uuid: "u-2",
      };
      emit("chat:ns-1", ev);
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].id).toBe("msg-1");
    expect(result.current.turns[0].role).toBe("assistant");
    expect(result.current.turns[0].streaming).toBe(true);
  });

  it("appends text deltas onto the active text block", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        session_id: "s",
        uuid: "u-2",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        session_id: "s",
        uuid: "u-3",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world." },
        },
        session_id: "s",
        uuid: "u-4",
      });
    });
    const turn = result.current.turns[0];
    expect(turn.blocks).toHaveLength(1);
    expect(turn.blocks[0]).toEqual({ kind: "text", text: "Hello world." });
  });

  it("marks turn complete on message_stop", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: { type: "message_stop" },
        session_id: "s",
        uuid: "u-2",
      });
    });
    expect(result.current.turns[0].streaming).toBe(false);
  });

  it("stores tool_use blocks and accumulates partial_json deltas", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
        },
        session_id: "s",
        uuid: "u-2",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls' },
        },
        session_id: "s",
        uuid: "u-3",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: ' /tmp"}' },
        },
        session_id: "s",
        uuid: "u-4",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        session_id: "s",
        uuid: "u-5",
      });
    });
    const block = result.current.turns[0].blocks[0];
    expect(block.kind).toBe("tool_use");
    if (block.kind !== "tool_use") throw new Error();
    expect(block.tool).toBe("Bash");
    expect(block.id).toBe("tu-1");
    expect(block.partialJson).toBe('{"command":"ls /tmp"}');
    expect(block.complete).toBe(true);
  });

  it("captures result event metadata onto the last assistant turn", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s",
        uuid: "u-2",
        duration_ms: 1500,
        total_cost_usd: 0.001,
        stop_reason: "end_turn",
      });
    });
    expect(result.current.turns[0].result).toEqual({
      duration_ms: 1500,
      total_cost_usd: 0.001,
      stop_reason: "end_turn",
    });
  });

  it("clearTurns resets the cache", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "user",
        message: {
          id: "m",
          type: "message",
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        session_id: "s",
        uuid: "u",
      });
    });
    expect(result.current.turns).toHaveLength(1);
    act(() => {
      result.current.clearTurns();
    });
    expect(result.current.turns).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run, expect FAIL**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useChatStream.test.tsx
```

- [ ] **Step 5: Implement useChatStream**

Create `/home/gnava/repos/honeycomb/dashboard/src/hooks/useChatStream.ts`:

```ts
/** useChatStream — subscribe to chat:<session_id> and reduce the
 * stream-json event flow into a ChatTurn[] cache (M33).
 *
 * Pattern mirrors M30's useDiffEvents but with a richer reducer:
 * the chat surface needs incremental text growth, in-flight tool
 * calls, and per-turn metadata (result events).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import type { ChatCliEvent, ChatTurn, ChatBlock, StreamEventInner } from "../components/chat/types";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseChatStreamResult {
  turns: ChatTurn[];
  clearTurns: () => void;
}

function chatQueryKey(sessionId: string) {
  return ["chat-turns", sessionId] as const;
}

function applyEvent(prev: ChatTurn[], event: ChatCliEvent): ChatTurn[] {
  // User messages: append a new user turn.
  if (event.type === "user") {
    const text = event.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    const turn: ChatTurn = {
      id: `user-${event.uuid}`,
      role: "user",
      blocks: text ? [{ kind: "text", text }] : [],
      streaming: false,
      startedAt: new Date().toISOString(),
      text,
    };
    return [...prev, turn];
  }

  // Result event: stamp metadata onto the most recent assistant turn.
  if (event.type === "result") {
    const next = [...prev];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === "assistant") {
        next[i] = {
          ...next[i],
          result: {
            duration_ms: event.duration_ms,
            total_cost_usd: event.total_cost_usd ?? null,
            stop_reason: event.stop_reason ?? null,
          },
        };
        break;
      }
    }
    return next;
  }

  // Stream events: drive incremental rendering of the active assistant turn.
  if (event.type === "stream_event") {
    return applyStreamEvent(prev, event.event);
  }

  // System / assistant snapshot / rate_limit are observational — ignore for now.
  return prev;
}

function applyStreamEvent(prev: ChatTurn[], inner: StreamEventInner): ChatTurn[] {
  if (inner.type === "message_start") {
    const turn: ChatTurn = {
      id: inner.message.id,
      role: "assistant",
      blocks: [],
      streaming: true,
      startedAt: new Date().toISOString(),
    };
    return [...prev, turn];
  }

  if (prev.length === 0) return prev; // defensive: deltas before any message_start
  const next = [...prev];
  const idx = next.length - 1;
  const turn = { ...next[idx], blocks: [...next[idx].blocks] };
  next[idx] = turn;

  if (inner.type === "content_block_start") {
    const cb = inner.content_block;
    let block: ChatBlock;
    if (cb.type === "tool_use") {
      block = {
        kind: "tool_use",
        tool: cb.name,
        id: cb.id,
        input: cb.input,
        partialJson: "",
        complete: false,
      };
    } else if (cb.type === "thinking") {
      block = { kind: "thinking", thinking: cb.thinking ?? "" };
    } else {
      block = { kind: "text", text: cb.text ?? "" };
    }
    turn.blocks[inner.index] = block;
    return next;
  }

  if (inner.type === "content_block_delta") {
    const block = turn.blocks[inner.index];
    if (block === undefined) return next;
    if (inner.delta.type === "text_delta" && block.kind === "text") {
      turn.blocks[inner.index] = { ...block, text: block.text + inner.delta.text };
    } else if (inner.delta.type === "thinking_delta" && block.kind === "thinking") {
      turn.blocks[inner.index] = {
        ...block,
        thinking: block.thinking + inner.delta.thinking,
      };
    } else if (inner.delta.type === "input_json_delta" && block.kind === "tool_use") {
      turn.blocks[inner.index] = {
        ...block,
        partialJson: block.partialJson + inner.delta.partial_json,
      };
    }
    return next;
  }

  if (inner.type === "content_block_stop") {
    const block = turn.blocks[inner.index];
    if (block !== undefined && block.kind === "tool_use") {
      turn.blocks[inner.index] = { ...block, complete: true };
    }
    return next;
  }

  if (inner.type === "message_stop") {
    turn.streaming = false;
    turn.stoppedAt = new Date().toISOString();
    return next;
  }

  return next;
}

export function useChatStream(sessionId: string | null): UseChatStreamResult {
  const qc = useQueryClient();
  const ws = useHiveWebSocket();

  const query = useQuery({
    queryKey: sessionId ? chatQueryKey(sessionId) : ["chat-turns", "_disabled"],
    queryFn: () => Promise.resolve([] as ChatTurn[]),
    enabled: sessionId !== null,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (sessionId === null) return;
    const channel = `chat:${sessionId}`;
    ws.subscribe([channel]);
    const remove = ws.onChannel(channel, (frame) => {
      const event = frame.data as ChatCliEvent;
      qc.setQueryData<ChatTurn[]>(chatQueryKey(sessionId), (prev) => applyEvent(prev ?? [], event));
    });
    return () => {
      remove();
      ws.unsubscribe([channel]);
    };
  }, [sessionId, ws, qc]);

  const clearTurns = useCallback(() => {
    if (sessionId === null) return;
    qc.setQueryData<ChatTurn[]>(chatQueryKey(sessionId), []);
  }, [qc, sessionId]);

  return { turns: query.data ?? [], clearTurns };
}
```

- [ ] **Step 6: Run tests, expect 9/9 PASS**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useChatStream.test.tsx
```

- [ ] **Step 7: Run full vitest + typecheck**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

- [ ] **Step 8: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useChatStream.ts \
        dashboard/src/hooks/__tests__/useChatStream.test.tsx \
        dashboard/src/components/chat/types.ts \
        dashboard/src/lib/types.ts
git commit -m "feat(m33): useChatStream hook + chat type system

TanStack Query cache keyed by chat:<session_id>; subscribes to
the WS channel via useHiveWebSocket. The reducer accepts CLI
envelope events and maintains a ChatTurn[] with incremental text
growth, in-flight tool blocks (with partial_json accumulation),
and result-event metadata stamped onto the last assistant turn.

types.ts mirrors hub/models/chat_events.py with TS discriminated
unions; ChatTurn / ChatBlock are the reduced shape components
render against."
```

---

## Task 6: chat/ scaffolding — ChatThread + ChatHeader + ChatTabStrip + ModeToggle + ModelChip + EffortControl

**Files (all new):**

- `dashboard/src/components/chat/ChatThread.tsx`
- `dashboard/src/components/chat/ChatHeader.tsx`
- `dashboard/src/components/chat/ChatTabStrip.tsx`
- `dashboard/src/components/chat/ModeToggle.tsx`
- `dashboard/src/components/chat/ModelChip.tsx`
- `dashboard/src/components/chat/EffortControl.tsx`
- `dashboard/src/components/chat/__tests__/ChatHeader.test.tsx`
- `dashboard/src/components/chat/__tests__/ChatTabStrip.test.tsx`
- `dashboard/src/components/chat/__tests__/ModeToggle.test.tsx`
- Modify: `dashboard/src/index.css` (add `--color-todo` token + light variant)

The chat shell pieces are visual surfaces with no live data dependencies yet (Task 7 adds Composer + Stream; Task 13 wires the live cache). Each is small and self-tested.

- [ ] **Step 1: Add the `--color-todo` token to index.css**

In `dashboard/src/index.css`, find the `@theme` block and add inside the "Accent / semantic colors" section (after `--color-review`):

```css
--color-todo: #79c0ff;
```

In the `[data-theme="light"]` block, add (after `--color-review`):

```css
--color-todo: #0969da;
```

In the `prefers-color-scheme: light` `:root:not([data-theme])` block, add the same `--color-todo: #0969da;`.

- [ ] **Step 2: Implement ModeToggle**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ModeToggle.tsx`:

```tsx
/** Code/Review/Plan segmented control (M33).
 *
 * M33: persists to localStorage:hive:chat:<sessionId>:mode but has
 * no backend semantics. M34 wires per-mode subprocess args.
 */
import { useEffect, useState } from "react";

export type ChatMode = "code" | "review" | "plan";

const MODE_LABELS: Record<ChatMode, string> = {
  code: "Code",
  review: "Review",
  plan: "Plan",
};

const MODES: readonly ChatMode[] = ["code", "review", "plan"] as const;

interface Props {
  sessionId: string;
  onChange?: (mode: ChatMode) => void;
}

function storageKey(sessionId: string): string {
  return `hive:chat:${sessionId}:mode`;
}

function readStored(sessionId: string): ChatMode {
  if (typeof window === "undefined") return "code";
  const v = window.localStorage.getItem(storageKey(sessionId));
  return v === "review" || v === "plan" ? v : "code";
}

export function ModeToggle({ sessionId, onChange }: Props) {
  const [mode, setMode] = useState<ChatMode>(() => readStored(sessionId));
  useEffect(() => {
    setMode(readStored(sessionId));
  }, [sessionId]);
  const update = (next: ChatMode) => {
    setMode(next);
    window.localStorage.setItem(storageKey(sessionId), next);
    onChange?.(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Chat mode"
      className="inline-flex items-center rounded-md border border-edge bg-pane p-0.5"
    >
      {MODES.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => update(m)}
            className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
              active ? "bg-chip text-primary" : "text-secondary hover:text-primary"
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Implement ModelChip + EffortControl (M33-inert visuals)**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ModelChip.tsx`:

```tsx
/** Model picker chip (M33 visual; M34 wires real semantics).
 *
 * Click cycles through a placeholder list. Persisted to
 * localStorage:hive:chat:<sessionId>:model. The downstream chat
 * spawn does NOT yet pass --model — that's M34.
 */
import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

export type ChatModel = "opus-4-7" | "sonnet-4-6" | "haiku-4-5";

const MODEL_LABELS: Record<ChatModel, string> = {
  "opus-4-7": "Opus 4.7",
  "sonnet-4-6": "Sonnet 4.6",
  "haiku-4-5": "Haiku 4.5",
};

interface Props {
  sessionId: string;
}

function storageKey(sessionId: string) {
  return `hive:chat:${sessionId}:model`;
}

function readStored(sessionId: string): ChatModel {
  if (typeof window === "undefined") return "sonnet-4-6";
  const v = window.localStorage.getItem(storageKey(sessionId));
  return v === "opus-4-7" || v === "haiku-4-5" ? v : "sonnet-4-6";
}

export function ModelChip({ sessionId }: Props) {
  const [model, setModel] = useState<ChatModel>(() => readStored(sessionId));
  useEffect(() => {
    setModel(readStored(sessionId));
  }, [sessionId]);

  const cycle = () => {
    // M33 placeholder: cycle through the three models.
    const order: ChatModel[] = ["opus-4-7", "sonnet-4-6", "haiku-4-5"];
    const next = order[(order.indexOf(model) + 1) % order.length];
    setModel(next);
    window.localStorage.setItem(storageKey(sessionId), next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title="Model selection (full picker arrives in M34)"
      className="inline-flex items-center gap-1 rounded-md border border-edge bg-pane px-2 py-1 text-[11px] text-primary hover:bg-chip"
    >
      <Sparkles size={11} aria-hidden="true" className="text-claude" />
      <span>★ {MODEL_LABELS[model]}</span>
      <ChevronDown size={10} aria-hidden="true" />
    </button>
  );
}
```

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/EffortControl.tsx`:

```tsx
/** Quick · Standard · Deep · Max segmented control (M33 visual; M34
 * wires real `thinking.budget_tokens` semantics).
 */
import { useEffect, useState } from "react";

export type ChatEffort = "quick" | "standard" | "deep" | "max";

const EFFORTS: readonly ChatEffort[] = ["quick", "standard", "deep", "max"] as const;
const EFFORT_LABEL: Record<ChatEffort, string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
  max: "Max",
};

interface Props {
  sessionId: string;
}

function storageKey(sessionId: string) {
  return `hive:chat:${sessionId}:effort`;
}

function readStored(sessionId: string): ChatEffort {
  if (typeof window === "undefined") return "standard";
  const v = window.localStorage.getItem(storageKey(sessionId));
  return v === "quick" || v === "deep" || v === "max" ? v : "standard";
}

export function EffortControl({ sessionId }: Props) {
  const [effort, setEffort] = useState<ChatEffort>(() => readStored(sessionId));
  useEffect(() => {
    setEffort(readStored(sessionId));
  }, [sessionId]);

  const update = (next: ChatEffort) => {
    setEffort(next);
    window.localStorage.setItem(storageKey(sessionId), next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      className="inline-flex items-center rounded-md border border-edge bg-pane p-0.5"
    >
      {EFFORTS.map((e) => {
        const active = e === effort;
        return (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => update(e)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              active ? "bg-chip text-primary" : "text-secondary hover:text-primary"
            }`}
          >
            {EFFORT_LABEL[e]}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Implement ChatHeader**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatHeader.tsx`:

```tsx
/** Chat thread header — workspace pill (left) + mode + model + actions (right). */
import { History, MoreHorizontal, Compass } from "lucide-react";

import { WorkspacePill } from "../WorkspacePill";
import type { ContainerRecord } from "../../lib/types";
import { ModeToggle } from "./ModeToggle";
import { ModelChip } from "./ModelChip";

interface Props {
  sessionId: string;
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function ChatHeader({ sessionId, containers, activeContainerId, onSelectContainer }: Props) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-edge bg-pane px-3 py-1.5">
      <WorkspacePill
        containers={containers}
        activeContainerId={activeContainerId}
        onSelectContainer={onSelectContainer}
      />
      <div className="flex items-center gap-2">
        <ModeToggle sessionId={sessionId} />
        <ModelChip sessionId={sessionId} />
        <button
          type="button"
          title="History (M35)"
          aria-label="Chat history"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <History size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="Compact context"
          aria-label="Compact context"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Compass size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="More actions"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
```

Note: `ChatHeader` REPLACES the WorkspacePill placement that ChatsRoute had been rendering directly. Task 12 wires this up; for now ChatHeader just lives in `chat/` ready to be imported.

- [ ] **Step 5: Implement ChatTabStrip**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatTabStrip.tsx`:

```tsx
/** Tab strip below the chat header — one tab per chat session in the
 * active workspace. Mode-color icon per tab. + New at the right.
 *
 * For M33 this is a thin wrapper around the existing SessionSubTabs
 * shape; M35+ may evolve to surface fork relationships visually.
 */
import { Plus } from "lucide-react";

import type { ChatMode } from "./ModeToggle";

export interface ChatTabInfo {
  id: string;
  name: string;
  mode: ChatMode;
}

interface Props {
  tabs: ChatTabInfo[];
  activeId: string;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

const MODE_DOT: Record<ChatMode, string> = {
  code: "bg-tool",
  review: "bg-claude",
  plan: "bg-think",
};

export function ChatTabStrip({ tabs, activeId, onFocus, onClose, onNew }: Props) {
  return (
    <nav
      role="tablist"
      aria-label="Chat tabs"
      className="flex items-center gap-0.5 border-b border-edge bg-pane px-2 py-1"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onFocus(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.id);
            }}
            className={`flex items-center gap-1.5 rounded-t px-2 py-1 text-[11px] transition-colors ${
              active ? "bg-page text-primary" : "text-secondary hover:bg-chip hover:text-primary"
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MODE_DOT[tab.mode]}`} />
            <span className="max-w-[10rem] truncate">{tab.name}</span>
            <span
              role="button"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="rounded text-faint hover:bg-edge hover:text-primary"
            >
              ×
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        aria-label="New chat"
        className="ml-1 inline-flex items-center gap-1 rounded p-1 text-secondary hover:bg-chip hover:text-primary"
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    </nav>
  );
}
```

- [ ] **Step 6: Implement ChatThread shell (no Composer/Stream yet — Task 7 adds them)**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatThread.tsx`:

```tsx
/** Chat thread container (M33).
 *
 * Composes header → tab strip → stream → composer. Task 6 ships the
 * shell; Tasks 7-11 fill in the pieces. Task 13 wires the live data.
 */
import type { ContainerRecord } from "../../lib/types";
import { ChatHeader } from "./ChatHeader";
import { ChatTabStrip, type ChatTabInfo } from "./ChatTabStrip";

interface Props {
  sessionId: string;
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;

  tabs: ChatTabInfo[];
  activeTabId: string;
  onFocusTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export function ChatThread({
  sessionId,
  containers,
  activeContainerId,
  onSelectContainer,
  tabs,
  activeTabId,
  onFocusTab,
  onCloseTab,
  onNewTab,
}: Props) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-page">
      <ChatHeader
        sessionId={sessionId}
        containers={containers}
        activeContainerId={activeContainerId}
        onSelectContainer={onSelectContainer}
      />
      <ChatTabStrip
        tabs={tabs}
        activeId={activeTabId}
        onFocus={onFocusTab}
        onClose={onCloseTab}
        onNew={onNewTab}
      />
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Chat stream + composer arrive in subsequent M33 tasks.
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write the failing tests**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ModeToggle.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModeToggle } from "../ModeToggle";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("ModeToggle", () => {
  it("defaults to 'code' when no stored value", () => {
    render(<ModeToggle sessionId="s1" />);
    const code = screen.getByRole("radio", { name: "Code" });
    expect(code.getAttribute("aria-checked")).toBe("true");
  });

  it("loads stored mode on mount", () => {
    window.localStorage.setItem("hive:chat:s2:mode", "plan");
    render(<ModeToggle sessionId="s2" />);
    expect(screen.getByRole("radio", { name: "Plan" }).getAttribute("aria-checked")).toBe("true");
  });

  it("clicking a mode persists + flips aria-checked", () => {
    render(<ModeToggle sessionId="s3" />);
    fireEvent.click(screen.getByRole("radio", { name: "Review" }));
    expect(screen.getByRole("radio", { name: "Review" }).getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("hive:chat:s3:mode")).toBe("review");
  });
});
```

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ChatTabStrip.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatTabStrip } from "../ChatTabStrip";

const tabs = [
  { id: "t1", name: "main", mode: "code" as const },
  { id: "t2", name: "review", mode: "review" as const },
];

describe("ChatTabStrip", () => {
  it("renders one tab per item + a + New button", () => {
    render(
      <ChatTabStrip
        tabs={tabs}
        activeId="t1"
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByLabelText("New chat")).toBeTruthy();
  });

  it("active tab has aria-selected=true", () => {
    render(
      <ChatTabStrip
        tabs={tabs}
        activeId="t2"
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const tabsEls = screen.getAllByRole("tab");
    expect(tabsEls[0].getAttribute("aria-selected")).toBe("false");
    expect(tabsEls[1].getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a tab calls onFocus", () => {
    const onFocus = vi.fn();
    render(
      <ChatTabStrip
        tabs={tabs}
        activeId="t1"
        onFocus={onFocus}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(onFocus).toHaveBeenCalledWith("t2");
  });

  it("clicking the close × calls onClose with that tab's id", () => {
    const onClose = vi.fn();
    render(
      <ChatTabStrip
        tabs={tabs}
        activeId="t1"
        onFocus={vi.fn()}
        onClose={onClose}
        onNew={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close main"));
    expect(onClose).toHaveBeenCalledWith("t1");
  });

  it("clicking + New calls onNew", () => {
    const onNew = vi.fn();
    render(
      <ChatTabStrip tabs={tabs} activeId="t1" onFocus={vi.fn()} onClose={vi.fn()} onNew={onNew} />,
    );
    fireEvent.click(screen.getByLabelText("New chat"));
    expect(onNew).toHaveBeenCalled();
  });
});
```

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ChatHeader.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatHeader } from "../ChatHeader";
import type { ContainerRecord } from "../../../lib/types";

const fixture: ContainerRecord = {
  id: 1,
  workspace_folder: "/repos/foo",
  project_type: "base",
  project_name: "foo",
  project_description: "",
  git_repo_url: null,
  container_id: "deadbeef",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

describe("ChatHeader", () => {
  it("renders the workspace pill, mode toggle, model chip, and three action buttons", () => {
    render(
      <ChatHeader
        sessionId="s"
        containers={[fixture]}
        activeContainerId={1}
        onSelectContainer={vi.fn()}
      />,
    );
    // WorkspacePill exposes a button labelled with the container name
    expect(screen.getByRole("button", { name: /^foo$/ })).toBeTruthy();
    // Mode toggle exposes 3 radios
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    // Action buttons
    expect(screen.getByRole("button", { name: /Chat history/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Compact context/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /More actions/i })).toBeTruthy();
  });
});
```

- [ ] **Step 8: Run, expect 9/9 PASS (3 + 5 + 1)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/
```

- [ ] **Step 9: Typecheck + commit**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/ dashboard/src/index.css
git commit -m "feat(m33): chat shell scaffolding (header / tabs / mode / model / effort)

ChatThread shell renders ChatHeader (WorkspacePill + ModeToggle +
ModelChip + history/compact/overflow) over ChatTabStrip with a
placeholder body. Tasks 7+ fill in the stream + composer.

ModeToggle persists to localStorage:hive:chat:<id>:mode (code /
review / plan); ModelChip + EffortControl persist similarly but
have no backend semantics in M33 — M34 wires them.

Adds --color-todo to the M31 token table (blue, parallels
--color-tool) so MessageToolTodo can adopt it in Task 10."
```

If pre-commit prettier reformats anything, re-stage and re-commit.

---

## Task 7: ChatStream + ChatComposer (visual surfaces, no live data yet)

**Files (all new):**

- `dashboard/src/components/chat/ChatStream.tsx`
- `dashboard/src/components/chat/ChatComposer.tsx`
- `dashboard/src/lib/chatApi.ts` (REST wrappers)
- `dashboard/src/components/chat/__tests__/ChatComposer.test.tsx`
- `dashboard/src/components/chat/__tests__/ChatStream.test.tsx`

The Stream renders a list of `ChatTurn` with empty/loading states; Tasks 8-10 fill in per-message components. The Composer is the multi-line textarea + foot row + send/attach/slash buttons.

- [ ] **Step 1: Implement chatApi.ts (REST wrappers)**

Create `/home/gnava/repos/honeycomb/dashboard/src/lib/chatApi.ts`:

```ts
/** REST wrappers for M33 chat endpoints. */
import { authedFetch } from "./api";

export async function postChatTurn(sessionId: string, text: string): Promise<void> {
  const resp = await authedFetch(`/api/named-sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, attachments: [] }),
  });
  if (!resp.ok) {
    throw new Error(`POST /turns failed: ${resp.status} ${await resp.text()}`);
  }
}

export async function cancelActiveTurn(sessionId: string): Promise<void> {
  const resp = await authedFetch(`/api/named-sessions/${sessionId}/turns/active`, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`DELETE /turns/active failed: ${resp.status}`);
  }
}
```

(`authedFetch` is the existing helper from `dashboard/src/lib/api.ts` — verify the export name with `grep -n "export.*authedFetch\|export.*apiFetch" dashboard/src/lib/api.ts` and adjust the import name if it's `apiFetch` in your tree.)

- [ ] **Step 2: Implement ChatComposer**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatComposer.tsx`:

```tsx
/** Composer (M33).
 *
 * Multi-line auto-grow textarea, attach/slash/send icons on the
 * right, foot row with Effort + active-mode label + keyboard hints.
 *
 * Real semantics for effort/model/slash/attachments arrive in M34.
 * M33: the controls render and persist their state, but only the
 * text payload is sent to the hub.
 */
import { Paperclip, Send, Slash } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { EffortControl } from "./EffortControl";
import type { ChatMode } from "./ModeToggle";

interface Props {
  sessionId: string;
  mode: ChatMode;
  disabled?: boolean;
  onSend: (text: string) => void;
}

const MODE_LABEL: Record<ChatMode, string> = {
  code: "Code",
  review: "Review",
  plan: "Plan",
};

export function ChatComposer({ sessionId, mode, disabled, onSend }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-edge bg-pane">
      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`Send a message in ${MODE_LABEL[mode]} mode…`}
          aria-label="Chat input"
          disabled={disabled}
          rows={1}
          className="min-h-[2.25rem] flex-1 resize-none rounded border border-edge bg-input px-2 py-1.5 text-[13px] text-primary placeholder:text-muted focus:outline-none focus-visible:border-accent disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Attach file"
          title="Attach file (M34)"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Paperclip size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Insert slash command"
          title="Slash commands (M34)"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Slash size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={send}
          aria-label="Send"
          disabled={disabled || value.trim().length === 0}
          className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Send size={12} aria-hidden="true" />
          <span>Send</span>
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-edge-soft px-3 py-1 text-[10px] text-muted">
        <div className="flex items-center gap-2">
          <EffortControl sessionId={sessionId} />
          <span>
            Mode: <span className="text-primary">{MODE_LABEL[mode]}</span>
          </span>
        </div>
        <span className="font-mono text-faint">⌘↵ send · esc cancel</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement ChatStream (renders ChatTurn[] with empty + per-turn placeholder)**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatStream.tsx`:

```tsx
/** Chat stream (M33).
 *
 * Renders a flat list of ChatTurn; per-turn rendering delegates to
 * the message components from Tasks 8-10. Auto-scrolls to bottom
 * while a turn is streaming. Empty state shown when there are zero
 * turns.
 */
import { useEffect, useRef } from "react";

import type { ChatTurn } from "./types";

interface Props {
  turns: ChatTurn[];
  /** Optional render override — Task 13 passes a real renderer; the
   *  stub fallback shows a placeholder summary per turn. */
  renderTurn?: (turn: ChatTurn) => React.ReactNode;
}

export function ChatStream({ turns, renderTurn }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastTurn = turns[turns.length - 1];

  useEffect(() => {
    if (lastTurn?.streaming) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lastTurn?.streaming, lastTurn?.blocks]);

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-secondary">No turns yet — say something to start the chat.</p>
      </div>
    );
  }

  return (
    <div role="log" aria-live="polite" className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {turns.map((turn) =>
        renderTurn ? (
          <div key={turn.id}>{renderTurn(turn)}</div>
        ) : (
          <PlaceholderTurn key={turn.id} turn={turn} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

function PlaceholderTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div
      className={`rounded border border-edge bg-card px-3 py-2 text-[12px] ${
        turn.role === "user" ? "ml-auto max-w-[78%] text-primary" : "text-primary"
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {turn.role === "user" ? "You" : "Claude"}
        {turn.streaming && <span className="ml-2 text-think">streaming…</span>}
      </div>
      <div className="mt-1 font-mono text-[11px] text-secondary">
        blocks: {turn.blocks.length} · {turn.streaming ? "in flight" : "complete"}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the failing tests**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ChatComposer.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../ChatComposer";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("ChatComposer", () => {
  it("renders an input + send button (disabled when empty)", () => {
    render(<ChatComposer sessionId="s" mode="code" onSend={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /chat input/i })).toBeTruthy();
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send.hasAttribute("disabled")).toBe(true);
  });

  it("clicking Send calls onSend with trimmed text + clears input", () => {
    const onSend = vi.fn();
    render(<ChatComposer sessionId="s" mode="code" onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: /chat input/i }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(input.value).toBe("");
  });

  it("Cmd+Enter sends", () => {
    const onSend = vi.fn();
    render(<ChatComposer sessionId="s" mode="code" onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("ping");
  });

  it("displays the active mode label in the foot", () => {
    render(<ChatComposer sessionId="s" mode="plan" onSend={vi.fn()} />);
    // The foot row contains "Mode: Plan"
    expect(screen.getByText(/Mode:/)).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  it("disabled prop blocks Send + Cmd+Enter", () => {
    const onSend = vi.fn();
    render(<ChatComposer sessionId="s" mode="code" disabled onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
```

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ChatStream.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatStream } from "../ChatStream";
import type { ChatTurn } from "../types";

const userTurn: ChatTurn = {
  id: "user-1",
  role: "user",
  blocks: [{ kind: "text", text: "hi" }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
  text: "hi",
};

const assistantTurn: ChatTurn = {
  id: "msg-1",
  role: "assistant",
  blocks: [{ kind: "text", text: "Hello." }],
  streaming: true,
  startedAt: "2026-04-26T00:00:01Z",
};

describe("ChatStream", () => {
  it("renders empty state when no turns", () => {
    render(<ChatStream turns={[]} />);
    expect(screen.getByText(/No turns yet/i)).toBeTruthy();
  });

  it("renders one placeholder per turn when no renderTurn provided", () => {
    render(<ChatStream turns={[userTurn, assistantTurn]} />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    // Streaming indicator on the assistant turn
    expect(screen.getByText("streaming…")).toBeTruthy();
  });

  it("delegates to renderTurn when provided", () => {
    render(
      <ChatStream turns={[userTurn]} renderTurn={(t) => <div data-testid="custom">{t.id}</div>} />,
    );
    expect(screen.getByTestId("custom").textContent).toBe("user-1");
  });
});
```

- [ ] **Step 5: Run, expect FAIL → 8 PASS after implementation**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/ChatComposer.test.tsx src/components/chat/__tests__/ChatStream.test.tsx
```

(Tests above; implementations above. Run; should be 5 + 3 = 8 PASS.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/ChatStream.tsx \
        dashboard/src/components/chat/ChatComposer.tsx \
        dashboard/src/lib/chatApi.ts \
        dashboard/src/components/chat/__tests__/ChatComposer.test.tsx \
        dashboard/src/components/chat/__tests__/ChatStream.test.tsx
git commit -m "feat(m33): ChatStream + ChatComposer + chatApi REST wrappers

ChatComposer: multi-line auto-grow textarea, attach/slash/send
icons (attach + slash are visual placeholders for M34), foot row
with EffortControl + active-mode label + keyboard hint. ⌘↵ sends.
The text payload routes through onSend; the parent component
calls postChatTurn from chatApi.ts.

ChatStream: aria-live='polite' message list with auto-scroll
during streaming. Renders a placeholder per turn unless the
parent passes renderTurn — Task 13 plugs in the real per-message
renderer once Tasks 8-10 build the message components."
```

---

## Task 8: Basic message components (User / AssistantText / Thinking) + ToolBlockChrome

**Files (all new):**

- `dashboard/src/components/chat/messages/MessageUser.tsx`
- `dashboard/src/components/chat/messages/MessageAssistantText.tsx`
- `dashboard/src/components/chat/messages/MessageThinking.tsx`
- `dashboard/src/components/chat/messages/ToolBlockChrome.tsx` (shared chassis used by Tasks 9-10)
- `dashboard/src/components/chat/messages/__tests__/MessageUser.test.tsx`
- `dashboard/src/components/chat/messages/__tests__/MessageAssistantText.test.tsx`
- `dashboard/src/components/chat/messages/__tests__/MessageThinking.test.tsx`

Each message component takes a single `ChatTurn` (or a single block within a turn for tool messages — Tasks 9-10 model this differently). For these basic types, the turn maps 1:1 to a rendered bubble.

- [ ] **Step 1: Implement MessageUser**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageUser.tsx`:

```tsx
/** User message bubble (M33). Right-aligned, max 78% width. */
import type { ChatTurn } from "../types";

interface Props {
  turn: ChatTurn;
}

export function MessageUser({ turn }: Props) {
  const text =
    turn.text ??
    turn.blocks
      .filter((b) => b.kind === "text")
      .map((b) => (b as { kind: "text"; text: string }).text)
      .join("");
  return (
    <div
      role="article"
      aria-label="User message"
      className="ml-auto max-w-[78%] rounded-lg border border-edge bg-card px-3 py-2 text-[13px] text-primary"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">You</div>
      <div className="mt-1 whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}
```

- [ ] **Step 2: Implement MessageAssistantText**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageAssistantText.tsx`:

```tsx
/** Assistant text message (M33). Renders the concatenated text blocks
 *  with a streaming cursor when the turn is in flight. Markdown
 *  rendering is intentionally out of scope for M33 (M34 may add it);
 *  for now we render plain text + preserve newlines. */
import type { ChatTurn } from "../types";

interface Props {
  turn: ChatTurn;
}

export function MessageAssistantText({ turn }: Props) {
  const text = turn.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { kind: "text"; text: string }).text)
    .join("");
  return (
    <div role="article" aria-label="Assistant message" className="text-[13px] text-primary">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-claude">Claude</div>
      <div className="mt-1 whitespace-pre-wrap break-words">
        {text}
        {turn.streaming && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-claude align-middle"
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement MessageThinking**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageThinking.tsx`:

```tsx
/** Thinking block (M33). Orange-tinted, collapsible, italic body. */
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";

interface Props {
  thinking: string;
  streaming?: boolean;
}

export function MessageThinking({ thinking, streaming }: Props) {
  const [open, setOpen] = useState(false);
  const oneLine = thinking.split("\n")[0]?.slice(0, 120) ?? "";
  return (
    <div className="rounded border border-edge-soft bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle thinking block"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-think hover:bg-chip"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Sparkles size={11} />
        <span className="font-semibold uppercase tracking-wider">Thinking</span>
        {!open && <span className="truncate text-muted normal-case">{oneLine}</span>}
        {streaming && <span className="ml-auto text-think">streaming…</span>}
      </button>
      {open && (
        <pre className="border-t border-edge-soft px-3 py-2 font-mono text-[11px] italic text-secondary whitespace-pre-wrap">
          {thinking}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement ToolBlockChrome (shared chassis)**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/ToolBlockChrome.tsx`:

```tsx
/** Shared chassis for all MessageTool* components (M33).
 *
 * Header: tool icon + name + target (one-liner) + status badge.
 * Body: caller-rendered children. Color comes from the `accent` prop
 * which maps to a Tailwind text token (text-tool / text-edit / text-read /
 * text-write / text-task / text-todo / text-think).
 */
import { CheckCircle, Loader2 } from "lucide-react";

import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  name: string;
  target?: string | null;
  accent: string; // e.g. "text-tool" — Tailwind class
  borderAccent: string; // e.g. "border-tool/30"
  complete: boolean;
  children?: ReactNode;
}

export function ToolBlockChrome({
  icon,
  name,
  target,
  accent,
  borderAccent,
  complete,
  children,
}: Props) {
  return (
    <div className={`overflow-hidden rounded border ${borderAccent} bg-card`}>
      <header
        className={`flex items-center gap-2 border-b border-edge-soft bg-pane px-3 py-1 text-[11px] ${accent}`}
      >
        <span aria-hidden="true">{icon}</span>
        <span className="font-semibold uppercase tracking-wider">{name}</span>
        {target && <span className="truncate font-mono text-secondary normal-case">{target}</span>}
        <span className="ml-auto">
          {complete ? (
            <CheckCircle size={11} aria-label="Complete" />
          ) : (
            <Loader2 size={11} aria-label="Running" className="animate-spin" />
          )}
        </span>
      </header>
      {children && <div className="px-3 py-2 text-[12px] text-primary">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Write tests + run + commit**

Create the three test files. Each is short; example for MessageUser:

```tsx
// dashboard/src/components/chat/messages/__tests__/MessageUser.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageUser } from "../MessageUser";
import type { ChatTurn } from "../../types";

const turn: ChatTurn = {
  id: "u-1",
  role: "user",
  blocks: [{ kind: "text", text: "Hello there" }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
  text: "Hello there",
};

describe("MessageUser", () => {
  it("renders the text inside a labelled article", () => {
    render(<MessageUser turn={turn} />);
    const art = screen.getByRole("article", { name: /User message/i });
    expect(art.textContent).toContain("Hello there");
    expect(art.textContent).toContain("You");
  });
});
```

Mirror that pattern for `MessageAssistantText.test.tsx` (assert "Claude" label + the streaming cursor when `turn.streaming === true`) and `MessageThinking.test.tsx` (assert collapsed by default; click to expand; streaming indicator visible when `streaming=true`). Each test file: 2-3 cases.

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/messages/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/messages/
git commit -m "feat(m33): basic message components + ToolBlockChrome

MessageUser (right-aligned bubble, max 78% width), MessageAssistantText
(streaming cursor while in flight), MessageThinking (collapsible
orange-tinted block, italic body). ToolBlockChrome is the shared
chassis Tasks 9-10's tool components compose around — header with
icon + name + target + status badge, body slot for tool-specific
content."
```

---

## Task 9: Tool message components (Bash, Edit, Read, Write)

**Files (all new):**

- `dashboard/src/components/chat/messages/MessageToolBash.tsx`
- `dashboard/src/components/chat/messages/MessageToolEdit.tsx`
- `dashboard/src/components/chat/messages/MessageToolRead.tsx`
- `dashboard/src/components/chat/messages/MessageToolWrite.tsx`
- Tests for each

Each component takes a `ToolUseBlock` (with `partialJson` accumulated from deltas) and renders the tool-specific body inside `ToolBlockChrome`. Parse `partialJson` defensively — it may be incomplete during streaming.

Common helper: parse the partial JSON safely.

- [ ] **Step 1: Add a JSON parse helper at the top of each tool file (or extract to a shared util)**

Extract to `dashboard/src/components/chat/messages/_partialJson.ts`:

```ts
/** Defensive JSON.parse for tool_use partial inputs. Returns the
 *  parsed object on success, or null while the JSON is still
 *  incomplete. Don't throw — partial JSON is the streaming norm. */
export function tryParse(s: string): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Implement MessageToolBash**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageToolBash.tsx`:

```tsx
import { Terminal } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolBash({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const command = (parsed.command as string | undefined) ?? "";
  const description = parsed.description as string | undefined;
  return (
    <ToolBlockChrome
      icon={<Terminal size={11} />}
      name="Bash"
      target={description ?? null}
      accent="text-tool"
      borderAccent="border-tool/30"
      complete={block.complete}
    >
      <div className="space-y-1 font-mono text-[11.5px]">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Input</div>
        <pre className="whitespace-pre-wrap break-words rounded bg-input px-2 py-1 text-primary">
          {command}
        </pre>
      </div>
    </ToolBlockChrome>
  );
}
```

- [ ] **Step 3: Implement MessageToolEdit (reuses M27's react-diff-view)**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageToolEdit.tsx`:

```tsx
import { Pencil } from "lucide-react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

const COLLAPSE_THRESHOLD_LINES = 20;

function buildUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  // Minimal unified-diff synthesis. react-diff-view's parseDiff
  // expects standard unified-diff text. We construct a single-hunk
  // diff covering the whole replacement; not byte-perfect but
  // sufficient for the visual treatment.
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const header = `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body =
    oldLines.map((l) => `-${l}`).join("\n") + "\n" + newLines.map((l) => `+${l}`).join("\n") + "\n";
  return header + body;
}

export function MessageToolEdit({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const filePath = (parsed.file_path as string | undefined) ?? "(file)";
  const oldText = (parsed.old_string as string | undefined) ?? "";
  const newText = (parsed.new_string as string | undefined) ?? "";

  const totalLines = oldText.split("\n").length + newText.split("\n").length;
  const ready = block.complete && (oldText !== "" || newText !== "");

  let body: React.ReactNode;
  if (!ready) {
    body = <pre className="text-secondary">Streaming…</pre>;
  } else if (totalLines > COLLAPSE_THRESHOLD_LINES) {
    body = (
      <div className="text-[11px] text-secondary">
        <span className="font-mono">{filePath}</span> — {oldText.split("\n").length} →{" "}
        {newText.split("\n").length} lines
      </div>
    );
  } else {
    const unified = buildUnifiedDiff(oldText, newText, filePath);
    const files = parseDiff(unified, { nearbySequences: "zip" });
    body = (
      <div className="text-[11.5px]">
        {files.map((file, i) => (
          <Diff key={i} viewType="unified" diffType={file.type} hunks={file.hunks}>
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        ))}
      </div>
    );
  }

  return (
    <ToolBlockChrome
      icon={<Pencil size={11} />}
      name="Edit"
      target={filePath}
      accent="text-edit"
      borderAccent="border-edit/30"
      complete={block.complete}
    >
      {body}
    </ToolBlockChrome>
  );
}
```

- [ ] **Step 4: Implement MessageToolRead + MessageToolWrite**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageToolRead.tsx`:

```tsx
import { FileText } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolRead({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const filePath = (parsed.file_path as string | undefined) ?? "(file)";
  const offset = parsed.offset as number | undefined;
  const limit = parsed.limit as number | undefined;
  const range =
    offset !== undefined && limit !== undefined ? `lines ${offset}-${offset + limit}` : null;
  return (
    <ToolBlockChrome
      icon={<FileText size={11} />}
      name="Read"
      target={filePath}
      accent="text-read"
      borderAccent="border-read/30"
      complete={block.complete}
    >
      <div className="text-[11px] text-secondary">
        <span className="font-mono">{filePath}</span>
        {range && <span className="ml-2">{range}</span>}
      </div>
    </ToolBlockChrome>
  );
}
```

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/messages/MessageToolWrite.tsx`:

```tsx
import { FilePlus } from "lucide-react";
import { useState } from "react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

const PREVIEW_LINES = 8;

export function MessageToolWrite({ block }: Props) {
  const [expanded, setExpanded] = useState(false);
  const parsed = tryParse(block.partialJson) ?? block.input;
  const filePath = (parsed.file_path as string | undefined) ?? "(file)";
  const content = (parsed.content as string | undefined) ?? "";
  const lines = content.split("\n");
  const visible = expanded ? content : lines.slice(0, PREVIEW_LINES).join("\n");
  const hidden = lines.length - PREVIEW_LINES;
  return (
    <ToolBlockChrome
      icon={<FilePlus size={11} />}
      name="Write"
      target={filePath}
      accent="text-write"
      borderAccent="border-write/30"
      complete={block.complete}
    >
      <div className="space-y-1 font-mono text-[11.5px]">
        <pre className="whitespace-pre-wrap break-words rounded bg-input px-2 py-1 text-primary">
          {visible}
        </pre>
        {!expanded && hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-[10px] text-secondary hover:text-primary"
          >
            Show {hidden} more lines
          </button>
        )}
      </div>
    </ToolBlockChrome>
  );
}
```

- [ ] **Step 5: Tests + commit**

For each component, write a 2-3 case vitest in `dashboard/src/components/chat/messages/__tests__/`:

- Renders header label (Bash / Edit / Read / Write)
- Body shows the parsed input (`command` / file_path / etc.)
- `complete=false` → loading icon visible; `complete=true` → checkmark visible
- (MessageToolEdit) Large diff (>20 lines) collapses to stat header

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/messages/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/messages/_partialJson.ts \
        dashboard/src/components/chat/messages/MessageTool*.tsx \
        dashboard/src/components/chat/messages/__tests__/
git commit -m "feat(m33): tool message components — Bash / Edit / Read / Write

Each composes around ToolBlockChrome with its tool-specific color
(text-tool blue / text-edit blue / text-read orange / text-write
green) and body shape. MessageToolEdit reuses M27's react-diff-view
for inline mini-diffs (collapses to stat header above 20 lines).
MessageToolWrite shows first 8 lines + 'show more'.

partialJson parse is defensive — streaming partials surface as
'Streaming…' until the closing brace lands."
```

---

## Task 10: Tool message components (Task, Todo, Generic) + dispatch

**Files (all new):**

- `dashboard/src/components/chat/messages/MessageToolTask.tsx`
- `dashboard/src/components/chat/messages/MessageToolTodo.tsx`
- `dashboard/src/components/chat/messages/MessageToolGeneric.tsx`
- `dashboard/src/components/chat/messages/dispatch.ts` (block→component map)
- Tests

- [ ] **Step 1: Implement MessageToolTask**

```tsx
// dashboard/src/components/chat/messages/MessageToolTask.tsx
import { Bot } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolTask({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const subagent = (parsed.subagent_type as string | undefined) ?? "agent";
  const description = (parsed.description as string | undefined) ?? "";
  const prompt = (parsed.prompt as string | undefined) ?? "";
  return (
    <ToolBlockChrome
      icon={<Bot size={11} />}
      name="Task"
      target={`→ ${subagent}: ${description}`}
      accent="text-task"
      borderAccent="border-task/30"
      complete={block.complete}
    >
      <details className="text-[11.5px] text-secondary">
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted">
          Prompt
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-input px-2 py-1 text-primary">
          {prompt}
        </pre>
      </details>
    </ToolBlockChrome>
  );
}
```

- [ ] **Step 2: Implement MessageToolTodo**

```tsx
// dashboard/src/components/chat/messages/MessageToolTodo.tsx
import { ListChecks } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface TodoItem {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolTodo({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const todos = (parsed.todos as TodoItem[] | undefined) ?? [];
  return (
    <ToolBlockChrome
      icon={<ListChecks size={11} />}
      name="TodoWrite"
      target={`${todos.length} item${todos.length === 1 ? "" : "s"}`}
      accent="text-todo"
      borderAccent="border-todo/30"
      complete={block.complete}
    >
      <ul className="space-y-1 text-[12px]">
        {todos.map((t, i) => {
          const symbol = t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : "☐";
          const cls =
            t.status === "completed"
              ? "text-muted line-through"
              : t.status === "in_progress"
                ? "text-think"
                : "text-primary";
          return (
            <li key={i} className={cls}>
              <span className="mr-2 font-mono">{symbol}</span>
              {t.status === "in_progress" ? t.activeForm : t.content}
            </li>
          );
        })}
      </ul>
    </ToolBlockChrome>
  );
}
```

- [ ] **Step 3: Implement MessageToolGeneric (fallback)**

```tsx
// dashboard/src/components/chat/messages/MessageToolGeneric.tsx
import { Wrench } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolGeneric({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  return (
    <ToolBlockChrome
      icon={<Wrench size={11} />}
      name={block.tool}
      target={null}
      accent="text-tool"
      borderAccent="border-tool/30"
      complete={block.complete}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-secondary">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    </ToolBlockChrome>
  );
}
```

- [ ] **Step 4: Implement the dispatch map**

```ts
// dashboard/src/components/chat/messages/dispatch.ts
import type { ChatBlock } from "../types";
import { MessageToolBash } from "./MessageToolBash";
import { MessageToolEdit } from "./MessageToolEdit";
import { MessageToolGeneric } from "./MessageToolGeneric";
import { MessageToolRead } from "./MessageToolRead";
import { MessageToolTask } from "./MessageToolTask";
import { MessageToolTodo } from "./MessageToolTodo";
import { MessageToolWrite } from "./MessageToolWrite";

type ToolBlock = Extract<ChatBlock, { kind: "tool_use" }>;

const REGISTRY: Record<string, React.FC<{ block: ToolBlock }>> = {
  Bash: MessageToolBash,
  Edit: MessageToolEdit,
  MultiEdit: MessageToolEdit,
  Read: MessageToolRead,
  Write: MessageToolWrite,
  Task: MessageToolTask,
  TodoWrite: MessageToolTodo,
};

export function renderToolBlock(block: ToolBlock): React.ReactNode {
  const Cmp = REGISTRY[block.tool] ?? MessageToolGeneric;
  return <Cmp block={block} />;
}
```

- [ ] **Step 5: Tests + commit**

Per-component vitest (2 cases each: header label + body extracts the right input). For TodoWrite, also assert the in-progress vs completed visual states.

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/messages/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/messages/MessageToolTask.tsx \
        dashboard/src/components/chat/messages/MessageToolTodo.tsx \
        dashboard/src/components/chat/messages/MessageToolGeneric.tsx \
        dashboard/src/components/chat/messages/dispatch.ts \
        dashboard/src/components/chat/messages/__tests__/MessageToolTask.test.tsx \
        dashboard/src/components/chat/messages/__tests__/MessageToolTodo.test.tsx \
        dashboard/src/components/chat/messages/__tests__/MessageToolGeneric.test.tsx
git commit -m "feat(m33): MessageToolTask + MessageToolTodo + MessageToolGeneric + dispatch

Task block (text-task red) shows subagent + description in header
with prompt revealed via <details>. TodoWrite (text-todo blue)
renders a real checkbox list with ☑/▶/☐ glyphs and status-driven
text styling. Generic fallback for any tool not in the registry
(Grep/Glob/WebFetch/etc.) — JSON-pretty body inside the Bash-blue
chrome.

dispatch.ts maps content_block.name → component; falls back to
MessageToolGeneric for unknown tools. Registry covers the 7 named
tools in the spec; new tools appear without code change."
```

---

## Task 11: Hover action bar + Fork/Edit/Retry/Copy plumbing

**Files (all new):**

- `dashboard/src/components/chat/MessageActions.tsx`
- `dashboard/src/components/chat/__tests__/MessageActions.test.tsx`

`MessageActions` renders the four-button hover bar above each turn. The parent (Task 13's renderTurn) is responsible for wiring the actual semantics.

- [ ] **Step 1: Implement MessageActions**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/MessageActions.tsx`:

```tsx
/** Hover-revealed action bar for a single chat turn (M33).
 *
 * Buttons:
 *   - Retry — only on user turns; re-sends the same text + drops
 *     subsequent assistant turn from cache.
 *   - Fork  — only when both onFork is provided and turn.role can
 *     branch; creates a new chat tab.
 *   - Copy  — copies turn.text (user) or block text (assistant).
 *   - Edit  — only on user turns.
 */
import { Copy, GitBranch, Pencil, RotateCcw } from "lucide-react";

import type { ChatTurn } from "./types";

interface Props {
  turn: ChatTurn;
  onRetry?: () => void;
  onFork?: () => void;
  onCopy?: () => void;
  onEdit?: () => void;
}

export function MessageActions({ turn, onRetry, onFork, onCopy, onEdit }: Props) {
  const isUser = turn.role === "user";
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
    >
      {isUser && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry"
          title="Retry"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <RotateCcw size={11} aria-hidden="true" />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          onClick={onFork}
          aria-label="Fork"
          title="Fork from this message"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <GitBranch size={11} aria-hidden="true" />
        </button>
      )}
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy"
          title="Copy"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Copy size={11} aria-hidden="true" />
        </button>
      )}
      {isUser && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          title="Edit"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Pencil size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Tests**

```tsx
// dashboard/src/components/chat/__tests__/MessageActions.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageActions } from "../MessageActions";
import type { ChatTurn } from "../types";

const userTurn: ChatTurn = {
  id: "u-1",
  role: "user",
  blocks: [{ kind: "text", text: "hi" }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
  text: "hi",
};
const assistantTurn: ChatTurn = { ...userTurn, id: "m-1", role: "assistant", text: undefined };

describe("MessageActions", () => {
  it("user turn: shows Retry, Copy, Edit; not for assistant", () => {
    const { rerender } = render(
      <MessageActions turn={userTurn} onRetry={vi.fn()} onCopy={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    rerender(
      <MessageActions turn={assistantTurn} onRetry={vi.fn()} onCopy={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("Fork shows when onFork is provided regardless of role", () => {
    render(<MessageActions turn={assistantTurn} onFork={vi.fn()} onCopy={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Fork" })).toBeTruthy();
  });

  it("clicking buttons calls the appropriate handlers", () => {
    const onRetry = vi.fn();
    const onCopy = vi.fn();
    const onEdit = vi.fn();
    const onFork = vi.fn();
    render(
      <MessageActions
        turn={userTurn}
        onRetry={onRetry}
        onCopy={onCopy}
        onEdit={onEdit}
        onFork={onFork}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(onRetry).toHaveBeenCalled();
    expect(onCopy).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalled();
    expect(onFork).toHaveBeenCalled();
  });
});
```

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/MessageActions.test.tsx
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/MessageActions.tsx \
        dashboard/src/components/chat/__tests__/MessageActions.test.tsx
git commit -m "feat(m33): MessageActions hover bar (Retry/Fork/Copy/Edit)

Pure presentation — the parent (Task 13's renderTurn) wires the
actual semantics. Retry + Edit are user-turn only; Fork shows
whenever onFork is provided; Copy always shows. The bar uses
opacity-0 → group-hover:opacity-100 so the actions are revealed
on hover."
```

---

## Task 12: Wire ChatThread into ChatsRoute (kind="claude" branch)

**Files:**

- Modify: `dashboard/src/components/routes/ChatsRoute.tsx`
- Modify: `dashboard/src/components/chat/ChatThread.tsx` (add Composer + Stream + renderTurn)

ChatsRoute currently renders the legacy SessionSplitArea (PTY/xterm.js) for every active session. M33 splits on `kind`:

- `kind === "claude"` → render `<ChatThread>` (the new structured surface)
- `kind === "shell"` → keep `<SessionSplitArea>` (PTY fallback)

ChatThread also gets its missing pieces wired up: ChatStream + ChatComposer + the per-turn renderer that dispatches to message components.

- [ ] **Step 1: Update ChatThread to render ChatStream + ChatComposer + renderTurn**

Replace the body of `dashboard/src/components/chat/ChatThread.tsx`:

```tsx
import type { ContainerRecord } from "../../lib/types";
import { ChatHeader } from "./ChatHeader";
import { ChatTabStrip, type ChatTabInfo } from "./ChatTabStrip";
import { ChatComposer } from "./ChatComposer";
import { ChatStream } from "./ChatStream";
import { MessageActions } from "./MessageActions";
import { MessageAssistantText } from "./messages/MessageAssistantText";
import { MessageThinking } from "./messages/MessageThinking";
import { MessageUser } from "./messages/MessageUser";
import { renderToolBlock } from "./messages/dispatch";
import type { ChatTurn } from "./types";
import type { ChatMode } from "./ModeToggle";

interface Props {
  sessionId: string;
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;

  tabs: ChatTabInfo[];
  activeTabId: string;
  onFocusTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;

  turns: ChatTurn[];
  mode: ChatMode;
  pending: boolean;
  onSend: (text: string) => void;
  onRetry: (turn: ChatTurn) => void;
  onFork: (turn: ChatTurn) => void;
  onEdit: (turn: ChatTurn) => void;
}

export function ChatThread({
  sessionId,
  containers,
  activeContainerId,
  onSelectContainer,
  tabs,
  activeTabId,
  onFocusTab,
  onCloseTab,
  onNewTab,
  turns,
  mode,
  pending,
  onSend,
  onRetry,
  onFork,
  onEdit,
}: Props) {
  const renderTurn = (turn: ChatTurn) => {
    const copy = () => {
      const text =
        turn.text ??
        turn.blocks
          .filter((b) => b.kind === "text")
          .map((b) => (b as { kind: "text"; text: string }).text)
          .join("");
      void navigator.clipboard.writeText(text);
    };
    return (
      <div className="group">
        <div className="mb-1 flex items-center justify-end">
          <MessageActions
            turn={turn}
            onRetry={() => onRetry(turn)}
            onFork={() => onFork(turn)}
            onCopy={copy}
            onEdit={() => onEdit(turn)}
          />
        </div>
        {turn.role === "user" && <MessageUser turn={turn} />}
        {turn.role === "assistant" && (
          <div className="space-y-2">
            {turn.blocks.map((block, i) => {
              if (block.kind === "text") {
                return <MessageAssistantText key={i} turn={{ ...turn, blocks: [block] }} />;
              }
              if (block.kind === "thinking") {
                return (
                  <MessageThinking key={i} thinking={block.thinking} streaming={turn.streaming} />
                );
              }
              return <div key={i}>{renderToolBlock(block)}</div>;
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-page">
      <ChatHeader
        sessionId={sessionId}
        containers={containers}
        activeContainerId={activeContainerId}
        onSelectContainer={onSelectContainer}
      />
      <ChatTabStrip
        tabs={tabs}
        activeId={activeTabId}
        onFocus={onFocusTab}
        onClose={onCloseTab}
        onNew={onNewTab}
      />
      <ChatStream turns={turns} renderTurn={renderTurn} />
      <ChatComposer sessionId={sessionId} mode={mode} disabled={pending} onSend={onSend} />
    </div>
  );
}
```

- [ ] **Step 2: Update ChatsRoute to branch on kind**

Modify `dashboard/src/components/routes/ChatsRoute.tsx`. The ChatsRoute already receives `activeSessions` (the `SessionInfo[]` from App.tsx). M32's `SessionInfo` only carries `{id, name}` — for M33 we need the `kind`. Two options:

**Option A (recommended for M33):** ChatsRoute receives the full `NamedSession[]` instead of (or in addition to) `SessionInfo[]`. App.tsx already loads them via `useSessions(active?.id ?? null)`; pass the raw list down.

In `dashboard/src/App.tsx`, find the `<ChatsRoute ... />` element. Add a new prop:

```tsx
namedSessions = { namedSessions };
```

In `dashboard/src/components/routes/ChatsRoute.tsx`:

1. Import the new types + components:

```tsx
import { ChatThread } from "../chat/ChatThread";
import type { ChatMode } from "../chat/ModeToggle";
import { useChatStream } from "../../hooks/useChatStream";
import { postChatTurn } from "../../lib/chatApi";
import type { NamedSession } from "../../lib/types";
```

2. Add `namedSessions: NamedSession[]` to `Props`.

3. Inside the component, find the active session by id:

```tsx
const active = namedSessions.find((s) => s.session_id === activeSessionId) ?? null;
const isClaudeKind = active?.kind === "claude";
```

4. In the main pane render branch, when `isClaudeKind` is true, render `<ChatThread>` instead of `<SessionSplitArea>`:

```tsx
{isClaudeKind && active ? (
  <ChatThreadWrapper
    sessionId={active.session_id}
    containers={containers}
    activeContainerId={activeContainerId}
    onSelectContainer={onSelectContainer}
    tabs={namedSessions
      .filter((s) => s.kind === "claude")
      .map((s) => ({
        id: s.session_id,
        name: s.name,
        mode: (window.localStorage.getItem(`hive:chat:${s.session_id}:mode`) as ChatMode | null) ?? "code",
      }))}
    activeTabId={active.session_id}
    onFocusTab={onFocusSession}
    onCloseTab={(id) => void onCloseSession(id)}
    onNewTab={onNewSession}
  />
) : (
  /* existing PTY-based render path: SessionSplitArea, FileViewer, DiffViewerTab, etc. */
)}
```

5. Define `ChatThreadWrapper` locally (or as a sibling component) — it owns the `useChatStream` hook + the send handler:

```tsx
function ChatThreadWrapper(props: {
  sessionId: string;
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  tabs: ChatTabInfo[];
  activeTabId: string;
  onFocusTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}) {
  const { turns, clearTurns } = useChatStream(props.sessionId);
  const [pending, setPending] = useState(false);
  const mode =
    (window.localStorage.getItem(`hive:chat:${props.sessionId}:mode`) as ChatMode | null) ?? "code";

  const send = async (text: string) => {
    setPending(true);
    try {
      await postChatTurn(props.sessionId, text);
    } finally {
      setPending(false);
    }
  };

  const retry = (_turn: ChatTurn) => {
    // Drop everything from this turn onward + re-send
    clearTurns();
    void send(_turn.text ?? "");
  };
  const fork = (_turn: ChatTurn) => {
    // M33: stash fork metadata in localStorage; the new tab open is up to
    // the parent's onNewTab. M35 will wire this fully.
    window.localStorage.setItem(
      `hive:chat:${props.sessionId}:pending-fork`,
      JSON.stringify({ at_message: _turn.id }),
    );
    props.onNewTab();
  };
  const edit = (_turn: ChatTurn) => {
    const next = window.prompt("Edit your message:", _turn.text ?? "");
    if (next === null) return;
    clearTurns();
    void send(next);
  };

  return (
    <ChatThread
      {...props}
      turns={turns}
      mode={mode}
      pending={pending}
      onSend={send}
      onRetry={retry}
      onFork={fork}
      onEdit={edit}
    />
  );
}
```

(The retry/edit path is intentionally heavy-handed for M33 — it clears the entire chat and re-sends. M34 can refine this; for M33's success criterion ("Retry / Fork / Copy / Edit all work end-to-end") this is sufficient.)

- [ ] **Step 3: Run vitest + typecheck + Playwright**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
npx playwright test
```

Expected: all green. The existing tests still pass because the kind=shell path is preserved for any session that's not explicitly created with `kind: "claude"`.

- [ ] **Step 4: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/routes/ChatsRoute.tsx \
        dashboard/src/components/chat/ChatThread.tsx \
        dashboard/src/App.tsx
git commit -m "feat(m33): wire ChatThread into ChatsRoute for kind=claude sessions

ChatsRoute now branches on the active named-session's kind. For
'claude', renders the new ChatThread (header + tab strip + stream
+ composer with the per-message renderer and hover actions). For
'shell', the existing SessionSplitArea / PTY path is preserved.

ChatThreadWrapper owns useChatStream + the send handler. Retry
clears + re-sends; Fork stashes metadata + opens a new tab; Edit
prompts then clears + re-sends. Heavy-handed but satisfies M33's
success criteria; M34 refines."
```

---

## Task 13: Connect live useChatStream + axe-core scan

This is the integration checkpoint — verify a real container can actually drive the chat surface end-to-end.

**Files:**

- Modify: `dashboard/src/index.css` if any contrast violations surface (none expected)

- [ ] **Step 1: Manual smoke test**

Start the hub, register a container with `claude` available, create a kind="claude" named-session, open the dashboard in a browser, and:

1. Type "Reply with the literal text: hello" in the composer, press ⌘↵.
2. Within ~1s, an assistant turn should appear with a streaming cursor.
3. Within ~5s, the response "hello" should fully render.
4. The Retry button on the user turn should re-issue the request.
5. The Copy button should put the message text on the clipboard.
6. The Mode toggle should persist across reloads.
7. Switch theme (Settings → Light); chat surface should re-paint correctly.

Document any issues. Common gotchas:

- Container has no `claude` binary → POST returns 500. Fix: ensure the container's PATH includes the binary location (the hub runs the subprocess in the container's `cwd`, so PATH there is what matters).
- `~/.claude` shared volume not mounted → Claude prompts for OAuth on every spawn. Fix: ensure the container has the `claude-auth` volume mounted (per CLAUDE.md).

- [ ] **Step 2: Add an axe-core scan to an existing Playwright spec OR a dedicated smoke spec**

Append to `dashboard/tests/e2e/layout-shell.spec.ts` (or create a new `chat-surface-axe.spec.ts`):

```ts
test("ChatThread chrome passes axe-core in dark + light themes", async ({ page }) => {
  await page.goto("/chats");
  // Force a kind="claude" session to render. We'll mock the API for this.
  // (Implementation note: this test piggybacks on the layout-shell fixtures.
  //  See Task 14 for the dedicated Playwright happy-path with mocked WS.)
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  // Scope axe to the chat region
  // (Actual chat surface visibility depends on Task 14 fixtures; if the
  //  surface is hidden, this test will just assert no violations on what's
  //  visible — adjust scope as needed.)
});
```

A more useful axe-core scan lives in Task 14's dedicated `chat-stream.spec.ts` after the chat surface is actually visible with mocked data.

- [ ] **Step 3: No commit if step 2 was just a manual smoke**

If you found and fixed a contrast issue or other surprise, commit those individually with `fix(m33): ...` messages.

---

## Task 14: Playwright happy path — chat-stream.spec.ts

**Files:**

- Create: `dashboard/tests/e2e/chat-stream.spec.ts`

This spec uses Playwright's `page.evaluate` to inject mock WebSocket frames so the chat surface renders without needing a real claude subprocess. It exercises the full streaming flow, hover actions, and runs axe-core on the chat region.

- [ ] **Step 1: Create the spec**

Create `dashboard/tests/e2e/chat-stream.spec.ts`:

```ts
/** M33 chat-surface end-to-end happy path.
 *
 * Mocks the named-sessions endpoints to return a kind="claude" session,
 * mocks POST /turns to return 202, and pumps stream-json frames into
 * the dashboard's mock WebSocket so the ChatStream renders incrementally.
 *
 * Verifies:
 *   1. Chat surface renders for kind="claude" sessions
 *   2. User turn appears after Send
 *   3. Streaming assistant text grows incrementally
 *   4. Tool block renders with the right color + status
 *   5. Hover actions visible (Retry / Copy / Edit on user turn)
 *   6. Mode toggle persists across reload
 *   7. axe-core passes in dark + light on the chat surface
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "chat-stream-token";

const containerFixture = {
  id: 1,
  workspace_folder: "/repos/foo",
  project_type: "base",
  project_name: "foo",
  project_description: "",
  git_repo_url: null,
  container_id: "deadbeef",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const claudeSession = {
  session_id: "ns-claude-1",
  container_id: 1,
  name: "Main",
  kind: "claude",
  position: 1,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  claude_session_id: null,
};

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );

  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/named-sessions", (r) =>
    r.fulfill(mockJson([claudeSession])),
  );
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/problems**", (r) => r.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (r) =>
    r.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (r) => r.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (r) => r.fulfill(mockJson({ status: "ok" })));
  await context.route("**/api/named-sessions/*/turns", (r) =>
    r.fulfill({ status: 202, contentType: "application/json", body: '{"accepted":true}' }),
  );
});

// Helper: emit a stream frame into the dashboard's WS via window dispatch.
async function pumpFrame(page, frame: unknown) {
  await page.evaluate((f) => {
    // The dashboard's useHiveWebSocket exposes listeners via the singleton.
    // For test purposes, we dispatch a CustomEvent that a test-shim consumes.
    // (Implementation detail: see how M27/M30 specs do this; if the codebase
    //  has a `__test_pumpWsFrame` window hook, use that. Otherwise add a
    //  minimal hook in dashboard/src/main.tsx behind `import.meta.env.DEV ||
    //  window.__playwright_test`.)
    (window as any).__pumpWsFrame?.(f);
  }, frame);
}

test("chat surface renders for kind=claude session", async ({ page }) => {
  await page.goto("/chats");
  // Pick the container so the chat thread mounts
  await page.getByRole("button", { name: /^foo$/ }).first().click();
  // ChatHeader is visible
  await expect(page.getByRole("button", { name: /Chat history/i })).toBeVisible();
  // Composer is visible
  await expect(page.getByRole("textbox", { name: /chat input/i })).toBeVisible();
});

test("send a message → user turn appears", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: /^foo$/ }).first().click();
  const input = page.getByRole("textbox", { name: /chat input/i });
  await input.fill("hello there");
  await page.getByRole("button", { name: /^send$/i }).click();
  // Pump a user-replay frame
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "user",
    data: {
      type: "user",
      message: {
        id: "u-1",
        type: "message",
        role: "user",
        content: [{ type: "text", text: "hello there" }],
      },
      session_id: "claude-s",
      uuid: "u-1",
    },
  });
  await expect(page.getByRole("article", { name: /User message/i })).toContainText("hello there");
});

test("streaming text grows incrementally then completes", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: /^foo$/ }).first().click();
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-1",
      event: {
        type: "message_start",
        message: { id: "m-1", type: "message", role: "assistant", content: [] },
      },
    },
  });
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-2",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
  });
  for (const piece of ["1, ", "2, ", "3."]) {
    await pumpFrame(page, {
      channel: "chat:ns-claude-1",
      event: "stream_event",
      data: {
        type: "stream_event",
        session_id: "s",
        uuid: `u-${piece}`,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: piece },
        },
      },
    });
  }
  await expect(page.getByRole("article", { name: /Assistant message/i })).toContainText("1, 2, 3.");
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-stop",
      event: { type: "message_stop" },
    },
  });
  // Streaming cursor should be gone after message_stop
  await expect(page.getByRole("article", { name: /Assistant message/i })).not.toContainText(
    "streaming",
  );
});

test("tool block renders with status", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: /^foo$/ }).first().click();
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-1",
      event: {
        type: "message_start",
        message: { id: "m-1", type: "message", role: "assistant", content: [] },
      },
    },
  });
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-2",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
      },
    },
  });
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-3",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls /tmp"}' },
      },
    },
  });
  await pumpFrame(page, {
    channel: "chat:ns-claude-1",
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-4",
      event: { type: "content_block_stop", index: 0 },
    },
  });
  // Bash header + the parsed command should be visible
  await expect(page.getByText("Bash").first()).toBeVisible();
  await expect(page.getByText("ls /tmp")).toBeVisible();
  // Status: complete checkmark (aria-label "Complete")
  await expect(page.getByLabel("Complete").first()).toBeVisible();
});

test("axe-core passes on chat surface (dark)", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: /^foo$/ }).first().click();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});

test("axe-core passes on chat surface (light)", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: /^foo$/ }).first().click();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 2: Implement the test pump hook**

For `__pumpWsFrame` to work, the dashboard needs a small test shim. Add to `dashboard/src/main.tsx` (only in dev/test):

```ts
// Near the bottom of main.tsx, before createRoot:
if (import.meta.env.DEV || (window as any).__playwright_test) {
  // Test-only hook: lets Playwright pump WS frames into the singleton.
  import("./hooks/useWebSocket").then((mod) => {
    (window as any).__pumpWsFrame = (frame: unknown) => {
      // The HiveSocket singleton exposes a private dispatch path; we
      // call it via the channel listener registry.
      (mod as any).__test_dispatch?.(frame);
    };
  });
}
```

Then in `dashboard/src/hooks/useWebSocket.ts`, add a `__test_dispatch` export at the bottom that drives the singleton's listener map:

```ts
// At the very bottom of useWebSocket.ts:
export const __test_dispatch = (frame: { channel: string; event: string; data: unknown }) => {
  // Call into the singleton's safeInvoke for each listener on the channel.
  // (Implementation detail — the singleton already has a private `listeners`
  //  Map<string, Set<Listener>>. Expose a controlled dispatch path here.)
  const set = (singleton as any).listeners?.get(frame.channel);
  if (!set) return;
  for (const cb of set) cb(frame);
};
```

If exposing the singleton's internals feels too invasive, an alternative is to add an env-gated `mock-server` that the Playwright spec instantiates — but the test-hook approach is simpler for M33.

- [ ] **Step 3: Run + iterate**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test chat-stream.spec.ts
```

Expected: 6/6 PASS. If a test fails because the pump hook isn't wired, iterate on the dispatch path. If axe-core surfaces a real violation, fix the offending chrome class (use semantic tokens — never weaken the assertion).

- [ ] **Step 4: Run the full Playwright suite to confirm no regressions**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

Expected: 32 + 6 = 38 / 38 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/chat-stream.spec.ts \
        dashboard/src/main.tsx dashboard/src/hooks/useWebSocket.ts
git commit -m "test(m33): chat-stream playwright spec + WS test pump

6 cases: chat surface mounts for kind=claude, user turn appears
after Send, streaming text grows incrementally then completes,
tool block renders with parsed input + status, axe-core passes
in dark + light on the chat region.

The test pump (__pumpWsFrame) is gated on import.meta.env.DEV
or window.__playwright_test so production bundles never expose
it. The singleton's listener map is reachable via a small
__test_dispatch export."
```

---

## Task 15: Pre-flight regression sweep + prettier

Same shape as M31 Task 7 / M32 Task 10.

- [ ] **Step 1: Hub regression**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

- [ ] **Step 2: hive-agent regression**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

- [ ] **Step 3: Dashboard typecheck + lint + vitest**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npm run lint
npx vitest run
```

Lint warnings should be ≤ M32 baseline (~19). If higher, find what M33 added and fix or accept.

- [ ] **Step 4: Full Playwright**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

- [ ] **Step 5: Prettier sweep**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
cd /home/gnava/repos/honeycomb
git status
git diff
```

If prettier reformats anything, commit:

```bash
git add -A -- dashboard/
git diff --cached --quiet || git commit -m "style(m33): prettier sweep before push"
```

(Note `-- dashboard/` to avoid accidentally staging the gitignored `.claude/settings.json`.)

- [ ] **Step 6: Full pre-commit**

```bash
cd /home/gnava/repos/honeycomb
pre-commit run --all-files
```

Clean.

---

## Task 16: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1: Push the branch**

```bash
cd /home/gnava/repos/honeycomb
git push -u origin m33-chat-surface
```

CI doesn't run on push to non-main branches; it'll fire on the merge push.

- [ ] **Step 2: Merge to main with --no-ff**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff m33-chat-surface -m "Merge M33: chat surface (anatomy + streaming)"
```

- [ ] **Step 3: Tag**

```bash
git tag -a v0.33-chat-surface \
  -m "M33: chat surface (claude --output-format stream-json + ChatThread / ChatHeader / ChatTabStrip / ChatStream / ChatComposer + 10 message components + hover actions + mode toggle + per-tool color identity)"
```

- [ ] **Step 4: Push with --follow-tags**

```bash
git push --follow-tags origin main
```

- [ ] **Step 5: Watch the merge-CI**

```bash
sleep 12
gh run list --branch main --limit 1 --json databaseId,status
gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: all 7 jobs green (pre-commit, hub, hive-agent, dashboard lint+typecheck+vitest, dashboard playwright e2e, docker base build, gitleaks).

- [ ] **Step 6: Delete the merged branch**

```bash
git branch -d m33-chat-surface
git push origin --delete m33-chat-surface
```

---

## Verification Checklist

Before marking M33 done, confirm:

- [ ] `cd hub && uv run pytest tests -q` — 373 + new chat_stream tests green
- [ ] `cd dashboard && npx vitest run` — all green (existing + 11 chat_events + 14 parser + 7 subprocess + 6 endpoint + 9 useChatStream + ~30 component tests)
- [ ] `cd dashboard && npx playwright test` — 38/38 (32 pre-existing + 6 new chat-stream)
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint` — clean (lint ≤ M32 baseline)
- [ ] `pre-commit run --all-files` — clean
- [ ] **Manual smoke test:**
  - Hub starts, container has `claude` available
  - Create a kind="claude" named-session
  - Open `/chats`, focus that container
  - Type a prompt, ⌘↵ to send
  - User turn appears immediately; assistant turn streams in within seconds
  - Tool blocks (if Claude calls any) render with the right color
  - Mode toggle (Code/Review/Plan) flips and persists across reload
  - Theme switch (Settings → Light) re-paints chat surface correctly
  - Hover over a turn → action bar reveals; Copy puts text on clipboard
- [ ] `git log --oneline main` shows `Merge M33: chat surface (anatomy + streaming)` + `v0.33-chat-surface` tag
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green
- [ ] Branch `m33-chat-surface` deleted local + remote

---

## Out of scope — future tickets

- **Real Effort + Model semantics** (M34 wires `thinking.budget_tokens` + `--model` arg)
- **Slash commands** (M34 — composer parses `/cmd args`)
- **Mode-specific behavior** (M34 — Plan mode → `--permission-mode plan`)
- **File attachments in composer** (composer renders chip UI; upload pipeline is M34+ work)
- **Library artifact synthesis from chat** (M35)
- **Mobile breakpoints** (M36)
- **Persistent stream-json subprocess** (M33 spawns one per turn; persistent is a future optimization)
- **Chat history navigation** (M35 wires the History header button to artifact store)
- **Markdown rendering in MessageAssistantText** (M33 uses plain text + preserved newlines)
- **Real-time tool output streaming** (M33 captures `tool_use` block input via `input_json_delta`; tool RESULTS land in subsequent assistant message blocks; deeper integration with tool_use_id correlation is future work)
- **Fork that replays parent's turns** (M33 stashes fork metadata in localStorage; the new tab opens fresh — replay-from-fork is M35+)
