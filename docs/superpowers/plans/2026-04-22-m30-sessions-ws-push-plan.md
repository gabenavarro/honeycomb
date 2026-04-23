# M30 — WebSocket session-sync push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sub-second propagation of named-session CRUD (create / rename / delete / reorder) across every dashboard subscribed to the same container, by broadcasting a uniform `list` frame on the `sessions:<container_id>` channel after every hub-side commit and replacing the TanStack Query cache wholesale on the client.

**Architecture:** Reuse the existing multiplexed `/ws` transport + module-level `ConnectionManager`. Add a `_broadcast_sessions_list(engine, container_id)` helper in `hub/routers/named_sessions.py` that fires after each CRUD commit. Extend `delete_session` to return the deleted row's `container_id` so the router knows what to broadcast. On the client, grow `useSessions` with one `useEffect` that subscribes via `useHiveWebSocket` and `setQueryData`-replaces the cache on `list` events. TanStack Query's 30s `staleTime` + `refetchOnWindowFocus` stay as the safety net.

**Tech Stack:** FastAPI (router + Pydantic `WSFrame`), SQLAlchemy async + sqlite, Python `logging`, React 19 + TanStack Query v5, Vitest + `@testing-library/react`, pytest-asyncio + httpx.

**Branch:** `m30-sessions-ws-push` (already created; spec committed as `045eecc`).

**Spec:** [docs/superpowers/specs/2026-04-22-m30-sessions-ws-push-design.md](../specs/2026-04-22-m30-sessions-ws-push-design.md)

---

## File Structure

### Hub

