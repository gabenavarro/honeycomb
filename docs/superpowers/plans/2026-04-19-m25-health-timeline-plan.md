# M25 Implementation Plan — Container-health timeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A three-sparkline (CPU · MEM · GPU) strip above `SessionSubTabs` showing the last 5 minutes of resource usage for the focused container, backed by a hub-side ring buffer that survives reloads and is shared across every Tailscale-reachable device. Click opens the existing `ResourceMonitor` popover; a `timeline_visible` setting hides the strip globally.

**Architecture:** Ring buffer (`deque(maxlen=60)`) lives on the `ResourceMonitor` instance, appended to on every 5s poll. New `GET /api/containers/{id}/resources/history` exposes it. Dashboard `useResourceHistory` hook hydrates from `/history` on mount and appends each live `/resources` tick; dedup handles the hydration/first-live overlap. `<HealthTimeline>` renders three recharts sparklines inside a Radix Popover trigger that opens a second instance of the existing `ResourceMonitor` component for details. New boolean `timeline_visible` field in `HiveSettings` + `MUTABLE_FIELDS` surfaces as a toggle in `SettingsView`.

**Tech Stack:** FastAPI + pydantic-settings; `collections.deque` for the ring buffer; recharts (already a dep) for sparklines; Radix Popover/Tooltip; TanStack Query v5 for the hydration + live poll.

---

## File structure

### Created

- `hub/tests/test_resource_monitor_history.py` — unit tests for buffer + cleanup
- `hub/tests/test_resources_history_endpoint.py` — route integration tests
- `dashboard/src/hooks/useResourceHistory.ts` — history hook
- `dashboard/src/hooks/__tests__/useResourceHistory.test.tsx` — vitest
- `dashboard/src/components/HealthTimeline.tsx` — sparkline strip
- `dashboard/src/components/__tests__/HealthTimeline.test.tsx` — vitest
- `dashboard/tests/e2e/health-timeline.spec.ts` — Playwright

### Modified

- `hub/services/resource_monitor.py` — `_history` + `_record_sample` + `get_history` + `clear_history`
- `hub/routers/containers.py` — new `/resources/history` route
- `hub/config.py` — new `timeline_visible` field
- `hub/routers/settings.py` — add `"timeline_visible"` to `MUTABLE_FIELDS`
- `hub/tests/test_settings_overrides.py` — assertion that `timeline_visible` is mutable + round-trips via PATCH
- `dashboard/src/lib/api.ts` — `getResourceHistory` wrapper
- `dashboard/src/lib/types.ts` — verify `ResourceStats.timestamp` field
- `dashboard/src/components/SettingsView.tsx` — new toggle row
- `dashboard/src/App.tsx` — mount `<HealthTimeline>` conditionally

---

## Task 1: Hub ring buffer on `ResourceMonitor` (TDD)

**Files:**

- Modify: `hub/services/resource_monitor.py`
- Create: `hub/tests/test_resource_monitor_history.py`

- [ ] **Step 1: Create failing test.**

```python
"""Unit tests for ResourceMonitor ring-buffer history (M25)."""

from __future__ import annotations

from datetime import datetime

from hub.models.schemas import ResourceStats
from hub.services.resource_monitor import HISTORY_CAP, ResourceMonitor


def _sample(cid: str, cpu: float = 1.0) -> ResourceStats:
    return ResourceStats(
        container_id=cid,
        cpu_percent=cpu,
        memory_mb=1.0,
        memory_limit_mb=100.0,
        memory_percent=1.0,
        timestamp=datetime.now(),
    )


class TestResourceHistory:
    def test_record_and_read_empty(self) -> None:
        rm = ResourceMonitor()
        assert rm.get_history("nope") == []

    def test_record_sample_appends(self) -> None:
        rm = ResourceMonitor()
        a = _sample("c1", 1.0)
        b = _sample("c1", 2.0)
        rm._record_sample("c1", a)
        rm._record_sample("c1", b)
        history = rm.get_history("c1")
        assert len(history) == 2
        assert [s.cpu_percent for s in history] == [1.0, 2.0]

    def test_caps_at_history_cap(self) -> None:
        rm = ResourceMonitor()
        for i in range(HISTORY_CAP + 5):
            rm._record_sample("c1", _sample("c1", float(i)))
        history = rm.get_history("c1")
        assert len(history) == HISTORY_CAP
        # Oldest 5 dropped; first surviving cpu is 5.0.
        assert history[0].cpu_percent == 5.0
        assert history[-1].cpu_percent == float(HISTORY_CAP + 4)

    def test_get_history_returns_snapshot(self) -> None:
        # Mutating the returned list must not affect the internal buffer.
        rm = ResourceMonitor()
        rm._record_sample("c1", _sample("c1", 1.0))
        snap = rm.get_history("c1")
        snap.clear()
        assert len(rm.get_history("c1")) == 1

    def test_clear_history(self) -> None:
        rm = ResourceMonitor()
        rm._record_sample("c1", _sample("c1"))
        rm._record_sample("c2", _sample("c2"))
        rm.clear_history("c1")
        assert rm.get_history("c1") == []
        assert len(rm.get_history("c2")) == 1

    def test_clear_history_unknown_is_noop(self) -> None:
        rm = ResourceMonitor()
        rm.clear_history("nope")  # no raise

    def test_isolation_per_container(self) -> None:
        rm = ResourceMonitor()
        rm._record_sample("c1", _sample("c1", 1.0))
        rm._record_sample("c2", _sample("c2", 2.0))
        assert rm.get_history("c1")[0].cpu_percent == 1.0
        assert rm.get_history("c2")[0].cpu_percent == 2.0
```

