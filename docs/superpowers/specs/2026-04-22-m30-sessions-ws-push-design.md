# M30 — WebSocket session-sync push

**Status.** Approved 2026-04-22. Second of the post-M28 follow-up
tickets to ship (M29 was considered + deferred; M27 ε Claude diff
view remains queued). Builds on M26's persistent sessions + M28's
reorder work.

## Context

M26 shipped persistent named sessions with a 30s TanStack Query
`staleTime` plus `refetchOnWindowFocus: true`. Cross-device sync
works but is "eventually consistent with noticeable delay": two
dashboards open side-by-side see up to a 30-second lag before a
rename or reorder on one propagates to the other. The user
reported this as real friction worth fixing — the main scenario is
touching a session from Device A while Device B's dashboard is
watching over Tailscale.

Honeycomb already has a multiplexed `/ws` WebSocket with
room-based subscriptions. Container events, command output, and
problem feeds already ride on it. M30 adds one more channel
pattern — `sessions:<container_id>` — and a uniform `list` event
that carries the full ordered `NamedSession[]` for that container.
Every CRUD commit in the hub fires the event; every mounted
dashboard subscribed to the channel replaces its TanStack Query
cache wholesale.

The full-list payload (≤20 rows × ~200 bytes = ~4 KiB) is the
smallest-footprint path that avoids per-event merge logic. The
30s poll + refetch-on-focus stay as the safety net for events
missed during WS reconnects.

Codebase is at `v0.28-session-reorder`.

## Goals

- Sub-second propagation of session CRUD (create / rename /
  delete / reorder) across every Tailscale-reachable dashboard
  subscribed to the same container.
- Zero new transport primitive — reuse the existing multiplexed
  `/ws` + `ConnectionManager` + `useHiveWebSocket` hook.
- Uniform payload: every event carries the full `NamedSession[]`
  list for the container. Client replaces the cache; no merge.
- Zero regression to M26's polling: the push is a
  latency-reduction layer on top of the existing poll, not a
  replacement.

## Non-goals

- Per-event granular payloads (created / renamed / closed /
  reordered with different shapes). Uniform `list` is the
  intentional simplification.
- WebSocket transport rewrite. Existing hub + hook stay.
- Subscriptions for containers the user isn't currently focused
  on. The `useSessions` hook drives subscriptions; it only
  mounts for the active container.
- Auth / ACL changes. The existing bearer-token WS handshake
  already gates channel access.
- Broadcast to OTHER session-adjacent concepts (PTY live state,
  resource history). Those already have their own channels /
  poll paths.

## Design

### 1. Architecture

```
┌─ hub/routers/named_sessions.py ─────────────────────────────────┐
│  After each CRUD commit, call                                   │
│  _broadcast_sessions_list(app, container_id) which:             │
│    1. list_sessions(engine, container_id=...) → NamedSession[]  │
│    2. WSFrame(channel="sessions:<cid>", event="list", data=...) │
│    3. app.state.ws_manager.broadcast(frame)                     │
│  Failures inside broadcast are logged + swallowed — CRUD        │
│  success is independent of WS health.                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
            ConnectionManager.broadcast (existing, M11)
                            │
                            ▼
 Every subscriber on channel "sessions:<cid>" receives the frame
                            │
                            ▼
┌─ dashboard/src/hooks/useSessions.ts ────────────────────────────┐
│  useEffect: on mount (+ on containerId change):                 │
│    - ws.subscribe([`sessions:${containerId}`])  transport-sub   │
│    - ws.onChannel(channel, listener)            JS-side listen  │
│  listener:                                                      │
│    if frame.event === "list":                                   │
│      qc.setQueryData(["named-sessions", cid], frame.data)       │
│  cleanup: removeListener() + ws.unsubscribe([channel])          │
│  M26's 30s staleTime + refetchOnWindowFocus stay as fallback.   │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Backend — broadcast helper + four CRUD hooks

#### New helper in `hub/routers/named_sessions.py`

Placed near the top of the router module, after the imports:

```python
import logging

from hub.routers.ws import WSFrame, manager as ws_manager

logger = logging.getLogger(__name__)


async def _broadcast_sessions_list(engine, container_id: int) -> None:
    """Re-query the full named-sessions list for a container and
    publish it on the ``sessions:<container_id>`` channel.

    Best-effort: if the broadcast fails, the CRUD call itself still
    returns success. Event name is always ``list`` — the client
    replaces its TanStack Query cache wholesale rather than merging
    per-event payloads.
    """
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

Implementation notes:

- `WSFrame` and `manager` are exported from `hub/routers/ws.py`.
  The manager is a module-level singleton, not mounted on
  `app.state` — importing it directly mirrors how other hub
  components (e.g., `problem_log`, `claude_relay`) broadcast.
- `model_dump(mode="json")` ensures `datetime` fields serialise as
  ISO strings, matching the REST responses.
