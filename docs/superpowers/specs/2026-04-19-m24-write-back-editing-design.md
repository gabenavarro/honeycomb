# M24 — Write-back editing with CodeMirror 6 (textarea fallback)

**Status.** Approved 2026-04-19. Second of the M23–M26 follow-up
milestones seeded by the M22 spec; absorbs what the earlier roadmap
split as "M27 (CodeMirror integration)" into a single milestone.

## Context

M23 shipped read-side polish (palette file-mode + contextual
suggestions). M24 closes the edit loop: the user can open a text file
in the `FileViewer`, modify it in a CodeMirror 6 editor, and save it
back into the container. A new `PUT /api/containers/{id}/fs/write`
endpoint lands the file via `container.put_archive()` (tar-based, no
shell). A `mtime_ns` echo on every read + write lets the client refuse
to clobber files that changed on disk since the viewer's last fetch.

The M22 spec originally scoped this as "textarea first, CodeMirror
later (M27)." During brainstorming the user flagged — correctly —
that the write-back plumbing is editor-agnostic and the textarea
intermediate step would force two planning rounds for a single save
path. So M24 ships the CodeMirror editor directly, with a textarea
fallback triggered only if CodeMirror's dynamic import or mount
fails. That removes M27 from the roadmap entirely.

The codebase is at `v0.23-palette-file`. FastAPI 0.2.1 with
`fs_browser.py` already handling list/read/download/walk. Dashboard at
React 19 / Vite 8 / Tailwind v4 / cmdk / Radix / TanStack Query.

## Goals

- Round-trip editing of text files up to 5 MiB: open → edit → save →
  see the new content on disk (e.g., `cat` in a shell shows the new
  version).
- Refuse to clobber files modified by concurrent shell activity
  (mtime-echo guard); surface the conflict as a reload-or-force-save
  banner, never silently.
- Ship a real code editor (CodeMirror 6) on first exposure — not a
  plain textarea followed by a CodeMirror swap milestone.
- Keep saves working even if CodeMirror's module load / mount fails;
  the textarea fallback guarantees the feature never goes dark on a
  dependency issue.

## Non-goals

- File-create flow. PUT is overwrite-only; users create files via
  their terminal (`touch`) then open + edit.
- Permission escalation (`sudo` retry). Hub surfaces the OS's errno
  verbatim; users address permission problems themselves. Dev
  containers run as root so this path is rarely hit in practice; it
  matters for RO bind-mounts and for future non-root templates.
- Automatic formatter integration (prettier/ruff on save). Deferred.
- Notebook cell editing (.ipynb). Separate design space.
- Multi-cursor / vim-mode / search-and-replace. CodeMirror supports
  these via extensions; defer until user demand.
- Global "unsaved changes on tab switch" guard. In-viewer dirty-state
  confirm covers the common case.
- Editor-level preferences (font size, tab width, etc.). Inherit
  sensible CodeMirror defaults.

## Design

### 1. Architecture

One new backend route + helper, one new Pydantic request model, one
extension to `FileContent`. Dashboard gets a new `<CodeEditor>`
component wrapping `EditorView` and a reworked `FileViewer` that
grows edit-mode state + a save handler. No new hooks.

```
┌─────────── FileViewer.tsx ───────────┐
│  header: Edit | Save | Cancel | X   │
│  body:                              │
│   read-mode   → <pre>               │
│   edit-mode   → <CodeEditor>        │  ← new component
│                   │                  │
│                   ├─ ErrorBoundary fallback → <textarea>
│                   └─ @codemirror/view + lang packs
│  conflict     → yellow banner       │
│  save         → writeContainerFile  │
└──────────────────────────────────────┘
           │
           ▼
  PUT /api/containers/{id}/fs/write
           │
           ▼
  fs_browser.write_file()
  → stat (mtime check)
  → raise WriteConflict on mismatch
  → put_archive(tar)
  → re-stat
  → return fresh FileContent
```

