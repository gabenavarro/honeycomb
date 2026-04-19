# M23 — Command palette "go to file" + contextual suggestions

**Status.** Approved 2026-04-18. First of the M23–M26 follow-up
milestones seeded by [M22's spec](2026-04-18-m22-ux-refinements-design.md#m23--%CE%B1-command-palette-go-to-file--%CE%B6-contextual-suggestions).

## Context

The M22 spec committed to two additive palette features (α and ζ) but
left the backend shape and UX wiring deliberately vague. This spec
locks both down as a single milestone because they share code paths —
reading files from an active container — and ship together without
interfering.

**α — go to file.** Inside the existing Ctrl+K palette, typing
`file:<query>` flips the palette into a file-search mode that fuzzy-
matches against a flat index of the active container's filesystem,
rooted at WORKDIR. Enter opens the file in the same viewer the Files
activity already uses.

**ζ — contextual suggestions.** When the palette opens against an
active container, a "Suggestions for {project_name}" group at the top
lists commands parsed out of `package.json`, `pyproject.toml`, and
`Makefile`. Selecting one opens a PTY session pre-filled with the
command (Enter-to-run — never auto-submitted).

The codebase is at `v0.22-ux-refinements`. React 19, Vite 8, Tailwind
v4, cmdk + Radix palette, FastAPI 0.2.0 with `fs_browser.py` already
handling per-directory listing and file reads.

## Goals

- Make large containers navigable in <1s via fuzzy file search without
  leaving the keyboard.
- Surface discoverable, project-relevant run targets the moment the
  palette opens — no manual typing for common scripts.
- Land the backend walk as a **reusable file-index primitive** so
  M24 (write-back), M26 ε (Claude diff view), and future features can
  consume the same index without re-walking.
- Stay additive inside `CommandPalette.tsx` — no new dialog component,
  no second hotkey.

## Non-goals

- A dedicated `Ctrl+P` file picker (considered and deferred — one
  palette is enough today; the `paletteMode` state variable can be
  lifted into a second picker later without touching the walk
  endpoint).
- Shell-history mining or `.tool-versions`-style environment sniffing
  for suggestions (considered; rejected for privacy and scope).
- Automatic walk refresh after file creation (manual `file:!` trigger
  is enough; 30s staleTime already aggressive).
- Symbol search (`@<symbol>`) inside the palette — requires language-
  server integration; explicit M23+ non-goal.
- Persisting file-index results across browser reloads. React Query
  in-memory cache is sufficient.

## Design

### 1. Architecture

One new backend endpoint in `hub/routers/fs.py`, one new helper in
`hub/services/fs_browser.py`, two new hooks in `dashboard/src/hooks/`,
and mode-state additions to the existing `CommandPalette.tsx`. No
changes to the palette's Dialog/cmdk wiring.

```
┌───────────── CommandPalette.tsx ─────────────┐
│ paletteMode: "command" | "file"              │
│ ──────────────────────────────────────────── │
│ command mode:                                │
│   [Suggestions for X]  ← useContainerSuggestions
│   [Containers] [Sessions] [Activity] …       │
│                                              │
│ file mode (input starts with "file:"):       │
│   [Files]  ← useContainerFileIndex          │
└──────────────────────────────────────────────┘
             │                       │
             ▼                       ▼
   useContainerSuggestions    useContainerFileIndex
   (reads 3 manifest files)   (one walk call, cached)
             │                       │
             ▼                       ▼
       readContainerFile       GET /containers/{id}/fs/walk
       (existing endpoint)     (new endpoint)
                                     │
                                     ▼
                         fs_browser.walk_paths()
                         docker exec <cid> find … -print
```

### 2. Backend — walk endpoint

**Route.** `GET /api/containers/{id}/fs/walk`

Query params:

| Name          | Type                   | Default                                                                                   | Notes                                  |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `root`        | string (absolute path) | WORKDIR if omitted                                                                        | Validated via existing path sanitiser  |
| `max_entries` | int                    | `5000`                                                                                    | Hard cap on response size              |
| `excludes`    | CSV string             | `".git,node_modules,__pycache__,.venv,venv,dist,build,target,.next,.cache,.pytest_cache"` | Dir names pruned during walk           |
| `max_depth`   | int                    | `8`                                                                                       | Protects against accidental home scans |

**Handler.** `fs_browser.walk_paths(client, container_id, root,
max_entries, excludes, max_depth) -> WalkResult`. Shells out via
`docker exec <cid> find <root> -maxdepth <max_depth> \( -name .git
-o -name node_modules -o ... \) -prune -o -printf "%y\t%s\t%P\n"`
as an argv list — no shell string interpolation. Parses stdout into
`FsEntry` rows (`%y` → kind d/f/l → dir/file/symlink; `%s` → size;
`%P` → path relative to root). Prepends the root back to each path so
the client receives absolute paths matching what the Files activity
produces. Truncates at `max_entries` and sets `truncated=True`.

**Timeout.** 10s. 504 with structured `{detail: "walk timed out",
root, elapsed_ms}` body on exceed.

**Validation.** Reuses the existing path validator — absolute, no
shell metacharacters, no `..`. Rejects empty. 400 for invalid
`max_entries` (not positive or > 20000) or `max_depth` (< 1 or > 16).

**Response model.** Added to `hub/models/schemas.py`:

```python
class WalkResult(BaseModel):
    root: str
    entries: list[FsEntry]
    truncated: bool
    elapsed_ms: int
```

Reuses the existing `FsEntry` — no new client-side type. Future
filters (extension, size, mtime) key off existing fields.

**Why this shape.** Returning `FsEntry` instead of bare strings keeps
the endpoint extensible for M24 (write-back needs the file size to
decide "edit inline vs download first") and for future size-based
search refinements without a schema break.

### 3. Dashboard — file index + palette mode

#### `useContainerFileIndex(containerId, { enabled })`

New hook in `dashboard/src/hooks/useContainerFileIndex.ts`. Wraps
React Query:

- `queryKey: ["fs:walk", containerId]`
- `queryFn`: calls new `listContainerFiles(id)` in `lib/api.ts` which
  hits the walk endpoint with `root` resolved from `getContainerWorkdir`
  (a two-step promise chain — walk depends on workdir but we already
  cache that via React Query)
- `staleTime: 30_000`, `gcTime: 120_000`
- `enabled` gated by caller — only set to `true` when the palette is
  in file mode

Returns `{ entries, truncated, isLoading, error, refetch }`.

#### Palette mode state

`CommandPalette` adds:

```tsx
const [mode, setMode] = useState<"command" | "file">("command");
const [searchValue, setSearchValue] = useState("");
```

- On every input change: if `value.startsWith("file:")` → set
  `mode="file"` and strip the prefix for cmdk scoring. Else if
  `value.startsWith(">")` → explicit commands-only mode (strip the
  `>`). Else → `mode="command"`.
- Clearing the input resets to `command` mode.
- Palette close resets `mode` to `command` for the next open.

#### Rendering

- **Command mode:** existing groups unchanged. Plus a top group
  "Suggestions for {project_name}" when `useContainerSuggestions`
  returns at least one entry.
- **File mode:** single `Command.Group heading="Files"`; entries come
  from `useContainerFileIndex`. List capped at 200 fuzzy-matched
  results (cmdk scores against the full list, but we only render the
  top 200 to keep DOM size bounded). Selecting calls
  `onOpenFile(path)` which App.tsx wires to the same `setOpenedFile`
  the Files activity uses.
- **Truncated banner:** when `truncated`, append an inline `<p>`
  footer: `Showing first 5000 files. Refine with file:src/`
- **Error state:** replace the list with `<p>` message + Retry button
  calling `refetch()`. Error is the React Query `error` object.
- **`?` help card:** when `searchValue === "?"`, suppress the normal
  group list entirely and render a small help block listing the
  available prefixes (`file:<query>`, `>`, `?`). Also lists "press
  Enter on any file to open in editor." Not a `Command.Group` —
  it's a plain conditional `<div>` above `Command.List` so cmdk
  doesn't try to score it against the input.
- **`file:!` manual refresh:** when the user types `file:!` while in
  file mode, the first row becomes a synthetic `Refresh file index`
  entry. Selecting it calls `refetch()` on
  `useContainerFileIndex`, dismisses the palette. Enter without the
  `!` goes straight to whichever file is fuzzy-top.

### 4. Contextual suggestions (ζ)

`useContainerSuggestions(containerId, workdir)` — new hook in
`dashboard/src/hooks/useContainerSuggestions.ts`. Fires three
`readContainerFile` calls in parallel against `${workdir}/package.json`,
`${workdir}/pyproject.toml`, and `${workdir}/Makefile`. Each
resolution is wrapped in a `try`/`catch` — a 404 or parse error for
any single manifest does not fail the whole suggestion set.

- `package.json`: `JSON.parse(content).scripts` → entries
  `{ id: "sugg:npm:{name}", title: "Run npm: {name}", subtitle: "{cmd} — package.json" }`.
- `pyproject.toml`: parse via `smol-toml` (added to `package.json`,
  ~5 KiB, zero deps). Read `[project.scripts]` + `[tool.poetry.scripts]`
  → `Run python: {name}` with subtitle = `{cmd} — pyproject.toml`.
- `Makefile`: regex each line against `^([A-Za-z0-9_-]+):` and skip
  lines starting with `.`, `#`, or `\t` → `make {target}` with
  subtitle = `Makefile`. Dedup against already-seen targets.

`staleTime: 60_000`, `gcTime: 300_000`. Hook returns
`PaletteCommand[]` ready to merge into the palette's existing command
list.

**Execution.** Each suggestion's `run()` opens a PTY session against
the active container with the command pre-typed into the prompt but
**not submitted**. Reuses the `newClaudeSession` flow's container-
open path — opens the container tab, focuses the first shell session,
sends the text via xterm's API. The user sees the command sitting in
the prompt and presses Enter to run. No auto-submit, ever.

Edge case: if no PTY session is open for the container, the handler
creates a fresh shell session (same flow as clicking the "+" on
session sub-tabs) before sending the text. If the container is
stopped, a `warning` toast fires — "Start the container first" — and
the action no-ops.

### 5. Error handling + edge cases

| Case                                   | Behaviour                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No active container                    | Suggestions group hidden; `file:` mode shows empty-state `<p>Open a container first.</p>`; no fetch fires.    |
| Walk timeout (10s)                     | 504 from hub; hook surfaces "Walk timed out. Narrow the root with `file:src/`." + Retry.                      |
| Oversized tree                         | `truncated=True`; banner shown inline.                                                                        |
| Manifest parse error                   | Swallowed per-file; `structlog.warn` with `container_id` + `manifest_name`; other manifests still contribute. |
| Suggestion run without PTY             | Creates a fresh shell session, then pre-types.                                                                |
| Suggestion run while container stopped | `warning` toast; no-op.                                                                                       |
| Stale index after file creation        | Manual `file:!` refresh entry triggers `refetch()`.                                                           |
| Container deleted mid-walk             | Walk errors with 404 → hook returns `error` → palette shows message + Retry.                                  |

### 6. Testing

- **pytest** — `hub/tests/services/test_fs_browser_walk.py`
  - walks a prepared tree (via `testcontainers` or a docker fixture)
  - empty root → empty entries
  - `max_entries=2` → 2 entries + `truncated=true`
  - default excludes hide `.git` + `node_modules`
  - argv-safety smoke: `root=";rm -rf /"` → 400
- **pytest** — `hub/tests/routers/test_fs_walk_route.py`
  - 200 on a registered container
  - 404 on bad path
  - 502/504 on find failure / timeout
  - auth required (401 without token)
- **vitest** — `useContainerFileIndex.test.tsx`
  - enabled gating: disabled → no query fires
  - cache hit on re-open within staleTime window
  - error surfaces to `error` property
- **vitest** — `CommandPalette.test.tsx`
  - typing `file:foo` flips mode and renders "Files" group
  - `?` shows cheat-sheet card
  - Enter on a file entry calls `onOpenFile` with absolute path
  - clearing input returns to command mode
- **vitest** — `useContainerSuggestions.test.tsx`
  - parses `package.json.scripts` correctly
  - parses `[project.scripts]` and `[tool.poetry.scripts]`
  - parses Makefile top-level targets; ignores `.PHONY:` + comments
  - tolerates missing files (returns partial result)
- **Playwright** — `palette-file-mode.spec.ts`
  - stub walk response; Ctrl+K → `file:` → arrow-down → Enter opens
    the file in the editor pane
  - stub suggestion manifests; Ctrl+K shows "Suggestions for …"
    group; selecting a suggestion opens a PTY (asserted via tab
    focus state; the actual prompt-fill requires a real PTY so is
    covered by manual verification only)

## Critical files

- [hub/services/fs_browser.py](../../../hub/services/fs_browser.py) — new `walk_paths()`
- [hub/routers/fs.py](../../../hub/routers/fs.py) — new `GET /fs/walk` route
- [hub/models/schemas.py](../../../hub/models/schemas.py) — new `WalkResult`
- [dashboard/src/lib/api.ts](../../../dashboard/src/lib/api.ts) — new `listContainerFiles()`
- [dashboard/src/hooks/useContainerFileIndex.ts](../../../dashboard/src/hooks/useContainerFileIndex.ts) — new
- [dashboard/src/hooks/useContainerSuggestions.ts](../../../dashboard/src/hooks/useContainerSuggestions.ts) — new
- [dashboard/src/components/CommandPalette.tsx](../../../dashboard/src/components/CommandPalette.tsx) — mode state + file group + suggestions group + help card
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — wire `onOpenFile` + new-session-from-palette into existing callbacks
- [dashboard/package.json](../../../dashboard/package.json) — add `smol-toml`

## Verification

Same shape as M20–M22:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub && mypy hive-agent` clean.
3. `pytest hub/tests` green (new `fs_walk` specs included).
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green.
5. `npx playwright test` green.
6. Manual smoke against a live container:
   - Ctrl+K → suggestions group shows `npm run dev` / `pytest` /
     `make test` as appropriate for the container's WORKDIR.
   - Ctrl+K → `file:app` → fuzzy list narrows; Enter opens the file.
   - `file:!` triggers a refresh after creating a new file in a
     terminal.
   - `?` prints the cheat-sheet.
7. Branch merged `--no-ff` to `main`; tagged `v0.23-palette-file`;
   push `--follow-tags`; CI watched to green; branch deleted.

## Out of scope

- Symbol search (`@<symbol>`) — requires language servers.
- Cross-container file search (a single palette targets one active
  container at a time).
- Persistent walk cache (React Query in-memory is enough).
- Auto-refresh on filesystem change — deferred until a hub-side
  fsnotify feed exists.
