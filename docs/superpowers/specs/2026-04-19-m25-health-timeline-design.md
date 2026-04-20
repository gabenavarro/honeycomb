# M25 — Container-health timeline (hub-side buffered)

**Status.** Approved 2026-04-19. Third of the M23–M26 follow-up
milestones from the M22 roadmap.

## Context

M24 shipped write-back editing. M25 closes the resource-visibility
loop: a thin three-sparkline strip above `SessionSubTabs` shows the
last 5 minutes of CPU / memory / GPU utilisation for the focused
container. Hovering surfaces a tooltip with current + peak; clicking
opens the same `ResourceMonitor` popover that `ResourcePill` in the
StatusBar already renders.

Crucially, the sample buffer lives on the hub — not the client. Any
browser on any Tailscale-reachable device pulls the same rolling
5-minute window on mount. Reloads don't reset the timeline; a new
device picks up wherever the previous one left off. That's the main
driver for choosing hub-side state over a client-only ring buffer.

The backend already polls `/api/containers/{id}/resources` on a 5s
cadence via `resource_monitor.py`. This milestone wires a ring buffer
into that existing loop and exposes it via a new `/history` sibling
route. No polling frequency change, no new data path for the live
poll — the existing `ResourcePill` / `ResourceMonitor` continue to
work unchanged.

The codebase is at `v0.24-write-back`. `recharts` ^3.8.0 is already
in `dashboard/package.json` but not used anywhere; M25 is its first
consumer.

## Goals

- A three-sparkline strip (CPU · MEM · GPU) above `SessionSubTabs`
  giving a 5-minute glance at resource trends without opening a
  popover.
- Hub-backed ring buffer: reload-safe, cross-device-consistent over
  Tailscale.
- Reuse the existing `ResourceMonitor` for click-to-detail so
  zero new popover code ships.
- A settings-level toggle (`timeline_visible`) so users can hide the
  strip without touching code — shared across devices via the hub
  settings endpoint.

## Non-goals

- Configurable window length. 60 samples (5 min at 5s cadence) is
  fixed; a "last 15 min" or "last hour" view is a future milestone.
- Alert thresholds. No "sustained >90% CPU" problem emitting in M25.
- Historical replay beyond the ring buffer. 5 min is what we keep;
  once a sample rolls off, it's gone.
- Per-container visibility toggle. The settings flag is global.
- Inline expand-in-place toggle. Click opens the existing popover;
  we don't swap the strip for a full-height chart.
- Recharts beyond sparklines. No zoom, no brush, no axes. The strip
  is informational, not investigatory.

## Design

### 1. Architecture

```
┌─── hub/services/resource_monitor.py ────────────────────┐
│  Polling loop (every 5s):                               │
│    stats = sample_container(container_id)               │
│    _LATEST[container_id] = stats          ← existing    │
│    _HISTORY[container_id].append(stats)   ← NEW (M25)   │
│                                                         │
│  get_stats(container_id) → ResourceStats (existing)     │
│  get_history(container_id) → list[ResourceStats] NEW    │
└───────────────────────┬─────────────────────────────────┘
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
 GET /resources                GET /resources/history
 (existing; live sample)       (NEW; last 60 samples)
          │                           │
          └────────┬──────────────────┘
                   ▼
       Dashboard: useResourceHistory(containerId)
       - on mount: hydrate from /history
       - while mounted: append each /resources live tick
       - returns list[ResourceStats] (≤60 entries)
                   │
                   ▼
       <HealthTimeline> (NEW)
       - <Sparkline> × 3 (CPU · MEM · GPU)
       - Radix Tooltip on hover
       - onClick → <Popover> containing <ResourceMonitor>
                   ↑
                   │
       gated on settings.values.timeline_visible
       (NEW field in HiveSettings, MUTABLE)
```

### 2. Backend — ring buffer + history endpoint

#### `hub/services/resource_monitor.py`

Add a module-level registry alongside the existing `_LATEST` (or
equivalent) cache:

```python
from collections import deque

# One ring buffer per container_id; capped at 60 samples
# (= 5 minutes at the existing 5s poll cadence).
_HISTORY: dict[str, deque[ResourceStats]] = {}
HISTORY_CAP = 60
```

Extend the polling tick so each successful sample appends:

```python
def _record_sample(container_id: str, stats: ResourceStats) -> None:
    buf = _HISTORY.get(container_id)
    if buf is None:
        buf = deque(maxlen=HISTORY_CAP)
        _HISTORY[container_id] = buf
    buf.append(stats)
```

