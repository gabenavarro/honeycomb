# M22 — UX refinements, split sessions, notification center

**Status.** Approved 2026-04-18. Next-up milestone after `v0.21-polish-batch`.

## Context

After `v0.2.0` shipped, the user did a second pass through the dashboard
and flagged four concrete issues plus a prompt for my own suggestions:

1. **Folder-tree sort + interaction model.** Entries are alphabetical,
   but folders and files are mixed. The chevron both toggles and
   navigates, collapsing two behaviors into one click.
2. **Left sidebar polish.** The Files activity shows a duplicate
   `FILES` header; the activity rail doesn't respond to a double-click
   collapse gesture; collapse/expand isn't animated.
3. **Notices.** The yellow "unreachable" banner sticks around across
   reconnects. Toasts should be shorter-lived but recorded in a bell/
   popover history users can open on demand.
4. **Terminal split-drag.** Session sub-tabs can be reordered (M21 D)
   but can't be dropped onto another half of the editor to create a
   side-by-side split.

The user approved three design decisions up-front (split-drag scoped
to a single container's sessions, bell + popover history, replace
banner with one-shot toast), and approved all six of my proposed
follow-ups α–ζ with the caveat that we tackle them as separate
milestones. This document is the roadmap for M22 (the four numbered
items) and the brief for M23–M26 (the α–ζ follow-ups).

The codebase is at v0.21-polish-batch: React 19 / Vite 8 / Tailwind v4
/ Radix / cmdk / react-resizable-panels / xterm.js. FastAPI hub at 0.2.0
with the filesystem + sessions + problems routes shipped. See
[docs/ARCHITECTURE.md](../../ARCHITECTURE.md) for the current block +
sequence diagrams.

## Goals

- Ship the four user-facing items from the latest round in one cohesive
  milestone.
- Land a **notification center** primitive the rest of the dashboard can
  reuse for alerts beyond the unreachable banner.
- Land **drag-to-split** as a foundation `SplitEditor` already models
  but doesn't yet expose at the session granularity.
- Set up M23–M26 without building them, so the roadmap in the plan file
  tracks them.

## Non-goals

- Cross-container drag-to-split (vetoed; single-container scope is
  enough and cheaper to implement).
- Four-edge VSCode-parity drop zones (a future effort if we need
  arbitrary nesting — M22 ships horizontal split only).
