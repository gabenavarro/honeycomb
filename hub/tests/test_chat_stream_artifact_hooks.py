"""Auto-save artifact hooks in chat_stream parser (M35)."""

from __future__ import annotations

from hub.models.chat_events import ToolUseBlock
from hub.services.chat_stream_artifact_hooks import (
    PlanModeTracker,
    detect_note_marker,
    detect_snippet,
    detect_subagent_completion,
)

# ── Note hook ──────────────────────────────────────────────────────


class TestNoteDetector:
    def test_detects_note_marker_in_text(self) -> None:
        directive = detect_note_marker(
            text="Some prose.\n> NOTE: Remember to check the foo.\nMore prose.",
        )
        assert directive is not None
        assert directive.type == "note"
        assert "Remember to check the foo." in directive.body

    def test_no_marker_no_directive(self) -> None:
        assert detect_note_marker(text="No notes here.") is None

    def test_marker_title_is_first_60_chars(self) -> None:
        long = "A" * 200
        directive = detect_note_marker(text=f"> NOTE: {long}")
        assert directive is not None
        assert len(directive.title) <= 60


# ── Snippet hook ──────────────────────────────────────────────────


class TestSnippetDetector:
    def test_detects_3_line_python_block(self) -> None:
        text = "Here:\n```python\nimport os\nprint(os.getcwd())\nos.exit(0)\n```\nDone."
        directive = detect_snippet(text=text)
        assert directive is not None
        assert directive.type == "snippet"
        assert "import os" in directive.body
        assert directive.metadata is not None
        assert directive.metadata["language"] == "python"
        assert directive.metadata["line_count"] == 3

    def test_skips_2_line_block(self) -> None:
        text = "```python\nimport os\nprint('hi')\n```"
        assert detect_snippet(text=text) is None

    def test_skips_unlabeled_code_fence(self) -> None:
        text = "```\nline 1\nline 2\nline 3\n```"
        assert detect_snippet(text=text) is None

    def test_extracts_first_qualifying_block_only(self) -> None:
        text = "```python\na = 1\nb = 2\nc = 3\n```\nOther text.\n```ts\nx = 1\ny = 2\nz = 3\n```"
        directive = detect_snippet(text=text)
        assert directive is not None
        assert directive.metadata is not None
        assert directive.metadata["language"] == "python"


# ── Subagent hook ──────────────────────────────────────────────────


class TestSubagentDetector:
    def test_fires_on_task_tool_use_end(self) -> None:
        block = ToolUseBlock(
            id="tu-1",
            name="Task",
            input={
                "subagent_type": "general-purpose",
                "description": "Find bug",
                "prompt": "Find the bug",
            },
        )
        directive = detect_subagent_completion(block=block)
        assert directive is not None
        assert directive.type == "subagent"
        assert directive.metadata is not None
        assert directive.metadata["subagent_type"] == "general-purpose"
        assert directive.source_message_id == "tu-1"

    def test_skips_non_task_tool(self) -> None:
        block = ToolUseBlock(id="tu-1", name="Bash", input={"command": "ls"})
        assert detect_subagent_completion(block=block) is None


# ── Plan-mode hook ────────────────────────────────────────────────


class TestPlanModeTracker:
    def test_no_directive_when_mode_unchanged(self) -> None:
        tracker = PlanModeTracker()
        assert tracker.observe_turn_mode(named_session_id="ns-1", mode="code") is None
        assert tracker.observe_turn_mode(named_session_id="ns-1", mode="code") is None

    def test_directive_when_flipping_out_of_plan(self) -> None:
        tracker = PlanModeTracker()
        tracker.observe_turn_mode(named_session_id="ns-1", mode="plan")
        directive = tracker.observe_turn_mode(named_session_id="ns-1", mode="code")
        assert directive is not None
        assert directive.type == "plan"

    def test_no_directive_when_starting_in_plan(self) -> None:
        tracker = PlanModeTracker()
        assert tracker.observe_turn_mode(named_session_id="ns-2", mode="plan") is None

    def test_per_session_isolation(self) -> None:
        tracker = PlanModeTracker()
        tracker.observe_turn_mode(named_session_id="ns-1", mode="plan")
        assert tracker.observe_turn_mode(named_session_id="ns-2", mode="code") is None
        directive = tracker.observe_turn_mode(named_session_id="ns-1", mode="code")
        assert directive is not None