- **Modify** `hub/services/named_sessions.py` — `delete_session` returns `int | None` (the deleted row's `container_id`, or `None` when the row was absent).
- **Modify** `hub/routers/named_sessions.py` — add `_broadcast_sessions_list` helper; wire it into the four CRUD handlers.
- **Modify** `hub/tests/test_named_sessions_service.py` — one new contract test.
- **Modify** `hub/tests/test_named_sessions_endpoint.py` — five new broadcast cases, plus a `mock_ws_manager` fixture.

### Dashboard

- **Modify** `dashboard/src/hooks/useSessions.ts` — import `useHiveWebSocket`, add a `useEffect` that subscribes, listens, and `setQueryData`-replaces the cache.
- **Modify** `dashboard/src/hooks/__tests__/useSessions.test.tsx` — mock `useHiveWebSocket`; add four cases in a `describe("useSessions.ws", …)` block.

### No new files.

---

## Task 1: Extend `delete_session` to return `int | None`

Service-layer contract change first — the router can't know which container to broadcast for on delete unless the service tells it.

**Files:**

- Modify: `hub/services/named_sessions.py:239-251`
- Modify: `hub/tests/test_named_sessions_service.py` (append one test)

- [ ] **Step 1: Add the failing contract test**

Append at the end of `hub/tests/test_named_sessions_service.py`:

```python
@pytest.mark.asyncio
async def test_delete_session_returns_container_id(engine) -> None:
    """M30 — delete returns the container_id of the removed row so
    routers can broadcast the post-delete list; returns None for a
    missing id."""
    from hub.services.named_sessions import create_session, delete_session

    session = await create_session(engine, container_id=1, name="gone", kind="shell")
    result = await delete_session(engine, session_id=session.session_id)
    assert result == 1

    missing = await delete_session(engine, session_id="nope")
    assert missing is None
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_service.py::test_delete_session_returns_container_id -v
```

Expected: FAIL with `AssertionError` — `delete_session` currently returns `None` (implicit) for both cases, so the first `assert result == 1` fails.

- [ ] **Step 3: Update `delete_session` to return `int | None`**

Replace the existing `delete_session` function body in `hub/services/named_sessions.py` (currently at lines 239-251):

```python
async def delete_session(
    engine: AsyncEngine,
    *,
    session_id: str,
) -> int | None:
    """Remove ``session_id`` if present. Idempotent — calling for a
    nonexistent id is a silent no-op (matches ``DELETE`` REST
    semantics).

    Returns the deleted row's ``container_id`` so callers can
    broadcast WS events after a successful delete; returns ``None``
    when the row didn't exist.
    """
    async with engine.begin() as conn:
        row = (
            await conn.execute(
                sa.text(
                    "SELECT container_id FROM sessions WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )
        ).first()
        if row is None:
            return None
        container_id = int(row[0])
        await conn.execute(
            sa.text("DELETE FROM sessions WHERE session_id = :sid"),
            {"sid": session_id},
        )
    return container_id
```

- [ ] **Step 4: Run the full service test module**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_service.py -v
```

Expected: PASS — the new test passes, and the existing `test_delete_removes_row` / `test_delete_missing_is_idempotent` / `test_cascade_on_container_delete` all still pass because none of them bind the return value.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/named_sessions.py hub/tests/test_named_sessions_service.py
git commit -m "feat(m30): delete_session returns container_id for WS broadcast

Extends the service contract so the named-sessions router can
fire a post-delete broadcast. Returns None when the row didn't
exist — delete stays idempotent."
```

---

## Task 2: Add imports, `_broadcast_sessions_list` helper, and `mock_ws_manager` fixture

Add the helper and its import seam together with the test fixture that will monkeypatch it. No router wiring yet — this task compiles cleanly and every existing test still passes; the helper is dead code until Task 3 calls it.

**Files:**

- Modify: `hub/routers/named_sessions.py` (imports + helper)
- Modify: `hub/tests/test_named_sessions_endpoint.py` (imports + fixture)

- [ ] **Step 1: Update router imports + add helper**

**1a.** Replace the imports block in `hub/routers/named_sessions.py` (lines 16-27) with:

```python
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import NamedSession, NamedSessionCreate, NamedSessionPatch
from hub.routers.ws import WSFrame, manager as ws_manager
from hub.services.named_sessions import (
    SessionNotFound,
    create_session,
    delete_session,
    list_sessions,
    patch_session,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["named-sessions"])
```

**1b.** Add the helper immediately after the `router = APIRouter(…)` line:

```python
async def _broadcast_sessions_list(engine, container_id: int) -> None:
    """Re-query the full named-sessions list for ``container_id`` and
    publish it on the ``sessions:<container_id>`` channel. Best-effort
    — broadcast failures are logged and swallowed so CRUD success is
    independent of WS health. Event name is always ``list``; clients
    replace the TanStack Query cache wholesale."""
    try:
        sessions = await list_sessions(engine, container_id=container_id)
        frame = WSFrame(
            channel=f"sessions:{container_id}",
            event="list",
            data=[s.model_dump(mode="json") for s in sessions],
        )
        await ws_manager.broadcast(frame)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to broadcast sessions list for container %s: %s",
            container_id,
            exc,
        )
```

Aliasing `manager as ws_manager` keeps the call-site + monkeypatch target unambiguous (bare `manager` is too generic when the router already has a `router` local).

- [ ] **Step 2: Add the `mock_ws_manager` fixture**

In `hub/tests/test_named_sessions_endpoint.py`, add this import near the top of the imports block (after the existing `from httpx import …`):

```python
from unittest.mock import AsyncMock, MagicMock
```

Then append this fixture immediately after the existing `client` fixture (around line 49):

```python
@pytest.fixture
def mock_ws_manager(monkeypatch):
    """Replace the ``ws_manager`` alias imported into
    ``hub.routers.named_sessions`` at module load.

    Individual tests assert on ``mock.broadcast.await_args`` to
    confirm the WSFrame shape without reaching into
    ``ConnectionManager``'s internal subscription set.
    """
    from hub.routers import named_sessions as router_module

    mock = MagicMock()
    mock.broadcast = AsyncMock()
    monkeypatch.setattr(router_module, "ws_manager", mock)
    return mock
```

- [ ] **Step 3: Run the full hub test suite**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

Expected: every existing test PASSes. The helper is never called yet — the router still has zero broadcast wire-ups — so nothing changes from a behaviour perspective. The new fixture is dormant (no test requests it yet).

- [ ] **Step 4: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/named_sessions.py hub/tests/test_named_sessions_endpoint.py
git commit -m "feat(m30): add _broadcast_sessions_list helper + test fixture

Helper re-queries the named-sessions list and broadcasts a
uniform 'list' frame on sessions:<cid>. Not wired to any CRUD
handler yet — subsequent commits turn it on per endpoint. The
mock_ws_manager fixture monkeypatches the ws_manager alias so
per-endpoint tests can assert on broadcast call shape."
```

---

## Task 3: Wire `_broadcast_sessions_list` into `create_named_session_endpoint`

TDD: test first.

**Files:**

- Modify: `hub/routers/named_sessions.py` (create handler)
- Modify: `hub/tests/test_named_sessions_endpoint.py` (one broadcast test)

- [ ] **Step 1: Write the failing create-broadcast test**

Append at the bottom of `hub/tests/test_named_sessions_endpoint.py`:

```python
# --- M30: WS session-sync push ---


@pytest.mark.asyncio
async def test_create_broadcasts_list(
    client: AsyncClient, mock_ws_manager
) -> None:
    """POST /api/containers/{id}/named-sessions must broadcast a
    ``list`` frame on ``sessions:{id}`` carrying the full post-commit
    NamedSession[] for that container."""
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "Alpha", "kind": "shell"},
    )
    assert resp.status_code == 200

    assert mock_ws_manager.broadcast.await_count == 1
    frame = mock_ws_manager.broadcast.await_args.args[0]
    assert frame.channel == "sessions:1"
    assert frame.event == "list"
    assert isinstance(frame.data, list)
    assert len(frame.data) == 1
    assert frame.data[0]["session_id"] == resp.json()["session_id"]
    assert frame.data[0]["name"] == "Alpha"
