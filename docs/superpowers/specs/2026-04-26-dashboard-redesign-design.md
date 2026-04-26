# Honeycomb Dashboard Redesign — Chat-first Paradigm Pivot

**Status.** Approved 2026-04-26. Spawns a six-milestone arc (M31 → M36)
that incrementally pivots the dashboard from a file/terminal-first
VSCode-bones layout to a chat/skill/workflow-first layout inspired by
the Claude Code VSCode plugin. Each milestone leaves the dashboard
shippable; no broken intermediate state.

## Context

The current dashboard (M0 baseline through M30) was built around the
mental model of a developer who codes in an IDE. Its primary surfaces
— activity rail with file tree, source-control panel, container PTY
sessions, M27 diff event log — all assume "you are editing code, the
terminal is where you do work, the file viewer is what you reach
for." That model has been quietly subverted by the way the user
actually uses the product: every meaningful work session is a
conversation with Claude Code where Claude does the editing, runs
the bash, reads the files, plans the work. The terminal pane is now
mostly used to _watch Claude work_, not to type commands.

The Claude Code VSCode plugin captures the new paradigm cleanly:
conversations are first-class (tabs at the top), tool use is rendered
as inline structured blocks (Bash with IN/OUT, Edit with mini-diff,
Thinking as its own collapsible block), file context appears as
chips on individual messages, and the composer at the bottom is the
single place users actually act. The rest of the IDE chrome that
the plugin lives inside is largely background.

Honeycomb's distinctive value is orchestrating _many_ containers
simultaneously — but that doesn't mean container is the right primary
navigation concept. It means container is the _scope_ of work; chat
is the _content_. The redesign reframes the dashboard accordingly.

The redesign also addresses two unrelated weaknesses of the current
dashboard: there is no real mobile responsive design (below ~480 px
the layout simply cramps), and there is no light theme (everything
is GitHub-dark). Both are folded in.

Codebase is at `v0.27-claude-diff-view` plus the `uvicorn[standard]`
hub fix (commit `69da1dd`). Brainstorm record lives at
`.superpowers/brainstorm/{373089,35071,95298}-*` (seven mockups,
01–07, all approved by the user).

## Vision

Reorient the dashboard around **conversations with Claude Code**:

- **Chat is the primary work surface.** What the user sees first is
  the live conversation, with the composer always reachable.
- **Containers are scope, not navigation root.** A workspace pill in
  the chat chrome shows the current container; ⌘K cycles workspaces.
  No more "click container in sidebar to begin work."
- **Files are secondary, not removed.** A file tree + viewer surface
  remains accessible (rail icon, slash-command from the composer),
  but it is not the daily entry point.
- **Tool use renders as structured blocks** inline in the chat —
  Bash, Edit, Read, Write, Task (subagent), TodoWrite, etc. each
  with its own visual identity. The terminal is the chat.
- **Modes within a chat** — `Code` / `Review` / `Plan` — match how
  Claude Code itself models posture. Plan mode is read-only-and-discuss;
  review mode is a PR thread; code mode is the default.
- **Library accumulates artifacts.** Plans saved on plan-mode commit,
  reviewed PRs, M27 diff-events, code snippets, notes, skills,
  subagent results, specs — eight types in one searchable surface,
  always backlinked to the chat that produced them.
- **Light + dark, both first-class.** Warm Workshop light theme
  (cream + terracotta) gives Honeycomb its own visual identity rather
  than the existing dark-only GitHub-twin look.
- **Mobile is a real product, not a graceful failure.** Three
  breakpoints (≥1024 / 768–1023 / <768) with deliberate behavior
  shifts and a touch-adapted gesture model.

## Goals

- Pivot the daily entry point from container picker → chat thread.
- Adopt the Claude Code VSCode plugin's visual grammar for
  structured tool blocks, thinking, attachments, composer.
- Preserve all existing functionality (M0–M30 features) — files,
  source control, PTY, diff events — but demote them in the spatial
  hierarchy.
- Make the dashboard usable on phone (375 × 667) and tablet
  (768 × 1024) with native-feeling navigation.
- Add a light theme that feels purposefully Honeycomb, not generic.
- Build the **Library** as a new abstraction that turns ephemeral
  conversation outputs into durable, searchable artifacts.

## Non-goals

- Rewriting the hub (Python/FastAPI). The redesign is dashboard-only
  except for: (a) two new WebSocket channels — `chat:<chat_id>` for
  streaming chat events, and (b) one new database table —
  `artifacts` for the Library.
- Replacing the M27 diff-event capture system. Edits in the Library
  are powered by the existing `diff_events` table; the Library just
  presents them as one of eight artifact types.
- Replacing M26 named sessions. A "chat" in the new model maps 1:1
  to a Claude Code session that lives inside a named session of
  kind `claude`. The session abstraction stays.
- Replacing the existing M14 (resizable panels), M16 (sub-tabs), M17
  (filesystem browser), M18 (file viewer), M22+ infrastructure.
  These survive but get repositioned.
- Skill / workflow synthesis from chat patterns. Captured as a
  follow-up ticket; explicitly out of scope for the M31–M36 arc.
- Anthropic-API-key auth or paid plan tier handling. Continues to
  ride on the existing Max plan subscription model.
- Multi-user / collaboration / presence. Single-operator local
  product, same as today.

## Design

Six brainstorm rounds locked the following decisions. Each
sub-section is one round; visual references live in
`.superpowers/brainstorm/95298-1777173712/content/{01..07}-*.html`
(also reachable via the v1 session at `35071-*` for the first four).

### 1. Top-level navigation paradigm — Hybrid (Q1)

Chat-primary with workspace pill in the chrome, ⌘K cycle for
workspace switching.

- **Activity rail** (left, 56 px desktop): Chats, Library, Files,
  Settings.
- **Sidebar** (left of main, 280 px desktop): list of chats scoped
  to the active workspace.
- **Workspace pill** in the chat header: shows current container
  with status dot, click → workspace picker dropdown.
- **Main pane** (rest of width): the chat thread, composer at the
  bottom.
- **⌘K command palette** opens a global jump — workspaces, chats,
  Library artifacts, slash-commands.

Container fleet remains first-class because the workspace pill is
always visible and resource readouts (CPU/MEM/GPU) live in the
header beside it. Burying container behind a chip would have lost
the multi-container awareness that's Honeycomb's reason to exist.

### 2. Activity rail inventory — Layered (Q2)

Four rail entries: **Chats**, **Library**, **Files**, **Settings**.
Reviews and Plans are not separate rail entries — they are _modes_
within a chat thread (composer-foot toggle: `Code · Review · Plan`).

- **Reviews counter on Chats icon.** Reviews waiting on user appear
  as a red badge on the Chats rail icon (e.g., `3` for three open
  PR-review threads needing attention). No separate Reviews tab.