### 2. Backend — write endpoint

#### Request model (added to `hub/models/schemas.py`)

```python
class FileWriteRequest(BaseModel):
    """Body for PUT /api/containers/{id}/fs/write.

    Exactly one of ``content`` / ``content_base64`` must be set. The
    ``if_match_mtime_ns`` echo comes from the most recent ``GET
    /fs/read`` — the hub refuses the write if the file on disk has
    changed since then.
    """

    path: str
    content: str | None = None
    content_base64: str | None = None
    if_match_mtime_ns: int
```

#### Response model extension

`FileContent` gains a required `mtime_ns: int` field populated on
both read and write. Older clients that don't send `if_match_mtime_ns`
on PUT are rejected by Pydantic's required-field validation (400).

#### Route

`PUT /api/containers/{id}/fs/write` → returns `FileContent`.

Flow:

1. Validate path via `fs_browser.validate_path()`.
2. Validate body: exactly one of `content` / `content_base64` present
   (400 on both or neither).
3. `_lookup_container_id` → 404 on unknown record.
4. `docker.from_env()` → `containers.get(container_id)` → 502 on
   docker errors.
5. `fs_browser.write_file(container, path, payload_bytes,
if_match_mtime_ns)`:
   - `stat -c "%s|%Y%N"` the path; split at `|` → current `(size,
mtime_ns)`. Exit != 0 → raise `FileNotFound` (router → 404).
   - `mtime_ns != if_match_mtime_ns` → raise `WriteConflict`
     (router → 409 with `current_mtime_ns` in body).
   - `len(payload_bytes) > 5 MiB` → raise `WriteTooLarge`
     (router → 413).
   - `stat -c "%a|%u|%g"` → current mode, uid, gid.
   - Build in-memory tar: single entry at the target's basename, with
     the pre-existing mode/uid/gid applied to the new content.
   - `container.put_archive(parent_dir, tar_bytes)`. Non-truthy
     return value → raise `WriteError` (router → 502).
   - `stat -c "%s|%Y%N"` again → new `(size, mtime_ns)`.
   - Return `WriteResultData(path, size, mtime_ns, mime_type)`. The
     router constructs a `FileContent` response by combining that
     metadata with the **client-submitted content** (the text the
     user just wrote) — no re-read round trip. This keeps the client
     cache key (`["fs:read", …]`) populated with the now-authoritative
     value and matches the shape `FileContent` already has, so the
     dashboard's `queryClient.setQueryData` swap is a drop-in
     replacement of the previous cache entry.

#### New exceptions in `fs_browser.py`

```python
class FileNotFound(RuntimeError): ...
class WriteConflict(RuntimeError):
    def __init__(self, current_mtime_ns: int) -> None:
        super().__init__("File changed on disk")
        self.current_mtime_ns = current_mtime_ns

class WriteTooLarge(RuntimeError): ...
class WriteError(RuntimeError): ...
```

#### Router exception mapping

| Exception                            | HTTP                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| `InvalidFsPath`                      | 400                                                    |
| `FileNotFound`                       | 404                                                    |
| `WriteConflict`                      | 409, body `{"detail": "...", "current_mtime_ns": int}` |
| `WriteTooLarge`                      | 413                                                    |
| `WriteError`                         | 502                                                    |
| `docker.errors.APIError`             | 502                                                    |
| body validation (400-class Pydantic) | 400                                                    |

#### Size cap

5 MiB on either encoding after decode. Matches the read-side text
cap; binary cap stays 1 MiB on reads (no write-back path for binary
files today — images open in view-only mode, no Edit button).

#### Read endpoint mtime echo

`fs.py::read_file` — add `mtime_ns` to the returned `FileContent`. Two
extra stat formats are already cheap; repurpose the existing
`stat -c "%s"` call to `stat -c "%s|%Y%N"` and split. Everything else
stays.

