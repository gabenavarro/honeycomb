"""Auto-save artifact hooks for chat_stream (M35).

Four pure-function detectors plus one stateful tracker. Each detector
inspects either a chunk of accumulated assistant text or a single
``ToolUseBlock`` and returns an optional :class:`RecordArtifactDirective`
describing the artifact the chat_stream driver should persist after the
turn completes.

  - ``detect_note_marker(text)``         → looks for ``> NOTE: …`` blocks
  - ``detect_snippet(text)``             → first language-tagged code
                                            fence with ≥ 3 body lines
  - ``detect_subagent_completion(block)``→ Task tool_use block
  - ``PlanModeTracker.observe_turn_mode``→ plan→non-plan transitions

The plan-mode tracker is meant to be instantiated once at module import
time so that mode transitions across separate ``ClaudeTurnSession``
instances (one per turn) within the same hub process are tracked
correctly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from hub.models.chat_events import ToolUseBlock
from hub.models.schemas import ArtifactType


@dataclass(frozen=True)
class RecordArtifactDirective:
    """A declarative artifact-write request emitted by a hook detector.

    The chat_stream driver collects directives during stdout drain, then
    after the subprocess exits applies each one via
    :func:`hub.services.artifacts.record_artifact`. Hooks never touch
    the database directly — they're pure functions returning data."""

    type: ArtifactType
    title: str
    body: str
    body_format: str = "markdown"
    metadata: dict[str, Any] | None = None
    source_message_id: str | None = None


# ── Note hook ────────────────────────────────────────────────

# Match a markdown blockquote line beginning with `> NOTE:` and capture
# everything up to the next blank line (paragraph break) or end-of-text.
# DOTALL lets `.` span newlines inside the body; MULTILINE lets `^` anchor
# at any line start.
_NOTE_PATTERN = re.compile(r"^>\s*NOTE:\s*(.+?)(?=\n\s*\n|\Z)", re.MULTILINE | re.DOTALL)


def detect_note_marker(*, text: str) -> RecordArtifactDirective | None:
    """Return a ``note`` directive if ``text`` contains a ``> NOTE: …`` block."""
    m = _NOTE_PATTERN.search(text)
    if m is None:
        return None
    body = m.group(1).strip()
    title = body[:60].strip() or "Note"
    return RecordArtifactDirective(type="note", title=title, body=body)


# ── Snippet hook ─────────────────────────────────────────────

# Match a fenced code block with a language tag (``` followed by an
# alphanumeric identifier on the same line). Unlabeled fences are
# intentionally skipped — they're usually inline output, not snippets
# worth saving to the library.
_SNIPPET_PATTERN = re.compile(r"```([A-Za-z0-9_+-]+)\n(.+?)\n```", re.DOTALL)
_SNIPPET_MIN_LINES = 3


def detect_snippet(*, text: str) -> RecordArtifactDirective | None:
    """Return a ``snippet`` directive for the first language-tagged
    fenced block with at least ``_SNIPPET_MIN_LINES`` body lines."""
    for m in _SNIPPET_PATTERN.finditer(text):
        language = m.group(1)
        body = m.group(2)
        line_count = body.count("\n") + 1
        if line_count >= _SNIPPET_MIN_LINES:
            title = f"{language} snippet ({line_count} lines)"
            return RecordArtifactDirective(
                type="snippet",
                title=title,
                body=body,
                body_format=language,
                metadata={"language": language, "line_count": line_count},
            )
    return None


# ── Subagent hook ─────────────────────────────────────────────


def detect_subagent_completion(*, block: ToolUseBlock) -> RecordArtifactDirective | None:
    """Return a ``subagent`` directive if ``block`` is a ``Task`` tool use."""
    if block.name != "Task":
        return None
    inp = block.input if isinstance(block.input, dict) else {}
    agent_type = inp.get("subagent_type") or "agent"
    description = inp.get("description") or ""
    prompt = inp.get("prompt") or ""
    title = description or f"Subagent: {agent_type}"
    return RecordArtifactDirective(
        type="subagent",
        title=title[:200],
        body=prompt,
        metadata={"subagent_type": agent_type},
        source_message_id=block.id,
    )


# ── Plan-mode tracker ─────────────────────────────────────────


@dataclass
class PlanModeTracker:
    """Track the most recent ``mode`` per named session and emit a
    directive when a session transitions out of plan mode.

    Lifecycle: instantiate once at module scope (the chat_stream driver
    creates a new ``ClaudeTurnSession`` per turn, but the user's plan
    state spans turns). Call :meth:`observe_turn_mode` at the start of
    every turn; if it returns non-None, accumulate the assistant output
    and persist a ``plan`` artifact after the subprocess exits."""

    _last_seen: dict[str, str] = field(default_factory=dict)

    def observe_turn_mode(
        self, *, named_session_id: str, mode: str
    ) -> RecordArtifactDirective | None:
        # Synchronous on purpose — get-then-set is atomic under asyncio because
        # there is no `await` between them. Do not introduce one here.
        prev = self._last_seen.get(named_session_id)
        self._last_seen[named_session_id] = mode
        if prev == "plan" and mode != "plan":
            # Body is filled in by the chat_stream driver from the
            # accumulated assistant text once the subprocess exits.
            return RecordArtifactDirective(
                type="plan",
                title="Plan-mode session",
                body="(filled in by chat_stream driver from accumulated assistant turns)",
                metadata={"mode_at_save": "plan"},
            )
        return None