- The bare-except-with-log pattern is deliberate. WS broadcast
  problems must never break CRUD.
- Call sites pass `registry.engine` directly — the helper doesn't
  need the `Request`/`app` at all. Keeps the seam testable.

#### Four CRUD handler modifications

Each existing handler in `hub/routers/named_sessions.py` grows
one `await _broadcast_sessions_list(...)` line, placed after the
service call commits and before returning.

**create_named_session_endpoint** — broadcast with `record_id`:

```python
result = await create_session(...)
await _broadcast_sessions_list(registry.engine, record_id)
return result
```

**rename_named_session_endpoint** (PATCH) — broadcast with
`result.container_id`:

```python
try:
    result = await patch_session(
        registry.engine, session_id=session_id, name=body.name, position=body.position,
    )
except SessionNotFound:
    raise HTTPException(404, f"Session {session_id} not found")
await _broadcast_sessions_list(registry.engine, result.container_id)
return result
```

**delete_named_session_endpoint** — needs the `container_id` of
the row being deleted. `delete_session` currently returns `None`.
Extend its contract to return `int | None`:

```python
async def delete_session(
    engine: AsyncEngine,
    *,
    session_id: str,
) -> int | None:
    """Remove ``session_id`` if present. Returns the deleted row's
    ``container_id`` so callers can broadcast WS events; returns
    ``None`` when the row didn't exist (delete is idempotent, no
    broadcast needed)."""
    async with engine.begin() as conn:
        row = (
            await conn.execute(
                sa.text(
                    "SELECT container_id FROM sessions "
                    "WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )
        ).first()
        if row is None:
            return None
        container_id = row[0]
        await conn.execute(
            sa.text("DELETE FROM sessions WHERE session_id = :sid"),
            {"sid": session_id},
        )
    return container_id
```

Router:

```python
container_id = await delete_session(registry.engine, session_id=session_id)
if container_id is not None:
    await _broadcast_sessions_list(registry.engine, container_id)
return Response(status_code=204)
```

The existing 204 behaviour stays. If the session was already gone,
no broadcast — nothing changed to announce.

#### Tests

`hub/tests/test_named_sessions_endpoint.py` extensions:

- `test_create_broadcasts_list` — after POST, assert the mocked
  `ws_manager.broadcast` was called once with
  `channel="sessions:<record_id>"`, `event="list"`, and `data`
  containing the newly-created row.
- `test_patch_broadcasts_list` — same after PATCH (rename or
  position).
- `test_delete_broadcasts_list` — after DELETE, assert broadcast
  fires with the remaining rows (or `[]` if it was the last).
- `test_delete_missing_does_not_broadcast` — DELETE for a
  nonexistent id returns 204 and does NOT call broadcast.
- `test_broadcast_failure_does_not_block_crud` — if the
  `ws_manager` mock's broadcast raises, the CRUD response is
  still 200. Assert the response body + that broadcast was
  attempted.

The tests monkeypatch the module-level `manager` imported in
`hub.routers.named_sessions` with a `MagicMock(broadcast=AsyncMock())`
so individual cases can assert on `.broadcast.call_args` without
reaching into `ConnectionManager`'s internal `_active` set. A
`mock_ws_manager` fixture centralises the monkeypatch + reset.

`hub/tests/test_named_sessions_service.py` — one addition:

- `test_delete_session_returns_container_id` — verifies the new
  contract. Returns the id for present rows, `None` for missing.

### 3. Dashboard — `useSessions` subscription lifecycle

#### Extension to `dashboard/src/hooks/useSessions.ts`

Import the existing `useHiveWebSocket` hook (defined in
`dashboard/src/hooks/useWebSocket.ts`). The hook returns
`{connected, subscribe, unsubscribe, onChannel}`:

- `subscribe(channels: string[])` — ref-counted transport-level
  subscription. Tells the hub to start sending frames on these
  channels.
- `unsubscribe(channels: string[])` — drops the ref count;
  removes the transport subscription when it hits zero.
- `onChannel(channel: string, cb: Listener)` — installs a
  per-channel JS listener. Returns an unsubscribe function for
  the listener. Listener receives a frame shaped
  `{channel, event, data}`.

Effect added just before the mutations (or anywhere inside the
hook body before the `return`):

```tsx
import { useHiveWebSocket } from "./useWebSocket";
// ... existing imports ...

export function useSessions(containerId: number | null): UseSessionsResult {
  const qc = useQueryClient();
  const queryKey = ["named-sessions", containerId] as const;
  const ws = useHiveWebSocket();

  const query = useQuery({
    queryKey,
    queryFn: () => listNamedSessions(containerId as number),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // M30 — WebSocket push: every hub-side CRUD commit broadcasts a
  // ``list`` frame with the full NamedSession[] for the container.
  // We replace the cache wholesale; TanStack Query's 30s
  // staleTime + refetchOnWindowFocus stay as the fallback for
  // events missed during a reconnect gap.
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
    // queryKey is stable across renders for a fixed containerId;
    // ws comes from useHiveWebSocket and is also stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, ws, qc]);

  // ... existing mutations + return ...
}
```