Call `_record_sample` from inside the existing polling loop at the
same site that currently writes `_LATEST`. Errors during sampling
should not crash the loop — wrap in the existing try/except that
already guards the tick.

Add a read accessor + a cleanup hook:

```python
def get_history(container_id: str) -> list[ResourceStats]:
    """Return the last ``HISTORY_CAP`` samples for a container.
    Empty list when the container hasn't been sampled yet (or was
    recently deregistered)."""
    return list(_HISTORY.get(container_id, ()))


def clear_history(container_id: str) -> None:
    """Drop the buffer for ``container_id``. Called when a container
    is removed from the registry."""
    _HISTORY.pop(container_id, None)
```

Call `clear_history` from the existing deregistration / stop path.
If the resource monitor doesn't currently hook into deregistration,
leave the `_HISTORY` entry to age out naturally — the only downside
is ~5 KiB memory per dead container until the next hub restart,
which is negligible for the 7-container scale target.

#### New route in `hub/routers/containers.py`

```python
@router.get(
    "/{record_id}/resources/history",
    response_model=list[ResourceStats],
)
async def get_resources_history(
    request: Request, record_id: int
) -> list[ResourceStats]:
    """Return the last 60 resource samples (5 min at 5s cadence) for
    the given container. Empty list is a valid response when the
    container just started and hasn't been sampled yet."""
    registry = request.app.state.registry
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")
    if not record.container_id:
        return []
    return request.app.state.resource_monitor.get_history(record.container_id)
```

Auth is enforced globally; no extra middleware needed.

#### Settings integration

In `hub/config.py`'s `HiveSettings`:

```python
timeline_visible: bool = Field(
    default=True,
    description=(
        "Whether the dashboard shows the three-sparkline health "
        "timeline above the session tabs. Shared across all devices "
        "that sync via this hub."
    ),
)
```

In `hub/routers/settings.py`'s `MUTABLE_FIELDS`:

```python
MUTABLE_FIELDS: set[str] = {
    "log_level",
    "discover_roots",
    "metrics_enabled",
    "timeline_visible",   # M25
}
```

The existing PATCH endpoint handles persistence to
`~/.config/honeycomb/settings.json` without any further work.

#### Tests

- `hub/tests/test_resource_monitor_history.py` (new):
  - `_record_sample` appends to an empty deque.
  - Repeated appends cap at 60 (61st drops the oldest).
  - `get_history` returns a snapshot list independent of further mutations.
  - `clear_history` drops the buffer; subsequent `get_history` returns `[]`.
- `hub/tests/test_resources_history_endpoint.py` (new):
  - 200 with `[]` when buffer is empty.
  - 200 with populated list when `_record_sample` was called.
  - 401 without token.
  - 404 on unknown `record_id`.
- `hub/tests/test_settings_overrides.py` (extend):
  - `timeline_visible` appears in the GET response's `mutable_fields`.
  - PATCH persists `timeline_visible: false` and round-trips on subsequent GET.

### 3. Dashboard — `useResourceHistory` hook + `HealthTimeline`

#### New hook

`dashboard/src/hooks/useResourceHistory.ts`:

```tsx
/** Resource-sample history for the active container (M25).
 *
 * On mount: fetches ``GET /resources/history`` once to hydrate the
 * last 5 minutes of samples from the hub's ring buffer — so a
 * reload, or a new device opening the dashboard over Tailscale,
 * shows the same 5-minute window the last session saw.
 *
 * While live: subscribes to the existing ``/resources`` React
 * Query cache that ``ResourcePill`` / ``ResourceMonitor`` already
 * drive on a 5s poll. Each new sample appends to an in-memory
 * buffer; the 61st entry drops the oldest.
 */
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

  useEffect(() => {
    if (seed) setBuffer(seed);
  }, [seed]);

  useEffect(() => {
    if (!live) return;
    setBuffer((prev) => {
      // Dedup the hydration-vs-first-live-tick overlap.
      if (prev.length > 0 && prev[prev.length - 1].timestamp === live.timestamp) {
        return prev;
      }
      const next = [...prev, live];
      return next.length > 60 ? next.slice(next.length - 60) : next;
    });
  }, [live]);

  return buffer;
}
```

New API wrapper in `dashboard/src/lib/api.ts`:

```ts
export const getResourceHistory = (id: number) =>
  request<ResourceStats[]>(`/containers/${id}/resources/history`);
```