- **Library is a new abstraction.** Artifacts of all eight types
  accumulate in a single searchable surface. Detailed in Q6.
- **Files is on the rail, but secondary.** Defaults to collapsed
  state (sidebar pane closed); user must click Files to open. The
  file tree + viewer (M17/M18) lives here.
- **Settings is bottom-anchored** in the rail (industry pattern).

### 3. Chat thread anatomy — v2 with retry/fork/effort/streaming (Q3)

Mockup `04-chat-anatomy-v2.html` is the locked design.

**Header** (top of the thread):

- Workspace pill (left) — `🟢 gnbio · running · 2% CPU`. Click →
  workspace switcher dropdown.
- Mode toggle (right) — `Code · Review · Plan` segmented control.
  Saved per chat. Composer also shows the current mode label.
- Model chip — `★ Sonnet 4.6` with caret. Click → model picker
  (Opus 4.7 / Sonnet 4.6 / Haiku 4.5). Per-conversation.
- Header actions — History (chat history), Compact (compact-context
  command), overflow menu.

**Tab strip** (below header): each tab is one chat thread in the
active workspace. Tab icon mirrors the chat's mode color
(blue/purple/orange). `+ New` at the right.

**Message types** (the vocabulary that renders in the stream):

| Type                                   | Visual treatment                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User text**                          | Right-aligned bubble, `bg-card`, soft corner. Max 78% width.                                                                                                   |
| **User attachment**                    | File chip _inside_ the user bubble, above the text. Indicates the file is context for that turn.                                                               |
| **Thinking**                           | Orange-tinted block, italic body, collapsible (`expand ▾`). Distinct from any tool block.                                                                      |
| **Tool use — Bash**                    | Header (icon + name + target + status), body with labeled `INPUT` / `OUTPUT` subsections. Monospace.                                                           |
| **Tool use — Edit**                    | Header + compact mini-diff body. Reuses M27's `react-diff-view` styling at thread scale. Inline by default for <20 lines; collapses to stat header for larger. |
| **Tool use — Read**                    | Header + one-line preview of file path + range. Body collapsed by default.                                                                                     |
| **Tool use — Write**                   | Header + first-N-lines preview + "show more".                                                                                                                  |
| **Tool use — Task** (subagent)         | Distinct red-accent card. Shows the prompt + a step pipeline + live spinner. Click → drill into the subagent's own thread.                                     |
| **Tool use — TodoWrite**               | Real checkbox list with state (done/active/pending). Active item glows orange.                                                                                 |
| **Tool use — Read/Grep/Glob/WebFetch** | Each follows the same chassis with a tool-specific body.                                                                                                       |
| **Assistant message**                  | Markdown rendering. `Claude` speaker label in Claude-purple. Inline code chips for symbols.                                                                    |

**Per-tool color identity:**

- Bash → blue (`--accent-tool`)
- Edit / MultiEdit → blue (`--accent-edit`, same hue as bash)
- Read → orange (`--accent-read`)
- Write → green (`--accent-write`)
- Task (subagent) → red (`--accent-task`, signals "heavyweight")
- TodoWrite → blue (`--accent-todo`)
- Thinking → orange (`--accent-think`)

**Per-message hover-action bar** (revealed on hover desktop, tap on
tablet, long-press → bottom sheet on phone):

- **Retry** — re-send this message; the assistant response below is
  replaced.
- **Fork** — create a new chat tab branched from this turn. Inherits
  all turns up to and including this one. Forked chats show a dotted
  "Forked from … at HH:MM" banner between the inherited tail and the
  new turns. Tab strip indicates forks with a small fork-dot.
- **Copy** — copy message text to clipboard.
- **Edit** — edit the user message in place (only on user messages).

**Composer** (bottom of thread):

- Multi-line auto-grow textarea.
- Attachment chips above the input row — files, code references.
- Action icons inline-right: attach (paperclip), slash-commands (`/`),
  send (filled accent button).
- Foot row: **Effort** segmented control (`Quick · Standard · Deep ·
Max`), **Edit auto** toggle, keyboard shortcut hints
  (`⌘↵ send · esc attach selection`).
- **Effort** maps to the upstream Claude API's
  `thinking.budget_tokens`: Quick ≈ 8 k, Standard ≈ 32 k, Deep ≈
  64 k, Max ≈ 200 k. Per-turn (different turns in the same chat can
  use different effort). The "Max" level sends `ultrathink` upstream
  for the deepest reasoning.

**Live streaming** is functional, not just visual:

1. Each chat session spawns `claude --output-format stream-json`
   inside the container, via a new hub-side coroutine.
2. The hub parses the SSE event stream
   (`message_start`, `content_block_start`,
   `content_block_delta`, `content_block_stop`,
   `tool_use_start`, `tool_use_delta`, `message_stop`, `error`).
3. The hub broadcasts each event on the `chat:<chat_id>`
   WebSocket channel using the existing M30 push pattern.
4. The dashboard's `useChatStream` hook (mirror of M30
   `useDiffEvents`) consumes events and grows the message blocks
   in place — pulsing cursor in prose, spinner on the tool, output
   streaming line-by-line.

### 4. Mobile breakpoints — Three real layouts (Q4)

Mockup `05-mobile-breakpoints.html` is the locked design.

| Element                           | Desktop ≥1024            | Tablet 768–1023                 | Phone <768                            |
| --------------------------------- | ------------------------ | ------------------------------- | ------------------------------------- |
| Activity rail                     | 56 px, left edge         | 48 px, left edge                | moves to **bottom tab bar**           |
| Sidebar (chat list)               | 280 px, persistent       | drawer (left swipe / hamburger) | dedicated **list view**               |
| Workspace pill                    | full text + meta         | full text, no meta              | icon-only in header                   |
| Mode toggle                       | 3-segment in header      | 3-segment in header             | chip → tap opens sheet                |
| Effort control                    | 4-segment, composer foot | 4-segment, composer foot        | chip in composer foot                 |
| Tab strip                         | visible                  | visible (scrollable)            | chat title in header + ⌃ to switch    |
| Action bar (retry/fork/copy/edit) | hover-revealed           | tap-revealed                    | **long-press** → bottom action sheet  |
| Composer                          | multi-line, full width   | multi-line, full width          | single-line auto-grow + send (no mic) |
| FAB (+ new chat)                  | n/a (sidebar `+ New`)    | n/a (sidebar `+ New`)           | floating "+" on list view             |

**Phone navigation pattern** (List ↔ Detail):

- **List view**: workspace pill at top, search input, date-grouped
  chat list, FAB for new chat, bottom tab bar (Chats / Library /
  Files / More).
