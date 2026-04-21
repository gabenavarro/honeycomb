# M26 — Persistent named sessions (δ)

**Status.** Approved 2026-04-20. Fourth and final of the M23–M26
follow-up milestones from the M22 roadmap. (The ε "Claude diff view"
half of the original bundled M26 was split out into its own M27
milestone during brainstorming — different subsystem, different
uncertainty profile.)

## Context

M16 introduced per-container named session tabs backed by
`hive:layout:sessions` in localStorage. Sessions carry an id + name
per container and feed `SessionSubTabs` above the terminal pane.
Five milestones later the limits of that design are visible:

- Session names are **client-side only**. Opening the dashboard on a
  second Tailscale-reachable device shows empty tabs — the user's
  labels don't follow them.
- A reload on the same device restores sessions (localStorage
  persists), but clearing storage or switching browsers loses every
  name.
- Multi-tab is awkward: two browser tabs on the same host maintain
  independent session lists that drift.

M25 solved the same class of problem for the resource timeline (hub
as source of truth, reload + cross-device consistent). M26 applies
that pattern to session names.

The sibling M27 milestone (ε — Claude diff view) was deferred to its
own design round because it requires live-studying actual Claude
Code PTY output before freezing the parser contract.

Codebase is at `v0.25-health-timeline`. FastAPI + SQLAlchemy async +
Alembic already in use since M7. Alembic has shipped two baseline
migrations.

## Goals

- Move session names from localStorage to a hub-backed `sessions`
  table. Survives hub restart, consistent across Tailscale-reachable
  devices.
- One-shot client-side migration of existing localStorage session
  state on first load post-deploy. No action needed from the user —
  session names carry forward automatically.
- Keep CRUD responsive: optimistic updates on create/rename/close so
  the UI doesn't wait for a round trip.
- Cleanly separate the new persistent sessions concept from the
  existing `/api/containers/{id}/sessions` endpoint (which returns
  ephemeral PTY runtime state and keeps that narrow purpose).

## Non-goals

- Drag-to-reorder sessions. Ordering stays by `created_at ASC`.
  Tracked as a future ticket (see **Follow-up tickets** below).
- Per-session runtime metadata (font-size, last-cwd, theme).
  Tracked as a future ticket.
- WebSocket push notifications for real-time cross-device session
  sync. Poll-based (30s staleTime + refetch-on-focus) is sufficient
  at current scale. Tracked as a future ticket.
- PTY scrollback continuity across the migration. Session IDs
  change during migration → sessionKey changes in PtyPane → reattach
  labels become invalid. Users see fresh terminals on first mount
  after M26. User has explicitly accepted this trade-off.
- Unifying the new persistent sessions concept with the existing
  `/api/containers/{id}/sessions` (runtime PTY state) endpoint.
  They're different resources with different lifetimes.
- Multi-user concurrent sessions. Single-user local tool; no user_id
  column.

## Design

### 1. Architecture

```
┌─ hub/db/migrations ─ new sessions table via Alembic ────────────┐
│  (session_id PK | container_id FK CASCADE | name | kind         │
│   | created_at | updated_at)                                    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─ hub/services/named_sessions.py ────────────────────────────────┐
│  create_session / list_sessions / rename_session /              │
│  delete_session — SQLAlchemy Core async queries.                │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─ hub/routers/named_sessions.py ─────────────────────────────────┐
│  GET    /api/containers/{id}/named-sessions                     │
│  POST   /api/containers/{id}/named-sessions                     │
│  PATCH  /api/named-sessions/{session_id}                        │
│  DELETE /api/named-sessions/{session_id}                        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
                Dashboard: useSessions(containerId)
                (TanStack Query wrapper with optimistic mutations)
                              │
                              ▼
              App.tsx: replaces useLocalStorage reads
                              │
                              ▼
             One-time runSessionMigration() on first load
             - POSTs every legacy localStorage session to hub
             - rewrites activeSession + terminal-last-kind keys
             - wipes pty-label sessionStorage (fresh terminals)
             - sets hive:layout:sessionsMigratedAt guard
```

### 2. Backend — schema + service + router

#### Alembic migration

New file under `hub/db/migrations/versions/` (follow existing
naming pattern):