### 3. Dashboard — `<CodeEditor>` component

New file: `dashboard/src/components/CodeEditor.tsx`.

Props:

```tsx
interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language:
    | "javascript"
    | "typescript"
    | "python"
    | "json"
    | "markdown"
    | "css"
    | "html"
    | "plaintext";
  readOnly?: boolean;
  className?: string;
}
```

Implementation sketch:

- Mount a CodeMirror `EditorView` on a `<div ref>` on first render.
- Configure extensions: `basicSetup` (line numbers + folding +
  highlighting), `oneDark` theme, the language extension from a
  lookup map, `EditorView.updateListener` that calls `onChange` when
  the doc changes.
- Controlled bridge: when `value` prop changes and differs from the
  current editor doc, dispatch a replace transaction. Guard against
  the `onChange` echo by comparing before dispatching — a
  module-level `ref` stores the last-emitted value.
- Cleanup: `editor.destroy()` on unmount.
- `readOnly` prop toggles `EditorState.readOnly.of(true)`.
- Fails closed: if any of the dynamic imports or the mount itself
  throws, the wrapping `ErrorBoundary` in `FileViewer` catches and
  renders a textarea with the same controlled-value semantics.

Extension → language map (in `CodeEditor.tsx`):

```tsx
const langMap: Record<string, CodeEditorProps["language"]> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
};

export function languageForPath(path: string): CodeEditorProps["language"] {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return langMap[ext] ?? "plaintext";
}
```

#### Dependencies (added to `dashboard/package.json`)

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/commands`
- `@codemirror/language`
- `@codemirror/search`
- `@codemirror/autocomplete`
- `@codemirror/lang-javascript`
- `@codemirror/lang-python`
- `@codemirror/lang-markdown`
- `@codemirror/lang-json`
- `@codemirror/lang-css`
- `@codemirror/lang-html`
- `@codemirror/theme-one-dark`
- `codemirror` (aggregates `basicSetup`)

All are ESM-first and published by the same maintainers; Vite handles
them without extra config.

Bundle impact: ~150–200 KiB gzipped, code-split into the FileViewer
chunk via Vite's default route-based split. Acceptable.

### 4. Dashboard — FileViewer edit mode

#### New state

```tsx
const [editing, setEditing] = useState(false);
const [draft, setDraft] = useState("");
const [baseMtime, setBaseMtime] = useState<number | null>(null);
const [saving, setSaving] = useState(false);
const [conflict, setConflict] = useState(false);
```

Entering edit mode seeds `draft = data.content`, `baseMtime =
data.mtime_ns`, `conflict = false`. Cancelling with
`draft !== data.content` shows `confirm("Discard unsaved changes?")`.

#### Header additions (between Download and Close)

- Read mode: `<button>Edit</button>` — pencil icon. Rendered only when
  all of `data.content` text present, `!data.truncated`,
  `!isNotebook`, and `isTextMime(data.mime_type)` (new client-side
  helper mirroring the hub's allowlist).
- Edit mode: `<button>Save</button>` (primary blue), `<button>Cancel</button>`
  (ghost), + a muted "Modified" tag when `draft !== data.content`.

#### Save handler

```tsx
async function onSave() {
  if (!data || baseMtime === null) return;
  setSaving(true);
  try {
    const updated = await writeContainerFile(containerId, {
      path,
      content: draft,
      if_match_mtime_ns: baseMtime,
    });
    toast("success", "Saved", `${humanSize(updated.size_bytes)} written to ${path}`);
    queryClient.setQueryData<FileContent>(["fs:read", containerId, path], updated);
    setBaseMtime(updated.mtime_ns);
    setConflict(false);
    setEditing(false);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      setConflict(true);
    } else {
      toast("error", "Save failed", err instanceof Error ? err.message : String(err));
    }
  } finally {
    setSaving(false);
  }
}
```

#### Conflict banner

Yellow bar above the editor, rendered when `conflict === true`:

> \_"File changed on disk. [Reload] fetches the latest, or [Save
>
> > anyway] keeps your edits but uses the on-disk baseline."\_

- **Reload** → `queryClient.invalidateQueries(["fs:read", containerId, path])`;
  the refetch lands, `draft` reseeds from `data.content`, `baseMtime`
  updates, `conflict = false`.
- **Save anyway** → silent `readContainerFile()` → extract
  `mtime_ns` → call `onSave` logic with that mtime as the new
  baseline (ignoring the current `draft === data.content` equality).

#### Edit surface

The editor body is:

```tsx
<ErrorBoundary
  label={`the editor for ${path}`}
  onError={() => toast("warning", "Editor failed", "Using plain-text fallback.")}
  fallback={
    <textarea
      className={textareaClasses}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      wrap="off"
    />
  }