```

- [ ] **Step 2: Run the new test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py::test_create_broadcasts_list -v
```

Expected: FAIL with `AssertionError: assert 0 == 1` on `mock_ws_manager.broadcast.await_count` — the create handler doesn't call the helper yet.

- [ ] **Step 3: Wire the create handler**

Replace `create_named_session_endpoint` in `hub/routers/named_sessions.py` with:

```python
@router.post(
    "/api/containers/{record_id}/named-sessions",
    response_model=NamedSession,
)
async def create_named_session_endpoint(
    record_id: int, request: Request, body: NamedSessionCreate
) -> NamedSession:
    """Create a new session row. Server generates ``session_id``.
    Broadcasts the post-commit list on ``sessions:<record_id>``."""
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    result = await create_session(
        registry.engine,
        container_id=record_id,
        name=body.name,
        kind=body.kind,
    )
    await _broadcast_sessions_list(registry.engine, record_id)
    return result
```

- [ ] **Step 4: Run the full endpoint test module**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py -v
```

Expected: PASS for `test_create_broadcasts_list`, plus every existing endpoint test. (Tests that don't request the `mock_ws_manager` fixture hit the real `ConnectionManager.broadcast`, which is a no-op when no clients are subscribed.)

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/named_sessions.py hub/tests/test_named_sessions_endpoint.py
git commit -m "feat(m30): broadcast sessions:list on create"
```

---

## Task 4: Wire `_broadcast_sessions_list` into the rename/patch endpoint

**Files:**

- Modify: `hub/routers/named_sessions.py` (patch handler)
- Modify: `hub/tests/test_named_sessions_endpoint.py` (one broadcast test)

- [ ] **Step 1: Write the failing patch-broadcast test**

Append to `hub/tests/test_named_sessions_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_patch_broadcasts_list(
    client: AsyncClient, mock_ws_manager
) -> None:
    """PATCH /api/named-sessions/{id} (rename or position) must
    broadcast the full post-commit list for the session's container."""
    create = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "orig"},
    )
    sid = create.json()["session_id"]
    mock_ws_manager.broadcast.reset_mock()

    resp = await client.patch(
        f"/api/named-sessions/{sid}",
        headers=AUTH,
        json={"name": "renamed"},
    )
    assert resp.status_code == 200

    assert mock_ws_manager.broadcast.await_count == 1
    frame = mock_ws_manager.broadcast.await_args.args[0]
    assert frame.channel == "sessions:1"
    assert frame.event == "list"
    assert len(frame.data) == 1
    assert frame.data[0]["name"] == "renamed"
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py::test_patch_broadcasts_list -v
```

Expected: FAIL — `broadcast.await_count == 0` after the PATCH.

- [ ] **Step 3: Wire the patch handler**

Replace `rename_named_session_endpoint` in `hub/routers/named_sessions.py` with:

```python
@router.patch(
    "/api/named-sessions/{session_id}",
    response_model=NamedSession,
)
async def rename_named_session_endpoint(
    session_id: str, request: Request, body: NamedSessionPatch
) -> NamedSession:
    """Partial update (M26; M28 adds optional ``position``).

    Empty body → 422. ``SessionNotFound`` → 404. Otherwise returns
    the updated row (with renumbered position if ``position`` was
    set) and broadcasts the post-commit list on ``sessions:<cid>``.
    """
    if body.name is None and body.position is None:
        raise HTTPException(422, "patch requires at least one field")
    registry = request.app.state.registry
    try:
        result = await patch_session(
            registry.engine,
            session_id=session_id,
            name=body.name,
            position=body.position,
        )
    except SessionNotFound:
        raise HTTPException(404, f"Session {session_id} not found")
    await _broadcast_sessions_list(registry.engine, result.container_id)
    return result
```

- [ ] **Step 4: Run the full endpoint test module**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py -v
```

Expected: PASS — new `test_patch_broadcasts_list` green; every existing test still green.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/named_sessions.py hub/tests/test_named_sessions_endpoint.py
git commit -m "feat(m30): broadcast sessions:list on patch (rename + reorder)"
```

---

## Task 5: Wire `_broadcast_sessions_list` into the delete endpoint

Delete is trickier than create/patch: the router has to decide whether to broadcast _based on the return value_ of the service call. Two tests: present row broadcasts, missing row does not.

**Files:**

- Modify: `hub/routers/named_sessions.py` (delete handler)
- Modify: `hub/tests/test_named_sessions_endpoint.py` (two broadcast tests)

- [ ] **Step 1: Write the failing delete-broadcasts test**

Append to `hub/tests/test_named_sessions_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_delete_broadcasts_list(
    client: AsyncClient, mock_ws_manager
) -> None:
    """DELETE /api/named-sessions/{id} must broadcast the post-commit
    list for the deleted row's container. When the deleted row was
    the last one, the list is empty."""
    create = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "bye"},
    )
    sid = create.json()["session_id"]
    mock_ws_manager.broadcast.reset_mock()

    resp = await client.delete(f"/api/named-sessions/{sid}", headers=AUTH)
    assert resp.status_code == 204

    assert mock_ws_manager.broadcast.await_count == 1
    frame = mock_ws_manager.broadcast.await_args.args[0]
    assert frame.channel == "sessions:1"
    assert frame.event == "list"
    assert frame.data == []


@pytest.mark.asyncio
async def test_delete_missing_does_not_broadcast(
    client: AsyncClient, mock_ws_manager
) -> None:
    """DELETE on a nonexistent session returns 204 but must NOT
    broadcast — nothing changed, no need to announce."""
    resp = await client.delete("/api/named-sessions/nope", headers=AUTH)
    assert resp.status_code == 204
    assert mock_ws_manager.broadcast.await_count == 0
```

- [ ] **Step 2: Run and confirm both fail**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py -k "delete_broadcasts or delete_missing_does_not_broadcast" -v
```

Expected:

- `test_delete_broadcasts_list`: FAIL (`broadcast.await_count == 0`).
- `test_delete_missing_does_not_broadcast`: PASS coincidentally (it was already 0), but that's fine — we write it before the implementation so it's captured as a regression guard.

- [ ] **Step 3: Wire the delete handler**

Replace `delete_named_session_endpoint` in `hub/routers/named_sessions.py` with:

```python
@router.delete("/api/named-sessions/{session_id}", status_code=204)
async def delete_named_session_endpoint(session_id: str, request: Request) -> None:
    """Delete a session. Idempotent — 204 even when the row didn't
    exist. Broadcasts ``sessions:<cid>`` only when a row was actually
    deleted (missing rows yield None from the service)."""
    registry = request.app.state.registry
    container_id = await delete_session(registry.engine, session_id=session_id)
    if container_id is not None:
        await _broadcast_sessions_list(registry.engine, container_id)
```

- [ ] **Step 4: Run the full endpoint module**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py -v
```