- **Detail view**: header with back-arrow + chat title + mode chip,
  the chat thread, composer at the bottom, **no tab bar** (back
  arrow returns to list).

Native pattern (Slack / Telegram / Linear). The tab bar disappears
in detail view because the chat needs maximum vertical room and the
back-arrow gives a clear return path.

**Touch model:**

- Long-press message → bottom action sheet (Retry / Fork / Copy /
  Edit). Replaces hover bar exactly 1:1.
- Tap mode chip in detail header → mode switcher sheet.
- Tap effort chip in composer foot → 4-button picker sheet.
- Swipe left on list row → archive / delete actions.
- 44 px minimum tap targets throughout (iOS HIG).

**What's cut on phone:**

- Container resource readout (CPU/MEM) — moved behind the workspace
  pill (tap to reveal).
- Multi-line keyboard hint row (⌘↵, esc, ↑↓ history).
- Tab strip → single chat title; switch by going back to list.
- Edit-auto toggle → moves into the ⋯ overflow on the detail header.
- Diff-viewer split mode → unified only on phone (split is
  unreadable below 768).
- No voice-to-text input. Mic icon slot reclaimed.

### 5. Theme system — Warm Workshop light + existing dark (Q5)

Mockup `06-light-theme.html` is the locked design.

**Two themes, one design system.** Same density, same spatial
grammar — only color tokens swap.

**Dark (locked, existing aesthetic)** — palette unchanged from M0+:

```
--bg-page:       #0d1117    --text-primary:   #c9d1d9
--bg-pane:       #161b22    --text-secondary: #8b949e
--bg-main:       #0a0e14    --text-muted:     #6e7681
--bg-card:       #161b22    --text-faint:     #4a5159
--bg-chip:       #1c2128    --accent:         #58a6ff
--border:        #30363d    --accent-claude:  #d2a8ff
--border-soft:   #21262d    --accent-tool:    #79c0ff
                            --accent-think:   #ffa657
                            --accent-write:   #3fb950
                            --accent-task:    #ff7b72
```

**Warm Workshop (light, new):**

```
--bg-page:       #fdfaf3    --text-primary:   #2a241b
--bg-pane:       #f7f1e3    --text-secondary: #6b5d4a
--bg-main:       #fffdf7    --text-muted:     #968773
--bg-card:       #faf5e8    --text-faint:     #c5b9a1
--bg-chip:       #f0e9d6    --accent:         #b8541c   (terracotta — Honeycomb signature)
--border:        #e0d6bf    --accent-claude:  #7c3aed   (purple stays for Claude)
--border-soft:   #ece4d2    --accent-tool:    #0969da
                            --accent-think:   #b8541c
                            --accent-write:   #1f7a36
                            --accent-task:    #be1e1e
```

**Add/remove diff backgrounds** in light:
`--add-bg: #ddf3e0`, `--add-bg-soft: #ecfaee`,
`--rem-bg: #f8d8d4`, `--rem-bg-soft: #fbeae6`.

**Theme switcher:**

- Default: **System** — auto-follow `prefers-color-scheme` media
  query.
- User can override: **Settings → Appearance → System / Dark /
  Light**, with preview swatches.
- ⌘K command palette: `Switch to Light theme` (`⌘⇧L`),
  `Switch to Dark theme` (`⌘⇧D`), `Use System theme` (`⌘⇧S`).
- On phone: **More tab → Appearance → System / Dark / Light**.
- Persists in `localStorage:hive:theme` as `"system" | "light" |
"dark"`.

**Implementation:** CSS custom properties on `<html>` switch by
`data-theme="light"` / `data-theme="dark"` attribute. Tailwind
config maps semantic class names (e.g., `bg-pane`, `text-primary`)
to the CSS vars. No two-class explosion (e.g., no `dark:bg-gray-900`
prefix soup) — the data-attribute on `<html>` flips the entire
palette in one DOM mutation.

### 6. Library — eight types with primary/More overflow (Q6)

Mockup `07-library.html` is the locked design.

**Same dual-pane shape as Chats:** sidebar list (filter chips +
search + artifact cards) on the left of the Library activity, main
pane shows the opened artifact in its native rendering.

**Eight artifact types:**

| Type                | Card icon    | Source                                                                                           | Render in main                        |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **Plan**            | `📋` orange  | Plan-mode chat commit (auto-save on plan-mode end)                                               | Markdown                              |
| **Review**          | `👁` purple  | Review-mode chat on a PR thread                                                                  | PR thread render with inline comments |
| **Edit**            | `✏️` blue    | M27 `diff_events` table — file edits by Claude                                                   | `react-diff-view` (M27 component)     |
| **Snippet**         | `</>` blue   | Auto-tagged standalone code blocks in assistant messages                                         | Code block with copy/download         |
| **Note**            | `🗒` neutral | Free-form Claude-written prose tagged in plan or chat                                            | Markdown                              |
| **Skill**           | `🛠` purple  | (Future) Skills synthesized from chat patterns — placeholder type for v1                         | Skill schema render                   |
| **Subagent result** | `🤝` red     | Output from a Task tool dispatch                                                                 | Subagent's own thread                 |
| **Spec**            | `📄` orange  | Saved design spec from a brainstorm session (matches existing `docs/superpowers/specs/` pattern) | Markdown                              |

**Primary / More overflow chips:**

- The sidebar shows **5 chips** at the top:
  `All` + four **primary** type chips + `⋯ More` chip on the right.
- Default primary types: **Plans, Reviews, Edits, Snippets**.
- Default in More: **Notes, Skills, Subagent results, Specs**.
- Tap `⋯ More` → opens a bottom-sheet (or popover on desktop)
  listing all 8 types with `★` toggle. Toggling `★` swaps a type
  between primary chip row and More overflow.
- Persists per-user in `localStorage:hive:library:primary-types` as
  an ordered list of type IDs.
- The chip row is alphabetically sorted within the primary group.
- Multi-select supported (tap multiple chips → filtered intersection).
- Filter chip count badges update live with the artifact count for
  that type in the active scope.

**Workspace scope:**

- Default: **active workspace only** — the chip row header reads
  `Library · in gnbio · ⌃ all`.
- Tapping `⌃ all` toggles to fleet-wide
  (`Library · across all workspaces`). Toggle persists per-user.
- Cross-workspace artifacts are common in practice (a plan you
  wrote yesterday in another workspace is still relevant), so the
  toggle is one keystroke (`⌃A`) to flip.
- v1 ships with `active-workspace` as the lock-in default; toggle
  state is captured but no power-user defaults are pre-applied.

**Auto-save semantics** (always-on, no "save" dialogs):

- **Plan** — auto-saved when plan-mode is exited (either to code
  mode or by closing the chat). Title taken from the first heading
  in the plan body, or the chat name if none.
