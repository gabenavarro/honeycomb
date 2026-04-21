# M28 — Session drag-to-reorder

**Status.** Approved 2026-04-21. First of the post-M26 follow-up
tickets (M27, M28, M29, M30 queued). M28 ships first because it's
the lowest-risk of the remaining four and builds directly on M26's
persistent-sessions table.

## Context

M26 shipped persistent named sessions: a `sessions` table, four
CRUD endpoints, a `useSessions` hook, and a one-shot migration.
The dashboard's `SessionSubTabs` already has drag scaffolding from
M21 D — it dispatches `onReorder(fromId, toId)` — but the handler
in `App.tsx` is a no-op stub because reordering wasn't part of
M26's scope.

M28 closes that loop. A `position: int` column lands on the
`sessions` table; the existing `PATCH /api/named-sessions/{id}`
endpoint gains an optional `position` field; `useSessions` grows a
`reorder` method; and `App.tsx`'s `reorderSession` stub wires the
existing drag signal through to the server.

Session ordering today relies on `created_at ASC` — first created,
first rendered. After M28, rows sort by `position ASC` first, with
`created_at` as a stable tiebreaker for legacy rows still at the
default position 0.

Codebase is at `v0.26-session-persistence`. SQLAlchemy + Alembic
plumbing from M7/M26 covers the schema change. No new frontend
primitives needed — only hook + handler changes.

## Goals

- Let the user drag a session tab left or right to reorder.
- Persist the order on the hub so reloads and cross-device loads
  show the same sequence (matches the M26 Tailscale-consistency
  rationale).
- Keep contiguous 1..N positions — no sparse float tricks, no
  LexoRank. A transactional renumber on every reorder is fine at
  ≤20 sessions per container.
- Reuse the existing `PATCH /named-sessions/{id}` endpoint —
  don't introduce a separate reorder route when one optional field
  suffices.

## Non-goals

- Sparse / fractional position encoding. YAGNI at this scale.
- Batch reorder (send full ordering in one call). Single-session
  move is the canonical drag event; batching adds complexity
  without a user-visible benefit.
- Dedicated `POST /reorder` endpoint. Partial PATCH with an
  optional `position` field is the REST-idiomatic fit.
- Instant cross-device push. The 30s staleTime + refetch-on-focus
  from M26 is sufficient for now; real-time sync is M30's scope.
- Drag between containers. Sessions are always container-scoped;
  cross-container drag isn't a reordering operation and is out of
  scope.

## Design

### 1. Architecture

```
┌─ hub/db/migrations ─ ALTER TABLE sessions ADD position ─────────┐
│  NOT NULL DEFAULT 0 + ix_sessions_container_position index.     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌─ hub/services/named_sessions.py ────────────────────────────────┐
│  patch_session(name?, position?) replaces rename_session.       │
│  When ``position`` is set, _reorder_within_container() opens a  │
│  transaction, removes the moved row from the current ordering,  │
│  reinserts at the requested index, and renumbers all rows to    │
│  contiguous 1..N. ``create_session`` now assigns next_pos =     │
│  max(position)+1 atomically.                                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌─ hub/routers/named_sessions.py ─────────────────────────────────┐
│  PATCH /api/named-sessions/{session_id} accepts                 │
│  ``{name?, position?}``. Empty body → 422.                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
              Dashboard: useSessions(containerId)
              gains reorder(sessionId, newPosition) with
              optimistic cache update — renumbers in-memory to
              match the server's deterministic output.
                            │
                            ▼
              App.tsx: reorderSession(fromId, toId) translates
              M21 D's drag signal into the target row's current
              position and calls useSessions.reorder().
```

### 2. Backend — migration + schema + service

#### Alembic migration

New file `hub/db/migrations/versions/2026_04_21_1200-m28_session_position.py`:

```python
"""M28 — session position column.

Adds ``position`` to the ``sessions`` table so users can reorder
tabs and have the order persist server-side + sync across devices.

Revision ID: m28_position
Revises: m26_sessions
Create Date: 2026-04-21 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "m28_position"
down_revision: str | Sequence[str] | None = "m26_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column(
            "position",
            sa.Integer,
            nullable=False,
            server_default="0",
        ),
    )
    op.create_index(
        "ix_sessions_container_position",
        "sessions",
        ["container_id", "position"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_sessions_container_position",
        table_name="sessions",
    )
    op.drop_column("sessions", "position")
```

Existing rows get `position = 0`. The first successful reorder in
any container triggers a full renumber to 1..N — legacy default-0
rows become contiguous from that point on.

#### Pydantic model changes (in `hub/models/schemas.py`)

`NamedSession` gains a `position: int` field:

```python
class NamedSession(BaseModel):
    session_id: str
    container_id: int
    name: str
    kind: Literal["shell", "claude"]
    position: int  # M28 — 1-based slot; 0 until first renumber.
    created_at: datetime
    updated_at: datetime
```

`NamedSessionPatch` becomes fully optional:

```python
class NamedSessionPatch(BaseModel):
    """Partial update. At least one field must be set (422 otherwise)."""

    name: str | None = Field(default=None, min_length=1, max_length=64)
    position: int | None = Field(default=None, ge=1)
```

The router asserts `name is None and position is None` → 422 with
`detail: "patch requires at least one field"`.

#### Service layer — `hub/services/named_sessions.py`

Three changes:

1. **`list_sessions` ORDER BY:**

```sql
ORDER BY position ASC, created_at ASC, session_id ASC
```

2. **`create_session` assigns sequential position:**

```python
async with engine.begin() as conn:
    next_pos = (
        await conn.execute(
            sa.text(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM sessions "
                "WHERE container_id = :cid"
            ),
            {"cid": container_id},
        )
    ).scalar_one()
    # ... existing INSERT, but now also sets position=next_pos.
```

3. **Replace `rename_session` with `patch_session`:**

```python
async def patch_session(
    engine: AsyncEngine,
    *,
    session_id: str,
    name: str | None = None,
    position: int | None = None,
) -> NamedSession:
    """Apply a partial update. Raises ``SessionNotFound`` if the
    row is missing. Raises ``ValueError`` if both ``name`` and
    ``position`` are None.

    When ``position`` is set, all other rows in the same container
    are renumbered atomically so positions stay contiguous 1..N.
    """
    if name is None and position is None:
        raise ValueError("patch requires at least one field")

    now = datetime.now().isoformat()
    async with engine.begin() as conn:
        current = (
            await conn.execute(
                sa.text(
                    "SELECT container_id, position FROM sessions "
                    "WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )
        ).mappings().first()
        if current is None:
            raise SessionNotFound(session_id)

        if position is not None:
            await _reorder_within_container(
                conn,
                container_id=current["container_id"],
                moved_session_id=session_id,
                new_position=position,
            )

        if name is not None:
            await conn.execute(
                sa.text(
                    "UPDATE sessions SET name = :name, updated_at = :now "
                    "WHERE session_id = :sid"
                ),
                {"name": name, "now": now, "sid": session_id},
            )

        row = (
            await conn.execute(
                sa.text(
                    "SELECT session_id, container_id, name, kind, position, "
                    "created_at, updated_at FROM sessions "
                    "WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )
        ).mappings().one()
    return _row_to_model(row)
```

Renumber helper:

```python
async def _reorder_within_container(
    conn,
    *,
    container_id: int,
    moved_session_id: str,
    new_position: int,
) -> None:
    """Move one session to ``new_position`` and renumber the rest.

    Fetch all sessions in the container ordered stably, remove the
    moved id, insert at the (clamped) target index, then rewrite
    every row's position in one pass.
    """
    rows = (
        await conn.execute(
            sa.text(
                "SELECT session_id FROM sessions "
                "WHERE container_id = :cid "
                "ORDER BY position ASC, created_at ASC, session_id ASC"
            ),
            {"cid": container_id},
        )
    ).mappings().all()
    ids = [r["session_id"] for r in rows]
    if moved_session_id not in ids:
        raise SessionNotFound(moved_session_id)
    ids.remove(moved_session_id)
    target = max(1, min(new_position, len(ids) + 1))
    ids.insert(target - 1, moved_session_id)
    for new_pos, sid in enumerate(ids, start=1):
        await conn.execute(
            sa.text(
                "UPDATE sessions SET position = :pos "
                "WHERE session_id = :sid"
            ),
            {"pos": new_pos, "sid": sid},
        )
```

The existing `rename_session` function is inlined into the router
(see below) — all logic now lives behind `patch_session`. One
fewer public symbol in the service module.

#### Router change — `hub/routers/named_sessions.py`

```python
@router.patch(
    "/api/named-sessions/{session_id}",
    response_model=NamedSession,
)
async def patch_named_session_endpoint(
    session_id: str, request: Request, body: NamedSessionPatch
) -> NamedSession:
    if body.name is None and body.position is None:
        raise HTTPException(422, "patch requires at least one field")
    registry = request.app.state.registry
    try:
        return await patch_session(
            registry.engine,
            session_id=session_id,
            name=body.name,
            position=body.position,
        )
    except SessionNotFound:
        raise HTTPException(
            404, f"Session {session_id} not found"
        )
```

