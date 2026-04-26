# M34 — Composer (effort + model + slash commands) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real semantics behind the M33 composer placeholders. Effort, Model, Mode, and Edit-auto controls become functional CLI flags + user-text mutations on every turn. Add 8 slash commands parsed dashboard-side (6 dispatch, 2 stub-toast). File attachment chips appear above the composer input via drag-drop or paperclip click, sent as `@<path>` references with the user message.

**Architecture:** Backend extends `build_command` with `effort | model | mode | edit_auto` keyword arguments + adds a small `apply_effort_prefix(text, effort)` helper for the Deep/Max keyword nudge. The router's `TurnRequest` widens to accept the new fields and forwards them. Frontend's `postChatTurn(sessionId, params)` signature widens; a new `slashCommands.ts` pure-function parser produces a discriminated `SlashAction` union; a `SlashAutocomplete` dropdown component shows command hints when the input starts with `/`; an `AttachmentChip` array renders above the textarea; an Edit-auto toggle lives in the composer foot. `ChatThreadWrapper` becomes the integration point: reads effort/model/mode/edit_auto/attachments from localStorage + the chip state, parses slash commands, dispatches UI-only actions or transforms-and-sends to `postChatTurn`.

**Tech Stack:** FastAPI + Pydantic v2 (hub-side TurnRequest extension); React 19 + TanStack Query v5 (dashboard); existing `useToasts` (stubs); browser DataTransfer API (drag-drop); Vitest + `@testing-library/react`; Playwright + `@axe-core/playwright`.

**Branch:** `m34-composer` (to be created from `main` at the start of Task 0).

**Spec:** [docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md](../specs/2026-04-26-dashboard-redesign-design.md) — M34 section (lines 806–863) + section 3 chat anatomy v2 (lines 211–224 — Composer + Effort).

---

## Decisions made up front

These decisions are locked at plan time so the implementer doesn't have to think about them mid-task.

### CRITICAL: Effort semantics — corrected from spec

The spec says "Effort maps to `thinking.budget_tokens` upstream." **The `claude` CLI does not expose `thinking.budget_tokens` as a flag.** Verified by `claude --help`: the available knobs are `--model`, `--permission-mode`, `--max-budget-usd`, `--append-system-prompt`, `--fallback-model`. There is no thinking-budget flag.

M34 maps Effort to the closest available primitives:

| Effort     | Mechanism                                           | Notes                                                                                                                      |
| ---------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `quick`    | `--max-budget-usd 0.05`                             | Cost cap (~5¢/turn). Imperfect — Claude can hit the cap mid-response and abort. Acceptable for M34's first cut.            |
| `standard` | (no flag)                                           | Default behavior.                                                                                                          |
| `deep`     | Prepend `"think hard about this.\n\n"` to user text | Anthropic's chat protocol recognizes "think" / "think hard" / "think harder" / "ultrathink" as thinking-budget escalators. |
| `max`      | Prepend `"ultrathink.\n\n"` to user text            | Per spec line 223: "the Max level sends ultrathink upstream for the deepest reasoning."                                    |

The keyword-prefix approach is documented in Anthropic's chat protocol — these tokens map to ascending extended-thinking budgets at the API layer. This is the natural mechanism the CLI exposes.

### Mode × edit_auto interaction — locked precedence

Plan mode is restrictive (read-only-ish) by design. `acceptEdits` would contradict it. Resolution: **Plan mode wins over edit_auto.**

```
permission_mode = "plan"        if mode == "plan"
                = "acceptEdits"  elif edit_auto
                = "default"      else
```

Review mode uses the default permission-mode chain (Plan precedence applies; otherwise edit_auto wins; otherwise default), and additionally appends a system-prompt nudge:

```
--append-system-prompt "You are reviewing code; suggest improvements without writing them."
```

Code mode uses the default chain with no system-prompt nudge.

### Slash command dispatch architecture — discriminated union

The 8 commands fall into 4 action kinds:

| Command              | Action kind          | Behavior                                                                                   |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `/edit <path>`       | `transform-and-send` | Send user text: `"Please open <path> for me to edit."`                                     |
| `/git <subcmd>`      | `transform-and-send` | Send user text: `"Run \`git <subcmd>\` via the Bash tool."`                                |
| `/compact`           | `transform-and-send` | Send literal `"/compact"` (the CLI handles it natively as a context-compaction directive). |
| `/plan`              | `set-mode`           | Flip ModeToggle to `plan`. No post.                                                        |
| `/review <pr>`       | `set-mode` + toast   | Flip ModeToggle to `review`. Toast: `"PR thread loading arrives in M35."`. No post.        |
| `/clear`             | `clear-chat`         | Call `clearTurns()` on the active chat. No post.                                           |
| `/save note <title>` | `toast`              | Toast: `"Notes arrive in M35 (Library)."`. No post.                                        |
| `/skill <name>`      | `toast`              | Toast: `"Skills arrive in a future milestone."`. No post.                                  |

Unrecognized commands (e.g. `/wat`) → action kind `unknown`; toast `"Unknown command: <raw>"`. No post.

The parser (`slashCommands.ts`) is a pure function returning a `SlashAction` discriminated union. The dispatcher (in `ChatThreadWrapper`) switches on `kind`.

### File attachment scope — references only, no upload

Browser drag-drop on a `<div>` exposes `event.dataTransfer.files` but only as `File` objects with a `.name` (basename), `.size`, `.type`. We don't get the absolute path; the browser sandbox forbids it. **M34's attachment chips are basename references only** — there's no upload pipeline, no file content, no MIME inspection.

Two ways to add a chip:

1. **Drag-drop a file from the OS** onto the composer area → chip with `file.name`
2. **Click the paperclip icon** → `window.prompt()` for a path string → chip with the prompted text

On send, the chips' paths are appended to the user text:

```
<original user text>

Attachments: @<path1> @<path2>
```

Claude Code's existing `@<path>` reference behavior (it auto-loads the referenced file from the workspace) handles the actual content delivery. M34 is just the chip UI + the reference concatenation.

Removing a chip: × icon on the chip removes it from the array.

### Slash autocomplete UX — click-only for M34