`ResourceStats` TS type already exists in `dashboard/src/lib/types.ts`
mirroring the Pydantic model — no change needed unless `timestamp` is
missing (verify during implementation; add if so).

#### New component

`dashboard/src/components/HealthTimeline.tsx`:

- Accepts `{ containerId: number }`.
- Calls `useResourceHistory(containerId)` → `samples: ResourceStats[]`.
- Renders three `<Sparkline>` sub-components side by side inside a
  ~44 px tall Radix `Popover.Trigger` (the whole strip is a single
  click target that opens the detail popover).
- Each sparkline:
  - `recharts.ResponsiveContainer` → `AreaChart` with one `Area`.
  - `isAnimationActive={false}` (no flicker on rapid updates).
  - `YAxis` hidden with `domain={[0, 100]}`.
  - `XAxis` hidden.
  - No grid, no legend, no axis ticks.
  - Last value annotated as text to the right: `42%`.
  - Radix `Tooltip` on the sparkline area showing
    `CPU 42% · peak 78% (last 5 min)`.
- GPU sparkline:
  - If every entry in `samples` has `gpu_utilization == null` → render
    at `opacity-40` with tooltip "GPU not attached". No chart line.
  - Otherwise render like the others, using `gpu_utilization ?? 0` for
    gaps (a mid-window attach/detach shouldn't crash).
- Popover content reuses the existing `<ResourceMonitor containerId={…}>`
  so the detail view matches `ResourcePill`'s click behaviour.

The existing `ResourcePill` popover trigger and popover content can
stay — M25 adds a SECOND trigger on the timeline that opens the
same-shaped popover. DRY option (a lifted opener via context) is
deferred; two triggers is ~10 lines of Radix each and doesn't warrant
an abstraction layer yet.

#### Integration in `App.tsx`

Read the settings via the existing `useSettings` hook (or whatever
convention `SettingsView.tsx` uses):

```tsx
const { data: settings } = useSettings();
const timelineVisible = Boolean(settings?.values.timeline_visible ?? true);
```

Render between `<Breadcrumbs>` and `<SessionSubTabs>`:

```tsx
{
  timelineVisible && active && <HealthTimeline containerId={active.id} />;
}
```

When the container tab is split (M22 session split), the timeline
renders for the primary pane's container only — the split mirrors two
sessions of the _same_ container, so one timeline is correct. If M25
lands alongside future M22.4 evolution to cross-container splits, the
timeline would need to reconsider which pane it tracks; noted as a
follow-up.

#### Tests

- `dashboard/src/hooks/__tests__/useResourceHistory.test.tsx`:
  - Hydrates buffer from seed response.
  - Appends each live sample.
  - Drops the oldest at 61 entries.
  - Dedupes when live's first timestamp matches the seed's last.
  - Re-keys (clears) when `containerId` changes.
- `dashboard/src/components/__tests__/HealthTimeline.test.tsx`:
  - Renders three sparklines given a mixed-metric sample array.
  - GPU sparkline dimmed (opacity ≤ 0.4) when every sample's
    `gpu_utilization` is null.
  - Clicking the strip opens a Radix popover containing `ResourceMonitor`.
  - "Collecting…" placeholder shows when the buffer is empty.
- `dashboard/src/components/__tests__/SettingsView.test.tsx` (if this
  file exists; otherwise extend inline): assert the new toggle row
  renders when `timeline_visible` is in `mutable_fields`.

#### Playwright

`dashboard/tests/e2e/health-timeline.spec.ts`:

- Stub `/api/containers/7/resources/history` → 12 samples with rising
  CPU values.
- Stub `/api/containers/7/resources` → the 13th sample.
- Open the dashboard with container 7 focused; assert the timeline
  strip is visible (3 `.recharts-area` elements or similar).
- Click the strip; assert the popover opens (finds a known
  `ResourceMonitor` testid / aria-label).
- Reload the page; assert the timeline still shows the seeded samples
  (no empty-strip flash).

### 4. `SettingsView.tsx` — toggle row

Inside the existing settings form, gated on
`mutable.has("timeline_visible")`, render a boolean-toggle row:

- Label: "Show container-health timeline"
- Helper text: "Three-sparkline strip above the session tabs (CPU ·
  MEM · GPU). Hides the strip across every device that syncs via
  this hub."
- Value: `data.values.timeline_visible as boolean`.
- onChange: dispatch the existing PATCH-settings call.

