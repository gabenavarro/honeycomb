# M32 — Layout Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the dashboard around four top-level routes (`/chats`, `/library`, `/files`, `/settings`) driven by `react-router-dom` v7, rebuild the activity rail with the new four-entry layout, add a `WorkspacePill` + `WorkspacePicker` to the chat chrome, migrate the layout chrome (rail / sidebar / tabs / status bar / list components) from hardcoded hex to the M31 semantic tokens so the dashboard actually flips between dark and light end-to-end, and extend the ⌘K palette + global keyboard shortcuts (⌘1/⌘2/⌘3/⌘,) for route switching.

**Architecture:** `react-router-dom` v7 owns URL ↔ route state via `BrowserRouter`. `App.tsx` is split into a thin **routing shell** (state owner + provider tree + `<Routes>` switch) plus four route components (`ChatsRoute`, `LibraryRoute`, `FilesRoute`, `SettingsRoute`) that compose the existing UI building blocks (ContainerList, SessionSubTabs, DiffEventsActivity, ContainerFilesView, SettingsView, etc.). The legacy `Activity` union maps to routes via a single `routes.ts` table (route ↔ activity ↔ shortcut) so the bridge from the existing M0-M31 surface is mechanical. Chrome tokens come from M31's `@theme` block — every `bg-[#...]` / `text-[#...]` / `border-[#...]` in chrome files becomes `bg-pane` / `text-primary` / `border-edge` (etc.), so the same chrome paints both palettes.