When the input starts with `/`, render a small dropdown above the textarea listing matching commands (prefix-filter). Click on a row → set the input to that command + a trailing space (cursor at end). **No keyboard navigation in M34** — Up/Down/Enter on the dropdown is a follow-up. Escape closes the dropdown (just clears `/` prefix? No — Escape doesn't clear input; it just hides the dropdown).

The dropdown is purely a discovery hint. Users can still type the full command themselves and Send (parser handles whatever they type).

### Backend signature changes

`hub/services/chat_stream.py`:

```python
def build_command(
    claude_session_id: str | None,
    *,
    effort: str = "standard",
    model: str | None = None,
    mode: str = "code",
    edit_auto: bool = False,
    claude_binary: str = "claude",
) -> list[str]:
    ...

def apply_effort_prefix(user_text: str, effort: str) -> str:
    ...

class ClaudeTurnSession:
    async def run(
        self,
        *,
        user_text: str,
        claude_session_id: str | None,
        effort: str = "standard",
        model: str | None = None,
        mode: str = "code",
        edit_auto: bool = False,
    ) -> TurnResult:
        ...
```

`hub/routers/chat_stream.py`:

```python
class TurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    effort: Literal["quick", "standard", "deep", "max"] = "standard"
    model: str | None = None
    mode: Literal["code", "review", "plan"] = "code"
    edit_auto: bool = False
    attachments: list[str] = Field(default_factory=list)
```

The `attachments` field is RECEIVED but unused server-side — the dashboard appends `@<path>` references into `text` before sending. Server keeps the field for forward-compat (M35 may use it for richer context).

### Frontend signature changes

`dashboard/src/lib/api.ts`:

```ts
export interface ChatTurnParams {
  text: string;
  effort?: ChatEffort;        // "quick" | "standard" | "deep" | "max"
  model?: ChatModel | string; // "opus-4-7" | "sonnet-4-6" | "haiku-4-5" | "claude-opus-4-7[1m]" | etc.
  mode?: ChatMode;            // "code" | "review" | "plan"
  edit_auto?: boolean;
  attachments?: string[];
}

export const postChatTurn = (sessionId: string, params: ChatTurnParams) =>
  request<{ accepted: boolean; session_id: string }>(...);
```

This is a **breaking signature change** for the existing M33 callers. ChatThreadWrapper needs to update from `postChatTurn(sessionId, text)` to `postChatTurn(sessionId, { text, ... })`.

### Out of scope (deferred)

- **`/save note` and `/skill` real implementations** — depend on M35 (Library) / future tickets. M34 stubs both with toasts.
- **`/review <pr>` PR thread loading** — depends on M35 GitOps integration. M34 just flips Mode + toasts.
- **File content upload pipeline** — M34 attachments are `@<path>` references only; the CLI loads them.
- **Slash autocomplete keyboard navigation** — Up/Down/Enter to navigate the dropdown is a follow-up. M34 is click-only.
- **1M-context Opus toggle UI** — the alias `claude-opus-4-7[1m]` is just another option in `ModelChip`'s cycle.
- **Mobile composer adaptations** — M36.
- **System-prompt persistence across `--resume`** — open question; whether `--append-system-prompt` applies on every resumed turn or gets ignored is a CLI behavior detail. M34 passes the flag every turn; document as a known consideration.

---

## File Structure

### Backend — modify

- `hub/services/chat_stream.py` — extend `build_command`; add `apply_effort_prefix`; extend `ClaudeTurnSession.run` to accept the new args
- `hub/routers/chat_stream.py` — extend `TurnRequest` schema; thread the new fields into `ClaudeTurnSession`

### Backend — test

- `hub/tests/test_chat_stream_subprocess.py` — extend `TestBuildCommand` with new flag-combination cases; add `TestApplyEffortPrefix`
- `hub/tests/test_chat_stream_endpoint.py` — extend `test_post_turn_*` cases to verify the new TurnRequest fields land in `ClaudeTurnSession.run` correctly

### Frontend — create

- `dashboard/src/lib/slashCommands.ts` — parser that produces a `SlashAction` discriminated union
- `dashboard/src/components/chat/SlashAutocomplete.tsx` — dropdown component
- `dashboard/src/components/chat/AttachmentChip.tsx` — single-chip component
- `dashboard/src/components/chat/EditAutoToggle.tsx` — small toggle for the composer foot
- `dashboard/src/lib/__tests__/slashCommands.test.ts`
- `dashboard/src/components/chat/__tests__/SlashAutocomplete.test.tsx`
- `dashboard/src/components/chat/__tests__/AttachmentChip.test.tsx`
- `dashboard/src/components/chat/__tests__/EditAutoToggle.test.tsx`
- `dashboard/tests/e2e/chat-composer.spec.ts`

### Frontend — modify

- `dashboard/src/lib/api.ts` — widen `postChatTurn` signature
- `dashboard/src/components/chat/ChatComposer.tsx` — render attachment chips above input, edit-auto toggle in foot, slash autocomplete dropdown, drag-drop handler
- `dashboard/src/components/routes/ChatsRoute.tsx` — `ChatThreadWrapper` reads effort/model/mode/edit_auto, dispatches slash commands, posts the full payload
- `dashboard/src/components/chat/ChatThread.tsx` — pass attachments + edit_auto + slash callbacks down to ChatComposer (props extension)

---

## Task 0: Verify branch + claude CLI capabilities

- [ ] **Step 1: Confirm clean main + branch**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git status -s
git log --oneline -3
```

Expected: on `main`, status clean except `?? .claude/settings.json`, recent log shows `Merge M33: chat surface (anatomy + streaming)` (or later).

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b m34-composer
```

- [ ] **Step 3: Re-verify the claude CLI flag inventory M34 will use**

```bash
claude --help 2>&1 | grep -E "model|permission-mode|max-budget|append-system-prompt"
```

Expected output (the four flags M34 wires):

- `--model <model>`
- `--permission-mode <mode>` with choices `acceptEdits|auto|bypassPermissions|default|dontAsk|plan`
- `--max-budget-usd <amount>`
- `--append-system-prompt <prompt>`

If any flag is missing or has changed name/syntax, **STOP and document** — the plan's flag mapping needs the rev. (As of `claude --version` `2.1.120` all four exist.)

---

## Task 1: Backend — extend build_command + tests

**Files:**

- Modify: `hub/services/chat_stream.py` (extend `build_command`)
- Modify: `hub/tests/test_chat_stream_subprocess.py` (extend `TestBuildCommand`)

### Step 1: Write the failing tests

Open `hub/tests/test_chat_stream_subprocess.py`. Inside the existing `class TestBuildCommand:`, ADD these cases (keep the existing two):

```python
    # ── M34 additions ──────────────────────────────────────────────

    def test_quick_effort_adds_max_budget_flag(self) -> None:
        cmd = build_command(claude_session_id=None, effort="quick")
        assert "--max-budget-usd" in cmd
        assert cmd[cmd.index("--max-budget-usd") + 1] == "0.05"

    def test_standard_effort_no_extra_flags(self) -> None:
        cmd = build_command(claude_session_id=None, effort="standard")
        assert "--max-budget-usd" not in cmd
        # No system-prompt nudge for standard
        assert "--append-system-prompt" not in cmd

    def test_deep_effort_no_flag(self) -> None:
        # Deep doesn't use a CLI flag; the keyword prefix is applied
        # to the user text by apply_effort_prefix (Task 2).
        cmd = build_command(claude_session_id=None, effort="deep")
        assert "--max-budget-usd" not in cmd

    def test_max_effort_no_flag(self) -> None:
        # Max also uses the user-text prefix path.
        cmd = build_command(claude_session_id=None, effort="max")
        assert "--max-budget-usd" not in cmd

    def test_model_flag_passed_through(self) -> None:
        cmd = build_command(claude_session_id=None, model="opus-4-7")
        assert "--model" in cmd
        assert cmd[cmd.index("--model") + 1] == "opus-4-7"

    def test_model_1m_alias_passed_through(self) -> None:
        cmd = build_command(claude_session_id=None, model="claude-opus-4-7[1m]")
        assert "--model" in cmd
        assert cmd[cmd.index("--model") + 1] == "claude-opus-4-7[1m]"

    def test_no_model_no_flag(self) -> None:
        cmd = build_command(claude_session_id=None)
        assert "--model" not in cmd

    def test_plan_mode_sets_permission_mode_plan(self) -> None:
        cmd = build_command(claude_session_id=None, mode="plan")
        assert "--permission-mode" in cmd
        assert cmd[cmd.index("--permission-mode") + 1] == "plan"

    def test_plan_mode_overrides_edit_auto(self) -> None:
        # Plan precedence: even with edit_auto=True, --permission-mode is "plan"
        cmd = build_command(claude_session_id=None, mode="plan", edit_auto=True)
        assert cmd[cmd.index("--permission-mode") + 1] == "plan"

    def test_edit_auto_in_code_mode_sets_acceptEdits(self) -> None:
        cmd = build_command(claude_session_id=None, mode="code", edit_auto=True)
        assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"

    def test_code_mode_no_edit_auto_no_permission_flag(self) -> None:
        cmd = build_command(claude_session_id=None, mode="code", edit_auto=False)
        assert "--permission-mode" not in cmd

    def test_review_mode_appends_system_prompt(self) -> None:
        cmd = build_command(claude_session_id=None, mode="review")
        assert "--append-system-prompt" in cmd
        prompt = cmd[cmd.index("--append-system-prompt") + 1]
        assert "reviewing code" in prompt
        # Review uses the default permission chain (no edit_auto here)
        assert "--permission-mode" not in cmd

    def test_review_mode_with_edit_auto_sets_acceptEdits(self) -> None:
        cmd = build_command(claude_session_id=None, mode="review", edit_auto=True)
        assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"
        assert "--append-system-prompt" in cmd

    def test_resume_still_works_with_all_extras(self) -> None:
        cmd = build_command(
            claude_session_id="sess-001",
            effort="quick",
            model="sonnet-4-6",
            mode="plan",
            edit_auto=True,
        )
        assert "--resume" in cmd
        assert cmd[cmd.index("--resume") + 1] == "sess-001"
        assert "--max-budget-usd" in cmd
        assert "--model" in cmd
        assert cmd[cmd.index("--permission-mode") + 1] == "plan"  # plan wins
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_subprocess.py::TestBuildCommand -v
```

Expected: the new cases fail because `build_command` doesn't accept the new keyword args yet.

### Step 3: Replace build_command in chat_stream.py

Open `/home/gnava/repos/honeycomb/hub/services/chat_stream.py`. Find the existing `build_command` and replace its body with:

```python
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
        "--input-format", "stream-json",
        "--output-format", "stream-json",
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
```

### Step 4: Run, expect all green

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_subprocess.py::TestBuildCommand -v
```

Expected: 16 cases pass (2 existing + 14 new).

### Step 5: Run mypy + ruff

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check hub/services/chat_stream.py
uv run mypy hub/services/chat_stream.py
```

Both clean.

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/chat_stream.py hub/tests/test_chat_stream_subprocess.py
git commit -m "feat(m34): build_command accepts effort/model/mode/edit_auto

Effort=quick → --max-budget-usd 0.05 (cost cap proxy; the CLI
doesn't expose thinking.budget_tokens). Standard/Deep/Max omit
the cost cap; Deep/Max apply a user-text prefix in Task 2.

Mode=plan → --permission-mode plan (overrides edit_auto since
plan is intentionally restrictive). Code/Review modes use
edit_auto-driven --permission-mode acceptEdits when on, default
otherwise. Review mode also appends a system-prompt nudge.

Model alias passes through verbatim; supports the
claude-opus-4-7[1m] 1M-context variant alias as a regular value."
```

If pre-commit reformats anything, re-stage and re-commit.

---

## Task 2: Backend — apply_effort_prefix + ClaudeTurnSession.run integration

**Files:**

- Modify: `hub/services/chat_stream.py` (add `apply_effort_prefix`; extend `ClaudeTurnSession.run`)
- Modify: `hub/tests/test_chat_stream_subprocess.py` (add `TestApplyEffortPrefix`; extend `TestClaudeTurnSession`)

### Step 1: Write the failing tests

Add to `hub/tests/test_chat_stream_subprocess.py` (anywhere among the existing classes):

```python
class TestApplyEffortPrefix:
    def test_standard_returns_text_unchanged(self) -> None:
        from hub.services.chat_stream import apply_effort_prefix
        assert apply_effort_prefix("hello", "standard") == "hello"

    def test_quick_returns_text_unchanged(self) -> None:
        # Quick uses the cost cap, not a prefix.
        from hub.services.chat_stream import apply_effort_prefix
        assert apply_effort_prefix("hello", "quick") == "hello"

    def test_deep_prepends_think_hard_keyword(self) -> None:
        from hub.services.chat_stream import apply_effort_prefix
        out = apply_effort_prefix("hello", "deep")
        assert out.startswith("think hard about this.")
        assert "hello" in out

    def test_max_prepends_ultrathink_keyword(self) -> None:
        from hub.services.chat_stream import apply_effort_prefix
        out = apply_effort_prefix("hello", "max")
        assert out.startswith("ultrathink.")
        assert "hello" in out

    def test_unknown_effort_passes_through(self) -> None:
        # Defensive: unrecognized effort doesn't raise; it's a no-op
        from hub.services.chat_stream import apply_effort_prefix
        assert apply_effort_prefix("hello", "wat") == "hello"
```

In the existing `class TestClaudeTurnSession:`, ADD a new case verifying the args propagate to `build_command` AND the user-text prefix lands in stdin:

```python
    @pytest.mark.asyncio
    async def test_run_passes_effort_max_to_user_prefix(self, tmp_path: Path) -> None:
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
        await session.run(
            user_text="please find the bug",
            claude_session_id=None,
            effort="max",
        )

        stdin_payload = log_path.read_text().strip()
        # The user text written to stdin is JSON; the inner content
        # should have the ultrathink prefix.
        import json as _json
        envelope = _json.loads(stdin_payload)
        assert envelope["type"] == "user"
        assert envelope["message"]["role"] == "user"
        assert envelope["message"]["content"].startswith("ultrathink.")
        assert "please find the bug" in envelope["message"]["content"]

    @pytest.mark.asyncio
    async def test_run_passes_model_and_mode_to_subprocess(self, tmp_path: Path) -> None:
        # Fake claude that records its argv to a file then exits.
        argv_log = tmp_path / "argv.log"
        fake_script = tmp_path / "claude"
        fake_script.write_text(
            "#!/usr/bin/env bash\n"
            f'echo "$@" > {argv_log}\n'
            'cat - > /dev/null\n'  # consume stdin
            'echo \'{"type":"result","subtype":"success","is_error":false,"session_id":"s","uuid":"u","duration_ms":1}\'\n'
        )
        fake_script.chmod(0o755)

        manager = AsyncMock()
        session = ClaudeTurnSession(
            named_session_id="ns-m",
            cwd="/tmp",
            ws_manager=manager,
            claude_binary=str(fake_script),
        )
        await session.run(
            user_text="hi",
            claude_session_id=None,
            effort="quick",
            model="sonnet-4-6",
            mode="review",
            edit_auto=True,
        )

        argv = argv_log.read_text().strip().split()
        # Ordered checks: model + permission_mode (acceptEdits because
        # review with edit_auto) + max-budget-usd (quick) + system prompt
        assert "--model" in argv
        assert argv[argv.index("--model") + 1] == "sonnet-4-6"
        assert argv[argv.index("--permission-mode") + 1] == "acceptEdits"
        assert argv[argv.index("--max-budget-usd") + 1] == "0.05"
        assert "--append-system-prompt" in argv
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_subprocess.py -v
```

Expected: the 5 `TestApplyEffortPrefix` cases fail (no helper exists) and the 2 new `TestClaudeTurnSession` cases fail (run() doesn't accept the new kwargs).

### Step 3: Implement apply_effort_prefix + extend run()

In `hub/services/chat_stream.py`:

**3a.** Add the helper near `build_command` (above or below — pick wherever fits the existing layout):

```python
def apply_effort_prefix(user_text: str, effort: str) -> str:
    """Map Effort to a user-text prefix when it changes Claude's
    thinking depth (M34). The CLI doesn't expose a thinking-budget
    flag, so Deep/Max nudge the model via Anthropic's documented
    chat-protocol keywords.

    Quick uses the dollar cap (--max-budget-usd) at the CLI layer
    (see build_command) and doesn't need a text prefix.
    """
    if effort == "deep":
        return f"think hard about this.\n\n{user_text}"
    if effort == "max":
        return f"ultrathink.\n\n{user_text}"
    return user_text
```

**3b.** Extend `ClaudeTurnSession.run`'s signature + body. Find the existing `async def run(self, *, user_text: str, claude_session_id: str | None) -> TurnResult:` and replace with:

```python
    async def run(
        self,
        *,
        user_text: str,
        claude_session_id: str | None,
        effort: str = "standard",
        model: str | None = None,
        mode: str = "code",
        edit_auto: bool = False,
    ) -> TurnResult:
        if shutil.which(self.claude_binary) is None and not self.claude_binary.startswith("/"):
            raise FileNotFoundError(f"claude binary not found: {self.claude_binary}")

        cmd = build_command(
            claude_session_id,
            effort=effort,
            model=model,
            mode=mode,
            edit_auto=edit_auto,
            claude_binary=self.claude_binary,
        )
        logger.info(
            "chat_stream spawn: ns=%s cmd=%s cwd=%s resume=%s effort=%s model=%s mode=%s edit_auto=%s",
            self.named_session_id,
            " ".join(cmd),
            self.cwd,
            claude_session_id,
            effort,
            model,
            mode,
            edit_auto,
        )

        # The rest of the method is unchanged from M33 — keep the
        # subprocess spawn / stdin write / stdout drain / wait loop.
        # The ONLY substantive change inside is the user_text apply:
        prefixed_text = apply_effort_prefix(user_text, effort)

        # ... (existing subprocess.create_subprocess_exec call) ...

        # Where the existing code writes the stdin payload, change:
        user_payload = json.dumps(
            {"type": "user", "message": {"role": "user", "content": prefixed_text}}
        )
        # ... rest unchanged ...
```

**Critical:** Preserve the existing subprocess spawn body (cancel handling, start_new_session, etc.). Only two changes vs M33:

1. The signature gains `effort | model | mode | edit_auto` keyword args
2. The user_payload uses `prefixed_text` (output of `apply_effort_prefix`) instead of raw `user_text`

The rest of the method body is unchanged.

### Step 4: Run tests, expect all green

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_subprocess.py -v
```

Expected: 5 `TestApplyEffortPrefix` + 16 `TestBuildCommand` + 6 existing `TestClaudeTurnSession` + 2 new `TestClaudeTurnSession` = 29 cases pass.

### Step 5: Run mypy + ruff

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check hub/services/chat_stream.py
uv run mypy hub/services/chat_stream.py
```

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/chat_stream.py hub/tests/test_chat_stream_subprocess.py
git commit -m "feat(m34): apply_effort_prefix + ClaudeTurnSession.run accepts new args

apply_effort_prefix maps Effort=Deep → 'think hard about this.'
prefix and Effort=Max → 'ultrathink.' prefix on the user text.
Quick/Standard pass through unchanged (Quick uses the CLI cost
cap from Task 1; Standard is the no-op default).

ClaudeTurnSession.run now takes effort/model/mode/edit_auto kwargs
and threads them through build_command + apply_effort_prefix. The
subprocess spawn body is otherwise unchanged from M33."
```

---

## Task 3: Backend — TurnRequest extension + endpoint passthrough

**Files:**

- Modify: `hub/routers/chat_stream.py` (extend `TurnRequest`; thread fields into `ClaudeTurnSession.run`)
- Modify: `hub/tests/test_chat_stream_endpoint.py` (5 new endpoint cases)

### Step 1: Write the failing tests

Add to `hub/tests/test_chat_stream_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_post_turn_accepts_effort_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": "claude-x", "forwarded_count": 1}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "effort": "max"},
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)

    fake_session.run.assert_awaited_once()
    kwargs = fake_session.run.await_args.kwargs
    assert kwargs["effort"] == "max"


@pytest.mark.asyncio
async def test_post_turn_accepts_model_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "model": "claude-opus-4-7[1m]"},
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    assert fake_session.run.await_args.kwargs["model"] == "claude-opus-4-7[1m]"


@pytest.mark.asyncio
async def test_post_turn_accepts_mode_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "mode": "plan"},
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    assert fake_session.run.await_args.kwargs["mode"] == "plan"


@pytest.mark.asyncio
async def test_post_turn_accepts_edit_auto_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "edit_auto": True},
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    assert fake_session.run.await_args.kwargs["edit_auto"] is True


@pytest.mark.asyncio
async def test_post_turn_rejects_invalid_effort(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns",
        json={"text": "hi", "effort": "bogus"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_turn_rejects_invalid_mode(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns",
        json={"text": "hi", "mode": "destruct"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_turn_defaults_when_fields_omitted(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    """Backwards-compat: M33-style payload without the new fields still works."""
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi"},
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    kwargs = fake_session.run.await_args.kwargs
    assert kwargs["effort"] == "standard"
    assert kwargs["model"] is None
    assert kwargs["mode"] == "code"
    assert kwargs["edit_auto"] is False
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_endpoint.py -v
```

### Step 3: Extend TurnRequest + the POST handler

In `/home/gnava/repos/honeycomb/hub/routers/chat_stream.py`:

**3a.** Add the new imports at the top:

```python
from typing import Literal
```

**3b.** Replace the existing `class TurnRequest(BaseModel):` with:

```python
class TurnRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    # M34: effort/model/mode/edit_auto wire to chat_stream.build_command
    effort: Literal["quick", "standard", "deep", "max"] = "standard"
    model: str | None = None
    mode: Literal["code", "review", "plan"] = "code"
    edit_auto: bool = False
    # M34: attachments accepted but unused server-side — the dashboard
    # appends @<path> references into `text` before sending. Field stays
    # for forward-compat (M35 may use it for richer context).
    attachments: list[str] = Field(default_factory=list)
```

**3c.** Update the `_drive` inner function inside `post_turn` to thread the new fields into `chat.run(...)`. Find the existing `result = await chat.run(user_text=body.text, claude_session_id=sess.claude_session_id)` and replace with:

```python
        try:
            result = await chat.run(
                user_text=body.text,
                claude_session_id=sess.claude_session_id,
                effort=body.effort,
                model=body.model,
                mode=body.mode,
                edit_auto=body.edit_auto,
            )
```

### Step 4: Run tests, expect all green

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_endpoint.py -v
```

Expected: existing 6 + 7 new = 13 cases pass.

### Step 5: Run the full hub suite

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

Expected: 410 + 14 (Task 1) + 7 (Task 2 prefix + run) + 7 (Task 3) = ~438 hub tests pass. (Counts approximate; what matters is "all green".)

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/chat_stream.py hub/tests/test_chat_stream_endpoint.py
git commit -m "feat(m34): TurnRequest accepts effort/model/mode/edit_auto/attachments

Pydantic Literals constrain effort to {quick, standard, deep, max}
and mode to {code, review, plan}; invalid values 422. Defaults
preserve M33 behavior (effort=standard, mode=code, edit_auto=False)
so existing dashboard callers still work without a payload bump.

Attachments accepted but server-side they're a no-op — the dashboard
concatenates @<path> references into text before sending. Field
stays for M35 richer-context expansion."
```

---

## Task 4: Frontend — extend postChatTurn signature

**Files:**

- Modify: `dashboard/src/lib/api.ts` (widen `postChatTurn`)

This is a small standalone task to land the API surface change before the components depend on it.

### Step 1: Replace postChatTurn

In `/home/gnava/repos/honeycomb/dashboard/src/lib/api.ts`, find the existing M33 `postChatTurn` definition and replace with:

```ts
// ─── M33/M34 chat-stream ────────────────────────────────────────────────────

import type { ChatEffort } from "../components/chat/EffortControl";
import type { ChatMode } from "../components/chat/ModeToggle";
import type { ChatModel } from "../components/chat/ModelChip";

export interface ChatTurnParams {
  text: string;
  /** M34: per-turn effort. Defaults server-side to "standard". */
  effort?: ChatEffort;
  /** M34: per-conversation model. */
  model?: ChatModel | string;
  /** M34: chat mode. Defaults to "code". */
  mode?: ChatMode;
  /** M34: when true, Edit-tool calls auto-accept. */
  edit_auto?: boolean;
  /** M34: attachment path strings appended as @<path> references in text. */
  attachments?: string[];
}

export const postChatTurn = (sessionId: string, params: ChatTurnParams) =>
  request<{ accepted: boolean; session_id: string }>(`/named-sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify(params),
  });