Drop the import of `rename_session` from the router; replace with
`patch_session`.

#### Tests

**Migration — `hub/tests/test_m28_session_position_migration.py` (new):**

- Column added with `DEFAULT 0`.
- Index `ix_sessions_container_position` exists.
- Existing rows (inserted before the migration) survive with
  `position = 0`.

**Service — extend `hub/tests/test_named_sessions_service.py`:**

- `create_session` assigns sequential positions (1, 2, 3…).
- `list_sessions` orders by `position ASC`.
- `patch_session(name=...)` renames without touching positions.
- `patch_session(position=N)` renumbers contiguously across
  move-up / move-down / move-to-first / move-to-last.
- `patch_session(position > len)` clamps to the end.
- `patch_session(position < 1)` is rejected by Pydantic's `ge=1`
  (tested at the route layer; service asserts `ge=1` upstream).
- `patch_session(name, position)` applies both atomically.
- `patch_session()` with neither raises `ValueError`.

**Endpoint — extend `hub/tests/test_named_sessions_endpoint.py`:**

- `PATCH {position: N}` returns renumbered row.
- `PATCH {}` returns 422.
- `PATCH {position: 1}` with only 1 session keeps the same row at
  position 1.
- `PATCH {name, position}` returns row with both changes applied.
- `PATCH {position: 0}` returns 422 (Pydantic `ge=1`).

### 3. Dashboard — `useSessions.reorder` + API wrapper + App.tsx

#### New API wrapper — `dashboard/src/lib/api.ts`

```ts
export const reorderNamedSession = (sessionId: string, position: number) =>
  request<NamedSession>(`/named-sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position }),
  });
```

No new type — returns `NamedSession` like the other PATCH callers.
Rename API wrapper stays as-is (it already sends `{name}` only).

#### TS type update — `dashboard/src/lib/types.ts`

`NamedSession` gains `position: number` (non-optional; server
always returns it, falling back to 0 for legacy rows).

#### `useSessions` hook extension

Add one mutation + one method:

```tsx
const reorderMutation = useMutation({
  mutationFn: ({ sessionId, position }: { sessionId: string; position: number }) =>
    reorderNamedSession(sessionId, position),
  onMutate: async ({ sessionId, position }) => {
    await qc.cancelQueries({ queryKey });
    const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
    const moved = previous.find((s) => s.session_id === sessionId);
    if (!moved) return { previous };
    const without = previous.filter((s) => s.session_id !== sessionId);
    const target = Math.max(1, Math.min(position, without.length + 1));
    without.splice(target - 1, 0, moved);
    // Re-emit positions so the array AND the position field agree.
    const renumbered = without.map((s, i) => ({ ...s, position: i + 1 }));
    qc.setQueryData<NamedSession[]>(queryKey, renumbered);
    return { previous };
  },
  onError: (_err, _vars, ctx) => {
    if (ctx) qc.setQueryData(queryKey, ctx.previous);
  },
});