If the existing `SettingsView` has a shared `ToggleRow` subcomponent
(e.g., for `metrics_enabled`), reuse it. Otherwise introduce a small
local one — keep it inside `SettingsView.tsx` unless more than one
consumer appears.

### 5. Error handling + edge cases

| Case                                                         | Behaviour                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| History endpoint returns `[]` (never sampled)                | Strip renders with a muted "Collecting…" label; sparklines hidden until first sample.                                                            |
| Container has no GPU (`gpu_utilization` null across samples) | GPU sparkline dim (`opacity-40`); tooltip "GPU not attached". No chart line.                                                                     |
| Container stopped mid-session                                | `useResourceHistory` keeps the buffer frozen (no new live ticks arrive); tooltip adds "container stopped".                                       |
| `timeline_visible` = false                                   | `<HealthTimeline>` not mounted; both fetches skipped.                                                                                            |
| Container switch                                             | Hook re-keys on `containerId`; old buffer discarded; fresh `/history` fetch.                                                                     |
| Reload / new device                                          | `/history` fetch hydrates from the hub ring buffer.                                                                                              |
| `/history` fetch errors (500)                                | Hook falls back to empty seed; live poll still populates the buffer going forward. Muted "History unavailable — live only" tooltip.              |
| Hub restart                                                  | `_HISTORY` is in-memory; restart empties it. Buffer rehydrates naturally after 1 poll tick. Not a data-loss concern in a single-user local tool. |

### 6. Testing summary

- **pytest** — `test_resource_monitor_history.py`,
  `test_resources_history_endpoint.py`, `test_settings_overrides.py`
  extension.
- **vitest** — `useResourceHistory.test.tsx`,
  `HealthTimeline.test.tsx`, `SettingsView` update.
- **Playwright** — `health-timeline.spec.ts`.

## Critical files

- [hub/services/resource_monitor.py](../../../hub/services/resource_monitor.py) — `_HISTORY` + `_record_sample` + `get_history` + `clear_history`
- [hub/routers/containers.py](../../../hub/routers/containers.py) — new `/resources/history` route
- [hub/config.py](../../../hub/config.py) — `timeline_visible` field
- [hub/routers/settings.py](../../../hub/routers/settings.py) — `MUTABLE_FIELDS` entry
- [hub/tests/test_resource_monitor_history.py](../../../hub/tests/test_resource_monitor_history.py) — new
- [hub/tests/test_resources_history_endpoint.py](../../../hub/tests/test_resources_history_endpoint.py) — new
- [dashboard/src/hooks/useResourceHistory.ts](../../../dashboard/src/hooks/useResourceHistory.ts) — new
- [dashboard/src/components/HealthTimeline.tsx](../../../dashboard/src/components/HealthTimeline.tsx) — new
- [dashboard/src/components/SettingsView.tsx](../../../dashboard/src/components/SettingsView.tsx) — new toggle row
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — mount the strip
- [dashboard/src/lib/api.ts](../../../dashboard/src/lib/api.ts) — `getResourceHistory`
- [dashboard/tests/e2e/health-timeline.spec.ts](../../../dashboard/tests/e2e/health-timeline.spec.ts) — new

## Verification

Same shape as M20–M24:

1. `pre-commit run --all-files` clean.
2. `ruff check hub && mypy hub && mypy hive-agent` clean.
3. `pytest hub/tests` green.
4. `npx tsc -b --noEmit && npm run lint && npx vitest run` green.
5. `npx playwright test` green.
6. `npx prettier --write .` in `dashboard/` before push — hook-vs-CI
   drift workaround still in force.
7. Manual smoke: open a running container, observe the strip grow
   over ~1 minute; toggle `timeline_visible` in Settings → strip
   disappears; reload → strip still shows history.
8. Branch merged `--no-ff` to `main`; tagged `v0.25-health-timeline`;
   push `--follow-tags`; CI watched to green; branch deleted.

## Follow-ups (out of scope for M25)

- Configurable window (60 → 720 samples for 1 hour).
- Sustained-threshold alerts surfaced in the Problems panel.
- Per-container visibility override (localStorage, not settings).
- Pin a timeline as a detail view in the editor (split-pane
  resource chart).
- Cross-container comparison overlay (two sparklines sharing the
  same y-axis).
- Historical replay beyond the ring buffer (requires persistence;
  SQLite-backed timeseries, or external Prometheus/Grafana).