- **Review** — auto-saved when a review-mode chat is opened on a
  PR thread. Updated each time the user comments or the PR state
  changes.
- **Edit** — already auto-recorded by M27's diff_events; the
  Library reads from the existing table (no duplicate storage).
- **Snippet** — auto-tagged when a standalone code block (≥3 lines,
  fenced with a language tag) appears in any assistant message.
- **Note** — auto-tagged when Claude writes prose with the marker
  `> NOTE:` or via a `/save note <title>` slash command.
- **Skill** — placeholder type; no auto-source in v1.
- **Subagent result** — auto-saved when a Task tool completes.
- **Spec** — auto-saved when a brainstorm session writes a file
  to `docs/superpowers/specs/`.

To mutate an artifact, **Fork** or **Edit** (re-uses the chat
hover-action bar — same vocabulary). To drop an artifact,
**Delete** (with confirm). No "save" buttons anywhere.

**Backlinks:** every artifact card shows `From: <chat name>` on the
meta line. The detail view has a prominent dashed-bordered
"Open in chat" card at the bottom that scrolls the source chat to
the originating message.

## Architecture

### State management

- **React Context for theme.** A single `ThemeContext` holds the
  resolved theme (`"light"` or `"dark"`) and the user preference
  (`"system" | "light" | "dark"`). The provider listens to
  `prefers-color-scheme` change events and re-resolves when
  preference is `system`.
- **TanStack Query for chat threads, artifacts, sessions.** Mirrors
  the existing M26/M27/M30 patterns. New query keys:
  `["chat", chatId]`, `["chat", chatId, "messages"]`,
  `["library", workspaceId, filterType]`, `["artifact", artifactId]`.
- **WebSocket per channel** via the existing `useHiveWebSocket`
  hook. New channels: `chat:<chat_id>` (M33 chat stream),
  `library:<workspace_id>` (M35 artifact updates).
- **LocalStorage** for: theme choice (`hive:theme`), Library
  primary-type chip set (`hive:library:primary-types`),
  workspace-scope toggle (`hive:library:scope`), active workspace
  (`hive:active-workspace`), composer effort default per chat
  (`hive:chat:<id>:effort`), composer model per chat
  (`hive:chat:<id>:model`).

### Theme tokens

CSS custom properties on `<html data-theme="dark|light">`. Tailwind
v4 config maps semantic utility classes (e.g., `bg-pane`,
`text-primary`, `border-soft`) to CSS vars. No `dark:` class prefix
soup — one DOM mutation flips the whole palette. Implementation:

```css
:root {
  --bg-page: #0d1117;
  /* ... full dark palette ... */
}

[data-theme="light"] {
  --bg-page: #fdfaf3;
  /* ... full warm palette ... */
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --bg-page: #fdfaf3;
    /* ... full warm palette ... */
  }
}
```

The `:not([data-theme])` qualifier ensures user overrides win over
system preference. When user picks "System" we _clear_ the
`data-theme` attribute, letting the media query take effect.

### Chat stream wire format