>
  <CodeEditor value={draft} onChange={setDraft} language={languageForPath(path)} />
</ErrorBoundary>
```

The existing `ErrorBoundary` (used since M8 around the editor subtree)
does **not** yet support a prop-supplied fallback — it renders its own
"Try again" card. M24 extends it with an optional
`fallback?: ReactNode` prop: when present and an error is caught, the
boundary renders the fallback instead of the default card. The
`Try again` card remains the default for consumers that don't pass a
fallback (i.e., all current callers stay unchanged).

#### Dirty-state guard on close

Wrap the existing `onClose` prop:

```tsx
function handleClose() {
  if (editing && draft !== data?.content) {
    if (!window.confirm("Discard unsaved changes?")) return;
  }
  onClose();
}
```

Swap the "X" button's `onClick` to `handleClose`. Switching containers
mid-edit remounts `FileViewer` (keyed on `(containerId, path)` in
App.tsx) and loses the draft silently — acceptable for M24; a
global-unsaved-changes guard is follow-up work.

### 5. Error handling + edge cases

| Case                                                        | Behaviour                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 400 (bad path / both content fields / neither / validation) | Red toast with `detail`.                                                                    |
| 404 (file deleted)                                          | Red toast: "File no longer exists. Close the viewer and re-open from the tree."             |
| 409 (mtime mismatch)                                        | Yellow conflict banner.                                                                     |
| 413 (>5 MiB)                                                | Red toast: "File is too large to save inline. Use the terminal."                            |
| 502 (permission denied / RO mount / put_archive failure)    | Red toast with the hub's errno body.                                                        |
| CodeMirror module fails to load or throws on mount          | ErrorBoundary → textarea fallback + one warning toast. Write-back still works.              |
| User clicks X with unsaved changes                          | `confirm()` guard.                                                                          |
| User switches containers mid-edit                           | FileViewer re-mounts; draft lost (documented follow-up).                                    |
| Network drop during save                                    | Save button spinner continues, eventual failure → red toast, edit mode preserved for retry. |

### 6. Testing

#### Backend

`hub/tests/test_fs_writer.py` — pure helpers:

- `build_write_tar(name, content_bytes, mode, uid, gid)` → valid tar
  (verified by re-reading with `tarfile`)
- `parse_stat_size_mtime("312|1234567890.123456789")` → `(312, 1234567890123456789)`
- `parse_stat_mode_ownership("755|0|0")` → `(0o755, 0, 0)`
- Size cap enforced (raises `WriteTooLarge` at 5 MiB + 1 byte)

`hub/tests/test_fs_write_endpoint.py` — route tests (mirror the
walk-endpoint pattern, monkeypatch `docker.from_env`):

- 200 + mtime echo updated after text write
- 200 + base64 decode round-trip
- 401 without token
- 400 on bad path
- 400 on both content + content_base64
- 400 on neither
- 404 on missing file
- 409 on mtime mismatch, body includes `current_mtime_ns`
- 413 on oversized payload
- 502 when `put_archive` returns False

#### Dashboard

`dashboard/src/components/__tests__/CodeEditor.test.tsx`:

- Mounts an EditorView given an initial value
- `onChange` fires when the user types
- `readOnly=true` prevents edits
- `key` change remounts with fresh value

`dashboard/src/components/__tests__/FileViewer.test.tsx` (new):

- Edit button absent for non-text MIME / truncated / notebook paths
- Edit button present for text MIME, clicking flips to edit mode +
  CodeEditor renders
- Save calls `writeContainerFile` with `if_match_mtime_ns = data.mtime_ns`
- 409 response flips `conflict` state and renders the banner
- "Reload" in banner invalidates the read query and reseeds draft
- Cancel with dirty draft shows confirm; confirmed returns to read
- ErrorBoundary fallback activates when CodeEditor throws (simulate
  via a mock that throws on mount)

#### Playwright

`dashboard/tests/e2e/file-write.spec.ts`:

- Stub `/fs/read` → text file + mtime
- Stub `/fs/write` → 200 with updated mtime
- Click Edit → type "// edit" in the editor → Save → success toast
- Rerun: stub `/fs/write` → 409 once → yellow banner appears

### 7. Manual smoke (documented; not automated)

1. In a running container, open a README in the viewer.
2. Enter edit mode; change a line; save.
3. In a terminal attached to the same container, `cat README` — new
   content.
4. In the terminal, `echo "outside" >> README`; switch back to the
   viewer; edit something; save — assert yellow conflict banner.
5. Reload from the banner; the textarea/editor shows the terminal's
   append; edit again; save — success.
6. Try to save a file under `/etc` without write permission (if
   running as non-root) — assert 502 + errno toast.

## Critical files

- [hub/services/fs_browser.py](../../../hub/services/fs_browser.py) — new `write_file()`, exceptions, helpers
- [hub/routers/fs.py](../../../hub/routers/fs.py) — new PUT route; `read_file` mtime echo
- [hub/models/schemas.py](../../../hub/models/schemas.py) — `FileWriteRequest`, `FileContent.mtime_ns`
- [hub/tests/test_fs_writer.py](../../../hub/tests/test_fs_writer.py) — new
- [hub/tests/test_fs_write_endpoint.py](../../../hub/tests/test_fs_write_endpoint.py) — new
- [dashboard/src/components/CodeEditor.tsx](../../../dashboard/src/components/CodeEditor.tsx) — new
- [dashboard/src/components/FileViewer.tsx](../../../dashboard/src/components/FileViewer.tsx) — edit mode
- [dashboard/src/components/ErrorBoundary.tsx](../../../dashboard/src/components/ErrorBoundary.tsx) — add `fallback` prop if missing
- [dashboard/src/lib/api.ts](../../../dashboard/src/lib/api.ts) — `writeContainerFile` wrapper
- [dashboard/src/lib/types.ts](../../../dashboard/src/lib/types.ts) — `FileWriteRequest`, `FileContent.mtime_ns`
- [dashboard/package.json](../../../dashboard/package.json) — CodeMirror dep set

## Verification

Same shape as M20–M23:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub && mypy hive-agent` clean.
3. `pytest hub/tests` green.
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green.
5. `npx playwright test` green.
6. `npx prettier --write .` in `dashboard/` before push — avoids the
   hook-vs-CI drift documented in memory.
7. Manual smoke above.
8. Branch merged `--no-ff` to `main`; tagged `v0.24-write-back`;
   push `--follow-tags`; CI watched to green; branch deleted.

## Follow-ups (out of scope for M24)

- Global unsaved-changes guard on tab/container switch.
- `POST /fs/create` for new-file creation.
- Prettier / ruff auto-format on save.
- CodeMirror vim-mode / search-replace / multi-cursor extensions.
- Notebook cell editing.
- Editor preferences (font size, tab width, theme choice).