- [ ] **Step 2: Run — fails.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_resource_monitor_history.py -v
```

Expected: `ImportError` on `HISTORY_CAP` and `_record_sample` / `get_history` / `clear_history`.

- [ ] **Step 3: Add `_history` + helpers to `ResourceMonitor`.**

In `hub/services/resource_monitor.py`, add at the top of the file next to the existing imports:

```python
from collections import deque
```

Add the module-level constant near the existing top-level setup (above the class definition):

```python
# M25 — one ring buffer per container_id; capped at 60 samples
# (= 5 minutes at the default 5s poll cadence). Lives on the
# ResourceMonitor instance rather than module state so tests can
# instantiate multiple monitors without cross-test bleed.
HISTORY_CAP = 60
```

Inside `ResourceMonitor.__init__`, after `self._stats_cache: dict[str, ResourceStats] = {}`, add:

```python
        self._history: dict[str, deque[ResourceStats]] = {}
```

Add three methods to the class (place them after `get_all_stats`):

```python
    def _record_sample(self, container_id: str, stats: ResourceStats) -> None:
        """Append a sample to the per-container ring buffer. Creates
        the buffer on first use."""
        buf = self._history.get(container_id)
        if buf is None:
            buf = deque(maxlen=HISTORY_CAP)
            self._history[container_id] = buf
        buf.append(stats)

    def get_history(self, container_id: str) -> list[ResourceStats]:
        """Return the last ``HISTORY_CAP`` samples for a container.

        Returns an empty list when the container hasn't been sampled
        yet (or was cleared). The returned list is a snapshot —
        mutating it does not affect the internal buffer.
        """
        return list(self._history.get(container_id, ()))

    def clear_history(self, container_id: str) -> None:
        """Drop the buffer for ``container_id``. Idempotent — safe to
        call for containers that were never sampled."""
        self._history.pop(container_id, None)
```

- [ ] **Step 4: Wire the poll tick to record samples.**

Find the existing `poll_once` method. At the line `self._stats_cache[cid] = stats`, add `self._record_sample(cid, stats)` immediately after:

```python
            self._stats_cache[cid] = stats
            self._record_sample(cid, stats)
```

- [ ] **Step 5: Run — passing.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_resource_monitor_history.py -v
```

Expected: 7 passing.