Type gotcha: `queryKey` has the `as const` tuple type; TanStack
Query's `setQueryData` generic accepts it. No cast required.

#### Tests

Add to `dashboard/src/hooks/__tests__/useSessions.test.tsx`:

```tsx
// Mock the WS hook at module level.
const mockSubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
const mockUnsubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
const mockOnChannel = vi.hoisted(() =>
  vi.fn<
    (
      channel: string,
      cb: (frame: { channel: string; event: string; data: unknown }) => void,
    ) => () => void
  >(),
);

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    connected: true,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    onChannel: mockOnChannel,
  }),
}));

// ... reset in beforeEach ...
```

Four new cases in a `describe("useSessions.ws", ...)` block:

1. **subscribes on mount with non-null containerId** — assert
   `mockSubscribe` was called once with `["sessions:1"]` and
   `mockOnChannel` was called once with `"sessions:1"` + a
   function.
2. **does not subscribe when containerId is null** — neither
   `mockSubscribe` nor `mockOnChannel` called.
3. **list frame replaces the cache** — arrange: the listener
   captured via `mockOnChannel` is invoked with a `list` frame
   carrying `[session("z", "z")]`. Act: await waitFor. Assert:
   `result.current.sessions` now reads `[{session_id: "z", ...}]`.
4. **unsubscribes on containerId change** — rerender with a
   different id; assert the old channel's `unsubscribe` was
   called AND the listener-unsubscribe fn was called (captured
   via the return value of `mockOnChannel`).

### 4. Error handling + edge cases

| Case                                        | Behaviour                                                                                                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS disconnected when a CRUD fires elsewhere | Frame missed. 30s staleTime + focus-refetch catch up next time the user returns to the tab.                                                                                                                                                                    |
| Hub-side broadcast raises                   | Logged + swallowed; CRUD still returns success.                                                                                                                                                                                                                |
| Two devices race                            | Both CRUD commits broadcast sequentially. Last-write-wins on every subscriber's cache; all converge.                                                                                                                                                           |
| Listener lands mid-mount race               | `setQueryData` is idempotent; if an initial GET is still in flight, its response overwrites the listener's data (or vice versa) — both paths return the same list shape, so the final state is coherent. Rare transient flicker on container switch; accepted. |
| User switches container mid-session         | Cleanup fires before re-subscribe on the new id. `unsubscribe` is ref-counted, so overlapping dashboards on the same channel stay subscribed.                                                                                                                  |
| Frame with unknown `event` field            | Listener early-returns (only handles `event === "list"`). Forward-compatible with future event types if M30's scope expands.                                                                                                                                   |
| WS reconnect replays subscriptions          | The existing `useHiveWebSocket` replays live subscriptions on reconnect (see `useWebSocket.ts` line 151). M30 inherits this automatically.                                                                                                                     |

### 5. Testing summary

- **pytest** — 5 endpoint test extensions + 1 service contract
  test for `delete_session`'s new return type.
- **vitest** — 4 new `useSessions.ws` cases.
- **Playwright** — not applicable. Cross-device sync is hard to
  stage in a single Playwright browser context, and the
  vitest + pytest coverage pins the contract at the seams.
- **Manual smoke** — open the dashboard in two browser tabs
  pointed at the same container. Rename / reorder / close a
  session in tab A. Tab B should reflect the change within
  ~100ms (no 30s wait).

## Critical files

- [hub/routers/named_sessions.py](../../../hub/routers/named_sessions.py) — new `_broadcast_sessions_list` helper + 4 CRUD hooks
- [hub/services/named_sessions.py](../../../hub/services/named_sessions.py) — `delete_session` returns `int | None`
- [hub/tests/test_named_sessions_endpoint.py](../../../hub/tests/) — 5 broadcast cases
- [hub/tests/test_named_sessions_service.py](../../../hub/tests/) — 1 contract test
- [dashboard/src/hooks/useSessions.ts](../../../dashboard/src/hooks/useSessions.ts) — subscribe effect
- [dashboard/src/hooks/**tests**/useSessions.test.tsx](../../../dashboard/src/hooks/__tests__/) — 4 ws cases

## Verification

Same shape as M20–M28:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub && mypy hive-agent` clean.
3. `pytest hub/tests` green (354 existing + M30 additions).
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green.
5. `npx playwright test` green (unchanged suite; M30 adds no e2e).
6. `npx prettier --write .` in `dashboard/` before push.
7. Manual smoke: two-tab rename-and-see sync test (above).
8. Branch merged `--no-ff` to `main`; tagged
   `v0.30-sessions-ws-push`; push `--follow-tags`; CI watched;
   branch deleted.

## Follow-up tickets (remaining queue)

- **M27** — ε Claude diff view (requires live Claude output
  calibration; last queued item).