**Tech Stack:** `react-router-dom` v7 (NEW dep — supports React 19), Tailwind v4 semantic tokens (defined in M31's `dashboard/src/index.css`), existing Radix Popover (`@radix-ui/react-popover`) for the WorkspacePicker dropdown, existing `cmdk` palette + axe-core scan, Vitest + `@testing-library/react`, Playwright + `@axe-core/playwright`.

**Branch:** `m32-layout-shell` (to be created from `main` at the start of Task 0).

**Spec:** [docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md](../specs/2026-04-26-dashboard-redesign-design.md) — M32 section (lines 691–743) + Architecture → Theme Tokens.

---

## Decisions made up front

These decisions are locked at plan time so the implementer doesn't have to think about them mid-task:

1. **Router: `react-router-dom` v7.** Latest, React 19 compatible, ESM-clean. We use `BrowserRouter` (not `HashRouter`) because the dashboard is served from a single origin under Vite's dev server / static deploy, and the hub never needs to interpret the path. v7 dropped CommonJS-only exports — `import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";`.

2. **Route shape.** `/chats`, `/library`, `/files`, `/settings` — no params on the path itself. Container/session selection stays in localStorage as today (driven by App.tsx state). The `/files` route hosts a sub-tab strip for the legacy `files` / `scm` / `problems` / `keybindings` activities (preserves all existing UI without forcing a full sidebar redesign).

3. **Shortcut remap.** `⌘1` / `⌘2` / `⌘3` / `⌘,` become route shortcuts (Chats / Library / Files / Settings). The existing `⌘1`-`⌘9` "focus Nth tab" shortcut moves to `Alt+1`-`Alt+9` (matches VSCode's "switch editor group" gesture and is unconflicted on every OS).

4. **WorkspacePill placement.** In the M33 chat surface the pill will live in the chat-thread chrome; for M32's bridge phase it lives in `ChatsRoute`'s header (above the existing Breadcrumbs / SessionSubTabs strip).

5. **Resource Monitor demote.** The existing `ResourcePill` in the bottom `StatusBar` (added in M13) already implements the "popover triggered from a chip" pattern the spec asks for. M32 leaves `ResourcePill` in `StatusBar` (no behavior change). The spec's literal "demote ResourceMonitor from sidebar pane to popover triggered from Workspace pill" is a residual from spec-time inaccuracy — there is no resource pane in the sidebar today (M13 already removed it). This task is a no-op; we document it in the plan so the implementer doesn't go hunting.

6. **Activity union retention.** The legacy `Activity` union (`"containers" | "gitops" | "scm" | "search" | "settings" | "problems" | "keybindings" | "files" | "diff-events"`) stays internally as the data layer. Routes → activities is a one-way map in `routes.ts`. M33+ can deprecate `Activity` once the chat surface stops needing it. **Don't try to delete it in M32** — too much downstream code reads it.

7. **No Library skill/workflow synthesis.** That's a future-ticket item per the spec; M32 just needs `/library` to render `DiffEventsActivity` (the existing M27 surface).

8. **Reviews counter source.** Count of `listPRs("open")` rows (already queried in App.tsx as `prs`). Pass `prs.length` to ActivityBar's Chats badge.

---

## File Structure

### Dashboard — create

- `dashboard/src/lib/routes.ts` — route table + activity mapping + shortcut table
- `dashboard/src/components/routes/ChatsRoute.tsx` — sidebar (ContainerList) + main pane (WorkspacePill + Breadcrumbs + SessionSubTabs + SessionSplitArea / FileViewer / DiffViewerTab)
- `dashboard/src/components/routes/LibraryRoute.tsx` — sidebar (ContainerList + DiffEventsActivity) + main pane (DiffViewerTab or empty state)
- `dashboard/src/components/routes/FilesRoute.tsx` — sub-tab strip (Files / SCM / Problems / Keybindings) sidebar + main pane (FileViewer or stub)
- `dashboard/src/components/routes/SettingsRoute.tsx` — main pane (SettingsView), no sidebar
- `dashboard/src/components/WorkspacePill.tsx` — header chip rendered inside ChatsRoute
- `dashboard/src/components/WorkspacePicker.tsx` — Radix Popover dropdown listing containers, click to switch active workspace
- `dashboard/src/components/__tests__/WorkspacePill.test.tsx`
- `dashboard/src/components/__tests__/WorkspacePicker.test.tsx`
- `dashboard/src/components/__tests__/ActivityBar.test.tsx` (vitest replaces hand-rolled coverage with explicit four-entry assertions)
- `dashboard/src/lib/__tests__/routes.test.ts`
- `dashboard/tests/e2e/layout-shell.spec.ts`

### Dashboard — modify

- `dashboard/package.json` — add `react-router-dom` dep
- `dashboard/src/main.tsx` — wrap `<App />` in `<BrowserRouter>`
- `dashboard/src/components/ActivityBar.tsx` — rebuild around the four entries; Settings bottom-anchored; Reviews counter on Chats. Keep public API back-compat for the bridge (still emits `Activity` to `onChange`).
- `dashboard/src/components/StatusBar.tsx` — chrome token migration
- `dashboard/src/components/ContainerList.tsx` — chrome token migration
- `dashboard/src/components/ContainerTabs.tsx` — chrome token migration
- `dashboard/src/components/Breadcrumbs.tsx` — chrome token migration
- `dashboard/src/components/SessionSubTabs.tsx` — chrome token migration
- `dashboard/src/components/AuthGate.tsx` — chrome token migration
- `dashboard/src/components/ConnectivityChip.tsx` — chrome token migration
- `dashboard/src/components/NotificationCenter.tsx` — chrome token migration
- `dashboard/src/components/ResourcePill.tsx` — chrome token migration
- `dashboard/src/App.tsx` — add `<Routes>` switch, use `useLocation`/`useNavigate` to drive activity, extract per-route render into the four route components, keep state at the App level and pass it as props.
- `dashboard/src/hooks/useKeyboardShortcuts.ts` — remap `⌘1`-`⌘9` to `Alt+1`-`Alt+9`; add `onActivateRoute(route: RouteId)` for `⌘1`/`⌘2`/`⌘3`/`⌘,`
- `dashboard/src/components/CommandPalette.tsx` — replace the "Activity" group's "Show X sidebar" entries with a "Routes" group (Go to Chats / Go to Library / Go to Files / Open Settings), keep theme commands from M31

### Tests modified

- `dashboard/src/components/__tests__/CommandPalette.test.tsx` — add cases for new route commands
- `dashboard/tests/e2e/activity-dblclick.spec.ts` — update if it references removed activities (verify in Task 4)

---

## Task 0: Verify branch + create feature branch

- [ ] **Step 1: Confirm clean main**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git status -s
git log --oneline -3
```

Expected:

- On `main`
- Status clean except `?? .claude/settings.json`
- Recent log shows `a656d1e Merge M31: design system foundation` (or later)

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b m32-layout-shell
```

- [ ] **Step 3: Confirm M31's tokens are present**

```bash
grep -c '@theme' /home/gnava/repos/honeycomb/dashboard/src/index.css
grep -c 'data-theme="light"' /home/gnava/repos/honeycomb/dashboard/src/index.css
```

Expected: both grep counts > 0. If either is 0, M31 didn't merge — STOP and investigate.

---

## Task 1: Add `react-router-dom` + `routes.ts` module

**Files:**

- Modify: `dashboard/package.json`, `dashboard/package-lock.json`
- Create: `dashboard/src/lib/routes.ts`
- Test: `dashboard/src/lib/__tests__/routes.test.ts`

- [ ] **Step 1: Install `react-router-dom`**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm install --save react-router-dom@^7
```

This adds `react-router-dom` (and its transitive `@remix-run/router`-style dep, but v7 ships everything under one package). The lockfile will update.

- [ ] **Step 2: Verify install**

```bash
node -e "console.log(require('react-router-dom/package.json').version)"
```

Expected: a `7.x.y` version string.

- [ ] **Step 3: Write the failing test**

Create `dashboard/src/lib/__tests__/routes.test.ts`:

```ts
/** Route table tests (M32). */
import { describe, expect, it } from "vitest";

import {
  ROUTES,
  ROUTE_IDS,
  activityForRoute,
  routeForActivity,
  routeForPathname,
  pathnameForRoute,
  shortcutForRoute,
  type RouteId,
} from "../routes";

describe("routes table", () => {
  it("exposes exactly four route ids", () => {
    expect(ROUTE_IDS).toEqual(["chats", "library", "files", "settings"]);
  });

  it("each route has a unique pathname", () => {
    const seen = new Set<string>();
    for (const r of ROUTES) {
      expect(seen.has(r.pathname)).toBe(false);
      seen.add(r.pathname);
    }
    expect(seen.size).toBe(4);
  });

  it("pathnameForRoute round-trips", () => {
    expect(pathnameForRoute("chats")).toBe("/chats");
    expect(pathnameForRoute("library")).toBe("/library");
    expect(pathnameForRoute("files")).toBe("/files");
    expect(pathnameForRoute("settings")).toBe("/settings");
  });

  it("routeForPathname matches exact and prefix", () => {
    expect(routeForPathname("/chats")).toBe("chats");
    expect(routeForPathname("/library/anything")).toBe("library");
    expect(routeForPathname("/")).toBe("chats"); // root falls back to chats
    expect(routeForPathname("/unknown")).toBe("chats"); // unknown falls back to chats
  });

  it("activityForRoute / routeForActivity are inverses for owned activities", () => {
    expect(activityForRoute("chats")).toBe("containers");
    expect(activityForRoute("library")).toBe("diff-events");
    expect(activityForRoute("files")).toBe("files");
    expect(activityForRoute("settings")).toBe("settings");
    expect(routeForActivity("containers")).toBe("chats");
    expect(routeForActivity("diff-events")).toBe("library");
    expect(routeForActivity("files")).toBe("files");
    expect(routeForActivity("scm")).toBe("files");
    expect(routeForActivity("problems")).toBe("files");
    expect(routeForActivity("keybindings")).toBe("files");
    expect(routeForActivity("settings")).toBe("settings");
    expect(routeForActivity("gitops")).toBe("chats"); // legacy → fold into chats
    expect(routeForActivity("search")).toBe("chats"); // legacy → fold into chats
  });

  it("shortcutForRoute returns the spec'd combos", () => {
    expect(shortcutForRoute("chats")).toBe("Mod+1");
    expect(shortcutForRoute("library")).toBe("Mod+2");
    expect(shortcutForRoute("files")).toBe("Mod+3");
    expect(shortcutForRoute("settings")).toBe("Mod+,");
  });

  it("RouteId TS type contains exactly the four ids (compile-time)", () => {
    // Trivial assignability check — if RouteId ever drifts, this fails to compile.
    const _check: RouteId[] = ["chats", "library", "files", "settings"];
    expect(_check.length).toBe(4);
  });
});
```

- [ ] **Step 4: Run test, expect FAIL (no module)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/routes.test.ts
```

Expected: FAIL with `Cannot find module '../routes'`.

- [ ] **Step 5: Implement `routes.ts`**

Create `dashboard/src/lib/routes.ts`:

```ts
/** Route table for M32's four-entry layout shell.
 *
 * The dashboard's URL space is intentionally tiny: four top-level
 * routes (Chats / Library / Files / Settings) that map onto the
 * existing Activity surface. The Activity union stays internally —
 * components below the routing layer still consume it — but the URL
 * is now the source of truth for which one is showing.
 *
 * For each route we record:
 *   - id:        a stable opaque RouteId we use in code + storage
 *   - pathname:  the URL path the BrowserRouter matches
 *   - title:     the human-readable label shown in the rail tooltip
 *                + ⌘K palette
 *   - activity:  the legacy Activity that backs the route's main UI
 *                (some Activities collapse INTO a route — see
 *                routeForActivity below)
 *   - shortcut:  the chord that switches to the route. "Mod" expands
 *                to ⌘ on macOS / Ctrl elsewhere; the keyboard handler
 *                accepts both as M31 already does for theme commands.
 */

import type { Activity } from "../components/ActivityBar";

export type RouteId = "chats" | "library" | "files" | "settings";

export interface RouteSpec {
  id: RouteId;
  pathname: string;
  title: string;
  activity: Activity;
  shortcut: string;
}

export const ROUTES: readonly RouteSpec[] = [
  { id: "chats", pathname: "/chats", title: "Chats", activity: "containers", shortcut: "Mod+1" },
  {
    id: "library",
    pathname: "/library",
    title: "Library",
    activity: "diff-events",
    shortcut: "Mod+2",
  },
  { id: "files", pathname: "/files", title: "Files", activity: "files", shortcut: "Mod+3" },
  {
    id: "settings",
    pathname: "/settings",
    title: "Settings",
    activity: "settings",
    shortcut: "Mod+,",
  },
] as const;

export const ROUTE_IDS: readonly RouteId[] = ROUTES.map((r) => r.id);

export function pathnameForRoute(id: RouteId): string {
  return ROUTES.find((r) => r.id === id)!.pathname;
}

/** Map a URL pathname to a RouteId, falling back to "chats" for
 *  unknown / root paths. Prefix-matches so /library/anything still
 *  resolves to "library". */
export function routeForPathname(pathname: string): RouteId {
  for (const r of ROUTES) {
    if (pathname === r.pathname || pathname.startsWith(`${r.pathname}/`)) return r.id;
  }
  return "chats";
}

export function activityForRoute(id: RouteId): Activity {
  return ROUTES.find((r) => r.id === id)!.activity;
}

/** Map a legacy Activity to the route that owns its UI. Several
 *  activities (`scm`, `problems`, `keybindings`) collapse into the
 *  Files route as sub-tabs. */
export function routeForActivity(activity: Activity): RouteId {
  switch (activity) {
    case "containers":
      return "chats";
    case "diff-events":
      return "library";
    case "files":
    case "scm":
    case "problems":
    case "keybindings":
      return "files";
    case "settings":
      return "settings";
    case "gitops":
    case "search":
    default:
      return "chats";
  }
}

export function shortcutForRoute(id: RouteId): string {
  return ROUTES.find((r) => r.id === id)!.shortcut;
}
```

- [ ] **Step 6: Run tests, expect 7/7 PASS**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/routes.test.ts
```

- [ ] **Step 7: Typecheck**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/package.json dashboard/package-lock.json \
        dashboard/src/lib/routes.ts \
        dashboard/src/lib/__tests__/routes.test.ts
git commit -m "feat(m32): add react-router-dom v7 + routes.ts table

Single source of truth for the four top-level routes (Chats /
Library / Files / Settings) plus the activity ↔ route ↔ shortcut
mapping. Legacy Activity union stays as the data layer; routes.ts
is the bridge."
```

---

## Task 2: Migrate chrome to semantic tokens

This is the biggest sub-task by file count. The goal: every `bg-[#hex]` / `text-[#hex]` / `border-[#hex]` in chrome (rail / sidebar / tabs / status bar / list components) becomes a semantic token. Files NOT in chrome (CodeEditor, FileViewer body, NotebookViewer, xterm.js host) keep their hardcoded hex — those are content surfaces, not chrome.

**Token mapping (memorize this — used in every step below):**

| Old hex                                                         | Semantic token (Tailwind v4)                |
| --------------------------------------------------------------- | ------------------------------------------- |
| `bg-[#1e1e1e]` (page bg, panel bg)                              | `bg-page` (or `bg-pane` if it's a sub-pane) |
| `bg-[#181818]` (rail bg)                                        | `bg-pane` (rail-specific shade)             |
| `bg-[#252526]`, `bg-[#2a2d2e]`, `bg-[#232323]` (hover / active) | `bg-chip`                                   |
| `bg-[#0a0e14]` (deepest pane)                                   | `bg-main`                                   |
| `text-[#cccccc]`                                                | `text-primary`                              |
| `text-[#858585]`                                                | `text-secondary`                            |
| `text-[#6e7681]`, `text-[#606060]`                              | `text-muted`                                |
| `text-[#e7e7e7]`, `text-[#c0c0c0]`, `text-[#c9d1d9]`            | `text-primary` (consistent foreground)      |
| `border-[#2b2b2b]`, `border-[#30363d]`                          | `border-edge`                               |
| `border-[#21262d]`, `border-[#3e3e42]`                          | `border-edge-soft`                          |
| `bg-[#0078d4]` (accent, active rail indicator)                  | `bg-accent`                                 |
| `text-[#0078d4]` (accent text)                                  | `text-accent`                               |

Tailwind v4 generates utilities from `--color-*` tokens. So `--color-page` → `bg-page` / `text-page` / `border-page`, and `--color-edge` → `border-edge`. The full token list is in `dashboard/src/index.css` (M31).

The order below is bottom-up: smallest files first, biggest last. Each is its own commit. Verify after each that **dark-mode Playwright stays green** — that's the regression contract.

**Files (one commit each):**

### Task 2a: StatusBadge (smallest — already mostly tokenless)

```bash
grep -E "\[#[0-9a-fA-F]+\]" /home/gnava/repos/honeycomb/dashboard/src/components/StatusBadge.tsx | head -5
```

If output shows hardcoded hex, replace per the table above. If empty, this task is a no-op — skip to 2b.

If non-empty, edit + commit:

```bash
git add dashboard/src/components/StatusBadge.tsx
git commit -m "refactor(m32): migrate StatusBadge chrome to semantic tokens"
```

### Task 2b: AuthGate

- [ ] **Read the file**

```bash
sed -n '1,40p' /home/gnava/repos/honeycomb/dashboard/src/components/AuthGate.tsx
```

- [ ] **Replace hex literals using the table above.** Use the Edit tool, one occurrence at a time.

- [ ] **Verify (vitest auth tests if any, plus typecheck):**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

- [ ] **Commit:**

```bash
git add dashboard/src/components/AuthGate.tsx
git commit -m "refactor(m32): migrate AuthGate chrome to semantic tokens"
```

### Task 2c: ResourcePill + ConnectivityChip + NotificationCenter (status-bar chips)

Each is small and lives inside StatusBar. Migrate together (one commit).

```bash
git add dashboard/src/components/ResourcePill.tsx \
        dashboard/src/components/ConnectivityChip.tsx \
        dashboard/src/components/NotificationCenter.tsx
git commit -m "refactor(m32): migrate status-bar chips chrome to semantic tokens"
```

### Task 2d: StatusBar (the bottom bar itself)

The `bg-[#0078d4]` in StatusBar at line 37 is the accent strip — replace with `bg-accent`. The `text-white` stays (token-agnostic).

```bash
git add dashboard/src/components/StatusBar.tsx
git commit -m "refactor(m32): migrate StatusBar chrome to semantic tokens"
```

### Task 2e: ContainerList + Breadcrumbs + SessionSubTabs + ContainerTabs (list / nav chrome)

Four files but all small. Migrate together.

```bash
git add dashboard/src/components/ContainerList.tsx \
        dashboard/src/components/Breadcrumbs.tsx \
        dashboard/src/components/SessionSubTabs.tsx \
        dashboard/src/components/ContainerTabs.tsx
git commit -m "refactor(m32): migrate list/nav chrome to semantic tokens"
```

### Task 2f: ActivityBar (last — biggest by hex count, 13 occurrences)

This file gets a structural rebuild in Task 4. For Task 2 just swap the hex for tokens; structure (the icons + button rendering) stays identical.

Before:

```tsx
className =
  "flex w-12 shrink-0 flex-col items-center justify-between border-r border-[#2b2b2b] bg-[#181818] py-2";
```

After:

```tsx
className =
  "flex w-12 shrink-0 flex-col items-center justify-between border-r border-edge bg-pane py-2";
```

Apply the same swap to every other `[#hex]` literal in the file.

```bash
git add dashboard/src/components/ActivityBar.tsx
git commit -m "refactor(m32): migrate ActivityBar chrome to semantic tokens

Last of the chrome-token migration before the M32 structural
rebuild. Icons + button structure stay identical; M32 Task 4
replaces them with the four-entry layout."
```

### Task 2 — Verify chrome migration end-to-end

- [ ] **Step 1: Full vitest**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

Expected: all green (chrome migrations don't change rendered structure or text content; existing component tests should keep passing).

- [ ] **Step 2: Full Playwright (dark-mode regression baseline)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

Expected: all 11 specs green. **This is the contract** — chrome migration with no visible regression in dark mode.

- [ ] **Step 3: Light-mode visual sanity check (manual or scripted via DevTools)**

Open the dashboard, open Settings → Appearance → Light. Walk through Containers / Files / Settings activities. Confirm no white-on-white or black-on-black surfaces. The Warm Workshop palette should paint:

- Body bg cream (`#fdfaf3`)
- Sidebar / rail terracotta-tinted pane (`#f7f1e3`)
- Status bar accent terracotta (`#b8541c`)
- Text dark brown (`#2a241b`)

If any chrome surface still renders pure black/white in light mode, that file slipped through — go back and fix it.

- [ ] **Step 4: No commit at this checkpoint** — Task 2's commits are already in. The checkpoint is purely verification.

---

## Task 3: Rebuild ActivityBar with four entries + Reviews counter + Settings bottom-anchored

**Files:**

- Modify: `dashboard/src/components/ActivityBar.tsx`
- Test: `dashboard/src/components/__tests__/ActivityBar.test.tsx` (new)

The existing ActivityBar has 9 entries. M32 collapses to 4: Chats / Library / Files / Settings. The first three live at the top; Settings is bottom-anchored.

The `onChange` callback emits a legacy `Activity` value (`"containers"` for Chats, `"diff-events"` for Library, `"files"` for Files, `"settings"` for Settings). This keeps App.tsx's existing state machine happy during the bridge phase.

Reviews counter on Chats: when `prCount > 0`, render the badge.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/components/__tests__/ActivityBar.test.tsx`:

```tsx
/** ActivityBar tests (M32 rebuild). */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityBar } from "../ActivityBar";

const noop = () => undefined;

function renderBar(overrides: Partial<React.ComponentProps<typeof ActivityBar>> = {}) {
  return render(
    <ActivityBar
      active="containers"
      onChange={noop}
      containerCount={0}
      prCount={0}
      problemCount={0}
      onOpenCommandPalette={noop}
      {...overrides}
    />,
  );
}

describe("ActivityBar (M32)", () => {
  it("renders exactly four labelled entries", () => {
    renderBar();
    expect(screen.getByRole("button", { name: /Chats/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Library/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Files/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeTruthy();
    // Sanity: no stale entries
    expect(screen.queryByRole("button", { name: /Git Ops/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Recent Edits/ })).toBeNull();
  });

  it("Chats shows aria-pressed=true when active='containers'", () => {
    renderBar({ active: "containers" });
    expect(screen.getByRole("button", { name: /Chats/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Library/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("Library shows aria-pressed=true when active='diff-events'", () => {
    renderBar({ active: "diff-events" });
    expect(screen.getByRole("button", { name: /Library/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("Files shows aria-pressed=true for any of files/scm/problems/keybindings", () => {
    for (const a of ["files", "scm", "problems", "keybindings"] as const) {
      const { unmount } = renderBar({ active: a });
      expect(screen.getByRole("button", { name: /Files/ }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      unmount();
    }
  });

  it("Reviews counter renders on Chats when prCount > 0", () => {
    renderBar({ prCount: 3 });
    const chats = screen.getByRole("button", { name: /Chats/ });
    expect(chats.textContent).toContain("3");
  });

  it("Reviews counter omitted when prCount === 0", () => {
    renderBar({ prCount: 0 });
    const chats = screen.getByRole("button", { name: /Chats/ });
    expect(chats.textContent).not.toMatch(/\d/);
  });

  it("Reviews counter caps at 99+", () => {
    renderBar({ prCount: 150 });
    const chats = screen.getByRole("button", { name: /Chats/ });
    expect(chats.textContent).toContain("99+");
  });

  it("clicking Chats emits onChange('containers')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Chats/ }));
    expect(onChange).toHaveBeenCalledWith("containers");
  });

  it("clicking Library emits onChange('diff-events')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Library/ }));
    expect(onChange).toHaveBeenCalledWith("diff-events");
  });

  it("clicking Files emits onChange('files')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    expect(onChange).toHaveBeenCalledWith("files");
  });

  it("clicking Settings emits onChange('settings')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(onChange).toHaveBeenCalledWith("settings");
  });

  it("Settings is rendered in the bottom group (DOM order)", () => {
    renderBar();
    const buttons = screen.getAllByRole("button");
    const ids = buttons.map((b) => b.getAttribute("aria-label"));
    expect(ids[ids.length - 1]).toBe("Settings");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL (existing ActivityBar has 9 entries, not 4; Reviews badge isn't on Chats yet)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/ActivityBar.test.tsx
```

- [ ] **Step 3: Rewrite ActivityBar.tsx**

Replace the full content of `dashboard/src/components/ActivityBar.tsx` with:

```tsx
/** Activity rail (M32 rebuild).
 *
 * Four entries — Chats / Library / Files / Settings. Settings is
 * bottom-anchored. Chats shows a "reviews" counter (count of open
 * PRs from the GitOps panel) when > 0.
 *
 * The Activity union (legacy data layer) stays unchanged: the rail
 * still emits Activity values to onChange so App.tsx's state
 * machine doesn't need to know about RouteId during the bridge.
 *
 * Mapping:
 *   - Chats    → "containers"  (active when activity === "containers" || "search" || "gitops")
 *   - Library  → "diff-events"
 *   - Files    → "files"       (active when activity ∈ {files, scm, problems, keybindings})
 *   - Settings → "settings"
 */

import { FolderTree, MessagesSquare, Settings, Sparkles } from "lucide-react";

export type Activity =
  | "containers"
  | "gitops"
  | "search"
  | "settings"
  | "problems"
  | "scm"
  | "keybindings"
  | "files"
  | "diff-events";

interface Props {
  active: Activity;
  onChange: (a: Activity) => void;
  containerCount: number;
  prCount: number;
  problemCount?: number;
  onOpenCommandPalette: () => void;
  /** Double-click toggles the sidebar open/closed (M22.2 gesture). */
  onToggleSidebar?: () => void;
}

interface RailEntry {
  id: "chats" | "library" | "files" | "settings";
  label: string;
  shortcut: string;
  icon: React.ReactNode;
  /** Activity value emitted to onChange when clicked. */
  emits: Activity;
  /** True when this entry should appear "pressed" given the current activity. */
  isActive: (a: Activity) => boolean;
  /** Numeric badge shown over the icon, or null. */
  badgeFor: (counts: {
    containerCount: number;
    prCount: number;
    problemCount: number;
  }) => number | null;
}

const TOP_ENTRIES: readonly RailEntry[] = [
  {
    id: "chats",
    label: "Chats",
    shortcut: "Ctrl+1",
    icon: <MessagesSquare size={18} />,
    emits: "containers",
    isActive: (a) => a === "containers" || a === "gitops" || a === "search",
    badgeFor: ({ prCount }) => (prCount > 0 ? prCount : null),
  },
  {
    id: "library",
    label: "Library",
    shortcut: "Ctrl+2",
    icon: <Sparkles size={18} />,
    emits: "diff-events",
    isActive: (a) => a === "diff-events",
    badgeFor: () => null,
  },
  {
    id: "files",
    label: "Files",
    shortcut: "Ctrl+3",
    icon: <FolderTree size={18} />,
    emits: "files",
    isActive: (a) => a === "files" || a === "scm" || a === "problems" || a === "keybindings",
    badgeFor: ({ problemCount }) => (problemCount > 0 ? problemCount : null),
  },
];

const SETTINGS_ENTRY: RailEntry = {
  id: "settings",
  label: "Settings",
  shortcut: "Ctrl+,",
  icon: <Settings size={18} />,
  emits: "settings",
  isActive: (a) => a === "settings",
  badgeFor: () => null,
};

export function ActivityBar({
  active,
  onChange,
  containerCount,
  prCount,
  problemCount = 0,
  onOpenCommandPalette,
  onToggleSidebar,
}: Props) {
  void onOpenCommandPalette; // ⌘K is now triggered via global shortcut, not the rail; reserved for a future "Search" affordance.
  return (
    <nav
      aria-label="Activity bar"
      className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-edge bg-pane py-2"
    >
      <ul className="flex flex-col gap-1">
        {TOP_ENTRIES.map((item) => (
          <ActivityButton
            key={item.id}
            item={item}
            active={active}
            counts={{ containerCount, prCount, problemCount }}
            onChange={onChange}
            onToggleSidebar={onToggleSidebar}
          />
        ))}
      </ul>
      <ul className="flex flex-col gap-1">
        <ActivityButton
          item={SETTINGS_ENTRY}
          active={active}
          counts={{ containerCount, prCount, problemCount }}
          onChange={onChange}
          onToggleSidebar={onToggleSidebar}
        />
      </ul>
    </nav>
  );
}

function ActivityButton({
  item,
  active,
  counts,
  onChange,
  onToggleSidebar,
}: {
  item: RailEntry;
  active: Activity;
  counts: { containerCount: number; prCount: number; problemCount: number };
  onChange: (a: Activity) => void;
  onToggleSidebar?: () => void;
}) {
  const isActive = item.isActive(active);
  const badge = item.badgeFor(counts);
  return (
    <li>
      <button
        type="button"
        onClick={() => onChange(item.emits)}
        onDoubleClick={() => onToggleSidebar?.()}
        title={`${item.label} (${item.shortcut}) — double-click to toggle sidebar`}
        aria-label={item.label}
        aria-pressed={isActive}
        className={`relative flex h-10 w-10 items-center justify-center rounded transition-colors ${
          isActive
            ? "bg-chip text-primary before:absolute before:top-2 before:left-0 before:h-6 before:w-0.5 before:bg-accent"
            : "text-secondary hover:bg-chip hover:text-primary"
        }`}
      >
        {item.icon}
        {badge !== null && (
          <span className="absolute top-1 right-1 rounded-full bg-accent px-1 text-[8px] leading-none font-bold text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </button>
    </li>
  );
}
```

Note: this is structurally a smaller, simpler ActivityBar. It exports the same `Activity` union (for type back-compat with App.tsx) and the same `Props` shape (so the call site doesn't need to change in this task). The `onOpenCommandPalette` prop becomes a no-op here since the palette is opened via global ⌘K (the existing shortcut handler). The prop stays in the signature for now — Task 4 trims it during the App.tsx restructure if practical.

- [ ] **Step 4: Run vitest, expect 11/11 PASS for ActivityBar tests + no regressions elsewhere**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

If `activity-dblclick.spec.ts` (Playwright) was asserting against a removed activity (e.g. "Git Ops"), that's a Task 4 problem — not Task 3. Don't fix Playwright in this task; just confirm vitest is green.

- [ ] **Step 5: Run dark-mode Playwright spec to surface any breakage from the rebuild**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

If any spec fails because it was clicking on a removed rail entry (e.g. `getByRole("button", { name: /Git Ops/ })`), note which spec — Task 4 will update it as part of the App.tsx restructure (since the data flow changes there too).

- [ ] **Step 6: Typecheck**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

App.tsx still imports `Activity` from ActivityBar — fine. App.tsx may also still pass `onOpenCommandPalette` as a real callback; the rail accepts it for now (no-op). Nothing breaks.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/ActivityBar.tsx \
        dashboard/src/components/__tests__/ActivityBar.test.tsx
git commit -m "feat(m32): rebuild activity rail with four entries + Reviews counter

Chats / Library / Files / Settings (Settings bottom-anchored).
Reviews counter on Chats reads prCount from the existing GitOps
query. Settings entry collapses {settings} → settings; Files
entry collapses {files, scm, problems, keybindings} → files; the
Activity union (legacy data layer) stays for App.tsx
back-compat — the rebuild is presentational only."
```

---

## Task 4: BrowserRouter + four route components

**Files:**

- Modify: `dashboard/src/main.tsx` — wrap in `<BrowserRouter>`
- Modify: `dashboard/src/App.tsx` — add `<Routes>` switch, sync URL ↔ activity, extract per-route render
- Create: `dashboard/src/components/routes/ChatsRoute.tsx`
- Create: `dashboard/src/components/routes/LibraryRoute.tsx`
- Create: `dashboard/src/components/routes/FilesRoute.tsx`
- Create: `dashboard/src/components/routes/SettingsRoute.tsx`

This is the structural rewrite. App.tsx today is a single 982-line component that owns all state + renders sidebar + main pane in a giant JSX tree. After M32, App.tsx still owns all state (no refactor of state), but the per-activity branches in the sidebar + main JSX move to the four route components, and App.tsx delegates via `<Routes>`.

**Key constraint:** **No state ownership migration in M32.** App.tsx keeps every `useState` / `useLocalStorage` / `useQuery` it has today. The route components receive everything they need as props. State extraction (e.g. into a `WorkspaceContext`) is M33+ work.

### Step-by-step

- [ ] **Step 1: Wrap `<App />` in `<BrowserRouter>` in `main.tsx`**

Open `dashboard/src/main.tsx` and add the import + wrap:

```tsx
// Add import near the existing react-router-dom-free imports:
import { BrowserRouter } from "react-router-dom";

// Update the createRoot tree:
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastRelayInstaller>
            <App />
          </ToastRelayInstaller>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
```

`BrowserRouter` goes outermost so QueryClient + Theme can both consume `useLocation` if needed (they don't today, but the pattern is clean).

- [ ] **Step 2: Typecheck + verify still mounts**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

Expected: clean. Vitest tests that import `<App />` may fail to mount if any of them rely on `useLocation` without a router — none of them should today, but if something breaks, check whether the test file needs to wrap in `<MemoryRouter>` or `<BrowserRouter>`. Common fix:

```tsx
import { MemoryRouter } from "react-router-dom";
// in the test render:
render(
  <MemoryRouter initialEntries={["/chats"]}>
    <App />
  </MemoryRouter>,
);
```

- [ ] **Step 3: Create the four route components as bridge stubs**

Create the directory:

```bash
mkdir -p /home/gnava/repos/honeycomb/dashboard/src/components/routes
```

Create `dashboard/src/components/routes/SettingsRoute.tsx` (the simplest):

```tsx
/** Settings route (M32). Renders the existing SettingsView in the
 *  main pane; no sidebar.
 */
import { SettingsView } from "../SettingsView";

export function SettingsRoute() {
  return (
    <main className="flex h-full min-w-0 flex-col bg-page">
      <SettingsView />
    </main>
  );
}
```

Create `dashboard/src/components/routes/LibraryRoute.tsx`:

```tsx
/** Library route (M32 bridge).
 *
 * The full Library — eight artifact types, primary/More chips, scope
 * picker — arrives in M35. For M32 we surface the existing M27 Recent
 * Edits view as the bridge content.
 */
import { useEffect } from "react";

import { ContainerList } from "../ContainerList";
import { DiffEventsActivity } from "../DiffEventsActivity";
import { DiffViewerTab } from "../DiffViewerTab";
import { ErrorBoundary } from "../ErrorBoundary";
import type { ContainerRecord, DiffEvent } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  openedDiffEvent: DiffEvent | null;
  onOpenEvent: (e: DiffEvent | null) => void;
}

export function LibraryRoute({
  containers,
  activeContainerId,
  onSelectContainer,
  openedDiffEvent,
  onOpenEvent,
}: Props) {
  // When the active container changes, drop any opened diff event so
  // the viewer doesn't lag the workspace.
  useEffect(() => {
    onOpenEvent(null);
  }, [activeContainerId, onOpenEvent]);

  void containers;
  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Library sidebar"
        className="flex w-72 shrink-0 flex-col border-r border-edge bg-pane"
      >
        <header className="border-b border-edge px-3 py-1.5">
          <h2 className="text-[10px] font-semibold tracking-wider text-secondary uppercase">
            Library
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto">
          <ContainerList selectedId={activeContainerId} onSelect={onSelectContainer} />
          {activeContainerId !== null && (
            <DiffEventsActivity containerId={activeContainerId} onOpenEvent={onOpenEvent} />
          )}
        </div>
      </aside>
      <main className="flex h-full min-w-0 flex-1 flex-col bg-page">
        {openedDiffEvent !== null ? (
          <ErrorBoundary
            key={`eb-diff-${openedDiffEvent.event_id}`}
            label={`the diff viewer for ${openedDiffEvent.path}`}
          >
            <DiffViewerTab event={openedDiffEvent} onOpenFile={() => undefined} />
          </ErrorBoundary>
        ) : (
          <LibraryEmptyState />
        )}
      </main>
    </div>
  );
}

function LibraryEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-secondary">
        Pick a container, then a recent edit, to view the diff here.
      </p>
      <p className="text-[11px] text-muted">
        The full Library (Plans / Reviews / Skills / Specs and more) arrives in M35.
      </p>
    </div>
  );
}
```

Create `dashboard/src/components/routes/FilesRoute.tsx`:

```tsx
/** Files route (M32 bridge).
 *
 * Sub-tabs for the legacy Files / Source Control / Problems /
 * Keybindings activities. The existing Activity-driven UI stays
 * intact — Files Route just wraps it in a Tabs strip so all the
 * tooling lives behind a single rail entry.
 */
import { Breadcrumbs } from "../Breadcrumbs";
import { ContainerFilesView } from "../ContainerFilesView";
import { ContainerList } from "../ContainerList";
import { ErrorBoundary } from "../ErrorBoundary";
import { FileViewer } from "../FileViewer";
import { KeybindingsEditor } from "../KeybindingsEditor";
import { ProblemsPanel } from "../ProblemsPanel";
import { SourceControlView } from "../SourceControlView";
import type { ContainerRecord } from "../../lib/types";
import type { Activity } from "../ActivityBar";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  /** Sub-activity: which Files sub-tab is open. */
  subActivity: Extract<Activity, "files" | "scm" | "problems" | "keybindings">;
  onSubActivityChange: (a: Extract<Activity, "files" | "scm" | "problems" | "keybindings">) => void;
  activeFsPath: string;
  onFsPathChange: (path: string) => void;
  openedFile: string | null;
  onOpenFile: (path: string | null) => void;
}

const SUB_TABS: ReadonlyArray<{ id: Props["subActivity"]; label: string }> = [
  { id: "files", label: "Files" },
  { id: "scm", label: "Source Control" },
  { id: "problems", label: "Problems" },
  { id: "keybindings", label: "Keybindings" },
];

export function FilesRoute({
  containers,
  activeContainerId,
  onSelectContainer,
  subActivity,
  onSubActivityChange,
  activeFsPath,
  onFsPathChange,
  openedFile,
  onOpenFile,
}: Props) {
  void containers;
  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Files sidebar"
        className="flex w-72 shrink-0 flex-col border-r border-edge bg-pane"
      >
        <nav
          aria-label="Files sub-tabs"
          role="tablist"
          className="flex shrink-0 border-b border-edge"
        >
          {SUB_TABS.map((tab) => {
            const isActive = subActivity === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSubActivityChange(tab.id)}
                className={`flex-1 px-2 py-1.5 text-[11px] transition-colors ${
                  isActive
                    ? "border-b-2 border-accent bg-chip text-primary"
                    : "text-secondary hover:bg-chip hover:text-primary"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-y-auto">
          {subActivity === "files" && (
            <ContainerFilesView
              containerId={activeContainerId}
              path={activeFsPath}
              onNavigate={onFsPathChange}
              onOpenFile={onOpenFile}
            />
          )}
          {subActivity === "scm" && <SourceControlView />}
          {subActivity === "problems" && (
            <ProblemsPanel
              onOpenContainer={(id) => {
                onSelectContainer(id);
                onSubActivityChange("files");
              }}
            />
          )}
          {subActivity === "keybindings" && <KeybindingsEditor />}
        </div>
        <div className="border-t border-edge">
          <ContainerList selectedId={activeContainerId} onSelect={onSelectContainer} />
        </div>
      </aside>
      <main className="flex h-full min-w-0 flex-1 flex-col bg-page">
        {activeContainerId !== null && (
          <Breadcrumbs
            containerId={activeContainerId}
            path={activeFsPath}
            onPathChange={onFsPathChange}
          />
        )}
        {openedFile !== null && activeContainerId !== null ? (
          <ErrorBoundary
            key={`eb-file-${activeContainerId}-${openedFile}`}
            label={`the ${openedFile} viewer`}
          >
            <FileViewer
              key={`${activeContainerId}-${openedFile}`}
              containerId={activeContainerId}
              path={openedFile}
              onClose={() => onOpenFile(null)}
            />
          </ErrorBoundary>
        ) : (
          <FilesEmptyState />
        )}
      </main>
    </div>
  );
}

function FilesEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-secondary">
        Pick a container, then click a file in the tree to view it here.
      </p>
    </div>
  );
}
```

Create `dashboard/src/components/routes/ChatsRoute.tsx`:

```tsx
/** Chats route (M32 bridge).
 *
 * Sidebar: ContainerList. Main pane: WorkspacePill + Breadcrumbs +
 * SessionSubTabs + SessionSplitArea (or FileViewer / DiffViewerTab
 * when one is opened from the palette / a click).
 *
 * The full chat surface (structured tool blocks, Thinking, streaming)
 * arrives in M33. M32 wires the existing PTY-based session UI behind
 * this route as a bridge so users can keep working while M33 ships.
 */
import { useQuery } from "@tanstack/react-query";

import { Breadcrumbs } from "../Breadcrumbs";
import { ContainerList } from "../ContainerList";
import { DiffViewerTab } from "../DiffViewerTab";
import { ErrorBoundary } from "../ErrorBoundary";
import { FileViewer } from "../FileViewer";
import { HealthTimeline } from "../HealthTimeline";
import { SessionSplitArea } from "../SessionSplitArea";
import { SessionSubTabs, type SessionInfo } from "../SessionSubTabs";
import { WorkspacePill } from "../WorkspacePill";
import { listContainerSessions, getSettings } from "../../lib/api";
import type { ContainerRecord, DiffEvent } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainer: ContainerRecord | undefined;
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;

  activeSessions: SessionInfo[];
  activeSessionId: string;
  activeSplitSessionId: string | null;
  onFocusSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, nextName: string) => void;
  onReorderSession: (fromId: string, toId: string) => void;
  onSetSplitSession: (sessionId: string) => void;
  onClearSplitSession: () => void;

  activeFsPath: string;
  onFsPathChange: (path: string) => void;
  openedFile: string | null;
  onOpenFile: (path: string | null) => void;
  openedDiffEvent: DiffEvent | null;
  onOpenDiffEvent: (e: DiffEvent | null) => void;
}

export function ChatsRoute({
  containers,
  activeContainer,
  activeContainerId,
  onSelectContainer,
  activeSessions,
  activeSessionId,
  activeSplitSessionId,
  onFocusSession,
  onCloseSession,
  onNewSession,
  onRenameSession,
  onReorderSession,
  onSetSplitSession,
  onClearSplitSession,
  activeFsPath,
  onFsPathChange,
  openedFile,
  onOpenFile,
  openedDiffEvent,
  onOpenDiffEvent,
}: Props) {
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const timelineVisible = Boolean(
    (settingsData?.values as { timeline_visible?: boolean } | undefined)?.timeline_visible ?? true,
  );

  // Reference the live-sessions query so the existing M22.3 toast
  // logic in App.tsx still fires (it watches `containers.agent_status`
  // transitions; the query keeps the cache fresh).
  useQuery({
    queryKey: ["sessions", activeContainerId ?? 0],
    queryFn: () => listContainerSessions(activeContainerId!),
    enabled: activeContainerId !== null,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Chats sidebar"
        className="flex w-72 shrink-0 flex-col border-r border-edge bg-pane"
      >
        <header className="flex items-center justify-between border-b border-edge px-3 py-1.5">
          <h2 className="text-[10px] font-semibold tracking-wider text-secondary uppercase">
            Workspaces
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto">
          <ContainerList selectedId={activeContainerId} onSelect={onSelectContainer} />
        </div>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col bg-page">
        <WorkspacePill
          containers={containers}
          activeContainerId={activeContainerId}
          onSelectContainer={onSelectContainer}
        />
        {activeContainer !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <Breadcrumbs
              containerId={activeContainer.id}
              path={activeFsPath}
              onPathChange={onFsPathChange}
            />
            {timelineVisible && <HealthTimeline containerId={activeContainer.id} />}
            <SessionSubTabs
              sessions={activeSessions}
              activeId={activeSessionId}
              onFocus={onFocusSession}
              onClose={onCloseSession}
              onNew={onNewSession}
              onRename={onRenameSession}
              onReorder={onReorderSession}
            />
            {openedFile !== null ? (
              <div className="flex min-h-0 min-w-0 flex-1">
                <ErrorBoundary
                  key={`eb-file-${activeContainer.id}-${openedFile}`}
                  label={`the ${openedFile} viewer`}
                >
                  <FileViewer
                    key={`${activeContainer.id}-${openedFile}`}
                    containerId={activeContainer.id}
                    path={openedFile}
                    onClose={() => onOpenFile(null)}
                  />
                </ErrorBoundary>
              </div>
            ) : openedDiffEvent !== null ? (
              <div className="flex min-h-0 min-w-0 flex-1">
                <ErrorBoundary
                  key={`eb-diff-${activeContainer.id}-${openedDiffEvent.event_id}`}
                  label={`the diff viewer for ${openedDiffEvent.path}`}
                >
                  <DiffViewerTab
                    key={`${activeContainer.id}-${openedDiffEvent.event_id}`}
                    event={openedDiffEvent}
                    onOpenFile={(path) => {
                      onOpenDiffEvent(null);
                      onOpenFile(path);
                    }}
                  />
                </ErrorBoundary>
              </div>
            ) : (
              <SessionSplitArea
                containerId={activeContainer.id}
                containerName={activeContainer.project_name}
                hasClaudeCli={activeContainer.has_claude_cli}
                sessions={activeSessions}
                primarySessionId={activeSessionId}
                splitSessionId={activeSplitSessionId}
                onSetSplit={onSetSplitSession}
                onClearSplit={onClearSplitSession}
              />
            )}
          </div>
        ) : (
          <ChatsEmptyState />
        )}
      </main>
    </div>
  );
}

function ChatsEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-secondary">Pick a workspace from the sidebar to start a chat.</p>
      <p className="text-[11px] text-muted">
        Press <kbd className="rounded border border-edge px-1.5 py-0.5">Ctrl+K</kbd> for the command
        palette · <kbd className="rounded border border-edge px-1.5 py-0.5">Ctrl+B</kbd> to toggle
        the sidebar.
      </p>
    </div>
  );
}
```

Note `ChatsRoute` imports `WorkspacePill` from `"../WorkspacePill"` — that file doesn't exist yet. The build will fail at this point. **That's expected** — Task 5 creates it. Sequence:

1. Finish writing all four route components (Step 3 above).
2. Build will fail until WorkspacePill exists (Task 5).
3. Don't commit yet — proceed to App.tsx wiring in Step 4.

- [ ] **Step 4: Add `<Routes>` switch + URL-driven activity to App.tsx**

Open `dashboard/src/App.tsx`. The full file is 982 lines today. We're not rewriting all of it — only the JSX render block (lines 640-947) and a small URL-sync `useEffect` near the top.

Make these changes:

**4a. Add imports near the top:**

```tsx
// New imports for routing
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { ChatsRoute } from "./components/routes/ChatsRoute";
import { LibraryRoute } from "./components/routes/LibraryRoute";
import { FilesRoute } from "./components/routes/FilesRoute";
import { SettingsRoute } from "./components/routes/SettingsRoute";
import { pathnameForRoute, routeForActivity, routeForPathname, type RouteId } from "./lib/routes";
```

**4b. Add URL ↔ activity sync near the existing `useLocalStorage<Activity>` line (around line 155):**

```tsx
// After the `activity` useLocalStorage line (around line 155-157), add:
const location = useLocation();
const navigate = useNavigate();
const currentRoute: RouteId = routeForPathname(location.pathname);

// Hard sync URL -> activity. When the URL changes (back/forward
// button, programmatic navigate), update the activity state if it's
// not already on a compatible route.
useEffect(() => {
  const r = routeForActivity(activity);
  if (r !== currentRoute) {
    // The URL is the source of truth — if it doesn't match the
    // activity's owning route, snap activity to a sensible default
    // for the new route (each route's primary activity).
    const fallbackActivity: Activity =
      currentRoute === "chats"
        ? "containers"
        : currentRoute === "library"
          ? "diff-events"
          : currentRoute === "files"
            ? "files"
            : "settings";
    setActivity(fallbackActivity);
  }
}, [currentRoute, activity, setActivity]);
```

**4c. Add a helper for "navigate to route" (used by ActivityBar's onChange + ⌘K + global shortcuts):**

```tsx
// After the URL sync effect:
const goToRoute = useCallback(
  (route: RouteId) => {
    navigate(pathnameForRoute(route));
  },
  [navigate],
);
```

**4d. Update `ActivityBar`'s `onChange` to navigate:**

Replace the existing `onChange={(a) => { ... setActivity(a); setSidebarOpen(true); }}` block on the `<ActivityBar />` call with:

```tsx
onChange={(a) => {
  setActivity(a);
  setSidebarOpen(true);
  goToRoute(routeForActivity(a));
}}
```

**4e. Replace the giant JSX render block with `<Routes>`:**

Find the existing render starting around line 640. Replace the inner `<div className="flex h-screen flex-col bg-[#1e1e1e] text-[#cccccc]"> ... </div>` block (everything between `return (` of the App component and `</AuthGate>`) with:

```tsx
return (
  <AuthGate>
    <LocalStorageQuotaWatcher />
    <WebSocketListenerErrorWatcher />
    <StaleHubWatcher />
    <div className="flex h-screen flex-col bg-page text-primary">
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          active={activity}
          onChange={(a) => {
            setActivity(a);
            setSidebarOpen(true);
            goToRoute(routeForActivity(a));
          }}
          containerCount={containers.length}
          prCount={prs.length}
          problemCount={problemCount}
          onOpenCommandPalette={() => setPaletteOpen(true)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />

        <Routes>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route
            path="/chats"
            element={
              <ChatsRoute
                containers={containers}
                activeContainer={active}
                activeContainerId={activeTabId}
                onSelectContainer={openContainer}
                activeSessions={activeSessions}
                activeSessionId={activeSessionId}
                activeSplitSessionId={activeSplitSessionId}
                onFocusSession={focusSession}
                onCloseSession={closeSession}
                onNewSession={newSession}
                onRenameSession={renameSession}
                onReorderSession={reorderSession}
                onSetSplitSession={setActiveSplitSession}
                onClearSplitSession={clearActiveSplitSession}
                activeFsPath={activeFsPath}
                onFsPathChange={setActiveFsPath}
                openedFile={openedFile}
                onOpenFile={setOpenedFile}
                openedDiffEvent={openedDiffEvent}
                onOpenDiffEvent={setOpenedDiffEvent}
              />
            }
          />
          <Route
            path="/library"
            element={
              <LibraryRoute
                containers={containers}
                activeContainerId={activeTabId}
                onSelectContainer={openContainer}
                openedDiffEvent={openedDiffEvent}
                onOpenEvent={setOpenedDiffEvent}
              />
            }
          />
          <Route
            path="/files"
            element={
              <FilesRoute
                containers={containers}
                activeContainerId={activeTabId}
                onSelectContainer={openContainer}
                subActivity={
                  activity === "files" ||
                  activity === "scm" ||
                  activity === "problems" ||
                  activity === "keybindings"
                    ? activity
                    : "files"
                }
                onSubActivityChange={setActivity}
                activeFsPath={activeFsPath}
                onFsPathChange={setActiveFsPath}
                openedFile={openedFile}
                onOpenFile={setOpenedFile}
              />
            }
          />
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Routes>
      </div>

      <StatusBar
        activeContainerId={active?.id ?? null}
        activeContainerName={active?.project_name ?? null}
      />

      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />

      {showProvisioner && <Provisioner onClose={() => setShowProvisioner(false)} />}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        containers={containers}
        activeContainerId={active?.id ?? null}
        activeWorkdir={activeWorkdir}
        onFocusContainer={openContainer}
        onCloseContainer={closeTab}
        onNewClaudeSession={newClaudeSession}
        onActivity={(a) => {
          setActivity(a);
          setSidebarOpen(true);
          goToRoute(routeForActivity(a));
        }}
        onOpenProvisioner={() => setShowProvisioner(true)}
        onOpenFile={(path) => {
          if (active !== undefined) {
            setOpenedFile(path);
          }
        }}
        onRunSuggestion={(command) => {
          if (active === undefined) return;
          openContainer(active.id);
          dispatchPretype({
            recordId: active.id,
            sessionKey: activeSessionId,
            text: command,
          });
        }}
      />
    </div>
  </AuthGate>
);
```

**Note** the giant `<Group>` / `<Panel>` resizable-panels structure is **gone**. M32 simplifies the layout: Activity rail (fixed 48px) + route content (fills remaining width). The route components own their own sidebar widths. The per-container layout state (`rootLayout`, `layoutByContainer`) becomes orphaned — leave the state declarations in place (they're still imported from useLocalStorage and the data is in storage), but they're no longer rendered. M33+ may revive them inside the chat surface; for now they're inert.

**4f. Remove the now-orphaned state declarations + sidebar Panel ref code** (Task 4 housekeeping):

After the JSX swap, the following are unused:

- `rootLayout`, `setRootLayout`, `LS_ROOT_LAYOUT`, `DEFAULT_ROOT_LAYOUT` — keep (M33 may revive)
- `layoutByContainer`, `setLayoutByContainer`, `LS_ROOT_LAYOUT_BY_CONTAINER` — keep
- `activeRootLayout`, `setActiveRootLayout`, `activeLayoutKey` — delete (purely derived, no localStorage cost)
- `sidebarPanelRef` and the `useEffect` that drives `handle.collapse()` / `handle.expand()` — delete (no panels in the new layout)
- `splitContainer`, `splitId`, `setSplitId`, `LS_SPLIT_ID`, `toggleSplit` — delete (the editor split-view is gone in the new shell; M33+ might revive)
- The `Group`, `Panel`, `Separator` imports from `react-resizable-panels` — delete

Also remove the `import { Columns } from "lucide-react";` if `toggleSplit` was the only consumer.

The `EmptyEditor` function defined at the bottom is now unused — delete it.

- [ ] **Step 5: Run tsc, fix what breaks**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

Errors to expect + fix:

- `Cannot find module '../WorkspacePill'` — Task 5 will resolve.
- `Activity` type usage in route component prop types — verify the union casts work.
- Unused imports — delete them.

If `WorkspacePill` is the only blocker, **temporarily** add a stub in Task 4 so the build is green; Task 5 replaces it with the real component:

Create `dashboard/src/components/WorkspacePill.tsx` (Task 4 stub — Task 5 replaces):

```tsx
/** WorkspacePill stub (M32 Task 4 placeholder; replaced in Task 5). */
import type { ContainerRecord } from "../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function WorkspacePill({ containers, activeContainerId, onSelectContainer }: Props) {
  void containers;
  void activeContainerId;
  void onSelectContainer;
  return null;
}
```

- [ ] **Step 6: Run vitest + Playwright (regression baseline)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
npx playwright test
```

Vitest: existing tests should still pass. If any test imports `<App />` directly and fails because of `useLocation`-without-router, wrap in `<MemoryRouter initialEntries={["/chats"]}>`. Common offender locations:

- `src/__tests__/App.test.tsx` (if it exists)
- Any test that uses `import App from "../../App"`.

Playwright: the dark-mode regression contract still applies — every existing spec should pass. The biggest risk: tests that click the "Git Ops" or "Recent Edits" rail icon will fail (those entries are gone). Update them in Task 4 itself if needed:

- `tests/e2e/activity-dblclick.spec.ts` — if it asserts against removed activities, retarget to one of the four (Files / Library).
- Any spec that depends on the resizable Panel layout (`layout-panels.spec.ts`) — the panels are gone in the new shell. **Decision:** delete that spec in Task 4 with a note in the commit message.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/main.tsx \
        dashboard/src/App.tsx \
        dashboard/src/components/routes/ \
        dashboard/src/components/WorkspacePill.tsx
# If layout-panels.spec.ts was deleted:
# git rm dashboard/tests/e2e/layout-panels.spec.ts
git commit -m "feat(m32): BrowserRouter + four route components

App.tsx becomes a routing shell: state stays at the top, JSX
delegates to ChatsRoute / LibraryRoute / FilesRoute / SettingsRoute
based on URL. The legacy per-activity branches in App.tsx's render
are gone; the resizable Panel layout (M14) is removed in favour of
each route owning its own sidebar width.

WorkspacePill is a stub at this point — Task 5 replaces it with
the real component."
```

If Playwright specs needed updating or removing, include a separate commit:

```bash
git add dashboard/tests/e2e/
git commit -m "test(m32): update Playwright fixtures for new shell"
```

---

## Task 5: WorkspacePicker (Radix Popover dropdown)

**Files:**

- Create: `dashboard/src/components/WorkspacePicker.tsx`
- Test: `dashboard/src/components/__tests__/WorkspacePicker.test.tsx`

`WorkspacePicker` is the dropdown that opens when the user clicks the WorkspacePill. It lists every container with a status dot + name + workspace folder, and clicking one switches the active workspace.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/components/__tests__/WorkspacePicker.test.tsx`:

```tsx
/** WorkspacePicker tests (M32). */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspacePicker } from "../WorkspacePicker";
import type { ContainerRecord } from "../../lib/types";

function fixture(over: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 1,
    workspace_folder: "/repos/foo",
    project_type: "base",
    project_name: "foo",
    project_description: "",
    git_repo_url: null,
    container_id: "deadbeef",
    container_status: "running",
    agent_status: "idle",
    agent_port: 0,
    has_gpu: false,
    has_claude_cli: false,
    claude_cli_checked_at: null,
    created_at: "2026-04-26",
    updated_at: "2026-04-26",
    agent_expected: false,
    ...over,
  };
}

describe("WorkspacePicker", () => {
  it("renders a row for each container with name + workspace folder", () => {
    const containers = [
      fixture({ id: 1, project_name: "foo", workspace_folder: "/repos/foo" }),
      fixture({ id: 2, project_name: "bar", workspace_folder: "/repos/bar" }),
    ];
    render(<WorkspacePicker containers={containers} activeContainerId={1} onSelect={vi.fn()} />);
    expect(screen.getByText(/foo/)).toBeTruthy();
    expect(screen.getByText("/repos/foo")).toBeTruthy();
    expect(screen.getByText(/bar/)).toBeTruthy();
    expect(screen.getByText("/repos/bar")).toBeTruthy();
  });

  it("the active workspace is marked aria-current", () => {
    const containers = [fixture({ id: 1 }), fixture({ id: 2, project_name: "bar" })];
    render(<WorkspacePicker containers={containers} activeContainerId={2} onSelect={vi.fn()} />);
    const rows = screen.getAllByRole("button");
    const active = rows.find((r) => r.getAttribute("aria-current") === "true");
    expect(active?.textContent).toContain("bar");
  });

  it("clicking a row calls onSelect with that container's id", () => {
    const onSelect = vi.fn();
    const containers = [fixture({ id: 1 }), fixture({ id: 2, project_name: "bar" })];
    render(<WorkspacePicker containers={containers} activeContainerId={1} onSelect={onSelect} />);
    fireEvent.click(screen.getByText(/bar/));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("renders an empty state when no containers", () => {
    render(<WorkspacePicker containers={[]} activeContainerId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/No workspaces/i)).toBeTruthy();
  });

  it("status dot color follows container_status", () => {
    const containers = [
      fixture({ id: 1, project_name: "running-one", container_status: "running" }),
      fixture({ id: 2, project_name: "stopped-one", container_status: "stopped" }),
    ];
    render(<WorkspacePicker containers={containers} activeContainerId={1} onSelect={vi.fn()} />);
    const dots = document.querySelectorAll('[data-testid="workspace-status-dot"]');
    expect(dots.length).toBe(2);
    // Running dot should carry an "ok" data-state, stopped should carry "stopped".
    expect(dots[0].getAttribute("data-state")).toBe("ok");
    expect(dots[1].getAttribute("data-state")).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL (no module)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/WorkspacePicker.test.tsx
```

- [ ] **Step 3: Implement WorkspacePicker**

Create `dashboard/src/components/WorkspacePicker.tsx`:

```tsx
/** WorkspacePicker (M32).
 *
 * Renders the list of registered containers as a clickable list,
 * each row showing a status dot, the project name, and the workspace
 * folder. Clicking a row selects that container as the active
 * workspace. Used as the contents of the WorkspacePill's popover.
 *
 * Status dot colors:
 *   - running   → green  (--color-write)
 *   - stopped   → muted  (--color-faint)
 *   - error     → red    (--color-task)
 *   - other     → muted  (default)
 */
import type { ContainerRecord } from "../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelect: (id: number) => void;
}

function statusState(status: string): "ok" | "stopped" | "error" | "unknown" {
  switch (status) {
    case "running":
      return "ok";
    case "stopped":
    case "exited":
      return "stopped";
    case "error":
    case "crashed":
      return "error";
    default:
      return "unknown";
  }
}

function StatusDot({ status }: { status: string }) {
  const state = statusState(status);
  const color =
    state === "ok"
      ? "bg-write"
      : state === "error"
        ? "bg-task"
        : state === "stopped"
          ? "bg-faint"
          : "bg-muted";
  return (
    <span
      data-testid="workspace-status-dot"
      data-state={state}
      className={`h-2 w-2 shrink-0 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
}

export function WorkspacePicker({ containers, activeContainerId, onSelect }: Props) {
  if (containers.length === 0) {
    return (
      <div className="p-3 text-[12px] text-muted">
        <p>No workspaces registered.</p>
        <p className="mt-1 text-[11px] text-faint">
          Use the "+ New" button on the Containers sidebar to register one.
        </p>
      </div>
    );
  }

  return (
    <ul
      role="listbox"
      aria-label="Workspaces"
      className="flex max-h-80 flex-col overflow-y-auto py-1"
    >
      {containers.map((c) => {
        const isActive = c.id === activeContainerId;
        return (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              aria-selected={isActive}
              aria-current={isActive}
              onClick={() => onSelect(c.id)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                isActive
                  ? "bg-chip text-primary"
                  : "text-secondary hover:bg-chip hover:text-primary"
              }`}
            >
              <StatusDot status={c.container_status} />
              <span className="flex flex-1 flex-col overflow-hidden">
                <span className="truncate text-[12px] font-medium">{c.project_name}</span>
                <span className="truncate font-mono text-[10px] text-muted">
                  {c.workspace_folder}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run tests, expect 5/5 PASS**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/WorkspacePicker.test.tsx
```

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/WorkspacePicker.tsx \
        dashboard/src/components/__tests__/WorkspacePicker.test.tsx
git commit -m "feat(m32): WorkspacePicker dropdown component

Lists every container as a clickable row with a status dot,
project name, and workspace folder. Clicking selects the
container as the active workspace. Used by WorkspacePill in
ChatsRoute (Task 6)."
```

---

## Task 6: WorkspacePill (header chrome inside ChatsRoute)

**Files:**

- Replace stub: `dashboard/src/components/WorkspacePill.tsx`
- Test: `dashboard/src/components/__tests__/WorkspacePill.test.tsx`

`WorkspacePill` is a small button rendered at the top of the Chats route's main pane. It shows the active workspace's project name + a chevron, and on click opens a Radix Popover containing `WorkspacePicker`. Selecting a row in the picker closes the popover and switches the active workspace.

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/components/__tests__/WorkspacePill.test.tsx`:

```tsx
/** WorkspacePill tests (M32). */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspacePill } from "../WorkspacePill";
import type { ContainerRecord } from "../../lib/types";

function fixture(over: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 1,
    workspace_folder: "/repos/foo",
    project_type: "base",
    project_name: "foo",
    project_description: "",
    git_repo_url: null,
    container_id: "deadbeef",
    container_status: "running",
    agent_status: "idle",
    agent_port: 0,
    has_gpu: false,
    has_claude_cli: false,
    claude_cli_checked_at: null,
    created_at: "2026-04-26",
    updated_at: "2026-04-26",
    agent_expected: false,
    ...over,
  };
}

describe("WorkspacePill", () => {
  it("renders the active workspace name when present", () => {
    render(
      <WorkspacePill
        containers={[fixture({ id: 1, project_name: "foo" })]}
        activeContainerId={1}
        onSelectContainer={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /foo/ })).toBeTruthy();
  });

  it("renders 'No workspace' when activeContainerId is null", () => {
    render(
      <WorkspacePill
        containers={[fixture({ id: 1 })]}
        activeContainerId={null}
        onSelectContainer={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /No workspace/i })).toBeTruthy();
  });

  it("clicking the pill opens the picker popover", () => {
    render(
      <WorkspacePill
        containers={[
          fixture({ id: 1, project_name: "foo" }),
          fixture({ id: 2, project_name: "bar" }),
        ]}
        activeContainerId={1}
        onSelectContainer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /foo/ }));
    // Picker is rendered into a portal — check the document body
    const picker = within(document.body).getByRole("listbox", { name: /Workspaces/i });
    expect(picker).toBeTruthy();
    // Both rows should render
    expect(within(document.body).getByText("bar")).toBeTruthy();
  });

  it("selecting a row in the popover calls onSelectContainer + closes the popover", () => {
    const onSelect = vi.fn();
    render(
      <WorkspacePill
        containers={[
          fixture({ id: 1, project_name: "foo" }),
          fixture({ id: 2, project_name: "bar" }),
        ]}
        activeContainerId={1}
        onSelectContainer={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /foo/ }));
    fireEvent.click(within(document.body).getByText("bar"));
    expect(onSelect).toHaveBeenCalledWith(2);
    // After close, listbox should be gone from the body
    expect(within(document.body).queryByRole("listbox", { name: /Workspaces/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, expect FAIL (the stub doesn't render anything)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/WorkspacePill.test.tsx
```

- [ ] **Step 3: Replace the WorkspacePill stub with the real component**

Replace `dashboard/src/components/WorkspacePill.tsx` with:

```tsx
/** WorkspacePill (M32).
 *
 * A small button rendered at the top of the Chats route's main pane.
 * Shows the active workspace's project name + a chevron. Click opens
 * a Radix Popover containing WorkspacePicker; selecting a row in the
 * picker closes the popover and swaps the active workspace.
 *
 * In M33 the chat-thread chrome will host this pill directly. For
 * the M32 bridge it lives in ChatsRoute's header above the existing
 * Breadcrumbs / SessionSubTabs strip.
 */
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { WorkspacePicker } from "./WorkspacePicker";
import type { ContainerRecord } from "../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function WorkspacePill({ containers, activeContainerId, onSelectContainer }: Props) {
  const [open, setOpen] = useState(false);
  const active = containers.find((c) => c.id === activeContainerId) ?? null;
  const label = active?.project_name ?? "No workspace";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 border-b border-edge bg-pane px-3 py-1.5">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={active === null ? "No workspace selected" : label}
            className="flex max-w-[18rem] items-center gap-1.5 rounded border border-edge bg-chip px-2 py-1 text-[12px] text-primary transition-colors hover:bg-pane focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="truncate">{label}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-80 overflow-hidden rounded border border-edge bg-pane shadow-medium"
        >
          <WorkspacePicker
            containers={containers}
            activeContainerId={activeContainerId}
            onSelect={(id) => {
              onSelectContainer(id);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

- [ ] **Step 4: Run tests, expect 4/4 PASS**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/WorkspacePill.test.tsx
```

- [ ] **Step 5: Run the full vitest suite**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

Expected: green.

- [ ] **Step 6: Run typecheck**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/WorkspacePill.tsx \
        dashboard/src/components/__tests__/WorkspacePill.test.tsx
git commit -m "feat(m32): WorkspacePill in ChatsRoute header

Click → Radix Popover hosting the WorkspacePicker. Selecting a
container closes the popover and switches the active workspace.
Replaces the M32-Task-4 stub."
```

---

## Task 7: Extend CommandPalette with route commands

**Files:**

- Modify: `dashboard/src/components/CommandPalette.tsx`
- Test: `dashboard/src/components/__tests__/CommandPalette.test.tsx`

The palette already has a "Suggestions / Containers / Sessions / Activity / Discover / Appearance" group order from M31. M32 replaces the "Activity" group's "Show X sidebar" entries with a "Routes" group: "Go to Chats / Go to Library / Go to Files / Open Settings".

The existing `onActivity` prop in the palette becomes a navigation trigger. We add a thin wrapper that maps the route → activity → onActivity call (the App.tsx-side handler then navigates via `goToRoute`).

- [ ] **Step 1: Add cases to the existing CommandPalette test file**

Open `dashboard/src/components/__tests__/CommandPalette.test.tsx`. Add a new `describe` block:

```tsx
describe("CommandPalette — M32 route commands", () => {
  it("lists Go to Chats / Go to Library / Go to Files / Open Settings", () => {
    renderPalette();
    expect(screen.getByText(/Go to Chats/i)).toBeTruthy();
    expect(screen.getByText(/Go to Library/i)).toBeTruthy();
    expect(screen.getByText(/Go to Files/i)).toBeTruthy();
    expect(screen.getByText(/Open Settings/i)).toBeTruthy();
  });

  it("clicking 'Go to Chats' invokes onActivity('containers')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Go to Chats/i));
    expect(onActivity).toHaveBeenCalledWith("containers");
  });

  it("clicking 'Go to Library' invokes onActivity('diff-events')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Go to Library/i));
    expect(onActivity).toHaveBeenCalledWith("diff-events");
  });

  it("clicking 'Go to Files' invokes onActivity('files')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Go to Files/i));
    expect(onActivity).toHaveBeenCalledWith("files");
  });

  it("clicking 'Open Settings' invokes onActivity('settings')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Open Settings/i));
    expect(onActivity).toHaveBeenCalledWith("settings");
  });
});
```

The existing `renderPalette()` helper accepts an overrides bag (per the M31 test file). Make sure the call site allows `{ onActivity }` to be passed through.

- [ ] **Step 2: Run tests, expect FAIL (no Routes group yet)**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/CommandPalette.test.tsx
```

- [ ] **Step 3: Modify CommandPalette.tsx**

Open `dashboard/src/components/CommandPalette.tsx`.

**3a. Extend the `PaletteCommand.group` union:**

```tsx
group:
  | "Containers"
  | "Activity"
  | "Sessions"
  | "Discover"
  | "Suggestions"
  | "Appearance"
  | "Routes";
```

**3b. Replace the existing "Activity" group push** (the one that adds "Show Containers sidebar" / "Show Git Ops sidebar") **with a "Routes" group push:**

Find this block (around line 159-174 of the M31 version):

```tsx
items.push(
  {
    id: "act:containers",
    title: "Show Containers sidebar",
    shortcut: "Ctrl+Shift+C",
    group: "Activity",
    run: () => onActivity("containers"),
  },
  {
    id: "act:gitops",
    title: "Show Git Ops sidebar",
    shortcut: "Ctrl+Shift+G",
    group: "Activity",
    run: () => onActivity("gitops"),
  },
);
```

Replace it with:

```tsx
items.push(
  {
    id: "route:chats",
    title: "Go to Chats",
    subtitle: "Conversations + workspaces",
    shortcut: "Ctrl+1",
    group: "Routes",
    run: () => onActivity("containers"),
  },
  {
    id: "route:library",
    title: "Go to Library",
    subtitle: "Plans, Reviews, Edits, Snippets",
    shortcut: "Ctrl+2",
    group: "Routes",
    run: () => onActivity("diff-events"),
  },
  {
    id: "route:files",
    title: "Go to Files",
    subtitle: "Source Control · Problems · Keybindings",
    shortcut: "Ctrl+3",
    group: "Routes",
    run: () => onActivity("files"),
  },
  {
    id: "route:settings",
    title: "Open Settings",
    subtitle: "Hub configuration + Appearance",
    shortcut: "Ctrl+,",
    group: "Routes",
    run: () => onActivity("settings"),
  },
);
```

**3c. Update the `groupOrder` arrays** to include "Routes":

```tsx
const groupOrder: PaletteCommand["group"][] = useMemo(
  () =>
    (activeName
      ? ["Suggestions", "Containers", "Sessions", "Routes", "Discover", "Appearance"]
      : [
          "Containers",
          "Sessions",
          "Routes",
          "Discover",
          "Appearance",
        ]) as PaletteCommand["group"][],
  [activeName],
);
```

(Drop `"Activity"` from both arrays — it's now empty.)

- [ ] **Step 4: Run tests, expect green**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

- [ ] **Step 5: Typecheck + lint**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npm run lint
```

- [ ] **Step 6: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/CommandPalette.tsx \
        dashboard/src/components/__tests__/CommandPalette.test.tsx
git commit -m "feat(m32): replace Activity group with Routes group in palette

Four new commands: Go to Chats / Library / Files + Open Settings.
Each routes through the existing onActivity callback so App.tsx's
goToRoute handler navigates the URL. Theme commands (M31) and the
Containers / Sessions / Suggestions / Discover / Appearance groups
are unchanged."
```

---

## Task 8: Global ⌘1 / ⌘2 / ⌘3 / ⌘, route shortcuts + remap tab-focus to Alt+N

**Files:**

- Modify: `dashboard/src/hooks/useKeyboardShortcuts.ts`
- Modify: `dashboard/src/App.tsx`

The existing `useKeyboardShortcuts.ts` binds `⌘1`–`⌘9` to `onFocusTabByIndex`. M32 needs `⌘1`/`⌘2`/`⌘3` for routes (Chats / Library / Files) and `⌘,` for Settings. We remap tab-focus to `Alt+1`–`Alt+9` (matches VSCode's "switch editor group" gesture; unconflicted on every OS).

- [ ] **Step 1: Modify useKeyboardShortcuts.ts**

Replace the body of `dashboard/src/hooks/useKeyboardShortcuts.ts` with:

```ts
/** Global keyboard shortcuts — VSCode/Cursor-inspired (M32 update).
 *
 * Bound at the document level so focus inside an input still works:
 * Cmd+K from a terminal prompt still opens the palette. Shortcuts
 * that would compete with browser text editing (Ctrl+A, Ctrl+F) are
 * NOT bound.
 *
 * M32 changes:
 *   - ⌘1 / ⌘2 / ⌘3 → route switch (Chats / Library / Files)
 *   - ⌘,           → route switch (Settings)
 *   - Alt+1..Alt+9 → focus Nth open container tab (was ⌘1-⌘9)
 *   - ⌘⇧C / ⌘⇧G    → REMOVED (Activity-group entries deleted in M32
 *                    Task 7; route shortcuts replace them)
 */

import { useEffect } from "react";

import type { RouteId } from "../lib/routes";

export interface ShortcutBindings {
  onCommandPalette: () => void;
  onToggleSidebar: () => void;
  onToggleSecondary: () => void;
  onCloseActiveTab: () => void;
  onFocusTabByIndex: (idx: number) => void;
  /** M32 — switch to one of the four top-level routes. */
  onActivateRoute: (route: RouteId) => void;
  /** M21 M — open the shortcut cheat-sheet overlay. Triggered by the
   * unmodified ``?`` key anywhere outside an input element. */
  onShowHelp?: () => void;
}

export function useKeyboardShortcuts(bindings: ShortcutBindings): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Bare ``?`` (Shift+/) opens the cheat sheet. Skip when focus is
      // in a text input / textarea / contenteditable so typing a real
      // question mark works.
      if (!mod && e.key === "?" && bindings.onShowHelp) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const editing =
          tag === "INPUT" || tag === "TEXTAREA" || (target !== null && target.isContentEditable);
        if (!editing) {
          e.preventDefault();
          bindings.onShowHelp();
          return;
        }
      }

      // Alt+1..Alt+9 — focus Nth open container tab. Take this branch
      // BEFORE the modifier check so it's not gated on Cmd/Ctrl.
      if (e.altKey && !e.shiftKey && !mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        bindings.onFocusTabByIndex(parseInt(e.key, 10) - 1);
        return;
      }

      if (!mod) return;

      // Cmd/Ctrl+K — command palette
      if (e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onCommandPalette();
        return;
      }
      // Cmd/Ctrl+B — toggle primary sidebar
      if (e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onToggleSidebar();
        return;
      }
      // Cmd/Ctrl+` — toggle secondary panel (backtick)
      if (e.key === "`" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onToggleSecondary();
        return;
      }
      // Cmd/Ctrl+W — close active tab
      if (e.key.toLowerCase() === "w" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onCloseActiveTab();
        return;
      }

      // Cmd/Ctrl+1 — Chats route
      if (e.key === "1" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("chats");
        return;
      }
      // Cmd/Ctrl+2 — Library route
      if (e.key === "2" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("library");
        return;
      }
      // Cmd/Ctrl+3 — Files route
      if (e.key === "3" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("files");
        return;
      }
      // Cmd/Ctrl+, — Settings route
      if (e.key === "," && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("settings");
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [bindings]);
}
```

Note the removed bindings: `onActivityContainers` and `onActivityGitOps` — they're replaced by the route-shortcut branch.

- [ ] **Step 2: Update App.tsx's `useKeyboardShortcuts(...)` call**

In `dashboard/src/App.tsx`, find the existing `useKeyboardShortcuts({...})` block. Replace with:

```tsx
useKeyboardShortcuts({
  onCommandPalette: () => setPaletteOpen((v) => !v),
  onToggleSidebar: () => setSidebarOpen((v) => !v),
  onToggleSecondary: () => undefined,
  onCloseActiveTab: () => {
    if (activeTabId !== null) closeTab(activeTabId);
  },
  onFocusTabByIndex: (idx) => {
    const tab = openTabs[idx];
    if (tab !== undefined) setActiveTabId(tab);
  },
  onActivateRoute: (route) => {
    goToRoute(route);
  },
  onShowHelp: () => setHelpOpen(true),
});
```

(The `onActivityContainers` and `onActivityGitOps` lines are removed.)

- [ ] **Step 3: Run vitest + Playwright**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
npx playwright test
```

If `tests/e2e/activity-dblclick.spec.ts` was using `Cmd+Shift+C` or `Cmd+Shift+G` shortcuts (M32-removed), update or remove. Open the file and verify; the most common asserting line is something like `await page.keyboard.press("Meta+Shift+C")`.

If the spec was relying on those shortcuts, replace with `Meta+1` (Chats) or `Meta+3` (Files) as appropriate, OR delete the spec if it was specifically validating the M22.2 double-click gesture against the old rail items (which are gone).

- [ ] **Step 4: Typecheck**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useKeyboardShortcuts.ts \
        dashboard/src/App.tsx \
        dashboard/tests/e2e/  # if any e2e specs needed updates
git commit -m "feat(m32): global ⌘1/⌘2/⌘3/⌘, route shortcuts + Alt+N tab focus

Cmd/Ctrl+1/2/3 switches to Chats/Library/Files; Cmd/Ctrl+, opens
Settings. Tab focus moves to Alt+1..Alt+9 (matches VSCode's
'switch editor group' gesture). The legacy ⌘⇧C / ⌘⇧G shortcuts
are removed — they targeted Activity-group items that don't
exist after M32 Task 7."
```

---

## Task 9: Playwright spec for the new shell + axe-core in light theme

**Files:**

- Create: `dashboard/tests/e2e/layout-shell.spec.ts`

The new spec exercises the four-route shell end-to-end + scans the chrome with axe-core in both themes. It uses the same auth + container fixture pattern as M31's `theme-system.spec.ts`.

- [ ] **Step 1: Create the spec**

Create `dashboard/tests/e2e/layout-shell.spec.ts`:

```ts
/** M32 layout-shell end-to-end.
 *
 * Verifies:
 *   1. Default boot lands on /chats (root redirects)
 *   2. Clicking each rail entry navigates to the corresponding route
 *   3. ⌘1/⌘2/⌘3/⌘, keyboard shortcuts route correctly
 *   4. ⌘K palette's "Go to X" entries route correctly
 *   5. WorkspacePill click → picker opens → row click → workspace switches
 *   6. Reviews counter on Chats reflects open PR count from the GitOps query
 *   7. axe-core scan passes on the new ActivityBar in DARK theme
 *   8. axe-core scan passes on the new ActivityBar in LIGHT theme
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "layout-shell-token";

const containerA = {
  id: 1,
  workspace_folder: "/repos/foo",
  project_type: "base",
  project_name: "foo",
  project_description: "",
  git_repo_url: null,
  container_id: "deadbeef",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: false,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const containerB = { ...containerA, id: 2, project_name: "bar", workspace_folder: "/repos/bar" };

const prFixture = {
  number: 42,
  title: "Test PR",
  state: "open",
  url: "https://example.com/pr/42",
  repo_dir: "/repos/foo",
  head_branch: "feat/xyz",
  base_branch: "main",
  author: "alice",
  draft: false,
  mergeable_state: "clean",
};

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
      } catch {}
    },
    [TOKEN],
  );

  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerA, containerB])));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/named-sessions", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([prFixture])));
  await context.route("**/api/gitops/repos**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/problems**", (r) => r.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (r) =>
    r.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (r) => r.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (r) => r.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (r) => r.fulfill({ status: 404 }));
});

test("default boot lands on /chats (root redirects)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/chats$/);
});

test("clicking rail entries navigates to each route", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page).toHaveURL(/\/files$/);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Chats" }).click();
  await expect(page).toHaveURL(/\/chats$/);
});

test("⌘1/⌘2/⌘3/⌘, keyboard shortcuts route correctly", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+2");
  await expect(page).toHaveURL(/\/library$/);
  await page.keyboard.press("Control+3");
  await expect(page).toHaveURL(/\/files$/);
  await page.keyboard.press("Control+,");
  await expect(page).toHaveURL(/\/settings$/);
  await page.keyboard.press("Control+1");
  await expect(page).toHaveURL(/\/chats$/);
});

test("⌘K 'Go to Files' palette command routes to /files", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  await page.getByText(/Go to Files/i).click();
  await expect(page).toHaveURL(/\/files$/);
});

test("WorkspacePill: click pill → click bar in picker → active changes to bar", async ({
  page,
}) => {
  await page.goto("/");
  // Pick container 'foo' first so the pill renders that label.
  await page.getByRole("button", { name: /foo/i }).first().click();
  // Click the pill (top of Chats main pane)
  const pill = page.getByRole("button", { name: /^foo$/ });
  await pill.click();
  // Picker is in a Radix Portal; wait for the listbox
  await expect(page.getByRole("listbox", { name: /Workspaces/i })).toBeVisible();
  // Click the 'bar' row
  await page.getByRole("listbox").getByText(/bar/).click();
  // Pill now reads 'bar'
  await expect(page.getByRole("button", { name: /^bar$/ })).toBeVisible();
});

test("Reviews counter on Chats matches open PR count", async ({ page }) => {
  await page.goto("/");
  // The fixture includes one open PR — Chats button should show "1"
  const chats = page.getByRole("button", { name: "Chats" });
  await expect(chats).toContainText("1");
});

test("Activity rail passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/");
  // Ensure dark explicitly (in case test env prefers-color-scheme is light)
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  const results = await new AxeBuilder({ page })
    .include('nav[aria-label="Activity bar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Activity rail passes axe-core in light theme", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
  });
  const results = await new AxeBuilder({ page })
    .include('nav[aria-label="Activity bar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 2: Run the new spec**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test layout-shell.spec.ts
```

Expected: 8/8 PASS. If any fails:

- "Reviews counter" failing usually means the pr fixture's URL regex is wrong; check `/api/gitops/prs` matches.
- "WorkspacePill" failing usually means the pill's accessible name isn't `/^foo$/` — adjust the selector to whatever the implementation uses.
- "axe-core" violations in either theme → real contrast bug; fix the offending chrome file rather than weakening the assertion.

- [ ] **Step 3: Run the full Playwright suite to confirm no regressions**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

Expected: all green. If `activity-dblclick.spec.ts` or `layout-panels.spec.ts` survived prior tasks but fails here, decide: update or delete (with a brief commit message explanation if deleting).

- [ ] **Step 4: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/layout-shell.spec.ts
git commit -m "test(m32): playwright spec for the new shell + axe-core scan

8 cases: route landing, rail-click navigation, keyboard shortcuts,
⌘K route commands, WorkspacePill pick flow, Reviews counter,
axe-core scan on the rail in both themes. Scopes the axe scan to
the new rail surface (the rest of the chrome migrated in Task 2;
existing route content has its own per-component tests)."
```

---

## Task 10: Pre-flight regression sweep + prettier

This mirrors M31's Task 7. Run every quality gate locally before the merge push.

- [ ] **Step 1: Hub regression (untouched but verify)**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check .
uv run mypy .
uv run pytest tests -q
```

All clean.

- [ ] **Step 2: Hive-agent regression**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run ruff check .
uv run mypy .
uv run pytest tests -q
```

All clean.

- [ ] **Step 3: Dashboard typecheck + lint + vitest**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npm run lint
npx vitest run
```

**Use `tsc -b`** (composite), not `tsc --noEmit`. Lint warnings should equal the M31 baseline (~19); if higher, find what M32 added and fix or accept.

- [ ] **Step 4: Full Playwright**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

- [ ] **Step 5: Prettier sweep**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
cd /home/gnava/repos/honeycomb
git status
git diff
```

If prettier reformats anything, commit:

```bash
cd /home/gnava/repos/honeycomb
git add -A -- dashboard/
git diff --cached --quiet || git commit -m "style(m32): prettier sweep before push"
```

(Note `-- dashboard/` to avoid accidentally staging the gitignored `.claude/settings.json`.)

- [ ] **Step 6: Full pre-commit run**

```bash
cd /home/gnava/repos/honeycomb
pre-commit run --all-files
```

Expected: clean.

---

## Task 11: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1: Push the branch**

```bash
cd /home/gnava/repos/honeycomb
git push -u origin m32-layout-shell
```

CI does NOT run on push to non-main branches (per `.github/workflows/ci.yml`'s `on: push: branches: [main]` config). So no branch-CI to watch — the next CI run is on the merge push.

- [ ] **Step 2: Merge to main with --no-ff**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff m32-layout-shell -m "Merge M32: layout shell"
```

- [ ] **Step 3: Tag**

```bash
git tag -a v0.32-layout-shell \
  -m "M32: layout shell (four-route React Router + ActivityBar rebuild + WorkspacePill + chrome token migration + global route shortcuts)"
```

- [ ] **Step 4: Push with --follow-tags**

```bash
git push --follow-tags origin main
```

- [ ] **Step 5: Watch the merge-CI run**

```bash
sleep 12
gh run list --branch main --limit 1 --json databaseId,status
gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: all 7 jobs green (pre-commit, hub, hive-agent, dashboard lint+typecheck+vitest, dashboard playwright, docker base build, gitleaks).

If a job hangs or flakes (M27/M30 saw transient Docker Hub auth flakes), cancel + rerun:

```bash
gh run rerun <id> --failed
```

- [ ] **Step 6: Delete the merged branch**

```bash
git branch -d m32-layout-shell
git push origin --delete m32-layout-shell
```

---

## Verification Checklist

Before marking M32 done, confirm:

- [ ] `cd dashboard && npx vitest run` — all green (existing + 7 new routes tests + 11 ActivityBar tests + 5 WorkspacePicker + 4 WorkspacePill + 5 new CommandPalette M32 cases).
- [ ] `cd dashboard && npx playwright test` — all specs green (M0-M31 baseline + the new `layout-shell.spec.ts` minus any deleted layout-panels / dblclick specs).
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint` — clean.
- [ ] `cd hub && uv run pytest tests -q` — green (untouched).
- [ ] `pre-commit run --all-files` — clean.
- [ ] **Manual smoke test:**
  - Open the dashboard at `localhost:5173` → URL is `/chats`.
  - Click each rail entry → URL changes; main pane content swaps.
  - Press `⌘2` → `/library`. `⌘1` → `/chats`. `⌘,` → `/settings`. `⌘3` → `/files`.
  - Open `⌘K` → see Routes group with 4 entries → click "Go to Files" → URL changes.
  - Switch to Light theme via Settings → no white-on-white surfaces; rail icons are still visible.
  - Switch back to Dark → no visible regression vs `main`.
  - Click WorkspacePill → picker opens → click another workspace → pill label updates + ContainerList focus shifts.
  - Open a PR via the (mocked / real) `/api/gitops/prs` source → Chats icon shows the count.
- [ ] `git log --oneline main` shows `Merge M32: layout shell` + `v0.32-layout-shell` tag.
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green.
- [ ] Branch `m32-layout-shell` deleted locally and on origin.

---

## Out of scope for M32 (deferred)

- **Chat surface (structured tool blocks, Thinking, retry/fork/copy/edit, effort, model chip, live `stream-json` streaming).** That's M33's headline.
- **Composer (effort slider, model chip, slash commands).** M34.
- **Library proper (eight artifact types, primary/More chips, scope picker, auto-save).** M35.
- **Mobile breakpoints / phone bottom-tab + drawer.** M36.
- **State extraction from App.tsx into context/store.** M33+ work — M32 keeps state at the App level and passes it as props.
- **Workspace synthesis from chat patterns (Library skill/workflow generation).** Future ticket per the spec.
- **Migrating non-chrome surfaces (CodeEditor body, FileViewer content, NotebookViewer, xterm.js host) to semantic tokens.** Those are content surfaces, not chrome; M32 leaves them alone.