export const cancelActiveTurn = (sessionId: string) =>
  request<void>(`/named-sessions/${sessionId}/turns/active`, {
    method: "DELETE",
  });
```

The `cancelActiveTurn` is unchanged — keep its existing definition (just shown above for context).

### Step 2: Update the M33 callers

The signature change breaks ChatThreadWrapper's call. Find it:

```bash
grep -n "postChatTurn(" /home/gnava/repos/honeycomb/dashboard/src/components/routes/ChatsRoute.tsx
```

The M33 call was something like `await postChatTurn(sessionId, text)`. Update to:

```tsx
await postChatTurn(sessionId, { text });
```

This is the minimal compat update — Task 9 will pass the full param object.

### Step 3: Run typecheck + vitest

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

Expected: clean. Existing M33 tests still pass because the signature accepts `{text}` as a partial.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/api.ts dashboard/src/components/routes/ChatsRoute.tsx
git commit -m "feat(m34): postChatTurn accepts ChatTurnParams object

Widens the M33 (sessionId, text) signature to (sessionId, params)
where params carries effort/model/mode/edit_auto/attachments.

ChatThreadWrapper updated to the minimal { text } shape; Task 9
threads the full settings through."
```

---

## Task 5: Frontend — slashCommands.ts parser

**Files:**