Expected: both new delete tests PASS; everything else stays green.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/named_sessions.py hub/tests/test_named_sessions_endpoint.py
git commit -m "feat(m30): broadcast sessions:list on delete (no-op when missing)"
```

---

## Task 6: Regression test — broadcast failure must not block CRUD

No wiring change: we already designed the helper to swallow+log. This test pins that behaviour so a future "cleanup" that removes the try/except gets caught.

**Files:**

- Modify: `hub/tests/test_named_sessions_endpoint.py` (one test)

- [ ] **Step 1: Write the test**

Append to `hub/tests/test_named_sessions_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_broadcast_failure_does_not_block_crud(
    client: AsyncClient, mock_ws_manager
) -> None:
    """If the WS broadcast raises, the CRUD response must still
    succeed. The helper logs + swallows; success/failure of the
    transport is orthogonal to success of the write."""
    mock_ws_manager.broadcast.side_effect = RuntimeError("ws boom")

    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "still-works", "kind": "shell"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "still-works"
    # The helper still attempted to broadcast — the exception was
    # raised on the await, then caught by the helper.
    assert mock_ws_manager.broadcast.await_count == 1
```

- [ ] **Step 2: Run the test and confirm it passes**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_named_sessions_endpoint.py::test_broadcast_failure_does_not_block_crud -v
```

Expected: PASS — the helper catches `RuntimeError` and logs a warning; the POST still returns 200.

If this test fails, it means the try/except in `_broadcast_sessions_list` doesn't catch the exception — re-check the helper body from Task 3 Step 3b.

- [ ] **Step 3: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/tests/test_named_sessions_endpoint.py
git commit -m "test(m30): broadcast failure does not block CRUD"
```

---

## Task 7: Full hub regression pass + lint/type

Before moving to the dashboard, make sure the hub is clean.

- [ ] **Step 1: Run the hub test suite**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

Expected: all tests PASS. Track the total count — M30 adds 6 new tests (5 endpoint + 1 service) on top of the existing 354.

- [ ] **Step 2: Run the hub linters**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check .
uv run mypy .
```

Expected: clean. If mypy complains about `delete_session`'s return-type change at callsites, check `hub/` for any bare `await delete_session(…)` that captures the result — there shouldn't be any other than the router.

- [ ] **Step 3: No commit needed** (verification only).

---

## Task 8: Dashboard — `useSessions.ws` subscription lifecycle

The hook grows one `useEffect` that subscribes on mount, installs a listener, and unsubscribes on cleanup. TDD: start with a mock of `useHiveWebSocket`, then four test cases, then the implementation.

**Files:**

- Modify: `dashboard/src/hooks/__tests__/useSessions.test.tsx` — add module-level WS mock + new `describe("useSessions.ws", …)` block
- Modify: `dashboard/src/hooks/useSessions.ts` — import `useEffect` + `useHiveWebSocket`, add subscription effect

- [ ] **Step 1: Add the WS mock scaffolding at module scope**

In `dashboard/src/hooks/__tests__/useSessions.test.tsx`, immediately below the existing `mockReorder` definition (around line 18), add:

```tsx
const mockSubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
const mockUnsubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
type WsFrame = { channel: string; event: string; data: unknown };
type WsListener = (frame: WsFrame) => void;
const mockOnChannel = vi.hoisted(() => vi.fn<(channel: string, cb: WsListener) => () => void>());
const mockListenerRemovers = vi.hoisted(() => [] as Array<() => void>);

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    connected: true,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    onChannel: mockOnChannel,
  }),
}));
```

Then in the existing `beforeEach` block (around line 50), extend the reset list:

```tsx
beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockRename.mockReset();
  mockDelete.mockReset();
  mockReorder.mockReset();
  mockSubscribe.mockReset();
  mockUnsubscribe.mockReset();
  mockListenerRemovers.length = 0;
  mockOnChannel.mockReset();
  mockOnChannel.mockImplementation((_channel, _cb) => {
    const remover = vi.fn();
    mockListenerRemovers.push(remover);
    return remover;
  });
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
```

- [ ] **Step 2: Add the four test cases**

Append to `dashboard/src/hooks/__tests__/useSessions.test.tsx`:

```tsx
// --- M30: WebSocket session-sync push ---

describe("useSessions.ws", () => {
  it("subscribes on mount with non-null containerId", () => {
    mockList.mockResolvedValue([]);
    renderHook(() => useSessions(1), { wrapper });
    expect(mockSubscribe).toHaveBeenCalledWith(["sessions:1"]);
    expect(mockOnChannel).toHaveBeenCalledTimes(1);
    expect(mockOnChannel.mock.calls[0][0]).toBe("sessions:1");
    expect(typeof mockOnChannel.mock.calls[0][1]).toBe("function");
  });

  it("does not subscribe when containerId is null", () => {
    renderHook(() => useSessions(null), { wrapper });
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockOnChannel).not.toHaveBeenCalled();
  });

  it("list frame replaces the cache wholesale", async () => {
    mockList.mockResolvedValue([session("a")]);
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));

    const listener = mockOnChannel.mock.calls[0][1];
    act(() => {
      listener({
        channel: "sessions:1",
        event: "list",
        data: [session("z", "z")],
      });
    });

    await waitFor(() => expect(result.current.sessions.map((s) => s.session_id)).toEqual(["z"]));
  });

  it("unsubscribes + removes listener on containerId change", () => {
    mockList.mockResolvedValue([]);
    const { rerender } = renderHook(({ id }) => useSessions(id), {
      wrapper,
      initialProps: { id: 1 as number | null },
    });
    expect(mockSubscribe).toHaveBeenCalledWith(["sessions:1"]);
    const firstRemover = mockListenerRemovers[0];

    rerender({ id: 2 });

    expect(mockUnsubscribe).toHaveBeenCalledWith(["sessions:1"]);
    expect(firstRemover).toHaveBeenCalled();
    // New subscription on the new container.
    expect(mockSubscribe).toHaveBeenCalledWith(["sessions:2"]);
  });
});
```

- [ ] **Step 3: Run the new tests and confirm they fail**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useSessions.test.tsx -t "useSessions.ws"
```

Expected: all four fail — the hook doesn't call `subscribe`/`onChannel` yet.

- [ ] **Step 4: Implement the subscription effect in `useSessions.ts`**

In `dashboard/src/hooks/useSessions.ts`:

**4a.** Update imports (lines 12-22) to:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import {
  createNamedSession,
  deleteNamedSession,
  listNamedSessions,
  renameNamedSession,
  reorderNamedSession,
} from "../lib/api";
import type { NamedSession, NamedSessionCreate, SessionKind } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";
```

**4b.** In the body of `useSessions`, immediately after the `const query = useQuery(…)` block (before `const createMutation = …`), add:

```tsx
const ws = useHiveWebSocket();

// M30 — WebSocket push: every hub-side CRUD commit broadcasts a
// ``list`` frame with the full NamedSession[] for the container.
// We replace the cache wholesale; TanStack Query's 30s staleTime
// + refetchOnWindowFocus stay as the fallback for events missed
// during a reconnect gap.
useEffect(() => {
  if (containerId === null) return;
  const channel = `sessions:${containerId}`;
  ws.subscribe([channel]);
  const removeListener = ws.onChannel(channel, (frame) => {
    if (frame.event !== "list") return;
    const next = frame.data as NamedSession[];
    qc.setQueryData<NamedSession[]>(queryKey, next);
  });
  return () => {
    removeListener();
    ws.unsubscribe([channel]);
  };
  // queryKey is derived from containerId; ws is a stable singleton
  // wrapper. Including them would just re-trigger the effect on
  // every render without changing behaviour.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [containerId, ws, qc]);
```

- [ ] **Step 5: Run the full useSessions test file**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useSessions.test.tsx
```

Expected: every test PASSes — the 4 new `useSessions.ws` cases, plus the existing `useSessions` + `useSessions.reorder` blocks (unchanged behaviour because the WS hook is mocked and the new effect is a no-op on null containerId).

- [ ] **Step 6: Run the full dashboard test suite**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

Expected: every existing test still green. The module-level `vi.mock("../useWebSocket", …)` is scoped to `useSessions.test.tsx` only (it's inside that file); other test files are unaffected.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useSessions.ts dashboard/src/hooks/__tests__/useSessions.test.tsx
git commit -m "feat(m30): useSessions subscribes to sessions:<cid> WS channel

Every list frame replaces the TanStack Query cache wholesale.
30s staleTime + refetchOnWindowFocus stay as the safety net for
events missed during a reconnect gap."
```

---

## Task 9: Dashboard typecheck + lint

Use `tsc -b` (composite) not `tsc --noEmit` — per the memory, CI catches composite-resolver errors that the root config misses.

- [ ] **Step 1: Run the composite typecheck**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

Expected: clean. If `setQueryData<NamedSession[]>(queryKey, next)` complains about `queryKey`'s `as const` tuple — good, you're hitting TS 5.x's stricter tuple inference — adjust with `setQueryData(queryKey as unknown as [string, number | null], next)` as a last resort, but the first form should just work.