```python
"""M26 — persistent named sessions."""

import sqlalchemy as sa
from alembic import op

revision = "m26_sessions"
down_revision = "<current-head>"   # fill in during implementation


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("session_id", sa.String, primary_key=True),
        sa.Column("container_id", sa.Integer, nullable=False),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("kind", sa.String, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["container_id"],
            ["containers.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_sessions_container_id",
        "sessions",
        ["container_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_container_id", table_name="sessions")
    op.drop_table("sessions")
```

CASCADE on container delete is deliberate — orphan session rows for
a deleted container have no UI surface and would only accumulate.

The `ix_sessions_container_id` index supports the dominant query
shape (list all sessions for a container), which is the hot path on
every app mount.

#### Pydantic models (in `hub/models/schemas.py`, new block)

```python
class NamedSession(BaseModel):
    """One persistent session row (M26)."""

    session_id: str
    container_id: int
    name: str
    kind: Literal["shell", "claude"]
    created_at: datetime
    updated_at: datetime


class NamedSessionCreate(BaseModel):
    """Body for POST /api/containers/{id}/named-sessions."""

    name: str = Field(..., min_length=1, max_length=64)
    kind: Literal["shell", "claude"] = "shell"


class NamedSessionPatch(BaseModel):
    """Body for PATCH /api/named-sessions/{session_id}."""

    name: str = Field(..., min_length=1, max_length=64)
```

#### Service layer — `hub/services/named_sessions.py`

Thin async helpers using the existing SQLAlchemy engine from
`hub/services/registry.py`. Each function is a standalone coroutine
— four CRUD operations don't warrant a class wrapper:

```python
async def create_session(
    engine: AsyncEngine,
    *,
    container_id: int,
    name: str,
    kind: str,
) -> NamedSession: ...


async def list_sessions(
    engine: AsyncEngine,
    *,
    container_id: int,
) -> list[NamedSession]: ...


async def rename_session(
    engine: AsyncEngine,
    *,
    session_id: str,
    name: str,
) -> NamedSession: ...  # raises SessionNotFound if missing


async def delete_session(
    engine: AsyncEngine,
    *,
    session_id: str,
) -> None: ...  # idempotent — deleting nothing is fine


class SessionNotFound(KeyError): ...
```

`create_session` generates `session_id = uuid.uuid4().hex` server-
side. `list_sessions` orders by `created_at ASC`. `rename_session`
bumps `updated_at` via `sa.func.now()`.

#### Router — `hub/routers/named_sessions.py`

```python
router = APIRouter(tags=["named-sessions"])


@router.get(
    "/api/containers/{record_id}/named-sessions",
    response_model=list[NamedSession],
)
async def list_named_sessions(
    record_id: int, request: Request
) -> list[NamedSession]:
    # Verify the container exists (404 otherwise), then delegate.
    ...


@router.post(
    "/api/containers/{record_id}/named-sessions",
    response_model=NamedSession,
)
async def create_named_session(
    record_id: int, request: Request, body: NamedSessionCreate
) -> NamedSession:
    ...


@router.patch(
    "/api/named-sessions/{session_id}",
    response_model=NamedSession,
)
async def patch_named_session(
    session_id: str, request: Request, body: NamedSessionPatch
) -> NamedSession:
    # 404 via SessionNotFound.
    ...


@router.delete(
    "/api/named-sessions/{session_id}",
    status_code=204,
)
async def delete_named_session(
    session_id: str, request: Request
) -> None:
    # Idempotent — always 204 even if the row was already gone.
    ...
```

The PATCH / DELETE paths are container-agnostic (operate by
`session_id` only). That keeps the frontend's rename / close
flows one-liners. The GET / POST stay container-scoped to mirror
the existing container-scoped endpoints.

Global bearer-token auth covers all four routes without extra
middleware.

Register the new router in `hub/main.py` alongside the existing
`sessions` router.

#### Tests

- **`hub/tests/test_named_sessions_service.py`**: async service
  helpers against an in-memory SQLite.
  - `create_session` round-trips; `list_sessions` returns `[]` for
    an empty container; ordering by `created_at`; `rename_session`
    bumps `updated_at`; `delete_session` idempotent; CASCADE on
    container delete wipes orphan rows.