- Create: `dashboard/src/lib/slashCommands.ts`
- Create: `dashboard/src/lib/__tests__/slashCommands.test.ts`

This is the heart of M34's UX. Pure function; no React; trivially testable.

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/lib/__tests__/slashCommands.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  AVAILABLE_SLASH_COMMANDS,
  filterSlashCommands,
  parseSlashCommand,
  type SlashAction,
} from "../slashCommands";

describe("parseSlashCommand", () => {
  it("non-slash text returns kind='none'", () => {
    expect(parseSlashCommand("hello world")).toEqual<SlashAction>({ kind: "none" });
    expect(parseSlashCommand("")).toEqual<SlashAction>({ kind: "none" });
    expect(parseSlashCommand("  /edit foo")).toEqual<SlashAction>({ kind: "none" }); // leading whitespace = not a command
  });

  it("/edit transforms to a Claude prompt asking to open the path", () => {
    const action = parseSlashCommand("/edit src/main.tsx");
    expect(action).toEqual<SlashAction>({
      kind: "transform-and-send",
      userText: "Please open src/main.tsx for me to edit.",
    });
  });

  it("/edit without an argument returns 'unknown' (path is required)", () => {
    expect(parseSlashCommand("/edit")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/edit",
      reason: "/edit requires a path argument",
    });
  });

  it("/git wraps a Bash invocation", () => {
    expect(parseSlashCommand("/git status -sb")).toEqual<SlashAction>({
      kind: "transform-and-send",
      userText: "Run `git status -sb` via the Bash tool.",
    });
  });

  it("/git without args is unknown", () => {
    expect(parseSlashCommand("/git")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/git",
      reason: "/git requires a subcommand",
    });
  });

  it("/compact passes through literally to Claude", () => {
    expect(parseSlashCommand("/compact")).toEqual<SlashAction>({
      kind: "transform-and-send",
      userText: "/compact",
    });
  });

  it("/plan flips mode (no post)", () => {
    expect(parseSlashCommand("/plan")).toEqual<SlashAction>({
      kind: "set-mode",
      mode: "plan",
    });
  });

  it("/review with PR arg flips mode AND toasts the M35 deferral", () => {
    expect(parseSlashCommand("/review 42")).toEqual<SlashAction>({
      kind: "set-mode",
      mode: "review",
      toast: "PR thread loading arrives in M35.",
    });
  });

  it("/review without an arg also flips mode (PR optional)", () => {
    expect(parseSlashCommand("/review")).toEqual<SlashAction>({
      kind: "set-mode",
      mode: "review",
      toast: "PR thread loading arrives in M35.",
    });
  });

  it("/clear clears the chat", () => {
    expect(parseSlashCommand("/clear")).toEqual<SlashAction>({ kind: "clear-chat" });
  });

  it("/save note <title> stubs with a toast", () => {
    expect(parseSlashCommand("/save note My Idea")).toEqual<SlashAction>({
      kind: "toast",
      text: "Notes arrive in M35 (Library).",
    });
  });

  it("/save without 'note' is unknown", () => {
    expect(parseSlashCommand("/save todo Foo")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/save todo Foo",
      reason: "/save expects 'note <title>' (other artifact types arrive in M35)",
    });
  });

  it("/skill stubs with a toast", () => {
    expect(parseSlashCommand("/skill foo")).toEqual<SlashAction>({
      kind: "toast",
      text: "Skills arrive in a future milestone.",
    });
  });

  it("/wat is unknown", () => {
    expect(parseSlashCommand("/wat")).toEqual<SlashAction>({
      kind: "unknown",
      raw: "/wat",
      reason: "Unknown command: /wat",
    });
  });
});

describe("filterSlashCommands", () => {
  it("empty prefix returns all 8 commands", () => {
    expect(filterSlashCommands("")).toEqual(AVAILABLE_SLASH_COMMANDS);
    expect(AVAILABLE_SLASH_COMMANDS.length).toBe(8);
  });

  it("prefix /e matches /edit only", () => {
    const matches = filterSlashCommands("/e");
    expect(matches.map((c) => c.name)).toEqual(["/edit"]);
  });

  it("prefix /s matches /save and /skill", () => {
    const matches = filterSlashCommands("/s");
    expect(matches.map((c) => c.name).sort()).toEqual(["/save", "/skill"]);
  });

  it("non-slash prefix returns empty array", () => {
    expect(filterSlashCommands("hello")).toEqual([]);
  });

  it("prefix /xyz returns empty (no matches)", () => {
    expect(filterSlashCommands("/xyz")).toEqual([]);
  });
});
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/slashCommands.test.ts
```

### Step 3: Implement slashCommands.ts

Create `/home/gnava/repos/honeycomb/dashboard/src/lib/slashCommands.ts`:

```ts
/** Slash-command parser for the chat composer (M34).
 *
 * Pure function that takes raw input text and returns a SlashAction
 * describing what the dispatcher (in ChatThreadWrapper) should do:
 *
 *   - "none"               → no slash command; send text verbatim
 *   - "transform-and-send" → send `userText` (transformed) as the user message
 *   - "set-mode"           → flip the ModeToggle to `mode`; optional toast
 *   - "clear-chat"         → call clearTurns()
 *   - "toast"              → show toast with `text`
 *   - "unknown"            → command was recognized as a slash but invalid;
 *                            include `raw` + a human `reason` for the toast
 *
 * Eight commands (see AVAILABLE_SLASH_COMMANDS). The dispatcher in
 * ChatThreadWrapper is responsible for the side-effects.
 */

import type { ChatMode } from "../components/chat/ModeToggle";