- [ ] **Step 6: Full hub suite — catch regressions in any existing `ResourceMonitor` consumer.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 302 + 7 new = 309 passing.

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/resource_monitor.py hub/tests/test_resource_monitor_history.py
git commit -m "feat(m25): ring-buffer history on ResourceMonitor"
```

---

## Task 2: New `/resources/history` route (TDD)

**Files:**

- Create: `hub/tests/test_resources_history_endpoint.py`
- Modify: `hub/routers/containers.py`

- [ ] **Step 1: Write failing route tests.**

Create `hub/tests/test_resources_history_endpoint.py`:

```python
"""Integration tests for GET /api/containers/{id}/resources/history (M25)."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.models.schemas import ResourceStats


class _FakeRecord:
    def __init__(self, container_id: str | None = "deadbeef") -> None:
        self.container_id = container_id


class _FakeRegistry:
    def __init__(self, record: _FakeRecord | None) -> None:
        self._record = record

    async def get(self, record_id: int) -> _FakeRecord:  # noqa: ARG002
        if self._record is None:
            raise KeyError(record_id)
        return self._record


def _sample(cid: str = "deadbeef", cpu: float = 42.0) -> ResourceStats:
    return ResourceStats(
        container_id=cid,
        cpu_percent=cpu,
        memory_mb=100.0,
        memory_limit_mb=1024.0,
        memory_percent=10.0,
        timestamp=datetime.now(),
    )


async def _client(
    registry: _FakeRegistry,
    history_by_cid: dict[str, list[ResourceStats]] | None = None,
) -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = registry
    rm = MagicMock()
    rm.get_history = MagicMock(side_effect=lambda cid: (history_by_cid or {}).get(cid, []))
    app.state.resource_monitor = rm
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_history_empty_list_when_no_samples() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_history_returns_buffer() -> None:
    registry = _FakeRegistry(_FakeRecord("deadbeef"))
    history = {"deadbeef": [_sample(cpu=1.0), _sample(cpu=2.0), _sample(cpu=3.0)]}
    async with await _client(registry, history_by_cid=history) as c:
        resp = await c.get(
            "/api/containers/1/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 3
    assert [s["cpu_percent"] for s in body] == [1.0, 2.0, 3.0]


@pytest.mark.asyncio
async def test_history_unauthorized() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get("/api/containers/1/resources/history")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_history_404_on_unknown_record() -> None:
    registry = _FakeRegistry(None)
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/999/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_history_empty_when_record_has_no_docker_id() -> None:
    # A registered record that never started a container — container_id
    # is None. Return [] rather than 404.
    registry = _FakeRegistry(_FakeRecord(container_id=None))
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json() == []
```

- [ ] **Step 2: Run — fails (route not mounted).**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_resources_history_endpoint.py -v
```

Expected: 404 on every path.

- [ ] **Step 3: Add the route to `hub/routers/containers.py`.**

Find the existing `get_resources` endpoint (look for `@router.get("/{record_id}/resources"`). Insert the new route immediately after it:

```python
@router.get(
    "/{record_id}/resources/history",
    response_model=list[ResourceStats],
)
async def get_resources_history(
    request: Request, record_id: int
) -> list[ResourceStats]:
    """Return the last 60 resource samples (5 min at 5s cadence) for
    the given container.

    Returns an empty list when the container was just registered and
    hasn't been sampled yet, when its container_id is still unset, or
    after ``clear_history`` was called. An empty buffer is a valid
    state — clients render a muted "Collecting…" placeholder rather
    than treating it as an error.
    """
    registry = request.app.state.registry
    resource_monitor = request.app.state.resource_monitor
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404)

    if not record.container_id:
        return []
    return resource_monitor.get_history(record.container_id)
```

- [ ] **Step 4: Run — passing.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_resources_history_endpoint.py -v
```

Expected: 5 passing.

- [ ] **Step 5: Full hub suite.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 309 + 5 = 314 passing.

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/containers.py hub/tests/test_resources_history_endpoint.py
git commit -m "feat(m25): GET /api/containers/{id}/resources/history route"
```

---

## Task 3: `timeline_visible` setting + mutable flag (TDD)

**Files:**

- Modify: `hub/config.py`
- Modify: `hub/routers/settings.py`
- Modify: `hub/tests/test_settings_overrides.py`

- [ ] **Step 1: Find the relevant portion of the existing settings test.**

Open `hub/tests/test_settings_overrides.py` and read it to find:

- The test that lists `mutable_fields` (search for `mutable_fields`).
- A test that PATCHes a boolean (for `metrics_enabled`) — use it as the template for the new `timeline_visible` PATCH assertion.

- [ ] **Step 2: Add failing assertions.**

Append to `hub/tests/test_settings_overrides.py`:

```python
@pytest.mark.asyncio
async def test_timeline_visible_appears_in_mutable_fields(
    authed_client,
) -> None:
    """M25 — timeline_visible must be declared mutable so the
    SettingsView can render it as a toggle."""
    resp = await authed_client.get("/api/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert "timeline_visible" in body["mutable_fields"]
    # Default is True.
    assert body["values"]["timeline_visible"] is True


@pytest.mark.asyncio
async def test_timeline_visible_patch_round_trips(authed_client) -> None:
    """M25 — PATCH flips the flag; subsequent GET reflects it."""
    resp = await authed_client.patch(
        "/api/settings",
        json={"timeline_visible": False},
    )
    assert resp.status_code == 200
    resp = await authed_client.get("/api/settings")
    assert resp.json()["values"]["timeline_visible"] is False
    # Flip back for any follow-on test.
    await authed_client.patch("/api/settings", json={"timeline_visible": True})
```

The `authed_client` fixture should already exist from prior tests in the file — reuse its name. If the file uses a different fixture name (e.g. `client`), update accordingly.

- [ ] **Step 3: Run — fails.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_settings_overrides.py -v
```

Expected: assertion fails on "timeline_visible" not in `mutable_fields`.

- [ ] **Step 4: Add the field to `hub/config.py`.**

Find the existing `metrics_enabled` field in the `HiveSettings` class. Add directly below it:

```python
    timeline_visible: bool = Field(
        default=True,
        description=(
            "Whether the dashboard shows the three-sparkline health "
            "timeline above the session tabs. Shared across all "
            "devices that sync via this hub."
        ),
    )
```

Also add a corresponding `HubSettingsPatch` typed dict entry if one exists in this file. Search for "HubSettingsPatch" to confirm.

- [ ] **Step 5: Add to `MUTABLE_FIELDS` in `hub/routers/settings.py`.**

Find the `MUTABLE_FIELDS` set. Add `"timeline_visible"`:

```python
MUTABLE_FIELDS: set[str] = {
    "log_level",
    "discover_roots",
    "metrics_enabled",
    "timeline_visible",
}
```

If the PATCH handler uses a Pydantic model (e.g., `SettingsPatch`) with explicit field declarations rather than `MUTABLE_FIELDS` alone, also add `timeline_visible: bool | None = None` to that model.

- [ ] **Step 6: Run — passing.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_settings_overrides.py -v
```

Expected: all passing including the two new cases.

- [ ] **Step 7: Full hub suite.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 314 + 2 = 316 passing.

- [ ] **Step 8: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/config.py hub/routers/settings.py hub/tests/test_settings_overrides.py
git commit -m "feat(m25): timeline_visible setting + MUTABLE_FIELDS entry"
```

---

## Task 4: Dashboard — `getResourceHistory` API wrapper

**Files:**

- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/lib/types.ts` (verify only)

- [ ] **Step 1: Verify `ResourceStats` TS type exists with `timestamp`.**

```bash
grep -n "interface ResourceStats\|type ResourceStats" /home/gnava/repos/honeycomb/dashboard/src/lib/types.ts
```

If the interface is present and has a `timestamp: string` field, no change needed. If the field is missing, add it:

```ts
export interface ResourceStats {
  container_id: string;
  cpu_percent: number;
  memory_mb: number;
  memory_limit_mb: number;
  memory_percent: number;
  gpu_utilization?: number | null;
  gpu_memory_mb?: number | null;
  gpu_memory_total_mb?: number | null;
  timestamp: string;
}
```

- [ ] **Step 2: Add the wrapper to `dashboard/src/lib/api.ts`.**

Find the existing `getContainerResources` export (the live single-sample fetch). Add the history wrapper immediately below it:

```ts
export const getResourceHistory = (id: number) =>
  request<ResourceStats[]>(`/containers/${id}/resources/history`);
```

Ensure `ResourceStats` is already in the type import list at the top; add it if missing.

- [ ] **Step 3: Typecheck.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/api.ts dashboard/src/lib/types.ts
git commit -m "feat(m25): getResourceHistory API wrapper + ResourceStats type check"
```

---

## Task 5: `useResourceHistory` hook (TDD)

**Files:**

- Create: `dashboard/src/hooks/useResourceHistory.ts`
- Create: `dashboard/src/hooks/__tests__/useResourceHistory.test.tsx`

- [ ] **Step 1: Write failing tests.**

Create `dashboard/src/hooks/__tests__/useResourceHistory.test.tsx`:

```tsx
/** useResourceHistory tests (M25).
 *
 * Covers: hydration from /history seed, appending from /resources
 * live ticks, ring-buffer cap at 60, dedup on duplicate timestamp,
 * and re-key on container switch.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useResourceHistory } from "../useResourceHistory";

const mockHistory = vi.hoisted(() => vi.fn<(id: number) => Promise<unknown>>());
const mockLive = vi.hoisted(() => vi.fn<(id: number) => Promise<unknown>>());

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getResourceHistory: mockHistory,
    getContainerResources: mockLive,
  };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function sample(ts: string, cpu = 1.0) {
  return {
    container_id: "c1",
    cpu_percent: cpu,
    memory_mb: 1.0,
    memory_limit_mb: 100.0,
    memory_percent: 1.0,
    timestamp: ts,
  };
}

beforeEach(() => {
  mockHistory.mockReset();
  mockLive.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

describe("useResourceHistory", () => {
  it("does not fetch when containerId is null", () => {
    const { result } = renderHook(() => useResourceHistory(null), { wrapper });
    expect(result.current).toEqual([]);
    expect(mockHistory).not.toHaveBeenCalled();
    expect(mockLive).not.toHaveBeenCalled();
  });

  it("hydrates buffer from seed response", async () => {
    mockHistory.mockResolvedValue([sample("t1", 1), sample("t2", 2)]);
    mockLive.mockResolvedValue(null);
    const { result } = renderHook(() => useResourceHistory(1), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((s) => s.cpu_percent)).toEqual([1, 2]);
  });

  it("appends each live sample after hydration", async () => {
    mockHistory.mockResolvedValue([sample("t1", 1)]);
    let resolveLive: (v: unknown) => void = () => {};
    mockLive.mockImplementation(
      () =>
        new Promise((res) => {
          resolveLive = res;
        }),
    );
    const { result } = renderHook(() => useResourceHistory(1), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(1));

    await act(async () => {
      resolveLive(sample("t2", 2));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current[1].cpu_percent).toBe(2);
  });

  it("dedupes when live first tick matches last seed timestamp", async () => {
    mockHistory.mockResolvedValue([sample("tX", 42)]);
    mockLive.mockResolvedValue(sample("tX", 42));
    const { result } = renderHook(() => useResourceHistory(1), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(1));
    // If dedup failed we'd see length 2; the matching timestamp must
    // be collapsed.
    expect(result.current.length).toBe(1);
  });

  it("caps buffer at 60 entries", async () => {
    // Seed with 60 entries; a 61st live sample should drop the oldest.
    mockHistory.mockResolvedValue(Array.from({ length: 60 }, (_v, i) => sample(`t${i}`, i)));
    mockLive.mockResolvedValue(sample("t60", 60));
    const { result } = renderHook(() => useResourceHistory(1), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(60));
    // First surviving entry is index 1 (t1), last is 60 (t60).
    expect(result.current[0].cpu_percent).toBe(1);
    expect(result.current[result.current.length - 1].cpu_percent).toBe(60);
  });
});
```

- [ ] **Step 2: Run — fails (hook not defined).**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useResourceHistory.test.tsx
```

- [ ] **Step 3: Implement the hook.**

Create `dashboard/src/hooks/useResourceHistory.ts`:

```tsx
/** Resource-sample history for the active container (M25).
 *
 * On mount: fetches ``GET /resources/history`` once to hydrate the
 * last 5 minutes of samples from the hub's ring buffer — so a
 * reload, or a new device opening the dashboard over Tailscale,
 * shows the same 5-minute window the last session saw.
 *
 * While live: subscribes to the existing ``/resources`` React Query
 * cache that ``ResourcePill`` / ``ResourceMonitor`` already drive on
 * a 5s poll. Each new sample appends to an in-memory buffer; the
 * 61st entry drops the oldest.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getContainerResources, getResourceHistory } from "../lib/api";
import type { ResourceStats } from "../lib/types";

const HISTORY_CAP = 60;

export function useResourceHistory(containerId: number | null): ResourceStats[] {
  const { data: seed } = useQuery({
    queryKey: ["resources:history", containerId],
    queryFn: () => getResourceHistory(containerId as number),
    enabled: containerId !== null,
    staleTime: Infinity, // One-shot hydration.
    refetchOnWindowFocus: false,
  });

  const { data: live } = useQuery({
    queryKey: ["resources", containerId],
    queryFn: () => getContainerResources(containerId as number),
    enabled: containerId !== null,
    refetchInterval: 5_000,
  });

  const [buffer, setBuffer] = useState<ResourceStats[]>([]);

  // Reseed from history whenever a new seed arrives (container switch
  // re-keys the query so the seed for the new container lands here).
  useEffect(() => {
    if (seed) setBuffer(seed);
  }, [seed]);

  // Append each live tick, dropping the oldest at 61 entries and
  // deduping the hydration-vs-first-live-tick overlap.
  useEffect(() => {
    if (!live) return;
    setBuffer((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].timestamp === live.timestamp) {
        return prev;
      }
      const next = [...prev, live];
      return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
    });
  }, [live]);

  // Clear the buffer when containerId becomes null (no container
  // focused) so a subsequent re-focus doesn't flash stale samples.
  useEffect(() => {
    if (containerId === null) setBuffer([]);
  }, [containerId]);

  return buffer;
}
```

- [ ] **Step 4: Run — passing.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useResourceHistory.test.tsx
```

Expected: 5 passing.

- [ ] **Step 5: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useResourceHistory.ts dashboard/src/hooks/__tests__/useResourceHistory.test.tsx
git commit -m "feat(m25): useResourceHistory hook over /history + live polling"
```

---

## Task 6: `<HealthTimeline>` component (TDD)

**Files:**

- Create: `dashboard/src/components/HealthTimeline.tsx`
- Create: `dashboard/src/components/__tests__/HealthTimeline.test.tsx`

- [ ] **Step 1: Write failing tests.**

Create `dashboard/src/components/__tests__/HealthTimeline.test.tsx`:

```tsx
/** HealthTimeline tests (M25).
 *
 * The recharts ResponsiveContainer needs a non-zero parent size in
 * jsdom or it renders nothing. We stub ResizeObserver (shared via
 * test-setup.ts for M22/M23) and mock the hook so the component
 * sees predictable samples independent of the network.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HealthTimeline } from "../HealthTimeline";

const mockHook = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useResourceHistory", () => ({
  useResourceHistory: mockHook,
}));

// ResourceMonitor touches docker stats + children; stub it to a
// sentinel so the click-opens-popover assertion is cheap.
vi.mock("../ResourceMonitor", () => ({
  ResourceMonitor: ({ containerId }: { containerId: number | null }) => (
    <div data-testid="resource-monitor-stub">rm:{containerId}</div>
  ),
}));

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function sample(cpu = 10, mem = 20, gpu: number | null = 30, ts = "2026-04-19T00:00:00") {
  return {
    container_id: "c1",
    cpu_percent: cpu,
    memory_mb: 100,
    memory_limit_mb: 1000,
    memory_percent: mem,
    gpu_utilization: gpu,
    gpu_memory_mb: gpu === null ? null : 500,
    gpu_memory_total_mb: gpu === null ? null : 2000,
    timestamp: ts,
  };
}

beforeEach(() => {
  mockHook.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

describe("HealthTimeline", () => {
  it("renders the Collecting placeholder when buffer is empty", () => {
    mockHook.mockReturnValue([]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    expect(screen.getByText(/collecting/i)).toBeInTheDocument();
  });

  it("renders CPU, MEM, and GPU labels when samples are present", () => {
    mockHook.mockReturnValue([sample(10, 20, 30, "t1"), sample(12, 22, 32, "t2")]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    expect(screen.getByText(/CPU/i)).toBeInTheDocument();
    expect(screen.getByText(/MEM/i)).toBeInTheDocument();
    expect(screen.getByText(/GPU/i)).toBeInTheDocument();
  });

  it("shows the last value as text next to each sparkline", () => {
    mockHook.mockReturnValue([sample(42, 55, 77, "t1")]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    // Last-value annotation format is "NN%".
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(screen.getByText("77%")).toBeInTheDocument();
  });

  it("marks the GPU sparkline dim when every sample has null gpu_utilization", () => {
    mockHook.mockReturnValue([sample(10, 20, null, "t1"), sample(12, 22, null, "t2")]);
    const { container } = render(<HealthTimeline containerId={1} />, { wrapper });
    const gpu = container.querySelector('[data-slot="gpu-sparkline"]');
    expect(gpu).not.toBeNull();
    // "opacity-40" class is applied when GPU is missing.
    expect(gpu?.className).toMatch(/opacity-40/);
  });

  it("clicking the strip opens a popover with ResourceMonitor", async () => {
    mockHook.mockReturnValue([sample(10, 20, 30, "t1")]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: /open resource monitor/i }));
    expect(await screen.findByTestId("resource-monitor-stub")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — fails (component not defined).**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/HealthTimeline.test.tsx
```

- [ ] **Step 3: Implement the component.**

Create `dashboard/src/components/HealthTimeline.tsx`:

```tsx
/** Container-health timeline strip (M25).
 *
 * Three recharts sparklines (CPU · MEM · GPU) above ``SessionSubTabs``
 * showing the last 5 minutes of resource usage for the focused
 * container. Click the strip to open the existing ``ResourceMonitor``
 * in a Radix Popover for the full detail chart.
 *
 * The buffer comes from ``useResourceHistory`` which hydrates from
 * the hub's ring buffer on mount and appends each live ``/resources``
 * tick — so reloads and new Tailscale devices start with the same
 * 5-minute window the previous session saw.
 */

import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { useResourceHistory } from "../hooks/useResourceHistory";
import type { ResourceStats } from "../lib/types";
import { ResourceMonitor } from "./ResourceMonitor";

interface Props {
  containerId: number;
}

interface SparklineSpec {
  label: "CPU" | "MEM" | "GPU";
  stroke: string;
  fill: string;
  data: Array<{ t: number; v: number }>;
  last: number;
  peak: number;
  testSlot: string;
  dim: boolean;
  tooltipExtra?: string;
}

function pickCpu(s: ResourceStats): number {
  return s.cpu_percent;
}
function pickMem(s: ResourceStats): number {
  return s.memory_percent;
}
function pickGpu(s: ResourceStats): number {
  return s.gpu_utilization ?? 0;
}

function asSeries(
  samples: ResourceStats[],
  pick: (s: ResourceStats) => number,
): Array<{ t: number; v: number }> {
  return samples.map((s, i) => ({ t: i, v: pick(s) }));
}

function peakOf(samples: ResourceStats[], pick: (s: ResourceStats) => number): number {
  let peak = 0;
  for (const s of samples) {
    const v = pick(s);
    if (v > peak) peak = v;
  }
  return peak;
}

function lastOf(samples: ResourceStats[], pick: (s: ResourceStats) => number): number {
  return samples.length === 0 ? 0 : pick(samples[samples.length - 1]);
}

export function HealthTimeline({ containerId }: Props) {
  const samples = useResourceHistory(containerId);

  const gpuMissing = useMemo(
    () =>
      samples.length > 0 &&
      samples.every((s) => s.gpu_utilization === null || s.gpu_utilization === undefined),
    [samples],
  );

  const specs: SparklineSpec[] = useMemo(() => {
    if (samples.length === 0) return [];
    return [
      {
        label: "CPU",
        stroke: "#3b8eea",
        fill: "#3b8eea",
        data: asSeries(samples, pickCpu),
        last: Math.round(lastOf(samples, pickCpu)),
        peak: Math.round(peakOf(samples, pickCpu)),
        testSlot: "cpu-sparkline",
        dim: false,
      },
      {
        label: "MEM",
        stroke: "#23d18b",
        fill: "#23d18b",
        data: asSeries(samples, pickMem),
        last: Math.round(lastOf(samples, pickMem)),
        peak: Math.round(peakOf(samples, pickMem)),
        testSlot: "mem-sparkline",
        dim: false,
      },
      {
        label: "GPU",
        stroke: "#f5f543",
        fill: "#f5f543",
        data: gpuMissing ? [] : asSeries(samples, pickGpu),
        last: gpuMissing ? 0 : Math.round(lastOf(samples, pickGpu)),
        peak: gpuMissing ? 0 : Math.round(peakOf(samples, pickGpu)),
        testSlot: "gpu-sparkline",
        dim: gpuMissing,
        tooltipExtra: gpuMissing ? "GPU not attached" : undefined,
      },
    ];
  }, [samples, gpuMissing]);

  if (samples.length === 0) {
    return (
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#2b2b2b] bg-[#1a1a1a] px-3 text-[10px] text-[#858585]">
        <Activity size={11} aria-hidden="true" />
        <span>Collecting health samples…</span>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Open resource monitor"
            className="group flex h-11 w-full shrink-0 items-stretch gap-3 border-b border-[#2b2b2b] bg-[#1a1a1a] px-3 text-left hover:bg-[#222]"
          >
            {specs.map((s) => (
              <Sparkline key={s.label} spec={s} />
            ))}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            className="z-40 w-[360px] rounded border border-[#2b2b2b] bg-[#1e1e1e] p-3 shadow-lg"
          >
            <ResourceMonitor containerId={containerId} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Tooltip.Provider>
  );
}

function Sparkline({ spec }: { spec: SparklineSpec }) {
  const tooltipText = spec.tooltipExtra
    ? `${spec.label} — ${spec.tooltipExtra}`
    : `${spec.label} ${spec.last}% · peak ${spec.peak}% (last 5 min)`;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div
          data-slot={spec.testSlot}
          className={`flex flex-1 items-center gap-2 text-[10px] ${spec.dim ? "opacity-40" : ""}`}
        >
          <span className="w-8 font-mono text-[#858585]">{spec.label}</span>
          <div className="h-full min-w-0 flex-1">
            {spec.data.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={spec.data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                  <YAxis hide domain={[0, 100]} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={spec.stroke}
                    fill={spec.fill}
                    fillOpacity={0.25}
                    isAnimationActive={false}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full w-full" aria-hidden="true" />
            )}
          </div>
          <span className="w-10 shrink-0 font-mono text-right text-[#c0c0c0]">{spec.last}%</span>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={4}
          className="z-50 rounded bg-[#2d2d2d] px-2 py-1 text-[10px] text-[#cccccc]"
        >
          {tooltipText}
          <Tooltip.Arrow className="fill-[#2d2d2d]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
```

- [ ] **Step 4: Run — passing.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/HealthTimeline.test.tsx
```

Expected: 5 passing.

- [ ] **Step 5: Typecheck + lint.**

```bash
npx tsc --noEmit && npm run lint
```

Expected: 0 errors.

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/HealthTimeline.tsx dashboard/src/components/__tests__/HealthTimeline.test.tsx
git commit -m "feat(m25): HealthTimeline renders three sparklines + popover trigger"
```

---

## Task 7: `SettingsView` toggle row

**Files:**

- Modify: `dashboard/src/components/SettingsView.tsx`

- [ ] **Step 1: Add state + sync + patch wiring.**

Find the existing state declarations in `SettingsView()`:

```tsx
const [logLevel, setLogLevel] = useState<string>("INFO");
const [discoverRoots, setDiscoverRoots] = useState<string>("");
const [metricsEnabled, setMetricsEnabled] = useState<boolean>(true);
```

Add one more below:

```tsx
const [timelineVisible, setTimelineVisible] = useState<boolean>(true);
```

Find the `useEffect` that syncs state from `data`:

```tsx
useEffect(() => {
  if (!data) return;
  const v = data.values;
  if (typeof v.log_level === "string") setLogLevel(v.log_level);
  if (Array.isArray(v.discover_roots)) setDiscoverRoots((v.discover_roots as string[]).join("\n"));
  if (typeof v.metrics_enabled === "boolean") setMetricsEnabled(v.metrics_enabled);
}, [data]);
```

Append the timeline sync:

```tsx
if (typeof v.timeline_visible === "boolean") setTimelineVisible(v.timeline_visible);
```

Find the `save` function. The tail currently looks like:

```tsx
const prevMetrics = Boolean(values.metrics_enabled);
if (metricsEnabled !== prevMetrics) patch.metrics_enabled = metricsEnabled;

if (Object.keys(patch).length === 0) {
  toast("info", "Nothing to save");
  return;
}
mutation.mutate(patch);
```

Insert a parallel block before the "nothing to save" guard:

```tsx
const prevTimeline = Boolean(values.timeline_visible);
if (timelineVisible !== prevTimeline) patch.timeline_visible = timelineVisible;
```

- [ ] **Step 2: Add the toggle row to the rendered form.**

Find the `metrics_enabled` `<Row>` in the JSX (the one with `tooltip="Flips the /metrics endpoint…"`). Add this new row immediately below it (still inside the `Editable` section's `div.space-y-3`):

```tsx
<Row
  label="timeline_visible"
  tooltip="Show the three-sparkline health timeline above the session tabs. Shared across every device that syncs via this hub."
>
  <label className="inline-flex cursor-pointer items-center gap-2">
    <input
      type="checkbox"
      checked={timelineVisible}
      onChange={(e) => setTimelineVisible(e.target.checked)}
      className="h-4 w-4"
    />
    <span>{timelineVisible ? "on" : "off"}</span>
  </label>
</Row>
```

- [ ] **Step 3: Extend the `HubSettingsPatch` type in `dashboard/src/lib/types.ts`.**

Find the existing `HubSettingsPatch` definition. Add:

```ts
timeline_visible?: boolean;
```

- [ ] **Step 4: Typecheck + lint + full vitest.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit && npm run lint && npx vitest run
```

Expected: 0 errors; all tests passing.

- [ ] **Step 5: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/SettingsView.tsx dashboard/src/lib/types.ts
git commit -m "feat(m25): SettingsView timeline_visible toggle"
```

---

## Task 8: Mount `<HealthTimeline>` in `App.tsx`

**Files:**

- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Add import.**

Near the other component imports at the top of `App.tsx`:

```tsx
import { HealthTimeline } from "./components/HealthTimeline";
```

- [ ] **Step 2: Read the settings cache.**

In `App()`, find an area near other `useQuery` calls (e.g., where containers are fetched). Add:

```tsx
const { data: settings } = useQuery({
  queryKey: ["settings"],
  queryFn: getSettings,
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});
const timelineVisible = Boolean(
  (settings?.values as { timeline_visible?: boolean } | undefined)?.timeline_visible ?? true,
);
```

Ensure `getSettings` is in the import from `./lib/api` (it already exists; check the existing imports and add if missing).

- [ ] **Step 3: Render conditionally above `<SessionSubTabs>`.**

Find the existing JSX that renders `<Breadcrumbs>` and `<SessionSubTabs>` for the active container. The timeline goes between `<Breadcrumbs>` and `<SessionSubTabs>`:

```tsx
<Breadcrumbs containerId={active.id} path={activeFsPath} onPathChange={setActiveFsPath} />
{timelineVisible && <HealthTimeline containerId={active.id} />}
<SessionSubTabs ... />
```

Keep the `active !== undefined` guard chain that already wraps this JSX — no need for a second null check.

- [ ] **Step 4: Typecheck + lint.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit && npm run lint
```

Expected: 0 errors.

- [ ] **Step 5: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/App.tsx
git commit -m "feat(m25): mount HealthTimeline above SessionSubTabs (gated by settings)"
```

---

## Task 9: Playwright — `health-timeline.spec.ts`

**Files:**

- Create: `dashboard/tests/e2e/health-timeline.spec.ts`

- [ ] **Step 1: Write the spec.**

Create `dashboard/tests/e2e/health-timeline.spec.ts`:

```ts
/** M25 — container-health timeline end-to-end.
 *
 * Stubs ``/resources/history`` and ``/resources`` to drive the
 * sparkline render, then asserts the strip is visible and its click
 * opens the existing ResourceMonitor popover.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "health-timeline-token";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t, openTab, activeTab]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", openTab);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

  const mockJson = (data: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  await context.route("**/api/containers", (route) =>
    route.fulfill(
      mockJson([
        {
          id: 7,
          workspace_folder: "/w",
          project_type: "base",
          project_name: "demo",
          project_description: "",
          git_repo_url: null,
          container_id: "dead",
          container_status: "running",
          agent_status: "idle",
          agent_port: 0,
          has_gpu: false,
          has_claude_cli: false,
          claude_cli_checked_at: null,
          created_at: "2026-04-19",
          updated_at: "2026-04-19",
          agent_expected: false,
        },
      ]),
    ),
  );
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/gitops/prs**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/problems**", (route) => route.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (route) =>
    route.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: true,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));

  // Seed 12 samples with climbing CPU for a visible shape.
  const history = Array.from({ length: 12 }, (_v, i) => ({
    container_id: "dead",
    cpu_percent: i * 5,
    memory_mb: 100,
    memory_limit_mb: 1024,
    memory_percent: 20 + i,
    gpu_utilization: null,
    gpu_memory_mb: null,
    gpu_memory_total_mb: null,
    timestamp: `2026-04-19T00:00:${String(i).padStart(2, "0")}`,
  }));
  await context.route("**/api/containers/7/resources/history", (route) =>
    route.fulfill(mockJson(history)),
  );
  await context.route("**/api/containers/7/resources", (route) =>
    route.fulfill(
      mockJson({
        container_id: "dead",
        cpu_percent: 60,
        memory_mb: 130,
        memory_limit_mb: 1024,
        memory_percent: 34,
        gpu_utilization: null,
        gpu_memory_mb: null,
        gpu_memory_total_mb: null,
        timestamp: "2026-04-19T00:01:00",
      }),
    ),
  );
});

test("timeline strip renders and click opens the resource monitor popover", async ({ page }) => {
  await page.goto("/");

  // CPU label plus last-value annotation.
  await expect(page.getByText("CPU")).toBeVisible();
  await expect(page.getByText("MEM")).toBeVisible();
  await expect(page.getByText("GPU")).toBeVisible();

  // Click the timeline to open the popover.
  await page.getByRole("button", { name: /open resource monitor/i }).click();
  // ResourceMonitor renders its own header text "Resources" or similar —
  // grep the actual header during implementation and update this selector.
  // For a stable signal use the role="dialog" popover.
  await expect(page.locator("[role='dialog']").first()).toBeVisible();
});

test("timeline strip hides when timeline_visible is false", async ({ context, page }) => {
  // Override the settings stub from beforeEach for this test only.
  await context.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    }),
  );
  await page.goto("/");
  // Timeline button should not be present.
  await expect(page.getByRole("button", { name: /open resource monitor/i })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the spec.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test --reporter=line tests/e2e/health-timeline.spec.ts
```

Expected: 2 passing.

If the `role="dialog"` selector doesn't match Radix Popover content (Radix uses `role="dialog"` by default on `Popover.Content`, but older versions may not), fall back to matching on the stubbed `data-testid` by adding one in the `HealthTimeline` popover content: `<Popover.Content data-testid="health-popover" …>`. Update the selector accordingly.

- [ ] **Step 3: Full Playwright suite.**

```bash
npx playwright test --reporter=line
```

Expected: previous 14 + 2 = 16 passing.

- [ ] **Step 4: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/health-timeline.spec.ts
git commit -m "test(m25): Playwright — health timeline + settings toggle"
```

---

## Task 10: Prettier sweep + full verification

- [ ] **Step 1: Prettier-write dashboard (CI drift workaround).**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
```

- [ ] **Step 2: Typecheck + lint + full vitest.**

```bash
npx tsc --noEmit && npm run lint && npx vitest run
```

Expected: 0 errors; all tests green.

- [ ] **Step 3: Full Playwright suite.**

```bash
npx playwright test --reporter=line
```

Expected: all green.

- [ ] **Step 4: Full hub pytest.**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest -q
```

Expected: all green (316+ passing).

- [ ] **Step 5: Commit any prettier changes.**

```bash
cd /home/gnava/repos/honeycomb
git status
# if prettier modified anything:
git add -u
git commit -m "style(m25): prettier sweep before push" || true
```

---

## Task 11: Ship — merge, tag, push, CI watch

- [ ] **Step 1: Verify branch state.**

```bash
git log --oneline main..HEAD
```

Expected: ~10 M25 commits (spec + plan + feat + test + style).

- [ ] **Step 2: Merge to main with --no-ff.**

```bash
git checkout main && git pull --ff-only
git merge --no-ff m25-health-timeline -m "$(cat <<'EOF'
Merge M25: container-health timeline (hub-side buffered)

  * Ring buffer (deque(maxlen=60)) on ResourceMonitor, appended
    every 5s poll. New GET /api/containers/{id}/resources/history
    exposes it so reloads + new Tailscale devices pull the same
    5-minute window.
  * useResourceHistory hook hydrates from /history on mount then
    appends each /resources live tick, with dedup on the
    hydration/first-live overlap.
  * HealthTimeline renders three recharts sparklines (CPU · MEM ·
    GPU) above SessionSubTabs. Hover tooltips, click opens the
    existing ResourceMonitor inside a Radix Popover.
  * GPU sparkline dims to opacity-40 when the container reports
    no GPU stats.
  * New timeline_visible boolean in HiveSettings + MUTABLE_FIELDS,
    toggled from SettingsView. Shared across every device that
    syncs via this hub.

Full vitest + Playwright + hub pytest pass locally; prettier
sweep applied before push.
EOF
)"
```

- [ ] **Step 3: Tag.**

```bash
git tag -a v0.25-health-timeline -m "M25 — container-health timeline"
```

- [ ] **Step 4: Push with tags.**

```bash
git push origin main --follow-tags
```

- [ ] **Step 5: Delete the merged branch.**

```bash
git branch -d m25-health-timeline
```

- [ ] **Step 6: Watch CI.**

```bash
export GH_TOKEN=$(grep -E '^GITHUB_TOKEN=' .env | cut -d= -f2-)
sleep 5
gh run list --branch main --limit 2
# find the in-progress run id
gh run watch <RUN_ID> --exit-status --interval 15
```

Expected: all 7 CI jobs green.

- [ ] **Step 7: Report result to user** with tag + CI summary.

---

## Notes / pitfalls for the implementing engineer

- **Ring buffer scope.** Lives on the `ResourceMonitor` _instance_, not module state. Only one instance is created (in `hub/main.py` lifespan), so there's no bleed — but keeping it instance-scoped means tests can construct fresh monitors without shared state.
- **`_record_sample` is private on purpose.** The polling loop is the only legitimate caller. Tests use the underscore to exercise it directly; production code should never call it from outside the class.
- **`clear_history` is a no-op hook for now.** The spec notes that wiring it into container deregistration is optional — the memory cost of orphaned buffers is negligible for the 7-container scale. If a cleanup point surfaces naturally (e.g., `devcontainer_manager.stop()`), call `resource_monitor.clear_history(container_id)` there.
- **Dedup on the hydration/first-live overlap.** `/history` and `/resources` are two separate queries racing. Without the timestamp check, the last sample appears twice in the buffer for the first tick after mount. The timestamp comparison works because backend serialises `datetime` consistently.
- **Recharts + jsdom.** `ResponsiveContainer` needs a non-zero parent size; our M22 test-setup already stubs `ResizeObserver`, which is the main dependency. If any sparkline test crashes with `getBoundingClientRect` errors, add the same minimal stubs the CodeMirror integration uses.
- **`ResourceMonitor` has two triggers now.** The `ResourcePill` in the StatusBar and the new `HealthTimeline`. Both open their own Radix Popover instance containing `<ResourceMonitor>`. Duplicate state is avoided — each popover is self-contained and re-queries the cached `/resources` data. A lifted shared state isn't warranted at this scale; noted in the spec as a future follow-up.
- **Settings schema churn.** The dashboard caches `["settings"]` with a 30s staleTime. After flipping `timeline_visible`, the UI updates on the next invalidation (which `SettingsView`'s mutation triggers). Users toggling from `SettingsView` see the strip appear/disappear within the next render tick.
- **Prettier hook-vs-CI drift.** Task 10 includes the mandatory `npx prettier --write .` sweep before push — without it, CI fails on style-only diffs (see memory entry).

## Self-review summary

**Spec coverage.**

| Spec section                                                  | Implementing task(s)         |
| ------------------------------------------------------------- | ---------------------------- |
| §1 Architecture                                               | Tasks 1–8 collectively       |
| §2 Backend ring buffer + helpers                              | Task 1                       |
| §2 `/resources/history` route                                 | Task 2                       |
| §2 `timeline_visible` setting + MUTABLE_FIELDS                | Task 3                       |
| §3 `useResourceHistory` hook                                  | Task 5                       |
| §3 `HealthTimeline` component                                 | Task 6                       |
| §3 `App.tsx` integration                                      | Task 8                       |
| §4 `SettingsView` toggle row                                  | Task 7                       |
| §5 Error handling (empty seed, GPU missing, container switch) | Tasks 5, 6                   |
| §6 Testing                                                    | Tasks 1, 2, 3, 5, 6, 9       |
| §7 Follow-ups                                                 | Documented in spec; deferred |

**Placeholder scan.** No TBD/TODO. Every step has concrete code or commands.

**Type consistency.** `HISTORY_CAP = 60` matches between Python (`hub/services/resource_monitor.py`) and TypeScript (`dashboard/src/hooks/useResourceHistory.ts`). `timeline_visible` field name identical across `HiveSettings`, `MUTABLE_FIELDS`, API response shape, `HubSettingsPatch`, and `SettingsView` state. `_record_sample` / `get_history` / `clear_history` signatures consistent in Task 1, Task 2 tests, and the route handler.