The hub spawns `claude --output-format stream-json` per active
chat session. Stream events are parsed and broadcast on the
`chat:<chat_id>` WebSocket channel. Frame shape (mirrors Claude
Code's stream-json with extensions for our channel envelope):

```json
{
  "channel": "chat:abc123",
  "event": "content_block_delta",
  "data": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "Found it." },
    "message_id": "msg_xyz",
    "ts": "2026-04-26T07:38:00.123Z"
  }
}
```

Event types the dashboard handles:

| Event                 | Renderer behavior                                                                  |
| --------------------- | ---------------------------------------------------------------------------------- |
| `message_start`       | Append a new message block; mark it streaming.                                     |
| `content_block_start` | Append a sub-block (text, tool_use, thinking) inside the message.                  |
| `content_block_delta` | Append delta text/json to the active sub-block; trigger re-render.                 |
| `content_block_stop`  | Mark the sub-block complete; remove streaming cursor.                              |
| `tool_use_start`      | Render the tool block with header + spinner.                                       |
| `tool_use_delta`      | Append output to the tool block body.                                              |
| `tool_use_end`        | Mark the tool complete; render duration + status.                                  |
| `message_stop`        | Mark the message complete; auto-scroll to bottom.                                  |
| `error`               | Render an error banner at the bottom of the message; preserve any partial content. |

Implementation lives in:

- Hub: new `hub/services/chat_stream.py` (parser + broadcaster)
- Hub: extend `hub/routers/agent.py` to spawn `claude` subprocess
  per chat, pipe its stdout to the parser
- Hub: new `chat:<chat_id>` channel registered with the existing
  `ConnectionManager`
- Dashboard: new `useChatStream(chatId)` hook
- Dashboard: new `ChatStreamMessage` component family

### Library artifact schema

New `artifacts` table (Alembic migration):

```sql
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT UNIQUE NOT NULL,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'plan','review','edit','snippet','note','skill','subagent','spec'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,                  -- markdown / json depending on type
  body_format TEXT NOT NULL DEFAULT 'markdown',
  source_chat_id TEXT,                 -- which chat produced it
  source_message_id TEXT,              -- which turn within the chat
  metadata TEXT,                       -- JSON blob for type-specific extras
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_artifacts_container_created
  ON artifacts (container_id, archived, created_at DESC);
CREATE INDEX ix_artifacts_type
  ON artifacts (container_id, type, archived, created_at DESC);
CREATE INDEX ix_artifacts_source_chat
  ON artifacts (source_chat_id, created_at DESC);
```

**Type-specific metadata (in `metadata` JSON column):**

| Type       | Metadata fields                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- | --------- | ---------- | --------- |
| `plan`     | `mode_at_save: "plan"`, `headings: [string]`                                                   |
| `review`   | `pr_repo: string`, `pr_number: int`, `status: "open"                                           | "changes" | "approved" | "merged"` |
| `edit`     | `paths: [string]`, `lines_added: int`, `lines_removed: int`, references `diff_events.event_id` |
| `snippet`  | `language: string`, `line_count: int`                                                          |
| `note`     | (none beyond title + body)                                                                     |
| `skill`    | `skill_name: string` (placeholder for future synthesis)                                        |
| `subagent` | `agent_type: string`, `parent_chat_id: string`, `result_summary: string`                       |
| `spec`     | `file_path: string` (relative to repo root), `headings: [string]`                              |

Read-only Library REST endpoints (mirrors M26 named-sessions
shape):

- `GET /api/containers/{id}/artifacts?type=…&search=…` →
  `list[Artifact]`
- `GET /api/artifacts/{artifact_id}` → `Artifact`
- `POST /api/artifacts/{artifact_id}/pin` / `/unpin` / `/archive` /
  `/delete`

Auto-save sources (per-type recording paths):

- **Plan** — listener on the `chat:<chat_id>` stream; when mode
  flips from `plan` → `code` (or chat closes), the planning content
  is extracted and inserted as `artifact_id = uuid4().hex` with
  `type = "plan"`.
- **Edit** — read-only view over the existing `diff_events` table.
  No new write path; the Library router translates `diff_events`
  rows into `Artifact` JSON at read time. (No duplicate storage.)
- **Snippet** — listener on assistant `text` blocks; standalone
  fenced code blocks (≥3 lines, with a language tag, not inside a
  tool_use) are auto-saved as `type = "snippet"`.
- **Subagent result** — listener on `tool_use_end` events for
  `Task` tool; the result body is saved as `type = "subagent"`.
- **Spec** — file-system watcher on `docs/superpowers/specs/*.md`;
  new files generate `type = "spec"` artifacts.
- **Review** — auto-saved when review-mode chat is opened on a
  PR; updated on every comment/state-change.
- **Note** — `> NOTE:` marker in assistant text OR `/save note
  <title>` slash command.
- **Skill** — no auto-source in v1; placeholder type.

Live updates broadcast on `library:<container_id>` channel
(M30-style push, `event: "new" | "updated" | "deleted"`,
`data: Artifact | { artifact_id }`).

### Per-type renderer registry (Library main pane)

Component dispatch by `artifact.type`:

```ts
const RENDERERS: Record<ArtifactType, FC<{ artifact: Artifact }>> = {
  plan: PlanRenderer, // markdown
  review: ReviewRenderer, // PR thread reuses M14 GitOps panel components
  edit: EditRenderer, // react-diff-view (M27 component)
  snippet: SnippetRenderer, // code block with copy/download
  note: NoteRenderer, // markdown (lighter than plan)
  skill: SkillRenderer, // skill schema (frontmatter + markdown body)
  subagent: SubagentRenderer, // mini chat thread (subagent's own conversation)
  spec: SpecRenderer, // markdown with TOC sidebar
};
```

Each renderer is responsible for its own actions (e.g., `Edit`
renderer offers "Open file" and "Copy patch" buttons matching M27;
`Plan` renderer offers "Export .md" and "Open in chat").

## Milestone decomposition

Six milestones, sequenced so each leaves the dashboard shippable
and each subsequent milestone has its dependencies in place.

### M31 — Design system foundation

**Goal.** Establish the platform every later milestone reads from.
No visual changes; pure infrastructure.

**Scope:**

- Tailwind v4 theme config: semantic class names mapping to CSS
  custom properties (`bg-page`, `bg-pane`, `bg-main`, `bg-card`,
  `bg-chip`, `text-primary`, `text-secondary`, `text-muted`,
  `text-faint`, `border`, `border-soft`, `accent`, `accent-claude`,
  `accent-tool`, `accent-think`, `accent-write`, `accent-task`,
  `accent-edit`, `accent-read`, `accent-plan`, `accent-review`,
  plus `add-bg`, `add-bg-soft`, `rem-bg`, `rem-bg-soft`).
- CSS custom property declarations in `dashboard/src/index.css` for
  both `[data-theme="dark"]` (existing palette) and
  `[data-theme="light"]` (new Warm Workshop palette), plus the
  `prefers-color-scheme` fallback.
- Typography scale: `text-display`, `text-title`, `text-heading`,
  `text-body`, `text-meta`, `text-mono` — each maps to size + weight
  - line-height tokens.
- Spacing scale: 0/0.5/1/1.5/2/3/4/6/8/12/16 (Tailwind defaults
  with project-specific extensions).
- Radius tokens: `radius-xs` (3 px), `radius-sm` (5 px), `radius`
  (7 px), `radius-md` (10 px), `radius-lg` (12 px),
  `radius-pill` (999 px).
- Shadow tokens: `shadow-soft`, `shadow-medium`, `shadow-deep`,
  `shadow-pop` (each tuned for both themes).
- **`ThemeProvider`** + **`useTheme`** in
  `dashboard/src/lib/theme.ts` — wraps the app, resolves
  preference vs system, listens to `prefers-color-scheme` change.
- **Settings → Appearance** section with three radio rows (System /
  Dark / Light) and preview swatches.
- **⌘K commands** for theme switching (`⌘⇧L`, `⌘⇧D`, `⌘⇧S`).

**Estimated commits:** ~10 (token defs, ThemeProvider, settings UI,
⌘K wiring, tests).

**Files touched:**

- `dashboard/src/index.css` — token declarations
- `dashboard/tailwind.config.ts` — semantic class mapping
- `dashboard/src/lib/theme.ts` — provider + hook
- `dashboard/src/main.tsx` — wrap with ThemeProvider
- `dashboard/src/components/SettingsView.tsx` — Appearance section
- `dashboard/src/components/CommandPalette.tsx` — register theme commands
- `dashboard/src/hooks/__tests__/useTheme.test.tsx` — tests
- `dashboard/src/components/__tests__/SettingsAppearance.test.tsx` — tests

**Success criteria:**

- `useTheme()` returns the resolved theme; flipping it via Settings
  or ⌘K instantly recolors the entire dashboard.
- `prefers-color-scheme` change in the OS triggers re-resolution
  when preference is `system`.
- All existing components render unchanged in dark mode (regression
  test: visual diff of every existing Playwright spec).
- Light mode renders without contrast violations (axe-core
  accessibility scan in CI).

### M32 — Layout shell

**Goal.** Replace the current activity rail and primary sidebar
with the new four-entry rail (Chats / Library / Files / Settings),
add the workspace pill in the chat chrome, wire the ⌘K command
palette globally.

**Scope:**

- Rebuild `ActivityBar.tsx` with the new four entries and the
  Reviews counter on Chats. Settings bottom-anchored.
- New `WorkspacePill` component (header chrome). Click → workspace
  picker dropdown (lists all containers with status dot, click to
  switch active workspace).
- `App.tsx` restructured: rail → sidebar (route-dependent) → main
  pane (route-dependent). React Router for the four top-level
  routes (`/chats`, `/library`, `/files`, `/settings`).
- ⌘K palette becomes global — not just current container scope.
  Indexed sources: workspaces, recent chats, Library artifacts,
  slash-commands, theme-switcher commands, "Show settings", etc.
- Existing M14/M17/M18 panes survive but live behind `/files` route
  with the rail icon. M27 DiffEventsActivity becomes a Library
  filter (its data lives in the same `diff_events` table; the
  Library main pane reuses M27's `DiffViewerTab`).
- Keyboard shortcuts:
  `⌘1` → Chats, `⌘2` → Library, `⌘3` → Files, `⌘,` → Settings.
- Demote the existing Resource Monitor from a sidebar pane to a
  popover triggered from the Workspace pill (M13 pattern).

**Estimated commits:** ~8 (rail, pill, app shell, route wiring,
palette extension, popover migration, tests).

**Files touched:**

- `dashboard/src/components/ActivityBar.tsx` — rebuild
- `dashboard/src/components/WorkspacePill.tsx` — new
- `dashboard/src/components/WorkspacePicker.tsx` — new
- `dashboard/src/App.tsx` — route shell rewrite
- `dashboard/src/components/CommandPalette.tsx` — global indexing
- `dashboard/src/components/ResourceMonitorPopover.tsx` — new (extracted from existing)
- `dashboard/src/lib/routes.ts` — route + shortcut tables
- Tests for each new component

**Success criteria:**

- Existing chats keep working in the new shell (no data loss).
- Workspace switcher cycles correctly via click + ⌘K.
- All four top-level rail entries route to existing or stub pages
  (Chats stub renders the existing M26 named-sessions UI as a
  bridge; full chat surface arrives in M33).
- Reviews counter on Chats icon updates from a live source (initial
  source: count of M14 GitOps "open PR" rows; refined in M35 once
  Library captures Review artifacts).

### M33 — Chat surface — anatomy + streaming

**Goal.** The headline milestone. Replace the current PTY-pane
chat surface with the new structured chat thread, wired to live
`stream-json` from Claude Code.

**Scope:**

- New `ChatThread` component family:
  `ChatThread`, `ChatHeader`, `ChatTabStrip`, `ChatStream`,
  `ChatComposer`.
- Message components per type: `MessageUser`, `MessageThinking`,
  `MessageAssistantText`, `MessageToolBash`, `MessageToolEdit`,
  `MessageToolRead`, `MessageToolWrite`, `MessageToolTask`,
  `MessageToolTodo`, `MessageToolGeneric` (fallback).
- Per-tool color tokens (`accent-tool`, `accent-edit`, etc. — already
  in M31).
- Hover-action bar: Retry, Fork, Copy, Edit. Fork creates a new
  chat tab branched from the message.
- Mode toggle in header: `Code · Review · Plan`. Mode persists per
  chat in `localStorage:hive:chat:<id>:mode`.
- **Hub work:** new `hub/services/chat_stream.py` that spawns
  `claude --output-format stream-json` per chat, parses events,
  broadcasts on `chat:<chat_id>` channel.
- **Hub work:** extend `hub/routers/named_sessions.py` to spawn the
  Claude process when a session of `kind="claude"` is opened in
  chat-stream mode.
- Dashboard: `useChatStream(chatId)` hook that subscribes to the
  channel and renders incremental updates.
- The existing PTY view (xterm.js) is preserved as a _fallback_ —
  for `kind="shell"` named sessions, it still renders the raw
  terminal. Only `kind="claude"` sessions render the new chat
  surface.
- Reuses M27's `react-diff-view` setup for `MessageToolEdit` mini-
  diffs — no new diff rendering library.

**Estimated commits:** ~14 (the family of components + hub
services + tests + visual QA against the brainstorm mockup).

**Files touched:**

- `dashboard/src/components/chat/` — new directory, all components
- `dashboard/src/hooks/useChatStream.ts` — new
- `hub/services/chat_stream.py` — new
- `hub/routers/named_sessions.py` — extend with Claude spawn logic
- `hub/models/chat_events.py` — new Pydantic models for stream events
- `hub/tests/test_chat_stream_service.py` — new
- `hub/tests/test_chat_stream_endpoint.py` — new
- `dashboard/src/components/chat/__tests__/*.test.tsx` — comprehensive
- `dashboard/tests/e2e/chat-stream.spec.ts` — Playwright happy path

**Success criteria:**

- Sending a message in a `kind="claude"` chat results in live
  streaming visible in the dashboard (cursor + spinner + growing
  output as the stream-json arrives).
- All eight tool types render with their distinct color + body shape.
- Retry, Fork, Copy, Edit all work end-to-end.
- Mode toggle persists per chat; mode-specific behavior (e.g.,
  Plan mode = read-only Claude posture) is wired in M34.

### M34 — Composer — effort, model, slash commands

**Goal.** The composer becomes a real input surface — not just a
text area but the place users compose with mode + effort + model +
slash commands + attachments.

**Scope:**

- Effort segmented control in composer foot: `Quick · Standard ·
Deep · Max`. Maps to `thinking.budget_tokens` upstream.
- Model chip in header: `Opus 4.7 · Sonnet 4.6 · Haiku 4.5`.
  Click → picker. Per-conversation. The Opus 4.7 1M-context variant
  is selectable when the upstream max-context flag is set.
- Slash command grammar in the composer:
  `/edit <path>` opens an inline editor for `<path>`;
  `/git <subcmd>` executes git via Bash tool;
  `/plan` switches the chat to plan mode;
  `/review <pr>` switches to review mode and loads a PR thread;
  `/save note <title>` auto-saves the prior assistant message as a
  note artifact;
  `/skill <name>` (placeholder) invokes a saved skill;
  `/clear` clears the chat context;
  `/compact` triggers the upstream `/compact` to reduce token usage.
- File attachment chips above the composer input. Drag-and-drop or
  click attach icon to add files from the active workspace.
- "Edit auto" toggle (Edit-tool calls auto-execute vs require user
  confirmation per call).
- Keyboard shortcut hints in foot row: `⌘↵ send`,
  `esc attach selection`, `↑↓ history`.
- **Hub work:** wire `thinking.budget_tokens` into the
  `claude --output-format stream-json` invocation.
- **Hub work:** wire `--model opus-4-7|sonnet-4-6|haiku-4-5` flag.
- **Slash commands** are parsed dashboard-side; the dispatched
  action either (a) sends a transformed prompt to Claude (e.g.,
  `/edit foo.py` → `Please open foo.py for me to edit`), or
  (b) triggers a dashboard-only state change (e.g., `/plan` flips
  the mode toggle).

**Estimated commits:** ~6 (effort UI, model chip, slash grammar,
attachment UI, hub flag plumbing, tests).

**Files touched:**

- `dashboard/src/components/chat/ChatComposer.tsx` — extend
- `dashboard/src/components/chat/EffortSegmented.tsx` — new
- `dashboard/src/components/chat/ModelChip.tsx` — new
- `dashboard/src/lib/slashCommands.ts` — new
- `dashboard/src/components/chat/AttachmentChip.tsx` — new
- `hub/services/chat_stream.py` — extend with effort + model args
- `dashboard/src/components/chat/__tests__/*.test.tsx`

**Success criteria:**

- Effort changes between turns affect the actual upstream
  `thinking.budget_tokens` (verifiable in hub logs).
- Model picker switches the upstream model per conversation.
- All eight slash commands work end-to-end.
- File attachments are sent as context with the user message.

### M35 — Library — artifact aggregation

**Goal.** Build the Library: a new abstraction that aggregates
artifacts from all eight types into one searchable, browsable surface.

**Scope:**

- New `artifacts` table (Alembic migration) per the schema above.
- New `hub/services/artifacts.py` with `record_artifact` (create) +
  `list_artifacts` (with type/scope filter) + `get_artifact` +
  `pin/unpin/archive/delete` mutations.
- New `hub/routers/artifacts.py` with the REST endpoints listed
  above.
- Auto-save sources:
  - **Plan**: hook in `chat_stream.py` parser — detect mode
    transition → write artifact.
  - **Snippet**: hook in `chat_stream.py` parser — detect standalone
    code block ≥3 lines with language tag.
  - **Subagent**: hook on `Task` tool_use_end.
  - **Note**: hook on `> NOTE:` marker or `/save note` slash command.
  - **Spec**: file-system watcher on
    `docs/superpowers/specs/*.md`.
  - **Edit**: read-only translation from existing `diff_events`
    table (no new write path; the Library router synthesizes
    `Artifact` JSON at read time).
  - **Review**: hook on review-mode chat open.
  - **Skill**: placeholder; no auto-source in v1.
- Dashboard: `LibraryActivity` component (sidebar + main detail).
- Per-type renderers: `PlanRenderer`, `ReviewRenderer`,
  `EditRenderer` (reuses M27 `DiffViewerTab`), `SnippetRenderer`,
  `NoteRenderer`, `SkillRenderer`, `SubagentRenderer`,
  `SpecRenderer`.
- Filter chip row with primary/More overflow + customization sheet.
- Search input (full-text across title + body).
- Workspace scope toggle (default active-workspace, ⌃A toggles
  fleet-wide).
- Backlink to source chat from each artifact's main-pane header.
- Live updates via `library:<container_id>` WebSocket channel
  (M30-style push).

**Estimated commits:** ~12 (migration + service + router + auto-save
hooks + 8 renderers + sidebar + tests).

**Files touched:**

- `hub/db/migrations/versions/2026_xx_xx-m35_artifacts.py` — new
- `hub/db/schema.py` — add `artifacts` Table
- `hub/services/artifacts.py` — new
- `hub/routers/artifacts.py` — new
- `hub/main.py` — register router
- `hub/models/schemas.py` — add `Artifact` Pydantic model
- `hub/services/chat_stream.py` — extend with auto-save hooks
- `dashboard/src/components/library/` — new directory
- `dashboard/src/components/library/LibraryActivity.tsx` — sidebar + main shell
- `dashboard/src/components/library/renderers/{Plan,Review,Edit,Snippet,Note,Skill,Subagent,Spec}Renderer.tsx`
- `dashboard/src/components/library/FilterChips.tsx`
- `dashboard/src/components/library/MoreCustomizationSheet.tsx`
- `dashboard/src/hooks/useArtifacts.ts` — new
- `dashboard/src/lib/types.ts` — add `Artifact`, `ArtifactType`
- `dashboard/src/lib/api.ts` — add Library API wrappers
- Tests for service, router, hook, sidebar, each renderer

**Success criteria:**

- All eight artifact types visible in the Library with correct icons,
  filtering, and per-type rendering.
- Auto-save fires correctly on each source event (verifiable by
  triggering the source action and observing the artifact appear in
  the sidebar within ~1 s via the WS push).
- Backlinks open the source chat at the originating message.
- Primary/More chip customization persists per-user across reloads.

### M36 — Mobile + responsive breakpoints

**Goal.** The dashboard becomes usable on phone (375 × 667) and
tablet (768 × 1024) with native-feeling navigation.

**Scope:**

- Three breakpoint utility classes: `desktop:` (≥1024), `tablet:`
  (768–1023), `phone:` (<768). Tailwind v4 custom screen config.
- **Phone bottom tab bar** replaces the activity rail
  (Chats / Library / Files / More). Slides up only in list views;
  hidden in detail views.
- **Phone list view** for chats — workspace pill at top, search,
  date-grouped rows, FAB for new chat.
- **Phone detail view** for chats — back-arrow header + chat title
  - mode chip + composer + chat thread. No tab bar.
- **Tablet sidebar** as a slide-in drawer (hamburger trigger). Rail
  visible at 48 px (slightly narrower than desktop's 56 px).
- **Workspace pill** collapses to icon-only on phone.
- **Mode toggle** collapses to a chip → tap opens bottom sheet on
  phone.
- **Effort control** collapses to a chip in composer foot → tap
  opens 4-button picker sheet on phone.
- **Long-press** on any message → bottom action sheet (Retry / Fork
  / Copy / Edit). Replaces hover bar 1:1.
- **Swipe-left** on a chat list row → archive / delete actions.
- **Composer** on phone: single-line auto-grow + send button (no
  mic, no attachment chip row by default — paperclip icon opens
  sheet to attach).
- **Diff viewer** forces unified mode on phone (split unreadable
  below 768 px).
- All buttons / tap targets minimum 44 px (iOS HIG).
- Responsive Library mirrors the chat pattern: list view on phone,
  detail view replaces it on tap.

**Estimated commits:** ~7 (breakpoint utility config, phone tab bar,
phone list/detail components, tablet drawer, action sheet, tests).

**Files touched:**

- `dashboard/tailwind.config.ts` — custom screens
- `dashboard/src/components/PhoneTabBar.tsx` — new
- `dashboard/src/components/Sheet.tsx` — new (bottom-sheet primitive)
- `dashboard/src/components/chat/MessageActionSheet.tsx` — long-press
- `dashboard/src/components/chat/ModeToggleSheet.tsx` — phone variant
- `dashboard/src/components/chat/EffortPickerSheet.tsx` — phone variant
- `dashboard/src/components/PhoneChatList.tsx` — phone list
- `dashboard/src/components/PhoneChatDetail.tsx` — phone detail
- `dashboard/src/components/TabletSidebarDrawer.tsx` — drawer
- `dashboard/tests/e2e/mobile-chat.spec.ts` — Playwright at 375×667
- `dashboard/tests/e2e/tablet-chat.spec.ts` — Playwright at 768×1024

**Success criteria:**

- All three breakpoints render correctly with the deliberate
  behavior shifts described above.
- Touch model works in Chrome devtools mobile emulation
  (long-press, swipe-left, tap chips).
- 44 px minimum tap-target audit passes.
- Existing desktop layout regresses zero functionality.

## Critical files

By milestone:

**M31:**

- [dashboard/src/index.css](../../../dashboard/src/index.css) — token declarations
- [dashboard/tailwind.config.ts](../../../dashboard/tailwind.config.ts) — semantic class mapping
- [dashboard/src/lib/theme.ts](../../../dashboard/src/lib/) — new
- [dashboard/src/components/SettingsView.tsx](../../../dashboard/src/components/SettingsView.tsx) — Appearance section
- [dashboard/src/components/CommandPalette.tsx](../../../dashboard/src/components/CommandPalette.tsx) — theme commands

**M32:**

- [dashboard/src/components/ActivityBar.tsx](../../../dashboard/src/components/ActivityBar.tsx) — rebuild
- [dashboard/src/components/WorkspacePill.tsx](../../../dashboard/src/components/) — new
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — shell rewrite
- [dashboard/src/components/CommandPalette.tsx](../../../dashboard/src/components/CommandPalette.tsx) — global indexing

**M33:**

- [dashboard/src/components/chat/](../../../dashboard/src/components/) — new directory family
- [dashboard/src/hooks/useChatStream.ts](../../../dashboard/src/hooks/) — new
- [hub/services/chat_stream.py](../../../hub/services/) — new
- [hub/routers/named_sessions.py](../../../hub/routers/named_sessions.py) — extend

**M34:**

- [dashboard/src/components/chat/ChatComposer.tsx](../../../dashboard/src/components/) — extend
- [dashboard/src/lib/slashCommands.ts](../../../dashboard/src/lib/) — new
- [hub/services/chat_stream.py](../../../hub/services/) — extend with effort + model args

**M35:**

- [hub/db/migrations/versions/](../../../hub/db/migrations/versions/) — `m35_artifacts.py`
- [hub/services/artifacts.py](../../../hub/services/) — new
- [hub/routers/artifacts.py](../../../hub/routers/) — new
- [dashboard/src/components/library/](../../../dashboard/src/components/) — new directory family

**M36:**

- [dashboard/tailwind.config.ts](../../../dashboard/tailwind.config.ts) — custom screens
- [dashboard/src/components/Phone\*.tsx, Sheet.tsx](../../../dashboard/src/components/) — new family

## Verification approach

**Per milestone** — same shape as M20–M30:

1. `pre-commit run --all-files` clean
2. `cd hub && uv run ruff check . && uv run mypy . && uv run pytest tests -q` green
3. `cd hive-agent && uv run ruff check . && uv run mypy . && uv run pytest tests -q` green
4. `cd dashboard && npx tsc -b --noEmit && npm run lint && npx vitest run` green
5. `cd dashboard && npx playwright test` green (per-milestone specs land with the milestone)
6. `cd dashboard && npx prettier --write .` before push (hook-vs-CI drift memory)
7. Manual smoke matching the relevant brainstorm mockup
8. Branch merged `--no-ff` to `main`; tagged `v0.<N>-<slug>`;
   `git push --follow-tags`; CI watched; branch deleted

**Per spec** (across all six milestones): visual QA against the
brainstorm mockups in
`.superpowers/brainstorm/95298-1777173712/content/`. Every
milestone's UI work must visually match the corresponding mockup
within ±5% spacing tolerance and identical color tokens. Light-mode
contrast audited via `axe-core` in CI.

**Backwards-compatibility:** existing M0–M30 features continue to
work after each milestone merges. PTY shell sessions, M14 split
editor, M17 file tree, M18 file viewer, M27 diff events, M28 session
reorder, M30 sessions WS push — all survive the redesign because they
get repositioned (often to the `/files` route or the Library), not
removed.

**Migration UX:** the first time a user loads a redesigned dashboard
build, a one-time toast / modal explains the new layout
("Conversations are now first-class — your existing sessions are at
Files → Sessions, your diffs are at Library → Edits"). Dismissible.
LocalStorage flag prevents re-show.

## Follow-up tickets

These are explicitly out of scope for the M31–M36 arc; captured here
so they don't get lost.

- **Library — skill / workflow synthesis from chat patterns.** The
  highest-value future feature. Recognize repeated patterns across
  chats (e.g., "every time you start a new feature you do
  brainstorm → spec → plan → execute via subagent-driven development")
  and offer to crystallize them as reusable skills you can invoke
  from `/skill <name>`. Components needed: pattern-detection over
  the `artifacts` + chat-history corpus, skill-extraction (probably
  via a meta-Claude call with structured output), skill scaffolding
  (writes a SKILL.md with frontmatter + body to `~/.claude/skills/`
  or to a Library `skill` artifact), `/skill <name>` invocation
  binding. Likely a 4–6 milestone arc on its own.
- **Library — fleet-wide scope as a power-user default.** v1 ships
  with active-workspace as the lock-in default; some users may want
  fleet-wide as their everyday view. Add a Settings preference once
  there's enough usage data to know what's right.
- **Library — `⋯ More` chip drag-reorder.** v1 uses a customization
  sheet with `★` toggles to swap types between primary and overflow.
  v2 could add drag-and-drop reordering of the primary chip row
  itself.
- **Composer — voice input.** Originally cut from M36's mobile
  scope; could come back if there's demand. Browser
  `SpeechRecognition` API; mic icon slot in the phone composer.
- **Cross-workspace search.** ⌘K finds chats and artifacts across
  all workspaces; this is a small extension once M32 lands.
- **Theme — high-contrast mode** and additional themes (Solarized,
  Dracula, etc.) for users with specific preferences. Easy once
  M31's token system is in place — just one more `[data-theme="…"]`
  block per palette.
- **Mobile — Playwright tests at additional viewports** (iPad Pro,
  small phones, Android folding devices).

## References

- Visual mockups (locked):

  - `01-nav-paradigm.html` — Q1 nav paradigm options (chose C)
  - `02-rail-inventory.html` — Q2 rail options (chose C)
  - `03-chat-anatomy.html` — Q3 chat anatomy v1
  - `04-chat-anatomy-v2.html` — Q3 final with retry/fork/effort/streaming
  - `05-mobile-breakpoints.html` — Q4 mobile design
  - `06-light-theme.html` — Q5 light theme (chose B Warm Workshop)
  - `07-library.html` — Q6 Library design

  All under `.superpowers/brainstorm/95298-1777173712/content/`.

- Reference application: Anthropic Claude Code VSCode plugin (user-
  supplied screenshot in conversation, 2026-04-26). The visual
  grammar — conversations as tabs, structured tool blocks with
  IN/OUT, file context as chips, composer with attachments + edit-
  automatically toggle — is deliberately echoed throughout the
  redesign.
- Adjacent inspirations cited during brainstorm: Claude.ai web app
  (composer model picker, message hover actions), Linear (sidebar +
  detail dual-pane, command palette), Slack (List ↔ Detail mobile
  pattern, workspace switcher), Notion (Library artifact concept),
  GitHub Light theme (palette A reference for the Cool Editorial
  variant we did not pick).