export type SlashAction =
  | { kind: "none" }
  | { kind: "transform-and-send"; userText: string }
  | { kind: "set-mode"; mode: ChatMode; toast?: string }
  | { kind: "clear-chat" }
  | { kind: "toast"; text: string }
  | { kind: "unknown"; raw: string; reason: string };

export interface SlashCommandSpec {
  name: string; // e.g. "/edit"
  hint: string; // short description shown in autocomplete
  argHint?: string; // optional argument placeholder (e.g. "<path>")
}

export const AVAILABLE_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: "/edit", hint: "Ask Claude to open a file for editing", argHint: "<path>" },
  { name: "/git", hint: "Run a git subcommand via Bash", argHint: "<subcmd>" },
  { name: "/compact", hint: "Compact the conversation context to free tokens" },
  { name: "/plan", hint: "Switch to Plan mode (read-only)" },
  { name: "/review", hint: "Switch to Review mode", argHint: "[<pr>]" },
  { name: "/clear", hint: "Clear the chat history (UI only)" },
  { name: "/save", hint: "Save the prior message as an artifact (M35)", argHint: "note <title>" },
  { name: "/skill", hint: "Invoke a saved skill (future)", argHint: "<name>" },
];

/** Filter the available commands by what the user has typed so far.
 *  Returns matches in declaration order; empty for non-slash prefix.
 *  An empty prefix `""` returns all commands. */
export function filterSlashCommands(prefix: string): readonly SlashCommandSpec[] {
  if (prefix === "") return AVAILABLE_SLASH_COMMANDS;
  if (!prefix.startsWith("/")) return [];
  return AVAILABLE_SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/** Parse the user input. Non-slash text returns kind="none". */
export function parseSlashCommand(input: string): SlashAction {
  if (!input.startsWith("/")) return { kind: "none" };

  const trimmed = input.trim();
  // First token is the command name (without the rest of the args)
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "/edit": {
      if (rest === "") {
        return { kind: "unknown", raw: trimmed, reason: "/edit requires a path argument" };
      }
      return { kind: "transform-and-send", userText: `Please open ${rest} for me to edit.` };
    }
    case "/git": {
      if (rest === "") {
        return { kind: "unknown", raw: trimmed, reason: "/git requires a subcommand" };
      }
      return { kind: "transform-and-send", userText: `Run \`git ${rest}\` via the Bash tool.` };
    }
    case "/compact":
      return { kind: "transform-and-send", userText: "/compact" };
    case "/plan":
      return { kind: "set-mode", mode: "plan" };
    case "/review":
      return {
        kind: "set-mode",
        mode: "review",
        toast: "PR thread loading arrives in M35.",
      };
    case "/clear":
      return { kind: "clear-chat" };
    case "/save": {
      // M34 supports only "note <title>"; other artifact types arrive in M35
      if (!rest.startsWith("note ") && rest !== "note") {
        return {
          kind: "unknown",
          raw: trimmed,
          reason: "/save expects 'note <title>' (other artifact types arrive in M35)",
        };
      }
      return { kind: "toast", text: "Notes arrive in M35 (Library)." };
    }
    case "/skill":
      return { kind: "toast", text: "Skills arrive in a future milestone." };
    default:
      return { kind: "unknown", raw: trimmed, reason: `Unknown command: ${cmd}` };
  }
}
```

### Step 4: Run tests, expect 18/18 PASS

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/slashCommands.test.ts
```

### Step 5: Run full vitest + typecheck

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/slashCommands.ts dashboard/src/lib/__tests__/slashCommands.test.ts
git commit -m "feat(m34): slashCommands.ts parser (8 commands → discriminated union)

Pure function; no React. Eight commands fall into 4 action kinds:
transform-and-send (/edit /git /compact), set-mode (/plan /review),
clear-chat (/clear), toast-stub (/save note /skill). Unknown
commands surface a human reason for the toast.

filterSlashCommands gives the autocomplete (Task 6) the matching
specs by prefix. AVAILABLE_SLASH_COMMANDS is the canonical list."
```

---

## Task 6: Frontend — SlashAutocomplete dropdown

**Files:**

- Create: `dashboard/src/components/chat/SlashAutocomplete.tsx`
- Create: `dashboard/src/components/chat/__tests__/SlashAutocomplete.test.tsx`

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/SlashAutocomplete.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SlashAutocomplete } from "../SlashAutocomplete";

describe("SlashAutocomplete", () => {
  it("renders nothing when input prefix is non-slash", () => {
    const { container } = render(<SlashAutocomplete prefix="hello" onSelect={vi.fn()} />);
    expect(container.querySelector("[role='listbox']")).toBeNull();
  });

  it("renders all 8 commands for a bare '/' prefix", () => {
    render(<SlashAutocomplete prefix="/" onSelect={vi.fn()} />);
    const opts = screen.getAllByRole("option");
    expect(opts).toHaveLength(8);
  });

  it("filters to /save and /skill on prefix '/s'", () => {
    render(<SlashAutocomplete prefix="/s" onSelect={vi.fn()} />);
    const opts = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opts.some((t) => t?.startsWith("/save"))).toBe(true);
    expect(opts.some((t) => t?.startsWith("/skill"))).toBe(true);
    // /edit etc not shown
    expect(opts.some((t) => t?.startsWith("/edit"))).toBe(false);
  });

  it("clicking an option calls onSelect with that command name + trailing space", () => {
    const onSelect = vi.fn();
    render(<SlashAutocomplete prefix="/" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("/edit", { exact: false }));
    expect(onSelect).toHaveBeenCalledWith("/edit ");
  });

  it("renders empty list when prefix matches no command", () => {
    const { container } = render(<SlashAutocomplete prefix="/xyz" onSelect={vi.fn()} />);
    // Either renders empty listbox or nothing — test that no options exist
    expect(container.querySelectorAll("[role='option']")).toHaveLength(0);
  });
});
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/SlashAutocomplete.test.tsx
```

### Step 3: Implement SlashAutocomplete

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/SlashAutocomplete.tsx`:

```tsx
/** Slash-command autocomplete dropdown (M34).
 *
 * Shown by ChatComposer when the input starts with `/`. Lists the
 * matching commands (prefix-filter); click selects and inserts the
 * command name (with a trailing space) into the composer input.
 *
 * No keyboard navigation in M34 — Up/Down/Enter is a follow-up.
 */
import { filterSlashCommands } from "../../lib/slashCommands";

interface Props {
  prefix: string;
  onSelect: (text: string) => void;
}