const reorder = useCallback(
  async (sessionId: string, newPosition: number) => {
    await reorderMutation.mutateAsync({
      sessionId,
      position: newPosition,
    });
  },
  [reorderMutation],
);
```

`UseSessionsResult` grows:

```ts
reorder: (sessionId: string, newPosition: number) => Promise<void>;
```

#### `App.tsx` — wire reorderSession to the hook

Replace the current M26 no-op stub:

```tsx
const reorderSession = useCallback(
  (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const fromIdx = namedSessions.findIndex((s) => s.session_id === fromId);
    const toIdx = namedSessions.findIndex((s) => s.session_id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    // The M21 D drop handler already implements "insert BEFORE the
    // target" semantics via (fromIdx < toIdx ? toIdx - 1 : toIdx).
    // Translating to positions: the target row's current position
    // is where the moved row lands, regardless of direction —
    // the server's renumber inside patch_session absorbs the shift.
    const target = namedSessions[toIdx];
    void reorderApi(fromId, target.position || toIdx + 1);
  },
  [namedSessions, reorderApi],
);
```

Add `reorder: reorderApi` to the destructured `useSessions` result.

The `target.position || toIdx + 1` fallback handles legacy rows
still at position 0 before their first renumber — use the row's
array index (1-based) as a reasonable "wherever they sit now"
target. The first successful reorder in the container renumbers
everyone.

#### Tests

**`useSessions.test.tsx` — extend:**

- `reorder(id, N)` updates the cache optimistically with
  renumbered positions.
- Out-of-bounds position (> length) clamps to the end, < 1 clamps
  to the start.
- Rollback on server error restores previous ordering.

**Playwright `named-sessions.spec.ts` — extend:**

- Seed 3 sessions with positions 1, 2, 3. Dispatch a synthetic
  drag from tab 3 to tab 1's slot (Playwright's `dragTo` on the
  tab strip). Assert the server received a
  `PATCH /named-sessions/<id3> {position: 1}`. Assert the rendered
  tab order matches `[3, 1, 2]`.

### 4. Error handling + edge cases

| Case                                    | Behaviour                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag onto self (`fromId === toId`)      | Early return; no network call.                                                                                                                                            |
| Drag a pending (optimistic) session row | Its `session_id` starts with `pending-`; `reorderSession` skips it (no server target).                                                                                    |
| Server rejects (500)                    | Optimistic cache rolls back; toast surfaces the error via the existing TanStack Query error path.                                                                         |
| Session deleted mid-drag (404)          | Rollback; next refetch removes the tab.                                                                                                                                   |
| Legacy rows at position 0               | `ORDER BY position ASC, created_at ASC, session_id ASC` keeps them stable-ordered. First reorder triggers the renumber that lifts them to 1..N.                           |
| Position < 1 or > length                | Clamped server-side (in `_reorder_within_container`) and client-side (in `onMutate`). Client values < 1 are also blocked by Pydantic's `ge=1` before they hit the server. |
| Two devices reorder simultaneously      | SQLite single-writer serializes the transactions. Losing device sees the winner's order on next 30s poll / focus refetch.                                                 |
| `PATCH {}` (neither field set)          | 422 with `detail: "patch requires at least one field"`. Pre-M28 clients that still PATCH `{name}` are unaffected.                                                         |

### 5. Testing summary

- **pytest** — 1 new migration test, ~8 new service + endpoint assertions.
- **vitest** — 3 new `useSessions` cases.
- **Playwright** — 1 new `named-sessions.spec.ts` case.

### 6. Manual smoke (documented; not automated)

1. Open the dashboard with ≥2 sessions per container.
2. Drag the rightmost tab to position 1 — tab order updates;
   database `SELECT position FROM sessions WHERE container_id =
1 ORDER BY position` shows 1..N contiguously.
3. Reload the browser — the new order persists.
4. Open the dashboard on a second device over Tailscale within
   ~30s — same order appears.
5. Rename a session via the existing inline edit — position
   unchanged.
6. `PATCH` with both `{name, position}` via curl — both changes
   applied in one round trip.

## Critical files

- [hub/db/migrations/versions/2026_04_21_1200-m28_session_position.py](../../../hub/db/migrations/versions/) — new
- [hub/models/schemas.py](../../../hub/models/schemas.py) — `NamedSession.position`, `NamedSessionPatch` optional fields
- [hub/services/named_sessions.py](../../../hub/services/named_sessions.py) — `create_session` sequential, `patch_session` replaces `rename_session`, `_reorder_within_container` helper
- [hub/routers/named_sessions.py](../../../hub/routers/named_sessions.py) — PATCH handler uses `patch_session`
- [hub/tests/test_m28_session_position_migration.py](../../../hub/tests/) — new
- [hub/tests/test_named_sessions_service.py](../../../hub/tests/) — extended
- [hub/tests/test_named_sessions_endpoint.py](../../../hub/tests/) — extended
- [dashboard/src/lib/api.ts](../../../dashboard/src/lib/api.ts) — `reorderNamedSession`
- [dashboard/src/lib/types.ts](../../../dashboard/src/lib/types.ts) — `NamedSession.position`
- [dashboard/src/hooks/useSessions.ts](../../../dashboard/src/hooks/useSessions.ts) — `reorder` mutation + method
- [dashboard/src/hooks/**tests**/useSessions.test.tsx](../../../dashboard/src/hooks/__tests__/) — extended
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — `reorderSession` wires to `reorder` API
- [dashboard/tests/e2e/named-sessions.spec.ts](../../../dashboard/tests/e2e/) — extended

## Verification

Same shape as M20–M26:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub && mypy hive-agent` clean.
3. `pytest hub/tests` green (338 existing + M28 additions).
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green.
5. `npx playwright test` green.
6. `npx prettier --write .` in `dashboard/` before push
   (hook-vs-CI drift workaround).
7. Manual smoke (above).
8. Branch merged `--no-ff` to `main`; tagged
   `v0.28-session-reorder`; push `--follow-tags`; CI watched;
   branch deleted.

## Follow-up tickets (unchanged from M26 queue)

- **M29** — per-session runtime metadata (font_size, last_cwd,
  theme, last_command).
- **M30** — WebSocket session-sync push (instant cross-device
  propagation of create/rename/close/reorder).
- **M27** — ε Claude diff view (requires live Claude output
  calibration).