- [ ] **Step 2: Run lint**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm run lint
```

Expected: clean.

- [ ] **Step 3: No commit needed** (verification only).

---

## Task 10: Prettier sweep

Per the `prettier_hook_vs_ci.md` memory: run the dashboard's prettier before push. The pre-commit hook's pinned prettier is older than CI's; running here catches drift CI would otherwise flag.

- [ ] **Step 1: Run prettier --write in dashboard/**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
```

- [ ] **Step 2: Inspect the diff**

```bash
cd /home/gnava/repos/honeycomb
git status
git diff
```

Expected: zero or tiny diff on the M30-touched files. If prettier reformats lots of unrelated files, STOP — this means an older commit drifted; don't bundle unrelated reformats into the M30 branch. If only M30-touched files changed, continue.

- [ ] **Step 3: Commit if anything changed**

```bash
cd /home/gnava/repos/honeycomb
git add -A
git diff --cached --quiet || git commit -m "style(m30): prettier sweep before push"
```

`git diff --cached --quiet` returns non-zero (i.e. the `||` fires) only when there's something to commit. No commit happens if the sweep was a no-op.

---

## Task 11: Manual two-tab smoke test

Before merging, verify the user-facing behaviour once.

- [ ] **Step 1: Start the hub**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run hive
```

Leave it running in the foreground.

- [ ] **Step 2: Start the dashboard dev server (separate terminal)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm run dev
```

- [ ] **Step 3: Open two browser tabs** pointed at `http://localhost:5173`. Both authenticate with the same bearer token. Both pick the same container from the sidebar.

- [ ] **Step 4: In tab A**, rename one session. **In tab B**, confirm the new name appears within ~1 second (well under the 30s poll staleTime).

- [ ] **Step 5: In tab A**, create a new session. **In tab B**, confirm it appears at the end of the list within ~1 second.

- [ ] **Step 6: In tab A**, drag-reorder a session. **In tab B**, confirm the order updates within ~1 second.

- [ ] **Step 7: In tab A**, close a session. **In tab B**, confirm it disappears within ~1 second.

If all four propagate cleanly, stop the dev server and hub.

If anything fails: check the browser console in tab B for errors; check the hub logs for `Failed to broadcast sessions list` warnings.

---

## Task 12: Pre-commit run + branch merge + tag + push

- [ ] **Step 1: Full pre-commit run**

```bash
cd /home/gnava/repos/honeycomb
pre-commit run --all-files
```

Expected: clean.

- [ ] **Step 2: Merge `m30-sessions-ws-push` into `main`**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only
git merge --no-ff m30-sessions-ws-push -m "Merge M30: WebSocket session-sync push"
```

- [ ] **Step 3: Tag `v0.30-sessions-ws-push`**

```bash
cd /home/gnava/repos/honeycomb
git tag -a v0.30-sessions-ws-push -m "M30: WebSocket session-sync push"
```

- [ ] **Step 4: Push with --follow-tags**

```bash
cd /home/gnava/repos/honeycomb
git push --follow-tags origin main
```

- [ ] **Step 5: Watch CI**

```bash
cd /home/gnava/repos/honeycomb
gh run list --branch main --limit 3
gh run watch $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: green. If CI fails on `tsc -b --noEmit` despite local pass, the memory's warning was right — read the failure, fix on `main` (new commit, not branch restore), push, re-watch.

- [ ] **Step 6: Delete the merged branch**

```bash
cd /home/gnava/repos/honeycomb
git branch -d m30-sessions-ws-push
git push origin --delete m30-sessions-ws-push
```

---

## Verification Checklist

Before marking the milestone done, confirm:

- [ ] `cd hub && uv run pytest tests -q` — green (360 tests = 354 + 6 new).
- [ ] `cd hub && uv run ruff check . && uv run mypy .` — clean.
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint && npx vitest run` — all green.
- [ ] `pre-commit run --all-files` — clean.
- [ ] Manual two-tab smoke (Task 11) — all 4 propagations <1s.
- [ ] Branch merged `--no-ff` into `main`; `v0.30-sessions-ws-push` tag present; `git push --follow-tags` clean; CI green.
- [ ] Feature branch deleted locally and on origin.