export function SlashAutocomplete({ prefix, onSelect }: Props) {
  if (!prefix.startsWith("/")) return null;
  const matches = filterSlashCommands(prefix);
  if (matches.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Slash command suggestions"
      className="z-20 max-h-60 overflow-y-auto rounded border border-edge bg-pane shadow-medium"
    >
      {matches.map((cmd) => (
        <li key={cmd.name}>
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onSelect(`${cmd.name} `)}
            className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-chip"
          >
            <span className="font-mono text-tool">{cmd.name}</span>
            {cmd.argHint && <span className="font-mono text-muted">{cmd.argHint}</span>}
            <span className="ml-auto text-[11px] text-secondary">{cmd.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

### Step 4: Run tests, expect 5/5 PASS

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/SlashAutocomplete.test.tsx
```

### Step 5: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/SlashAutocomplete.tsx \
        dashboard/src/components/chat/__tests__/SlashAutocomplete.test.tsx
git commit -m "feat(m34): SlashAutocomplete dropdown component

Click-only selection (keyboard nav is a follow-up). Filters
AVAILABLE_SLASH_COMMANDS by prefix, renders nothing for non-slash
or no-match prefixes. Each row shows the command name (mono +
text-tool color), the argument hint if any, and the human
description on the right."
```

---

## Task 7: Frontend — AttachmentChip + drag-drop

**Files:**

- Create: `dashboard/src/components/chat/AttachmentChip.tsx`
- Create: `dashboard/src/components/chat/__tests__/AttachmentChip.test.tsx`

The drag-drop logic + the attachment array state live in ChatComposer (Task 8). This task only ships the chip component.

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/AttachmentChip.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AttachmentChip } from "../AttachmentChip";

describe("AttachmentChip", () => {
  it("renders the path", () => {
    render(<AttachmentChip path="src/main.tsx" onRemove={vi.fn()} />);
    expect(screen.getByText("src/main.tsx")).toBeTruthy();
  });

  it("clicking × calls onRemove", () => {
    const onRemove = vi.fn();
    render(<AttachmentChip path="foo.py" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove foo.py/i }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("long paths truncate via CSS but full path is in title", () => {
    const long = "a/very/deeply/nested/path/to/some/file.tsx";
    render(<AttachmentChip path={long} onRemove={vi.fn()} />);
    const el = screen.getByText(long);
    expect(el.getAttribute("title")).toBe(long);
  });
});
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/AttachmentChip.test.tsx
```

### Step 3: Implement AttachmentChip

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/AttachmentChip.tsx`:

```tsx
/** Single attachment chip rendered above the composer textarea (M34).
 *
 * M34 attachments are reference strings only (filename or path); the
 * actual file content isn't uploaded — the CLI loads files referenced
 * via @<path> from the workspace.
 */
import { Paperclip, X } from "lucide-react";

interface Props {
  path: string;
  onRemove: () => void;
}

export function AttachmentChip({ path, onRemove }: Props) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 rounded border border-edge bg-chip px-2 py-0.5 text-[11px]">
      <Paperclip size={11} aria-hidden="true" className="text-secondary" />
      <span className="truncate font-mono text-primary" title={path}>
        {path}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${path}`}
        className="rounded p-0.5 text-faint hover:bg-edge hover:text-primary"
      >
        <X size={10} aria-hidden="true" />
      </button>
    </span>
  );
}
```

### Step 4: Run tests, expect 3/3 PASS

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/AttachmentChip.test.tsx
```

### Step 5: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/AttachmentChip.tsx \
        dashboard/src/components/chat/__tests__/AttachmentChip.test.tsx
git commit -m "feat(m34): AttachmentChip component

Inline chip with Paperclip icon, truncated path (full path in
title attribute), and a × remove button (aria-label='Remove
<path>'). Composer integration arrives in Task 8."
```

---

## Task 8: Frontend — extend ChatComposer (attachments, edit-auto, slash dropdown)

**Files:**

- Modify: `dashboard/src/components/chat/ChatComposer.tsx`
- Modify: `dashboard/src/components/chat/__tests__/ChatComposer.test.tsx`
- Create: `dashboard/src/components/chat/EditAutoToggle.tsx`
- Create: `dashboard/src/components/chat/__tests__/EditAutoToggle.test.tsx`

### Step 1: Implement EditAutoToggle (TDD)

Write test first. Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/EditAutoToggle.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EditAutoToggle } from "../EditAutoToggle";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("EditAutoToggle", () => {
  it("defaults to off when no stored value", () => {
    render(<EditAutoToggle sessionId="s1" />);
    expect((screen.getByRole("switch") as HTMLInputElement).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("loads stored value on mount", () => {
    window.localStorage.setItem("hive:chat:s2:edit-auto", "true");
    render(<EditAutoToggle sessionId="s2" />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("clicking toggles + persists", () => {
    render(<EditAutoToggle sessionId="s3" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("hive:chat:s3:edit-auto")).toBe("true");
  });
});
```

Run, expect FAIL:

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/EditAutoToggle.test.tsx
```

Implement. Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/EditAutoToggle.tsx`:

```tsx
/** Edit-auto toggle (M34) — when on, Edit-tool calls auto-accept
 *  (--permission-mode acceptEdits). Plan mode overrides this; see
 *  hub/services/chat_stream.build_command for the precedence rules.
 *
 *  Persisted per chat in localStorage:hive:chat:<sessionId>:edit-auto.
 */
import { useEffect, useState } from "react";

interface Props {
  sessionId: string;
}

function storageKey(sessionId: string): string {
  return `hive:chat:${sessionId}:edit-auto`;
}

function readStored(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(storageKey(sessionId)) === "true";
}

export function EditAutoToggle({ sessionId }: Props) {
  const [on, setOn] = useState<boolean>(() => readStored(sessionId));
  useEffect(() => {
    setOn(readStored(sessionId));
  }, [sessionId]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    window.localStorage.setItem(storageKey(sessionId), next ? "true" : "false");
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className={`inline-flex items-center gap-1.5 rounded-md border border-edge px-2 py-0.5 text-[10px] transition-colors ${
        on ? "bg-write/20 text-write" : "bg-pane text-secondary hover:text-primary"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${on ? "bg-write" : "bg-faint"}`}
      />
      <span>Edit auto</span>
    </button>
  );
}
```

Run tests, expect 3/3 PASS.

### Step 2: Read public helper for storage

For ChatThreadWrapper (Task 9) to read the edit-auto value, expose a small reader. Add to the BOTTOM of `EditAutoToggle.tsx`:

```ts
/** Read the persisted edit-auto value without rendering the toggle.
 *  Used by the chat dispatcher to compose the postChatTurn payload. */
export function readEditAuto(sessionId: string): boolean {
  return readStored(sessionId);
}
```

### Step 3: Extend ChatComposer

Now the bigger change — ChatComposer needs:

1. An `attachments` prop array + an `onAttachmentsChange` callback (lifted state, set by parent)
2. A drag-drop handler that adds chips
3. The slash autocomplete dropdown rendered above the textarea when input starts with `/`
4. The Edit-auto toggle in the foot row (next to EffortControl)

Replace the FULL content of `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatComposer.tsx`:

```tsx
/** Composer (M33 + M34).
 *
 * Multi-line auto-grow textarea with:
 *   - Attachment chips above the input row (drag-drop a file or click
 *     paperclip to prompt for a path)
 *   - Slash autocomplete dropdown above the textarea when input
 *     starts with '/'
 *   - Send button (Cmd+Enter or click)
 *   - Foot row: EffortControl, EditAutoToggle, mode label, kbd hints
 */
import { Paperclip, Send, Slash } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AttachmentChip } from "./AttachmentChip";
import { EditAutoToggle } from "./EditAutoToggle";
import { EffortControl } from "./EffortControl";
import { SlashAutocomplete } from "./SlashAutocomplete";
import type { ChatMode } from "./ModeToggle";

interface Props {
  sessionId: string;
  mode: ChatMode;
  disabled?: boolean;
  onSend: (text: string) => void;
  /** Attachment paths shown as chips above the input. Lifted so the
   *  parent can clear them after send. */
  attachments: string[];
  onAttachmentsChange: (next: string[]) => void;
}

const MODE_LABEL: Record<ChatMode, string> = {
  code: "Code",
  review: "Review",
  plan: "Plan",
};

export function ChatComposer({
  sessionId,
  mode,
  disabled,
  onSend,
  attachments,
  onAttachmentsChange,
}: Props) {
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

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const newPaths = files.map((f) => f.name);
    onAttachmentsChange([...attachments, ...newPaths]);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handlePromptAttach = () => {
    const path = window.prompt("Attach a file path (workspace-relative or absolute):");
    if (path === null || path.trim() === "") return;
    onAttachmentsChange([...attachments, path.trim()]);
  };

  const removeAttachment = (idx: number) => {
    const next = [...attachments];
    next.splice(idx, 1);
    onAttachmentsChange(next);
  };

  // Slash autocomplete: visible when value starts with "/" AND there's
  // no whitespace yet (i.e. user is still typing the command name).
  const showSlashDropdown = value.startsWith("/") && !value.includes(" ");

  return (
    <div className="border-t border-edge bg-pane" onDrop={handleDrop} onDragOver={handleDragOver}>
      {/* Attachment chips row */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
          {attachments.map((path, i) => (
            <AttachmentChip key={`${path}-${i}`} path={path} onRemove={() => removeAttachment(i)} />
          ))}
        </div>
      )}

      {/* Slash autocomplete (positioned above the textarea via DOM
          order; the listbox is short enough to never overlap) */}
      {showSlashDropdown && (
        <div className="px-3 pt-2">
          <SlashAutocomplete
            prefix={value}
            onSelect={(filled) => {
              setValue(filled);
              ref.current?.focus();
            }}
          />
        </div>
      )}

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
          onClick={handlePromptAttach}
          aria-label="Attach file"
          title="Attach file"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Paperclip size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            // Insert a leading slash so the user sees the autocomplete.
            setValue("/");
            ref.current?.focus();
          }}
          aria-label="Insert slash command"
          title="Slash commands"
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

      <div className="flex items-center justify-between gap-2 border-t border-edge-soft px-3 py-1 text-[10px] text-secondary">
        <div className="flex items-center gap-2">
          <EffortControl sessionId={sessionId} />
          <EditAutoToggle sessionId={sessionId} />
          <span>
            Mode: <span className="text-primary">{MODE_LABEL[mode]}</span>
          </span>
        </div>
        <span className="font-mono text-secondary">⌘↵ send · esc cancel</span>
      </div>
    </div>
  );
}
```

### Step 4: Update existing ChatComposer tests

The Composer now requires `attachments` + `onAttachmentsChange` props. Open `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ChatComposer.test.tsx` and update each `render(<ChatComposer ... />)` call to include the new props:

```tsx
render(
  <ChatComposer
    sessionId="s"
    mode="code"
    onSend={vi.fn()}
    attachments={[]}
    onAttachmentsChange={vi.fn()}
  />,
);
```

Add three new test cases at the bottom of the existing `describe("ChatComposer", ...)`:

```tsx
it("typing '/' shows the slash autocomplete dropdown", () => {
  render(
    <ChatComposer
      sessionId="s"
      mode="code"
      onSend={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: /chat input/i });
  fireEvent.change(input, { target: { value: "/" } });
  expect(screen.getByRole("listbox", { name: /Slash command suggestions/i })).toBeTruthy();
});

it("typing past a space hides the slash autocomplete", () => {
  render(
    <ChatComposer
      sessionId="s"
      mode="code"
      onSend={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: /chat input/i });
  fireEvent.change(input, { target: { value: "/edit src/main.tsx" } });
  expect(screen.queryByRole("listbox", { name: /Slash command suggestions/i })).toBeNull();
});

it("attachment chips render above the textarea", () => {
  render(
    <ChatComposer
      sessionId="s"
      mode="code"
      onSend={vi.fn()}
      attachments={["foo.py", "bar.tsx"]}
      onAttachmentsChange={vi.fn()}
    />,
  );
  expect(screen.getByText("foo.py")).toBeTruthy();
  expect(screen.getByText("bar.tsx")).toBeTruthy();
});

it("removing a chip calls onAttachmentsChange with the chip dropped", () => {
  const onAttachmentsChange = vi.fn();
  render(
    <ChatComposer
      sessionId="s"
      mode="code"
      onSend={vi.fn()}
      attachments={["foo.py", "bar.tsx"]}
      onAttachmentsChange={onAttachmentsChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Remove foo.py/i }));
  expect(onAttachmentsChange).toHaveBeenCalledWith(["bar.tsx"]);
});

it("EditAutoToggle is rendered in the foot row", () => {
  render(
    <ChatComposer
      sessionId="s"
      mode="code"
      onSend={vi.fn()}
      attachments={[]}
      onAttachmentsChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("switch")).toBeTruthy();
});
```

### Step 5: Run tests, expect all green

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/ChatComposer.test.tsx \
              src/components/chat/__tests__/EditAutoToggle.test.tsx
```

Expected: existing 5 + 5 new ChatComposer + 3 EditAutoToggle = 13 cases pass.

### Step 6: Run full vitest + typecheck

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

If `ChatThread.tsx` or any other consumer of `<ChatComposer>` fails to typecheck because of the new required props — those will be caught here. ChatThread.tsx is the parent; it needs to thread `attachments` + `onAttachmentsChange` from its own parent (ChatThreadWrapper, Task 9). For now, add stub defaults to ChatThread.tsx so the typecheck passes:

```tsx
// In ChatThread.tsx, change the JSX call to ChatComposer:
<ChatComposer
  sessionId={sessionId}
  mode={mode}
  disabled={pending}
  onSend={onSend}
  attachments={attachments ?? []}
  onAttachmentsChange={onAttachmentsChange ?? (() => undefined)}
/>
```

And add `attachments?: string[]; onAttachmentsChange?: (next: string[]) => void;` to ChatThread's `Props` interface (optional for now; Task 9 makes them required when ChatThreadWrapper supplies them).

### Step 7: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/ChatComposer.tsx \
        dashboard/src/components/chat/EditAutoToggle.tsx \
        dashboard/src/components/chat/ChatThread.tsx \
        dashboard/src/components/chat/__tests__/ChatComposer.test.tsx \
        dashboard/src/components/chat/__tests__/EditAutoToggle.test.tsx
git commit -m "feat(m34): ChatComposer extends with attachments + slash dropdown + edit-auto

Composer now lifts attachment state to its parent (so ChatThreadWrapper
can clear chips after send). Drag-drop a file → chip with file.name;
click paperclip → prompt() for a path. Slash autocomplete shows when
input starts with '/' (no whitespace yet) and selection inserts the
command name + trailing space. EditAutoToggle (3-state switch) lives
next to EffortControl in the foot row, persists per chat in
localStorage:hive:chat:<id>:edit-auto.

ChatThread temporarily accepts attachments/onAttachmentsChange as
optional with stub defaults; Task 9 makes ChatThreadWrapper supply
the real ones."
```

---

## Task 9: Frontend — ChatThreadWrapper integration (the heart of M34)

**Files:**

- Modify: `dashboard/src/components/routes/ChatsRoute.tsx` (rewrite ChatThreadWrapper)
- Modify: `dashboard/src/components/chat/ChatThread.tsx` (require attachments + tighten Props)

This is where everything wires together. ChatThreadWrapper:

1. Holds attachment-chip state (lifted from ChatComposer)
2. Reads effort/model/mode/edit_auto from localStorage on each send (or via the hook readers)
3. Parses each user message via `parseSlashCommand` and dispatches by `kind`
4. For `transform-and-send`, posts the transformed userText with the full settings payload + `@<path>` attachment refs appended

### Step 1: Rewrite ChatThreadWrapper

Open `/home/gnava/repos/honeycomb/dashboard/src/components/routes/ChatsRoute.tsx`. Replace the existing `ChatThreadWrapper` definition with:

```tsx
import { ChatThread } from "../chat/ChatThread";
import type { ChatMode } from "../chat/ModeToggle";
import type { ChatEffort } from "../chat/EffortControl";
import type { ChatModel } from "../chat/ModelChip";
import type { ChatTabInfo } from "../chat/ChatTabStrip";
import type { ChatTurn } from "../chat/types";
import { useChatStream } from "../../hooks/useChatStream";
import { postChatTurn } from "../../lib/api";
import { parseSlashCommand } from "../../lib/slashCommands";
import { useToasts } from "../../hooks/useToasts";
import { readEditAuto } from "../chat/EditAutoToggle";
import { useState } from "react";

// (The plan keeps the existing imports already present in ChatsRoute;
//  these are NEW imports only.)

interface WrapperProps {
  activeNamedSession: NamedSession;
  namedSessions: NamedSession[];
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  onFocusSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
}

function ChatThreadWrapper({
  activeNamedSession,
  namedSessions,
  containers,
  activeContainerId,
  onSelectContainer,
  onFocusSession,
  onCloseSession,
  onNewSession,
}: WrapperProps) {
  const sessionId = activeNamedSession.session_id;
  const { turns, clearTurns } = useChatStream(sessionId);
  const [pending, setPending] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const { toast } = useToasts();

  function readMode(): ChatMode {
    if (typeof window === "undefined") return "code";
    const v = window.localStorage.getItem(`hive:chat:${sessionId}:mode`);
    return v === "review" || v === "plan" ? v : "code";
  }
  function readEffort(): ChatEffort {
    if (typeof window === "undefined") return "standard";
    const v = window.localStorage.getItem(`hive:chat:${sessionId}:effort`);
    return v === "quick" || v === "deep" || v === "max" ? v : "standard";
  }
  function readModel(): ChatModel {
    if (typeof window === "undefined") return "sonnet-4-6";
    const v = window.localStorage.getItem(`hive:chat:${sessionId}:model`);
    return v === "opus-4-7" || v === "haiku-4-5" ? v : "sonnet-4-6";
  }
  function writeMode(next: ChatMode): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`hive:chat:${sessionId}:mode`, next);
  }

  const mode = readMode();

  const tabs: ChatTabInfo[] = namedSessions
    .filter((s) => s.kind === "claude")
    .map((s) => {
      const m =
        (typeof window !== "undefined"
          ? (window.localStorage.getItem(`hive:chat:${s.session_id}:mode`) as ChatMode | null)
          : null) ?? "code";
      return { id: s.session_id, name: s.name, mode: m };
    });

  const sendToHub = async (rawUserText: string): Promise<void> => {
    // Append @<path> references for any attachments
    const attachClause =
      attachments.length > 0 ? `\n\nAttachments: ${attachments.map((a) => `@${a}`).join(" ")}` : "";
    const finalText = `${rawUserText}${attachClause}`;
    setPending(true);
    try {
      await postChatTurn(sessionId, {
        text: finalText,
        effort: readEffort(),
        model: readModel(),
        mode: readMode(),
        edit_auto: readEditAuto(sessionId),
        attachments,
      });
      // Clear the chips after a successful send
      setAttachments([]);
    } finally {
      setPending(false);
    }
  };

  const send = (rawText: string): void => {
    const action = parseSlashCommand(rawText);
    switch (action.kind) {
      case "none":
        void sendToHub(rawText);
        return;
      case "transform-and-send":
        void sendToHub(action.userText);
        return;
      case "set-mode":
        writeMode(action.mode);
        if (action.toast) toast("info", action.toast);
        // Force a re-render by clearing-and-restoring attachments (cheap)
        // — alternative: lift the mode state into ChatThreadWrapper too.
        setAttachments((prev) => [...prev]);
        return;
      case "clear-chat":
        clearTurns();
        return;
      case "toast":
        toast("info", action.text);
        return;
      case "unknown":
        toast("error", action.reason);
        return;
    }
  };

  const retry = (turn: ChatTurn) => {
    clearTurns();
    void sendToHub(turn.text ?? "");
  };

  const fork = (turn: ChatTurn) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        `hive:chat:${sessionId}:pending-fork`,
        JSON.stringify({ at_message: turn.id }),
      );
    }
    onNewSession();
  };

  const edit = (turn: ChatTurn) => {
    const next = window.prompt("Edit your message:", turn.text ?? "");
    if (next === null) return;
    clearTurns();
    void sendToHub(next);
  };

  return (
    <ChatThread
      sessionId={sessionId}
      containers={containers}
      activeContainerId={activeContainerId}
      onSelectContainer={onSelectContainer}
      tabs={tabs}
      activeTabId={sessionId}
      onFocusTab={onFocusSession}
      onCloseTab={onCloseSession}
      onNewTab={onNewSession}
      turns={turns}
      mode={mode}
      pending={pending}
      onSend={send}
      onRetry={retry}
      onFork={fork}
      onEdit={edit}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
    />
  );
}
```

### Step 2: Tighten ChatThread.tsx Props

Make `attachments` + `onAttachmentsChange` REQUIRED in ChatThread now that ChatThreadWrapper supplies them. In `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ChatThread.tsx`:

```tsx
interface Props {
  // ... existing props
  attachments: string[];
  onAttachmentsChange: (next: string[]) => void;
}
```

Remove the `?? []` / `?? (() => undefined)` defaults — they were Task 8's compat shims.

### Step 3: Run typecheck + vitest + Playwright

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
npx playwright test
```

Expected: all green. The vitest tests for ChatThread don't need the new props (no test renders ChatThread directly — it's always via ChatsRoute).

If a Playwright test fails because the chat-stream spec from M33 (`chat-stream.spec.ts`) clicks Send and expects the M33-shaped payload, it'll still work — the mocked `/api/named-sessions/*/turns` route returns 202 regardless of payload shape.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/routes/ChatsRoute.tsx \
        dashboard/src/components/chat/ChatThread.tsx
git commit -m "feat(m34): ChatThreadWrapper dispatches slash commands + sends full settings

ChatThreadWrapper now reads effort/model/mode/edit_auto from
localStorage on each send and posts them as the ChatTurnParams
payload. Slash commands are parsed via parseSlashCommand:
transform-and-send posts the rewritten userText; set-mode flips
mode + optional toast; clear-chat calls clearTurns(); toast
shows the stub messages; unknown shows a red toast.

Attachment chips lift their state into the wrapper. On send,
attachments are appended as @<path> references in the user text
and the chip array is cleared. Hub gets the same paths in the
attachments[] field for forward-compat.

Plan-mode precedence over edit_auto, Review-mode system-prompt
nudge, and Quick effort cost cap all flow through the backend
build_command from Tasks 1-3."
```

---

## Task 10: Playwright spec for M34 composer flows

**Files:**

- Create: `dashboard/tests/e2e/chat-composer.spec.ts`

### Step 1: Create the spec

Create `/home/gnava/repos/honeycomb/dashboard/tests/e2e/chat-composer.spec.ts`:

```ts
/** M34 composer end-to-end.
 *
 * Verifies:
 *   1. Typing '/' shows the slash autocomplete with 8 commands
 *   2. Typing '/clear' + Send clears the chat (no POST)
 *   3. Typing '/plan' + Send flips the mode toggle to Plan (no POST)
 *   4. Typing '/edit foo.py' + Send POSTs with text "Please open foo.py for me to edit."
 *   5. Effort change → next POST carries the new effort field
 *   6. Edit-auto toggle → next POST carries edit_auto: true
 *   7. axe-core scan on the composer in dark + light themes
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "chat-composer-token";

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

// Capture the most recent /turns POST payload for assertion.
let lastTurnPayload: Record<string, unknown> | null = null;

test.beforeEach(async ({ context }) => {
  lastTurnPayload = null;
  await context.addInitScript(() => {
    (window as unknown as { __playwright_test: boolean }).__playwright_test = true;
  });
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
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
  await context.route("**/api/named-sessions/*/turns", async (route) => {
    try {
      const post = route.request().postData();
      if (post) {
        lastTurnPayload = JSON.parse(post) as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: '{"accepted":true,"session_id":"ns-claude-1"}',
    });
  });
});

test("typing '/' shows the slash autocomplete with 8 commands", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/");
  const listbox = page.getByRole("listbox", { name: /Slash command suggestions/i });
  await expect(listbox).toBeVisible();
  const options = await listbox.getByRole("option").all();
  expect(options.length).toBe(8);
});

test("typing '/clear' + Send clears the chat (no POST)", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/clear");
  await page.getByRole("button", { name: /^send$/i }).click();
  // Brief wait to confirm no network call landed
  await page.waitForTimeout(150);
  expect(lastTurnPayload).toBeNull();
});

test("typing '/plan' + Send flips mode toggle to Plan (no POST)", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/plan");
  await page.getByRole("button", { name: /^send$/i }).click();
  await page.waitForTimeout(150);
  expect(lastTurnPayload).toBeNull();
  // Plan radio is now active in the ModeToggle (radiogroup)
  const planRadio = page.getByRole("radio", { name: "Plan" });
  await expect(planRadio).toHaveAttribute("aria-checked", "true");
});

test("typing '/edit foo.py' + Send POSTs the transformed userText", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/edit foo.py");
  await page.getByRole("button", { name: /^send$/i }).click();
  // Wait for the POST to land
  await expect.poll(() => lastTurnPayload).not.toBeNull();
  expect(lastTurnPayload?.text).toBe("Please open foo.py for me to edit.");
});

test("changing Effort + Send carries the new effort in payload", async ({ page }) => {
  await page.goto("/chats");
  // Pick "Max" from the EffortControl
  await page.getByRole("radio", { name: "Max" }).click();
  await page.getByRole("textbox", { name: /chat input/i }).fill("hello");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect.poll(() => lastTurnPayload).not.toBeNull();
  expect(lastTurnPayload?.effort).toBe("max");
});

test("Edit-auto toggle ON + Send carries edit_auto: true", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("switch").click();
  await page.getByRole("textbox", { name: /chat input/i }).fill("hello");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect.poll(() => lastTurnPayload).not.toBeNull();
  expect(lastTurnPayload?.edit_auto).toBe(true);
});

test("composer passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/chats");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  // Open the slash dropdown so it's in the scan
  await page.getByRole("textbox", { name: /chat input/i }).fill("/");
  const results = await new AxeBuilder({ page })
    .include('div:has(> div > textarea[aria-label="Chat input"])')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("composer passes axe-core in light theme", async ({ page }) => {
  await page.goto("/chats");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.getByRole("textbox", { name: /chat input/i }).fill("/");
  const results = await new AxeBuilder({ page })
    .include('div:has(> div > textarea[aria-label="Chat input"])')
    .analyze();
  expect(results.violations).toEqual([]);
});
```

### Step 2: Run, iterate

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test chat-composer.spec.ts
```

Expected: 8/8 PASS. Common iterations:

- **Multi-element collisions** — if a selector resolves to >1 element, scope to a parent: `page.locator("footer-row-selector").getByRole(...)`.
- **The axe-core `include` selector** — the `div:has(> div > textarea...)` may not match cleanly. Alternative: add a `data-testid="chat-composer"` to the outer composer div and use `.include('[data-testid="chat-composer"]')`. **Add the testid to ChatComposer.tsx if needed.**
- **Real axe-core violations** — the new attachment chip + slash dropdown introduce new color combos. If a violation surfaces, fix the chrome class. Don't suppress.

### Step 3: Run the full Playwright suite

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

Expected: 38 (existing) + 8 (new) = 46 / 46 PASS.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/chat-composer.spec.ts
# If ChatComposer.tsx gained a data-testid, also:
# git add dashboard/src/components/chat/ChatComposer.tsx
git commit -m "test(m34): chat-composer playwright spec + axe-core scan

8 cases: slash dropdown shows on '/' input, /clear and /plan are
UI-only (no POST), /edit transforms the userText, Effort + Edit-auto
controls land in the next POST payload, axe-core passes on the
composer surface in dark + light themes.

Captures the actual POST body via context.route to verify the
ChatTurnParams payload shape end-to-end."
```

---

## Task 11: Pre-flight regression sweep + prettier

Same shape as M33 Task 15.

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

Lint warnings should be ≤ M33 baseline (~19). If higher, find what M34 added and fix or accept.

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
git diff --cached --quiet || git commit -m "style(m34): prettier sweep before push"
```

(Note `-- dashboard/` to avoid accidentally staging the gitignored `.claude/settings.json`.)

- [ ] **Step 6: Full pre-commit**

```bash
cd /home/gnava/repos/honeycomb
pre-commit run --all-files
```

Clean.

---

## Task 12: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1: Push the branch**

```bash
cd /home/gnava/repos/honeycomb
git push -u origin m34-composer
```

- [ ] **Step 2: Merge to main with --no-ff**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff m34-composer -m "Merge M34: composer (effort + model + slash commands)"
```

- [ ] **Step 3: Tag**

```bash
git tag -a v0.34-composer \
  -m "M34: composer (effort + model + mode + edit_auto wired through to subprocess args; 8 slash commands; attachment chips; axe-core green)"
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

Expected: all 7 jobs green.

- [ ] **Step 6: Delete the merged branch**

```bash
git branch -d m34-composer
git push origin --delete m34-composer
```

---

## Verification Checklist

Before marking M34 done, confirm:

- [ ] `cd hub && uv run pytest tests -q` — green (existing 410 + ~30 new chat_stream + endpoint tests)
- [ ] `cd dashboard && npx vitest run` — green (existing 243 + ~25 new M34 component + parser tests)
- [ ] `cd dashboard && npx playwright test` — green (38 existing + 8 new chat-composer)
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint` — clean (lint ≤ M33 baseline)
- [ ] `pre-commit run --all-files` — clean
- [ ] **Manual smoke test:**
  - Open the dashboard, focus a kind="claude" session
  - Type `/` → autocomplete dropdown shows 8 commands
  - Type `/clear` + Send → chat clears (no POST)
  - Type `/plan` + Send → ModeToggle flips to Plan
  - Type `/edit foo.py` + Send → assistant turn appears with the transformed prompt
  - Toggle Effort to "Max" + send a real message → check hub logs for `effort=max` and the user text starting with "ultrathink."
  - Toggle Edit-auto on + send → check hub logs for `--permission-mode acceptEdits`
  - Click ModelChip to cycle to Opus 4.7 + send → check hub logs for `--model opus-4-7`
  - Drag a file from the OS file manager onto the composer → chip appears with file.name; send → message text contains `Attachments: @file.name`
- [ ] `git log --oneline main` shows `Merge M34: composer (effort + model + slash commands)` + `v0.34-composer` tag
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green
- [ ] Branch `m34-composer` deleted local + remote

---

## Out of scope — future tickets

- **Real `thinking.budget_tokens` mapping** — when/if the CLI exposes a thinking-budget flag, replace the cost-cap (Quick) + keyword-prefix (Deep/Max) approach with the real budget arg.
- **Slash autocomplete keyboard navigation** — Up/Down/Enter to navigate the dropdown.
- **`/save note` real implementation** — depends on M35 Library artifact store.
- **`/skill <name>` real implementation** — depends on a future Skills milestone.
- **`/review <pr>` PR thread loading** — depends on M35 GitOps integration.
- **File content upload** — M34 sends `@<path>` references; richer attachments (binary content via multipart) are future work.
- **System-prompt persistence on `--resume`** — verify CLI behavior; if the system prompt is set at session-start and ignored on resumed turns, M34's per-turn `--append-system-prompt` for Review mode is a no-op after turn 1. Worth a small follow-up ticket once this is observed in the manual smoke.
- **Mobile composer adaptations** — M36.