- Container rename collisions / server-side uniqueness checks (the
  PATCH endpoint already tolerates duplicates; dashboard side-effects
  are the users' problem to notice).
- A unified "notifications preferences" page — the initial center is
  pure UI; source-level filtering happens later if demand warrants.

## Design — by item

### M22.1 — File tree sort + interaction split

**Sort:** in `ContainerFilesView.Row` (render path in the parent
`DirectoryNode`), partition `data.entries` into two arrays before the
`.map`. Directories first, both arrays sorted by
`a.name.localeCompare(b.name, undefined, { sensitivity: "base" })`.

**Interaction:** split the single `<button>` into two controls inside
a wrapper `<div>`:

1. `<ChevronButton>` — visible only for directories. Clicking toggles
   inline expansion. Stops propagation so the click doesn't fall
   through to the row's double-click handler.
2. `<span>` label area — single-click focuses the row, double-click
   calls `onNavigate(childPath)` (the existing path-as-root mechanism,
   updates Breadcrumbs).

For files: no chevron, single-click opens the viewer
(`onOpenFile`). Up-arrow `..` remains the explicit "go to parent"
control. Expansion cascades infinitely (each `Row` owns its own
`open` state).

Tests:

- Vitest: folder-first sort for a mixed input; chevron toggles expand
  without navigating; double-click label triggers `onNavigate`.
- No Playwright — the spec depends on a live docker container we can't
  reproduce in CI.

### M22.2 — Sidebar header de-duplication + activity double-click + animation

**Header:** App.tsx's outer `<aside>` already renders a header with the
activity title + the container-CTA. `ContainerFilesView` also renders
its own header with `FILES` + path. Remove the inner `<header>` from
`ContainerFilesView` and let the path live in the outer header
instead. The outer header's content becomes:

- `<h2>` → activity title (`Containers`, `Files`, …). For Files, append
  the current path as a monospace span.
- CTA region → unchanged; only renders for `containers`.

**Double-click-to-collapse:** add `onDoubleClickActivity(a: Activity)`
to `ActivityBar`. In App.tsx it flips `sidebarOpen`. The single-click
handler stays — switch activity and ensure sidebar is open. The two
gestures don't fight each other because the browser only dispatches
`dblclick` after a delay; if the user is slow, they'll land on
single-click behavior, which is still correct.

**Animation:** `react-resizable-panels` doesn't animate collapse
natively, but we own the panel body — add `transition-[flex-basis]`

- `duration-150` tailwind classes on the Panel's root div via a
  wrapper stylesheet. Duration 150ms; `ease-out`. Matches VSCode.

Tests: Playwright — double-click the Containers activity icon, assert
the `<aside>` has `hidden` attribute after ~300ms.

### M22.3 — Notification center

**Shorter durations:** `useToasts` default stays 5000ms when unset;
call-site standards become:

- `info`: 3000ms
- `success`: 3000ms
- `warning`: 5000ms
- `error`: 8000ms

These are defaults; anywhere a caller explicitly passes a duration
wins.

**Toast history:** extend the `ToastContextValue` shape:

```ts
interface ToastContextValue {
  toast: (kind: ToastKind, title: string, body?: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
  history: ToastRecord[];
  clearHistory: () => void;
  markHistoryRead: () => void;
  unreadCount: number;
}

interface ToastRecord extends ToastItem {
  dismissed_at: string; // ISO
}
```

History capped at 50 entries (oldest evicted). `unreadCount` increments
on `toast()`, resets on `markHistoryRead()`. Stored in-memory only for
M22 — localStorage persistence can come later if users ask.

**Bell component:** new `NotificationCenter.tsx` rendered in
`StatusBar`. Shows a `Bell` icon from lucide with an overlaid unread
badge (style matches `ActivityBar`'s badge). Radix Popover on click:

- Header: "Recent notifications" + "Clear" button
- List: severity-colored rows, title, body, relative timestamp
- Empty state: "Nothing recent."

**Unreachable transition:** in App.tsx, keep a
`useRef<Map<number, AgentStatus>>` of the last-seen agent_status for
each container. On each render, diff the current `containers` against
the ref and fire:

- `warning` toast when a container transitions to `unreachable`
- `info` toast when it recovers (`unreachable` → `idle`/`busy`)

Remove the `selectedUnhealthy` banner JSX entirely. Keep the
`firstHealthy` hint (the "Switch to X" suggestion) — but render it as
an action inside the toast instead of a banner. Initial implementation
can ship without the switch action; a follow-up toast mutation path
handles "actionable toasts".

Tests:

- Vitest: toast history push + cap + unread counter on new entry +
  reset on `markHistoryRead`.
- Vitest: NotificationCenter renders the bell badge count and lists
  recent items.

### M22.4 — Drag session tab to split

**State:** new localStorage key `hive:layout:sessionSplit` storing
`Record<containerId, sessionId>` (the session ID of the SECOND pane in
the split; the primary pane stays `activeSessionId`). Same shape as
the existing `splitId` (which is container-level) so mental models
match.

**Drop zones:** when `SessionSubTabs` dispatches a drag with the new
payload type, the editor body renders two semi-transparent overlays:
one on the left half, one on the right half, with "Split here" text.
On drop, App.tsx sets the split session and the SessionSubTabs clears
its dragging state.

**Rendering:** when `activeSplitSessionId !== null && !== activeSessionId`,
swap the single `<TerminalPane>` region for:

```tsx
<Group orientation="horizontal" autoSaveId={`split-${container.id}`}>
  <Panel defaultSize={50} minSize={20}>
    <TerminalPane ... sessionId={activeSessionId} />
  </Panel>
  <Separator ... />
  <Panel defaultSize={50} minSize={20}>
    <TerminalPane ... sessionId={activeSplitSessionId} />
    <button onClick={() => clearSplit()}>×</button>
  </Panel>
</Group>
```

The existing container-level `<SplitEditor>` (M10) is untouched — this
is session-level split, scoped to one container's two sessions.

**UX subtleties:**

- Dragging a session onto the "split here" overlay while no split is
  active creates the split.
- Dragging another session onto the existing split pane replaces the
  secondary pane.
- Closing the secondary session (x button in its header) clears the
  split and falls back to single-pane.
- The primary session can't be dragged onto itself (no-op guard).

Tests:

- Vitest: App reducer — dragging B onto a container that shows A
  results in (primary=A, split=B).
- Playwright: drag a session tab to the right half of the editor,
  assert two terminal regions exist.

## Roadmap slots — α through ζ

Each gets its own milestone/branch. All approved during M22
brainstorming; ordered by effort + dependency.

### M23 — α: Command palette "go to file" + ζ: contextual suggestions

- Palette learns a `file:<query>` mode (and a `?` help suggestion).
  Fuzzy-matches against a flat listing of the active container's
  filesystem starting from WORKDIR, pulled via the existing
  `/api/containers/{id}/fs` endpoint (walked recursively with a cap).
- Contextual suggestions: read `package.json`, `pyproject.toml`,
  `requirements.txt` from the WORKDIR and propose
  common commands (`pytest`, `npm run dev`, `uv run <script>`). All
  client-side; no new endpoints.

### M24 — β: Write-back editing

- New `PUT /api/containers/{id}/fs/write` endpoint — body is `{path,
content}` (or `content_base64`). Size cap 5 MiB to match the read
  path. Rejects if the target is a directory or doesn't exist.
- `FileViewer` gains an "Edit" toggle that swaps the `<pre>` for a
  basic `<textarea>` (full monaco integration deferred), "Save"
  button that POSTs the new content, confirmation toast on success.

### M25 — γ: Container-health timeline

- `ResourceMonitor` stays as the popover detail view; add a thin inline
  strip above the SessionSubTabs showing the last 60 samples (5-minute
  rolling window). Rendered via `recharts` (already a dep).
- Backend already provides stats via `/api/containers/{id}/resources`
  polled on 5s intervals. Dashboard buffers the last 60 samples per
  active container.

### M26 — δ: Session persistence + ε: Claude diff view

- δ: Move session names from localStorage to a new `sessions` table in
  the registry. Alembic migration adds
  `(id, container_id, name, kind, created_at)`. The client still drives
  create/rename/close, but state is now hub-backed — survives hub
  restart and multiple browser tabs.
- ε: Parse Claude Code output in the Interactive pane (the `PtyPane`
  with `command="claude"`). Detect the tool-use blocks via their known
  prefixes (they print as structured markdown-ish blocks). Fold them
  into a collapsible widget with a diff renderer. Deferred because it
  requires live-studying real Claude output.

## Architecture impact

All of M22 lives in the dashboard — no backend or migration changes.
The existing routes are sufficient. No Pydantic model changes. No
registry schema changes.

Follow-ups:

- M24 introduces a new route + size cap.
- M26 δ introduces a migration.

Neither is in M22's scope.

## Critical files

- [dashboard/src/components/ContainerFilesView.tsx](../../../dashboard/src/components/ContainerFilesView.tsx) — M22.1
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — M22.2, M22.3 (banner removal), M22.4 (split state)
- [dashboard/src/components/ActivityBar.tsx](../../../dashboard/src/components/ActivityBar.tsx) — M22.2 double-click
- [dashboard/src/hooks/useToasts.tsx](../../../dashboard/src/hooks/useToasts.tsx) — M22.3 history + defaults
- [dashboard/src/components/NotificationCenter.tsx](../../../dashboard/src/components/NotificationCenter.tsx) — new, M22.3
- [dashboard/src/components/StatusBar.tsx](../../../dashboard/src/components/StatusBar.tsx) — mount the bell
- [dashboard/src/components/SessionSubTabs.tsx](../../../dashboard/src/components/SessionSubTabs.tsx) — M22.4 drag payloads
- [dashboard/src/components/SplitEditor.tsx](../../../dashboard/src/components/SplitEditor.tsx) — reference only; session-split reuses the Group/Panel pattern

## Verification

Runs on the milestone branch before merge:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub` clean (no backend churn, but run anyway).
3. `pytest hub/tests -q` green.
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green on the
   dashboard.
5. `npx playwright test` green — new spec for double-click collapse
   and drag-to-split.
6. Manual smoke against a live container:
   - Files activity: single-click chevron expands inline; double-click
     a folder label navigates into it; files sort below folders.
   - Double-click the Files icon: sidebar collapses with a ~150ms
     transition; activity rail stays visible.
   - Disconnect a container; a warning toast pops, auto-dismisses, the
     bell badge increments; open the bell to see the entry. No full-
     width banner.
   - Drag a second session's tab onto the right half of the editor;
     two terminals render side by side; close the right one to collapse.

## Out of scope

- Anything in α–ζ (documented above, separate milestones).
- Persisting toast history across reloads.
- Keyboard-driven split (e.g., `Ctrl+\` to split right) — follow-up.
- A "notifications" Radix Tooltip on the bell icon itself — redundant
  with the aria-label.