- **`hub/tests/test_named_sessions_endpoint.py`**: integration tests
  via `httpx.ASGITransport` (same pattern as the M25
  `test_resources_history_endpoint.py`).
  - GET empty; GET with rows; POST creates + returns; PATCH
    renames; DELETE idempotent; 401 without token; 404 on unknown
    container; 404 on unknown session id; 422 on empty name; 422
    on name > 64 chars; 422 on bad kind.
- **Migration test**: extend `hub/tests/test_registry_m7.py` (or add
  `test_named_sessions_migration.py`) asserting the `sessions`
  table exists with correct columns + FK constraint after Alembic
  runs.

### 3. Dashboard — hook, API wrappers, migration, App.tsx swap

#### `dashboard/src/lib/api.ts`

Add four wrappers:

```ts
export const listNamedSessions = (id: number) =>
  request<NamedSession[]>(`/containers/${id}/named-sessions`);

export const createNamedSession = (id: number, body: NamedSessionCreate) =>
  request<NamedSession>(`/containers/${id}/named-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const renameNamedSession = (sessionId: string, name: string) =>
  request<NamedSession>(`/named-sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

export const deleteNamedSession = (sessionId: string) =>
  request<void>(`/named-sessions/${sessionId}`, {
    method: "DELETE",
  });
```

TypeScript types in `dashboard/src/lib/types.ts`:

```ts
export type SessionKind = "shell" | "claude";

export interface NamedSession {
  session_id: string;
  container_id: number;
  name: string;
  kind: SessionKind;
  created_at: string;
  updated_at: string;
}

export interface NamedSessionCreate {
  name: string;
  kind?: SessionKind;
}
```

#### `useSessions(containerId)` hook

New file `dashboard/src/hooks/useSessions.ts`. Returns:

```ts
export interface UseSessionsResult {
  sessions: NamedSession[];
  isLoading: boolean;
  error: unknown;
  create: (input: NamedSessionCreate) => Promise<NamedSession>;
  rename: (sessionId: string, name: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
}

export function useSessions(containerId: number | null): UseSessionsResult;
```

Internals:

- `useQuery({ queryKey: ["named-sessions", containerId],
queryFn: () => listNamedSessions(containerId!), enabled,
staleTime: 30_000, refetchOnWindowFocus: true })`.
- Three `useMutation` calls with `onMutate` optimistic updates:
  - `create`: append to cache with a provisional row; rollback on
    error; replace with server row on success.
  - `rename`: patch the cached row's name; rollback on error.
  - `close`: remove from cache; rollback on error.
- All mutations invalidate the query on settle so the list stays
  authoritative.

#### One-time migration — `dashboard/src/lib/migrateSessions.ts`

```ts
export interface MigrationResult {
  migrated: number;
  skipped: Array<{ containerId: string; oldId: string; reason: string }>;
}

export async function runSessionMigration(): Promise<MigrationResult>;
```

Behaviour:

1. If `localStorage["hive:layout:sessionsMigratedAt"]` exists, return
   `{migrated: 0, skipped: []}` immediately.
2. Read `hive:layout:sessions` (the legacy
   `Record<containerId, {id, name}[]>`). If missing or empty, set
   the guard key and exit with 0 migrated.
3. Read `hive:layout:activeSession` for later rewriting.
4. For each `(containerIdStr, sessions[])`, parse `containerIdStr`
   as an integer. For each session entry:
   - `kind` = `localStorage["hive:terminal-last-kind:<cid>:<oldId>"]`
     if present and one of `"shell" | "claude"`, else `"shell"`.
   - `POST /api/containers/<cid>/named-sessions` with `{name, kind}`.
   - On success, record `{oldId → newId}` in a local map.
   - On 404 (container no longer exists) or 400 (invalid name),
     push to `skipped` and continue.
5. Rewrite `hive:layout:activeSession`: for each
   `(containerIdStr, oldId)`, if the id is in the migration map,
   replace with `newId`; drop entries whose id is unmapped.
6. Rewrite `hive:terminal-last-kind:*`: for each migrated
   `(containerId, oldId, newId)` pair, copy the value from the old
   key to the new key (if present), then delete the old key.
7. **Wipe matching `hive:pty:label:*` sessionStorage keys** for
   every migrated `(recordId, oldId)` pair. PTY reattach labels
   become invalid when the sessionKey changes; fresh terminals on
   first mount.
8. Clear `hive:layout:sessions`.
9. Set `hive:layout:sessionsMigratedAt = new Date().toISOString()`.
10. Return `{migrated, skipped}`.

Called from `App.tsx` inside a `useEffect` that fires exactly once
on mount, gated by `hive:layout:sessionsMigratedAt`. If the
returned `skipped` array is non-empty, a one-time `warning` toast
surfaces the summary.

#### `App.tsx` changes

**Removed:**

- `LS_SESSIONS`, `LS_ACTIVE_SESSION`, the `useLocalStorage` readers
  for `sessionsByContainer` / `activeSessionByContainer`, the
  `isSessionsByContainer` / `isActiveSessionMap` validators.
- The auto-seed-on-empty `activeSessions` memo's fallback to
  `[{id: "default", name: "Main"}]` — the hub now returns the real
  list; "empty" means the user hasn't created any sessions yet.

**Added:**

- `const { sessions, create, rename, close } = useSessions(active?.id ?? null);`
- A compact `LS_ACTIVE_SESSION_ID = "hive:layout:activeSessionByContainer"`
  localStorage for the _currently focused_ session id per container
  (client state, not shared across devices). Same shape as the old
  active-session map. Updated on tab click + session creation.
- `newSession` → `create({name, kind: "shell"})` + focus new id.
- `newClaudeSession` → `create({name: "Claude", kind: "claude"})` +
  focus new id.
- `renameSession` → `rename(sessionId, newName)`.
- `closeSession` → `close(sessionId)` + refocus first remaining.
- `focusSession` → update `activeSessionByContainer` localStorage.
- `runSessionMigration()` invoked in a mount-only `useEffect`.
- First-empty-state guard: if the active container has zero sessions
  after the hook resolves, auto-create a default shell session so
  `<SessionSubTabs>` never renders blank.

#### `PtyPane` impact

**None at API level.** `sessionKey` still comes from the session
id. Since IDs changed during migration and we wiped
`hive:pty:label:*` sessionStorage entries, `labelFor()` generates
fresh labels on first post-migration mount. Users see new
terminals. Expected and accepted.

#### Tests

- **`useSessions.test.tsx`**: list fetch + cache hit on remount,
  `create` optimistic update (pending row visible before server
  resolves), `rename` cache patch, `close` cache remove, rollback
  on server error.
- **`migrateSessions.test.ts`**: multi-container localStorage
  snapshot migrates correctly, rewrites active-session + terminal-
  last-kind keys, wipes pty-label keys, clears the source
  localStorage key, sets the guard key, is no-op on re-run, skips
  unmapped-container entries on 404.

### 4. Error handling + edge cases

| Case                                               | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration POSTs all succeed                        | Silent success; one toast "Migrated N sessions to hub" if N > 0. Guard key prevents repeat.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Migration 404 on a container that no longer exists | Skip that container's entries; continue. Summary reports `reason: "container not found"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Migration 422 on a name > 64 chars                 | Skip with `reason: "name too long"`. User can rename manually after migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Auth fails mid-migration                           | Abort gracefully. localStorage sessions remain untouched. On next load after token refresh, migration re-runs from scratch. **Hub-side duplicate session rows are a risk** here — mitigated by an idempotency guard: migration runs the full pass, then only sets the guard key on success. A second run will retry unmigrated entries but will NOT skip already-migrated ones. _Trade-off:_ a genuine failure half-way through produces duplicate rows. User can delete duplicates manually. Acceptable given the rarity of mid-migration auth failure. |
| Hub down on first load                             | `useSessions` returns empty + error; SessionSubTabs shows a skeleton. Migration defers until first successful GET lands; guard key not yet set.                                                                                                                                                                                                                                                                                                                                                                                                          |
| User creates a session while offline               | Optimistic update shows the tab; `useMutation`'s `retry: 3` re-attempts on reconnect. If all retries fail, rollback + error toast.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Two tabs create the same-named session at once     | Server allows duplicate names; each POST gets a unique `session_id`. Both tabs see both sessions after the next 30s refetch or focus event.                                                                                                                                                                                                                                                                                                                                                                                                              |
| User deletes the last session of a container       | Auto-create a default `{name: "Main", kind: "shell"}` so the tab strip never shows zero sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Container deleted from the registry                | FK CASCADE wipes session rows. Dashboard's existing tab-prune effect (gated on `containersLoaded`) already removes tabs for deleted containers.                                                                                                                                                                                                                                                                                                                                                                                                          |

### 5. Testing summary

- **pytest** — `test_named_sessions_service.py`,
  `test_named_sessions_endpoint.py`, migration table check.
- **vitest** — `useSessions.test.tsx`, `migrateSessions.test.ts`.
- **Playwright** — `named-sessions.spec.ts`: mock /named-sessions
  routes; assert create adds a tab, rename updates its label, close
  removes the tab, and the "first empty auto-creates Main" guard
  fires on an empty response.

### 6. Manual smoke (documented; not automated)

1. Start the hub. Verify the Alembic migration creates the
   `sessions` table (`sqlite3 registry.db ".schema sessions"`).
2. Open the dashboard. Expect a toast "Migrated N sessions to
   hub" (N = number of pre-existing localStorage sessions).
3. `sqlite3 registry.db "select * from sessions"` — confirm the
   rows exist with proper UUIDs.
4. Close the dashboard tab. Open a second browser / device.
   Observe: the same session names appear under each container
   (minus the PTY scrollback, as expected).
5. Rename a session → second device sees the new name within 30s
   (or instantly on focus).
6. Delete a container → the `sessions` rows for it are gone (FK
   CASCADE).
7. Reload dashboard → no duplicate migration toast (guard key
   prevents re-run).

## Critical files

- [hub/db/migrations/versions/m26_sessions.py](../../../hub/db/migrations/versions/) — new migration
- [hub/services/named_sessions.py](../../../hub/services/) — new service
- [hub/routers/named_sessions.py](../../../hub/routers/) — new router
- [hub/models/schemas.py](../../../hub/models/schemas.py) — `NamedSession*` models
- [hub/main.py](../../../hub/main.py) — register new router
- [hub/tests/test_named_sessions_service.py](../../../hub/tests/) — new
- [hub/tests/test_named_sessions_endpoint.py](../../../hub/tests/) — new
- [dashboard/src/lib/api.ts](../../../dashboard/src/lib/api.ts) — four new wrappers
- [dashboard/src/lib/types.ts](../../../dashboard/src/lib/types.ts) — `NamedSession*` types
- [dashboard/src/lib/migrateSessions.ts](../../../dashboard/src/lib/) — new one-shot migration
- [dashboard/src/hooks/useSessions.ts](../../../dashboard/src/hooks/) — new hook
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — swap localStorage reads; run migration on mount
- [dashboard/src/components/**tests**/](../../../dashboard/src/components/__tests__/) — vitest for hook + migration
- [dashboard/tests/e2e/named-sessions.spec.ts](../../../dashboard/tests/e2e/) — new Playwright

## Verification

Same shape as M20–M25:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub && mypy hive-agent` clean.
3. `pytest hub/tests` green — 317 existing + the M26 additions.
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green.
5. `npx playwright test` green.
6. `npx prettier --write .` in `dashboard/` before push
   (hook-vs-CI drift workaround from memory).
7. Manual smoke (above).
8. Branch merged `--no-ff` to `main`; tagged
   `v0.26-session-persistence`; push `--follow-tags`; CI watched
   to green; branch deleted.

## Follow-up tickets (out of scope for M26, queued for later)

### M27 — ε (Claude diff view)

- Second half of the originally bundled M26 (split out during
  brainstorming). Parse claude-mode PtyPane output; detect
  tool-use blocks via known prefixes; render file-edit diffs in a
  collapsible widget.
- Gets its own brainstorm + design pass when live Claude output is
  handy for parser calibration.
- First of the post-M26 follow-ups, since the ε scope predates the
  rest.

### M28 — Session reorder

- New `position: int` column on `sessions` with a default computed
  at insert time.
- `PATCH /api/named-sessions/{session_id}` accepts `position`
  alongside `name`.
- Frontend: drag-to-reorder in `SessionSubTabs` (already has drag
  scaffolding from M21 D for rename-order).

### M29 — Per-session runtime metadata

- Additional nullable columns or a sibling `session_prefs` table.
  Candidates: `last_cwd`, `font_size`, `theme`, `last_command`.
- The goal is to make "restore my session exactly how I left it"
  work across devices.

### M30 — WebSocket session-sync push

- New `sessions:<container_id>` WebSocket channel announces
  create/rename/close events so cross-device sync is instant
  instead of poll-based.
- Deferred until the 30s poll proves insufficient in practice.
