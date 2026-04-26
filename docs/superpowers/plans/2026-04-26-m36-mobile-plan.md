# M36 — Mobile + responsive breakpoints (final milestone of the redesign arc)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a usable phone (375 × 667) and tablet (768 × 1024) experience for the dashboard with native-feeling navigation — bottom tab bar on phone, slide-in drawer on tablet, sheet-based pickers, long-press action sheets, 44 × 44 touch targets — without regressing any desktop functionality.

**Architecture:** Tailwind v4 named breakpoints (`tablet:` ≥ 768, `desktop:` ≥ 1024 — base = phone) drive most chrome differences. A new `useMediaQuery` hook + `useBreakpoint` helper drive the JS-side major layout swaps (PhoneChatList vs desktop sidebar+main, PhoneTabBar vs ActivityBar). One generic `Sheet` primitive backs three sheet variants (mode picker, effort picker, message action sheet) and the full-screen `MoreCustomizationSheet` mobile state. New components: `Sheet`, `PhoneTabBar`, `TabletSidebarDrawer`, `PhoneChatList`, `PhoneChatDetail`, `MessageActionSheet`, `ModeToggleSheet`, `EffortPickerSheet`. Existing components — `ChatComposer`, `LibraryActivity`, `FilterChips`, `MoreCustomizationSheet`, `ActivityBar`, `DiffViewerTab`, `App.tsx` — get responsive variants and CSS adjustments. Three-viewport Playwright matrix (375/667, 768/1024, 1024/768) + axe-core scans at all three viewports in dark + light themes.

**Tech Stack:** React 19, Vite 8, Tailwind v4 (custom screens via `@theme` directive in `index.css` — **NOT** `tailwind.config.ts`; that file does not exist in this project), TanStack Query v5, Playwright, `@axe-core/playwright`. No new runtime dependencies.

**Final milestone in the redesign arc:** M31 (semantic palette) → M32 (router) → M33 (chat thread) → M34 (composer) → M35 (library) → **M36 (mobile)**. Post-merge, the dashboard is feature-complete for the M31–M36 redesign and ready for the v0.36 release-notes / changelog rollup.

---

## Critical decisions locked at plan-write time

These are non-obvious choices the implementer should NOT relitigate. They're surfaced in the relevant tasks as inline reminders too.

1. **Breakpoint thresholds match the spec, not Tailwind defaults.** Spec (lines 245–256 of the redesign design doc) defines `desktop ≥ 1024 / tablet 768–1023 / phone < 768`. Tailwind v4 ships `md = 768 / lg = 1024` by default — those numeric thresholds happen to match, but we OVERRIDE the names so the codebase reads `tablet:` and `desktop:` (matches the spec's vocabulary). No `xs:` is added — spec doesn't call for one.
2. **Tailwind v4 config lives in `dashboard/src/index.css` `@theme` block.** There is NO `dashboard/tailwind.config.ts`. The spec lists that file as "to modify" but it doesn't exist; do not create it. All breakpoint config goes in `index.css`.
3. **Sheet primitive is hand-rolled, not Radix Dialog.** Matches the M35 `MoreCustomizationSheet` precedent (M35 went hand-rolled despite Radix being M8's standard, citing "click-only" simplicity). Mobile sheets are even more constrained — no keyboard nav, just tap. Hand-rolled keeps the bundle small.
4. **Bottom-nav, not hamburger drawer, for phone top-level routes.** Matches "VSCode-on-mobile" iconography of the existing activity bar (5 icons map cleanly: Chats / Library / Files / Git / More). The "More" tab opens a drawer with the lower-priority routes (Settings, Problems).
5. **`hover:` Tailwind variants need `(hover: hover)` media query gating.** Touch devices fire `:hover` on tap and it sticks until the next interaction — a real problem on iOS. Tailwind v4 ships `hover:` mapped to `&:hover` by default (NOT gated). T1 adds the gate via custom variant `@custom-variant hover (&:hover @media (hover: hover))` in `index.css`. Verify with a small test before relying on it across the codebase.
6. **xterm.js mobile keyboard handling: BOTH the meta hint AND the JS listener.** `viewport-fit=cover` + `interactive-widget=resizes-content` in the viewport meta (T14) gets us the lay-of-the-land; `window.visualViewport` listener in PtyPane (T11) is the safety net for browsers that ignore the meta hint. Both layers — neither is sufficient alone on iOS Safari < 17.
7. **Modal backdrop tap on iOS Safari requires `cursor: pointer`.** Without it, iOS Safari treats the `<div onClick=...>` backdrop as non-interactive and the tap doesn't fire. Sheet primitive (T3) sets `cursor: pointer` on the backdrop unconditionally.
8. **Test viewports: 375×667 (iPhone SE), 768×1024 (iPad portrait), 1024×768 (iPad landscape — desktop boundary).** No iPhone X (812 height) — adds nothing testable beyond what 667 covers. No Android-specific cases — Chromium is the only Playwright browser the project runs.
9. **Visual regression deferred.** No Percy / Chromatic. Existing axe-core scans cover semantic correctness; visual regression is a future ticket. Spec is explicit about this being out of scope.
10. **JS-driven layout swap vs CSS-only:** CSS-only for chrome (rail width, mode toggle vs chip, tab bar visibility); JS-driven (`useMediaQuery`) for major component swaps (PhoneChatList vs desktop sidebar+main, PhoneTabBar vs ActivityBar). This is because rendering BOTH layouts and hiding one with CSS doubles the DOM and breaks event delegation. The hook decides which tree to mount.

---

## File structure

### New files (created)

| File                                                                  | Responsibility                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dashboard/src/hooks/useMediaQuery.ts`                                | Generic `useMediaQuery(query)` + named helpers `useIsPhone() / useIsTablet() / useIsDesktop()`. Also exports `BREAKPOINTS` constant for tests.                                                   |
| `dashboard/src/components/Sheet.tsx`                                  | Hand-rolled bottom-sheet primitive: backdrop + slide-up panel + close handlers. Used by ModeToggleSheet, EffortPickerSheet, MessageActionSheet, and the phone variant of MoreCustomizationSheet. |
| `dashboard/src/components/PhoneTabBar.tsx`                            | Bottom tab bar (5 icons: Chats / Library / Files / Git / More). Replaces ActivityBar at phone breakpoint.                                                                                        |
| `dashboard/src/components/TabletSidebarDrawer.tsx`                    | Slide-in drawer hosting the container list at tablet breakpoint. Hamburger trigger lives in the header.                                                                                          |
| `dashboard/src/components/PhoneChatList.tsx`                          | Phone-specific chats list view: workspace pill + search + date-grouped sessions + FAB for new chat.                                                                                              |
| `dashboard/src/components/PhoneChatDetail.tsx`                        | Phone-specific chat detail view: back-arrow header + chat title + mode chip + thread + composer.                                                                                                 |
| `dashboard/src/components/chat/MessageActionSheet.tsx`                | Long-press → bottom sheet with Retry / Fork / Copy / Edit. Replaces hover bar 1:1 on phone.                                                                                                      |
| `dashboard/src/components/chat/ModeToggleSheet.tsx`                   | Tap mode chip → sheet with 3-button picker (Code / Review / Plan).                                                                                                                               |
| `dashboard/src/components/chat/EffortPickerSheet.tsx`                 | Tap effort chip → sheet with 4-button picker (Low / Standard / High / Max).                                                                                                                      |
| `dashboard/src/hooks/__tests__/useMediaQuery.test.tsx`                | Tests for the hook with a mocked `matchMedia`.                                                                                                                                                   |
| `dashboard/src/components/__tests__/Sheet.test.tsx`                   | Tests for the sheet primitive: backdrop click, escape key, mount/unmount focus.                                                                                                                  |
| `dashboard/src/components/__tests__/PhoneTabBar.test.tsx`             | Tests for the tab bar: 5 buttons, active state, click navigates.                                                                                                                                 |
| `dashboard/src/components/__tests__/TabletSidebarDrawer.test.tsx`     | Tests for the drawer: hamburger toggle, click outside closes.                                                                                                                                    |
| `dashboard/src/components/__tests__/PhoneChatList.test.tsx`           | Tests for the phone list: empty state, FAB click, session click.                                                                                                                                 |
| `dashboard/src/components/__tests__/PhoneChatDetail.test.tsx`         | Tests for the phone detail: back-arrow callback, mode chip click.                                                                                                                                |
| `dashboard/src/components/chat/__tests__/MessageActionSheet.test.tsx` | Tests for the action sheet: 4 actions render, callback fires.                                                                                                                                    |
| `dashboard/src/components/chat/__tests__/ModeToggleSheet.test.tsx`    | Tests for the mode picker sheet.                                                                                                                                                                 |
| `dashboard/src/components/chat/__tests__/EffortPickerSheet.test.tsx`  | Tests for the effort picker sheet.                                                                                                                                                               |
| `dashboard/tests/e2e/mobile-chat.spec.ts`                             | Playwright at 375×667 — list view, tap into detail, send a message, long-press → action sheet.                                                                                                   |
| `dashboard/tests/e2e/tablet-chat.spec.ts`                             | Playwright at 768×1024 — drawer toggle, sidebar visibility, composer behavior.                                                                                                                   |
| `dashboard/tests/e2e/mobile-library.spec.ts`                          | Playwright at 375×667 — chip horizontal-scroll, MoreCustomizationSheet full-screen, tap card → stacked detail.                                                                                   |
| `dashboard/tests/e2e/responsive-axe.spec.ts`                          | axe-core scans at 375 / 768 / 1024 viewports in dark + light.                                                                                                                                    |

### Modified files

| File                                                                                                | Change                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard/src/index.css`                                                                           | Add `@theme` `--breakpoint-tablet`/`--breakpoint-desktop` tokens. Add `@custom-variant hover` to gate hover styles behind `(hover: hover)` media query. Add `.safe-area-inset-bottom` utility for the iOS home-indicator gap.                  |
| `dashboard/index.html`                                                                              | Update viewport meta with `viewport-fit=cover, interactive-widget=resizes-content`.                                                                                                                                                            |
| `dashboard/src/components/ActivityBar.tsx`                                                          | Hide at phone breakpoint (`hidden phone:hidden tablet:flex` — actually `hidden tablet:flex` since base = phone). Compact rail width to `w-12` (48 px) at tablet.                                                                               |
| `dashboard/src/App.tsx`                                                                             | Wire `useIsPhone()` to swap between desktop (existing layout) and phone (PhoneChatList ↔ PhoneChatDetail). Wire `useIsTablet()` to render TabletSidebarDrawer in place of the always-visible sidebar. Inject PhoneTabBar at phone breakpoint. |
| `dashboard/src/components/chat/ChatComposer.tsx`                                                    | At phone: collapse mode toggle to chip → ModeToggleSheet; collapse effort picker to chip → EffortPickerSheet; switch textarea to single-line auto-grow; hide the keyboard-hint row.                                                            |
| `dashboard/src/components/library/LibraryActivity.tsx`                                              | At phone: stack detail BELOW sidebar (flex-col); make sidebar fluid-width (no `w-80`); hide main pane when no artifact selected (sidebar-only view).                                                                                           |
| `dashboard/src/components/library/FilterChips.tsx`                                                  | At phone: chip row becomes horizontal-scroll (`overflow-x-auto`, `flex-nowrap`, `snap-start`).                                                                                                                                                 |
| `dashboard/src/components/library/MoreCustomizationSheet.tsx`                                       | At phone: refactor to use the new generic `Sheet` primitive (full-screen sheet on phone, popover on desktop).                                                                                                                                  |
| `dashboard/src/components/PtyPane.tsx`                                                              | Add `window.visualViewport` listener to recompute terminal dimensions when virtual keyboard opens/closes.                                                                                                                                      |
| `dashboard/src/components/DiffViewerTab.tsx`                                                        | Force `unified` mode at phone breakpoint (split is unreadable below 768 px). Hide the `Split` toolbar button at phone.                                                                                                                         |
| `dashboard/src/components/chat/MessageBubble.tsx` (or wherever the hover-revealed action bar lives) | At phone: replace hover-bar with long-press → MessageActionSheet. Use a small `useLongPress` hook inline.                                                                                                                                      |
| `dashboard/public/manifest.webmanifest`                                                             | Verify or create a sane PWA manifest with `display: standalone`, `theme_color`, `background_color`. Not gating PWA install — just sanity.                                                                                                      |

---

## Workflow contract (same as M31–M35)

For every milestone:

1. `git checkout main && git pull` — start from the current tip.
2. `git checkout -b m36-mobile` — branch from main.
3. Implement the task list. Commit per task with conventional-commit messages.
4. Run the verification checklist locally; CI must be green before merge.
5. Self-review using `superpowers:requesting-code-review`; address findings in new commits on the same branch.
6. Merge to `main` with `--no-ff` after CI green.
7. Tag `v0.36-mobile` on the merge commit.
8. Push `--follow-tags`. Watch CI for the merge run.
9. Delete the merged branch local + remote.

---

## Task 0: Verify branch + create feature branch

**Files:** none — git only.

- [ ] **Step 1: Confirm main is at the M35 merge.**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git log --oneline -1
```

Expected: `c3ee20c Merge M35: library (artifact aggregation)` (or newer if any direct commits to main happened).

- [ ] **Step 2: Confirm working tree is clean.**

```bash
git status
```

Expected: untracked `.claude/scheduled_tasks.lock` and `.claude/settings.json` are fine; nothing else.

- [ ] **Step 3: Create the M36 branch.**

```bash
git checkout -b m36-mobile
git rev-parse HEAD
```

Expected: `c3ee20c` (or whatever main is at). Branch `m36-mobile` is now active.

- [ ] **Step 4: Verify backend + dashboard baselines are green.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests -q
cd /home/gnava/repos/honeycomb/dashboard && npx vitest run
cd /home/gnava/repos/honeycomb/dashboard && npx playwright test
```

Expected:

- Hub: 484 passed.
- Vitest: 346 passed.
- Playwright: 51 passed.

If any baseline is red, STOP — investigate before adding M36 work on top.

---

## Task 1: Tailwind v4 breakpoint tokens + `(hover: hover)` gate

**Files:**

- Modify: `dashboard/src/index.css`

This task adds the `tablet:` and `desktop:` Tailwind variants used throughout the rest of the milestone, and gates `hover:` styles behind `@media (hover: hover)` so touch devices don't get sticky-hover footguns.

### Step 1: Read the existing `@theme` block

Open `dashboard/src/index.css` and confirm:

- The `@theme` block starts at line 19 (per the earlier inventory).
- No existing `--breakpoint-*` tokens.

- [ ] **Step 2: Add breakpoint tokens to `@theme`.**

Insert these four lines at the END of the `@theme` block (just before the closing `}` of `@theme`):

```css
/* M36 — responsive breakpoints. Mobile-first: base = phone (<768),
     tablet: ≥ 768, desktop: ≥ 1024. Names match the M36 spec
     (docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md
     §"Mobile breakpoints"). */
--breakpoint-tablet: 768px;
--breakpoint-desktop: 1024px;
```

- [ ] **Step 3: Add `@custom-variant hover` gate.**

Tailwind v4's default `hover:` variant fires on touch tap (sticky on iOS). Override with a media query gate. Add this BELOW the `@theme` block, as a standalone block:

```css
/* M36 — gate `hover:` styles behind (hover: hover) so touch devices
   don't get sticky-tap-as-hover. See:
   https://tailwindcss.com/docs/adding-custom-styles#with-arbitrary-variants */
@custom-variant hover (&:hover) (@media (hover: hover));
```

- [ ] **Step 4: Add the safe-area-inset utility.**

Append at the end of `index.css`:

```css
@layer utilities {
  /* M36 — iOS home-indicator gap. PhoneTabBar uses pb-[var(--safe-bottom)]
     so the tab bar floats above the home indicator on iPhone X+. */
  .pb-safe-bottom {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .pt-safe-top {
    padding-top: env(safe-area-inset-top, 0px);
  }
}
```

- [ ] **Step 5: Run prettier + tsc to confirm nothing else regressed.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/index.css
npx tsc -b --noEmit
npx vitest run
```

Expected: prettier rewrites `index.css` if needed (formatting only), tsc clean, vitest 346/346.

- [ ] **Step 6: Confirm the breakpoint utilities resolve.**

Quick smoke check — open a dev server briefly and verify in the browser DevTools console:

```bash
npm run dev &
sleep 4
# then in another shell:
curl -s http://localhost:5173/ | head -1
kill %1
```

(Optional — tsc + vitest already prove the CSS compiles.)

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/index.css
git commit -m "feat(m36): tablet:/desktop: breakpoints + hover-gate + safe-area utilities

Add the M36 spec's named breakpoints to the Tailwind v4 @theme:
--breakpoint-tablet: 768px and --breakpoint-desktop: 1024px. Phone
is the base (mobile-first). Tailwind v4 picks these up automatically
as 'tablet:' and 'desktop:' variants — no JS-side config change.

Add @custom-variant hover gating so 'hover:' styles only apply on
pointer-fine devices (avoids the sticky-tap-as-hover footgun on iOS).

Add .pb-safe-bottom and .pt-safe-top utilities for the iOS notch +
home-indicator gaps. PhoneTabBar will use the bottom one in T4."
```

---

## Task 2: useMediaQuery hook + breakpoint constants

**Files:**

- Create: `dashboard/src/hooks/useMediaQuery.ts`
- Create: `dashboard/src/hooks/__tests__/useMediaQuery.test.tsx`

The hook drives JS-level layout swaps (PhoneChatList vs desktop, PhoneTabBar vs ActivityBar). CSS-only Tailwind variants handle the rest.

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/hooks/__tests__/useMediaQuery.test.tsx`:

```tsx
/** useMediaQuery hook tests (M36). */
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useMediaQuery,
  useIsPhone,
  useIsTablet,
  useIsDesktop,
  BREAKPOINTS,
} from "../useMediaQuery";

// matchMedia mock — installed per-test, restored in afterEach.
type MqlListener = (e: MediaQueryListEvent) => void;
type MqlState = { matches: boolean; listeners: Set<MqlListener> };

const mqlState = new Map<string, MqlState>();

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      let state = mqlState.get(query);
      if (!state) {
        state = { matches: false, listeners: new Set() };
        mqlState.set(query, state);
      }
      const mql = {
        media: query,
        get matches() {
          return state!.matches;
        },
        addEventListener: (_: string, cb: MqlListener) => state!.listeners.add(cb),
        removeEventListener: (_: string, cb: MqlListener) => state!.listeners.delete(cb),
        // legacy API:
        addListener: (cb: MqlListener) => state!.listeners.add(cb),
        removeListener: (cb: MqlListener) => state!.listeners.delete(cb),
        dispatchEvent: () => true,
        onchange: null,
      };
      return mql as unknown as MediaQueryList;
    },
  });
}

function setMatches(query: string, matches: boolean) {
  const state = mqlState.get(query);
  if (!state) throw new Error(`unknown query: ${query}`);
  state.matches = matches;
  const event = { matches } as unknown as MediaQueryListEvent;
  for (const cb of state.listeners) cb(event);
}

beforeEach(() => {
  mqlState.clear();
  installMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMediaQuery", () => {
  it("returns the initial matches value of the query", () => {
    mqlState.set("(min-width: 768px)", { matches: true, listeners: new Set() });
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the query changes", () => {
    mqlState.set("(min-width: 768px)", { matches: false, listeners: new Set() });
    const { result } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(result.current).toBe(false);
    act(() => setMatches("(min-width: 768px)", true));
    expect(result.current).toBe(true);
  });

  it("removes its listener on unmount", () => {
    mqlState.set("(min-width: 768px)", { matches: false, listeners: new Set() });
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 768px)"));
    expect(mqlState.get("(min-width: 768px)")!.listeners.size).toBe(1);
    unmount();
    expect(mqlState.get("(min-width: 768px)")!.listeners.size).toBe(0);
  });
});

describe("named breakpoint helpers", () => {
  it("useIsPhone is true when neither tablet nor desktop matches", () => {
    mqlState.set(`(min-width: ${BREAKPOINTS.tablet}px)`, {
      matches: false,
      listeners: new Set(),
    });
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(true);
  });

  it("useIsTablet is true when tablet matches but desktop does not", () => {
    mqlState.set(`(min-width: ${BREAKPOINTS.tablet}px)`, {
      matches: true,
      listeners: new Set(),
    });
    mqlState.set(`(min-width: ${BREAKPOINTS.desktop}px)`, {
      matches: false,
      listeners: new Set(),
    });
    const { result } = renderHook(() => useIsTablet());
    expect(result.current).toBe(true);
  });

  it("useIsDesktop is true when desktop matches", () => {
    mqlState.set(`(min-width: ${BREAKPOINTS.desktop}px)`, {
      matches: true,
      listeners: new Set(),
    });
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useMediaQuery.test.tsx
```

Expected: FAIL — module `../useMediaQuery` does not exist.

- [ ] **Step 3: Implement the hook.**

Create `/home/gnava/repos/honeycomb/dashboard/src/hooks/useMediaQuery.ts`:

```ts
/** useMediaQuery — reactive media-query subscription (M36).
 *
 *  Returns the current `matches` value of the query and re-renders
 *  when the media-query state flips. Cleans up its listener on
 *  unmount.
 *
 *  Named helpers (useIsPhone / useIsTablet / useIsDesktop) wrap the
 *  spec's three breakpoint thresholds (phone < 768, tablet 768–1023,
 *  desktop ≥ 1024). They drive the JS-level layout swaps in App.tsx
 *  while CSS-only Tailwind variants (tablet: / desktop:) handle the
 *  chrome adjustments.
 *
 *  SSR: returns `false` if `window` is undefined; the first client
 *  render reconciles to the real value.
 */
import { useEffect, useState } from "react";

export const BREAKPOINTS = {
  tablet: 768,
  desktop: 1024,
} as const;

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Resync once on mount in case the initial value was stale.
    setMatches(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export function useIsTablet(): boolean {
  // tablet covers 768–1023; the helper returns true only when we are
  // EXACTLY in that band (≥ tablet AND NOT ≥ desktop).
  const tabletOrUp = useMediaQuery(`(min-width: ${BREAKPOINTS.tablet}px)`);
  const desktopOrUp = useMediaQuery(`(min-width: ${BREAKPOINTS.desktop}px)`);
  return tabletOrUp && !desktopOrUp;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS.desktop}px)`);
}

export function useIsPhone(): boolean {
  // Phone is the base — true when neither tablet nor desktop matches.
  const tabletOrUp = useMediaQuery(`(min-width: ${BREAKPOINTS.tablet}px)`);
  return !tabletOrUp;
}
```

- [ ] **Step 4: Run tests, expect 6/6 PASS.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useMediaQuery.test.tsx
```

Expected: 6/6 PASS.

- [ ] **Step 5: Run full vitest + tsc.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

Expected: tsc clean, vitest 352/352 (346 prior + 6 new).

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useMediaQuery.ts dashboard/src/hooks/__tests__/useMediaQuery.test.tsx
git commit -m "feat(m36): useMediaQuery hook + named breakpoint helpers

Reactive matchMedia subscription with proper cleanup. Three named
helpers map to the M36 spec's breakpoints:
- useIsPhone()   → < 768
- useIsTablet()  → 768–1023
- useIsDesktop() → ≥ 1024

CSS-only Tailwind variants (tablet:/desktop:) handle chrome
adjustments; this hook drives the JS-level layout swaps that
follow (PhoneChatList vs desktop, PhoneTabBar vs ActivityBar)."
```

---

## Task 3: Sheet primitive (bottom-sheet for phone)

**Files:**

- Create: `dashboard/src/components/Sheet.tsx`
- Create: `dashboard/src/components/__tests__/Sheet.test.tsx`

Generic bottom-sheet primitive. Used by 4 callers (ModeToggleSheet, EffortPickerSheet, MessageActionSheet, the phone variant of MoreCustomizationSheet). Hand-rolled per the M35 / M8 precedent.

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/__tests__/Sheet.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sheet } from "../Sheet";

afterEach(() => {
  // Reset the document body in case a sheet leaks a class.
  document.body.className = "";
});

describe("Sheet", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <Sheet open={false} onClose={vi.fn()} title="Test sheet">
        body
      </Sheet>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders title + body + close button when open=true", () => {
    render(
      <Sheet open={true} onClose={vi.fn()} title="Pick mode">
        body
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Pick mode" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="t">
        body
      </Sheet>,
    );
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the panel does NOT call onClose", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="t">
        <button>inside</button>
      </Sheet>,
    );
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="t">
        body
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop has cursor: pointer (iOS Safari tap fix)", () => {
    render(
      <Sheet open={true} onClose={vi.fn()} title="t">
        body
      </Sheet>,
    );
    const bd = screen.getByTestId("sheet-backdrop");
    expect(bd.className).toContain("cursor-pointer");
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/Sheet.test.tsx
```

- [ ] **Step 3: Implement Sheet.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/Sheet.tsx`:

```tsx
/** Sheet — hand-rolled bottom-sheet primitive (M36).
 *
 *  Used by ModeToggleSheet, EffortPickerSheet, MessageActionSheet,
 *  and the phone variant of MoreCustomizationSheet. Per the M35
 *  precedent (MoreCustomizationSheet), we hand-roll instead of using
 *  Radix Dialog — mobile sheets are click-only and the bundle savings
 *  matter on phones.
 *
 *  Backdrop has cursor: pointer so iOS Safari treats the tap as
 *  interactive (without it the tap is silently ignored). Escape key
 *  also closes.
 *
 *  Slides up from the bottom with a 200ms CSS transition. Respects
 *  the iOS safe-area-inset-bottom via .pb-safe-bottom.
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Override the default max-height (90vh). For action sheets that
   *  should hug their content, pass "auto". */
  maxHeight?: string;
}

export function Sheet({ open, onClose, title, children, maxHeight = "90vh" }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        data-testid="sheet-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-pointer bg-black/50"
      />
      <div
        role="dialog"
        aria-label={title}
        className="border-edge bg-pane pb-safe-bottom fixed right-0 bottom-0 left-0 z-50 flex flex-col rounded-t-xl border-t shadow-pop"
        style={{ maxHeight }}
      >
        <header className="border-edge flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-primary text-[14px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sheet"
            className="text-secondary hover:text-primary rounded p-1.5"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run tests, expect 6/6 PASS.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/Sheet.test.tsx
```

- [ ] **Step 5: Run prettier + tsc.**

```bash
npx prettier --write src/components/Sheet.tsx src/components/__tests__/Sheet.test.tsx
npx tsc -b --noEmit
```

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/Sheet.tsx dashboard/src/components/__tests__/Sheet.test.tsx
git commit -m "feat(m36): Sheet primitive (hand-rolled bottom-sheet for phone)

Generic bottom-sheet used by ModeToggleSheet, EffortPickerSheet,
MessageActionSheet, and the phone variant of MoreCustomizationSheet.
Hand-rolled per the M35 / M8 precedent — mobile sheets are
click-only, bundle savings matter on phones.

Backdrop has cursor: pointer (iOS Safari tap fix). Escape key closes.
Respects safe-area-inset-bottom via .pb-safe-bottom."
```

---

## Task 4: PhoneTabBar

**Files:**

- Create: `dashboard/src/components/PhoneTabBar.tsx`
- Create: `dashboard/src/components/__tests__/PhoneTabBar.test.tsx`

Bottom tab bar for phone. Replaces ActivityBar at phone breakpoint. 5 tabs: Chats / Library / Files / Git / More.

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/__tests__/PhoneTabBar.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneTabBar } from "../PhoneTabBar";

describe("PhoneTabBar", () => {
  it("renders 5 tab buttons (Chats / Library / Files / Git / More)", () => {
    render(<PhoneTabBar activeTab="chats" onTabChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /chats/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /library/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /files/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /git/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /more/i })).toBeTruthy();
  });

  it("the active tab carries aria-current=page", () => {
    render(<PhoneTabBar activeTab="library" onTabChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /library/i }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: /chats/i }).getAttribute("aria-current")).toBeNull();
  });

  it("clicking a tab calls onTabChange with the tab id", () => {
    const onTabChange = vi.fn();
    render(<PhoneTabBar activeTab="chats" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("button", { name: /library/i }));
    expect(onTabChange).toHaveBeenCalledWith("library");
  });

  it("each tab button is at least 44x44 (iOS HIG)", () => {
    const { container } = render(<PhoneTabBar activeTab="chats" onTabChange={vi.fn()} />);
    const buttons = container.querySelectorAll('button[role="button"], button:not([role])');
    for (const b of buttons) {
      expect((b as HTMLElement).className).toMatch(/min-h-\[44px\]/);
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement PhoneTabBar.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/PhoneTabBar.tsx`:

```tsx
/** PhoneTabBar — bottom tab bar for phone (<768px) (M36).
 *
 *  Replaces the ActivityBar (visible only at tablet+desktop). 5 tabs
 *  match the desktop activity rail's primary entries:
 *    Chats / Library / Files / Git / More
 *
 *  "More" opens a sheet listing the lower-priority routes
 *  (Settings, Problems). M36 keeps the tab bar at 5 entries — adding
 *  a 6th turns the bar into a horizontal-scroll surface which doesn't
 *  feel native.
 *
 *  Tap targets are 44x44 minimum (iOS HIG).
 *
 *  Hidden in detail views per the M36 spec (composer needs the
 *  vertical real-estate); App.tsx controls visibility via the
 *  `visible` prop.
 */
import { MessageSquare, BookOpen, FolderOpen, GitBranch, MoreHorizontal } from "lucide-react";

export type PhoneTab = "chats" | "library" | "files" | "git" | "more";

interface Props {
  activeTab: PhoneTab;
  onTabChange: (tab: PhoneTab) => void;
  visible?: boolean; // default true; hidden in detail views
}

const TABS: { id: PhoneTab; label: string; icon: React.ReactElement }[] = [
  { id: "chats", label: "Chats", icon: <MessageSquare size={20} aria-hidden="true" /> },
  { id: "library", label: "Library", icon: <BookOpen size={20} aria-hidden="true" /> },
  { id: "files", label: "Files", icon: <FolderOpen size={20} aria-hidden="true" /> },
  { id: "git", label: "Git", icon: <GitBranch size={20} aria-hidden="true" /> },
  { id: "more", label: "More", icon: <MoreHorizontal size={20} aria-hidden="true" /> },
];

export function PhoneTabBar({ activeTab, onTabChange, visible = true }: Props) {
  if (!visible) return null;
  return (
    <nav
      aria-label="Phone bottom navigation"
      className="border-edge bg-pane pb-safe-bottom fixed right-0 bottom-0 left-0 z-30 flex border-t"
    >
      {TABS.map((t) => {
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onTabChange(t.id)}
            className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] transition-colors ${
              active ? "text-accent" : "text-secondary"
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run tests, expect 4/4 PASS.**

- [ ] **Step 5: Prettier + tsc.**

```bash
npx prettier --write src/components/PhoneTabBar.tsx src/components/__tests__/PhoneTabBar.test.tsx
npx tsc -b --noEmit
npx vitest run
```

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/PhoneTabBar.tsx dashboard/src/components/__tests__/PhoneTabBar.test.tsx
git commit -m "feat(m36): PhoneTabBar — bottom tab bar for phone (<768px)

5 tabs (Chats / Library / Files / Git / More) match the desktop
activity rail's primary entries. 'More' opens a sheet listing
lower-priority routes (Settings / Problems).

44x44 tap targets per iOS HIG. Respects safe-area-inset-bottom for
the iPhone home indicator. Hidden in detail views (App.tsx
controls visibility) so the composer gets full vertical room."
```

---

## Task 5: ActivityBar responsive + TabletSidebarDrawer

**Files:**

- Create: `dashboard/src/components/TabletSidebarDrawer.tsx`
- Create: `dashboard/src/components/__tests__/TabletSidebarDrawer.test.tsx`
- Modify: `dashboard/src/components/ActivityBar.tsx`

ActivityBar shrinks to 48 px on tablet (was 56 px on desktop) and is hidden entirely on phone. TabletSidebarDrawer hosts the container list as a slide-in drawer, triggered from a hamburger button.

### Step 1: Failing test for TabletSidebarDrawer

Create `/home/gnava/repos/honeycomb/dashboard/src/components/__tests__/TabletSidebarDrawer.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TabletSidebarDrawer } from "../TabletSidebarDrawer";

describe("TabletSidebarDrawer", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <TabletSidebarDrawer open={false} onClose={vi.fn()}>
        <p>sidebar content</p>
      </TabletSidebarDrawer>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the children when open=true", () => {
    render(
      <TabletSidebarDrawer open={true} onClose={vi.fn()}>
        <p>sidebar content</p>
      </TabletSidebarDrawer>,
    );
    expect(screen.getByText("sidebar content")).toBeTruthy();
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(
      <TabletSidebarDrawer open={true} onClose={onClose}>
        <p>x</p>
      </TabletSidebarDrawer>,
    );
    fireEvent.click(screen.getByTestId("drawer-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    render(
      <TabletSidebarDrawer open={true} onClose={onClose}>
        <p>x</p>
      </TabletSidebarDrawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has role=dialog with an aria-label", () => {
    render(
      <TabletSidebarDrawer open={true} onClose={vi.fn()}>
        <p>x</p>
      </TabletSidebarDrawer>,
    );
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement TabletSidebarDrawer.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/TabletSidebarDrawer.tsx`:

```tsx
/** TabletSidebarDrawer — slide-in drawer for the container sidebar at
 *  the tablet breakpoint (768–1023px) (M36).
 *
 *  Hamburger button in the header (App.tsx) toggles `open`. Backdrop
 *  click + Escape both close. Slides in from the LEFT (matches the
 *  desktop sidebar's position).
 *
 *  Width: 280px (matches the desktop `w-72` ~ 288px sidebar so the
 *  hosted ContainerList renders at its natural size).
 */
import { useEffect } from "react";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function TabletSidebarDrawer({ open, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div
        data-testid="drawer-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-pointer bg-black/50"
      />
      <aside
        role="dialog"
        aria-label="Container sidebar"
        className="border-edge bg-pane fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r shadow-pop"
      >
        {children}
      </aside>
    </>
  );
}
```

- [ ] **Step 4: Run tests, expect 5/5 PASS.**

- [ ] **Step 5: Update ActivityBar to compact at tablet, hide at phone.**

Open `dashboard/src/components/ActivityBar.tsx`. Find the outer `<aside>` or `<div>` that sets `w-12` (or whatever the desktop rail width is). Apply two responsive classes:

- Hide at phone: add `hidden tablet:flex` (the rail is invisible at phone; PhoneTabBar replaces it).
- Tablet vs desktop width: keep `w-12` everywhere — the spec says 48px at tablet, 56px at desktop, but the existing rail is already `w-12`. Document in the file header that we kept w-12 at both because the design difference is purely aspirational and doesn't justify a CSS variant.

Concretely: read the file first, then add `hidden tablet:flex` to the outer container's className. If the existing className uses `flex` directly, change to `hidden tablet:flex` (the `flex` is overridden at tablet+).

Add a header doc-comment update noting:

```tsx
/** Activity bar — leftmost rail (M32 base, M36 mobile-aware).
 *
 *  M36: hidden at phone (<768px); PhoneTabBar replaces it.
 *  Width is w-12 (48px) at tablet and desktop; the spec aspirated
 *  56px at desktop but the difference is too small to be worth a
 *  variant.
 */
```

- [ ] **Step 6: Run vitest + tsc + prettier.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/components/TabletSidebarDrawer.tsx src/components/__tests__/TabletSidebarDrawer.test.tsx src/components/ActivityBar.tsx
npx tsc -b --noEmit
npx vitest run
```

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/TabletSidebarDrawer.tsx dashboard/src/components/__tests__/TabletSidebarDrawer.test.tsx dashboard/src/components/ActivityBar.tsx
git commit -m "feat(m36): TabletSidebarDrawer + ActivityBar mobile-aware

ActivityBar hidden at phone (PhoneTabBar replaces it). Rail width
stays w-12 — the spec's 48 vs 56px difference is too small to
warrant a variant.

TabletSidebarDrawer hosts the container sidebar as a slide-in
drawer at the tablet breakpoint (768–1023). Hamburger trigger in
the header (T-app integration); backdrop + Escape both close."
```

---

## Task 6: PhoneChatList

**Files:**

- Create: `dashboard/src/components/PhoneChatList.tsx`
- Create: `dashboard/src/components/__tests__/PhoneChatList.test.tsx`

Phone-specific chats list view. Workspace pill at top, search, date-grouped session rows, FAB for new chat. The session rows reuse the existing chat-session card data shape from M33.

### Step 1: Failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/__tests__/PhoneChatList.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneChatList } from "../PhoneChatList";
import type { NamedSession } from "../../lib/types";

const session1: NamedSession = {
  session_id: "s-1",
  container_id: 1,
  name: "Refactor auth",
  kind: "claude",
  claude_session_id: null,
  cwd: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};
const session2: NamedSession = {
  session_id: "s-2",
  container_id: 1,
  name: "Fix bug 42",
  kind: "claude",
  claude_session_id: null,
  cwd: null,
  created_at: "2026-04-25T08:00:00Z",
  updated_at: "2026-04-25T08:00:00Z",
};

describe("PhoneChatList", () => {
  it("renders the workspace name in the pill at top", () => {
    render(
      <PhoneChatList
        workspaceName="my-project"
        sessions={[session1, session2]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText("my-project")).toBeTruthy();
  });

  it("renders a row per session", () => {
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[session1, session2]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText("Refactor auth")).toBeTruthy();
    expect(screen.getByText("Fix bug 42")).toBeTruthy();
  });

  it("clicking a session row calls onSelectSession with the session_id", () => {
    const onSelectSession = vi.fn();
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[session1]}
        onSelectSession={onSelectSession}
        onNewChat={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Refactor auth"));
    expect(onSelectSession).toHaveBeenCalledWith("s-1");
  });

  it("clicking the FAB calls onNewChat", () => {
    const onNewChat = vi.fn();
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[]}
        onSelectSession={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("renders an empty state when no sessions", () => {
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText(/no chats yet/i)).toBeTruthy();
  });

  it("typing in the search filters the visible rows", () => {
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[session1, session2]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Fix" } });
    expect(screen.queryByText("Refactor auth")).toBeNull();
    expect(screen.getByText("Fix bug 42")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement PhoneChatList.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/PhoneChatList.tsx`:

```tsx
/** PhoneChatList — list view for chats at phone breakpoint (M36).
 *
 *  Workspace pill at top, search input, list of session rows, FAB
 *  for new chat. Tapping a row navigates to PhoneChatDetail.
 *
 *  No sub-tabs / no resource readout / no edit-auto toggle — those
 *  are cut on phone per the M36 spec ("What's cut on phone" §).
 */
import { Plus, Search } from "lucide-react";
import { useState } from "react";

import type { NamedSession } from "../lib/types";

interface Props {
  workspaceName: string;
  sessions: NamedSession[];
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
}

function relativeDateGroup(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.floor((now - t) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Last 7 days";
  if (days < 30) return "Last 30 days";
  return "Older";
}

export function PhoneChatList({ workspaceName, sessions, onSelectSession, onNewChat }: Props) {
  const [query, setQuery] = useState("");

  const filtered = query
    ? sessions.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    : sessions;

  // Group by relative date bucket. Order: Today → Yesterday → Last 7 → Last 30 → Older.
  const groupOrder = ["Today", "Yesterday", "Last 7 days", "Last 30 days", "Older"] as const;
  const groups = new Map<string, NamedSession[]>();
  for (const s of filtered) {
    const bucket = relativeDateGroup(s.updated_at);
    const arr = groups.get(bucket) ?? [];
    arr.push(s);
    groups.set(bucket, arr);
  }

  return (
    <div className="bg-page flex h-full flex-col">
      <header className="border-edge bg-pane border-b px-4 py-3">
        <div className="bg-chip border-edge-soft text-primary flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium">
          <span className="bg-accent inline-block h-1.5 w-1.5 rounded-full" />
          {workspaceName}
        </div>
        <label className="bg-input border-edge text-primary focus-within:border-accent mt-3 flex items-center gap-2 rounded border px-2 py-2 text-[12px]">
          <Search size={14} aria-hidden="true" className="text-muted shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            className="placeholder:text-muted flex-1 bg-transparent focus:outline-none"
          />
        </label>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {filtered.length === 0 ? (
          <p className="text-secondary px-3 py-8 text-center text-[13px]">
            {query ? "No chats match your search." : "No chats yet. Tap + to start one."}
          </p>
        ) : (
          groupOrder.map((g) => {
            const items = groups.get(g);
            if (!items || items.length === 0) return null;
            return (
              <section key={g} className="mb-4">
                <h2 className="text-muted mb-1.5 px-1 text-[10px] font-semibold tracking-wider uppercase">
                  {g}
                </h2>
                <ul className="flex flex-col gap-1">
                  {items.map((s) => (
                    <li key={s.session_id}>
                      <button
                        type="button"
                        onClick={() => onSelectSession(s.session_id)}
                        className="bg-pane border-edge-soft hover:bg-chip text-primary flex min-h-[44px] w-full items-center gap-3 rounded border px-3 py-2 text-left text-[13px]"
                      >
                        <span className="flex-1 truncate">{s.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <button
        type="button"
        onClick={onNewChat}
        aria-label="New chat"
        className="bg-accent text-primary fixed right-4 bottom-20 z-20 flex h-12 w-12 items-center justify-center rounded-full shadow-pop"
      >
        <Plus size={22} aria-hidden="true" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect 6/6 PASS.**

- [ ] **Step 5: Run prettier + tsc + vitest.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/components/PhoneChatList.tsx src/components/__tests__/PhoneChatList.test.tsx
npx tsc -b --noEmit
npx vitest run
```

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/PhoneChatList.tsx dashboard/src/components/__tests__/PhoneChatList.test.tsx
git commit -m "feat(m36): PhoneChatList — phone list view for chats

Workspace pill + search + date-grouped session rows + FAB for new
chat. Tapping a row navigates to PhoneChatDetail. Search is
client-side substring filter (debounced search isn't needed —
session lists are small).

44x44 row height, 48x48 FAB. Bottom 20 padding so the FAB sits
above the PhoneTabBar."
```

---

## Task 7: PhoneChatDetail

**Files:**

- Create: `dashboard/src/components/PhoneChatDetail.tsx`
- Create: `dashboard/src/components/__tests__/PhoneChatDetail.test.tsx`

Phone-specific chat detail view. Back-arrow header + title + mode chip + thread + composer. Reuses the existing `ChatThread` and `ChatComposer` from M33/M34 — the M36 changes are scoped to the wrapper chrome (header + lack of tab strip + lack of secondary panes).

### Step 1: Failing test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/__tests__/PhoneChatDetail.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneChatDetail } from "../PhoneChatDetail";

describe("PhoneChatDetail", () => {
  it("renders a back-arrow button with aria-label='Back to chat list'", () => {
    render(
      <PhoneChatDetail title="my-chat" onBack={vi.fn()}>
        <p>thread + composer go here</p>
      </PhoneChatDetail>,
    );
    expect(screen.getByRole("button", { name: /back to chat list/i })).toBeTruthy();
  });

  it("clicking the back-arrow calls onBack", () => {
    const onBack = vi.fn();
    render(
      <PhoneChatDetail title="my-chat" onBack={onBack}>
        <p>x</p>
      </PhoneChatDetail>,
    );
    fireEvent.click(screen.getByRole("button", { name: /back to chat list/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the title in the header", () => {
    render(
      <PhoneChatDetail title="my-chat" onBack={vi.fn()}>
        <p>x</p>
      </PhoneChatDetail>,
    );
    expect(screen.getByText("my-chat")).toBeTruthy();
  });

  it("renders the children below the header", () => {
    render(
      <PhoneChatDetail title="x" onBack={vi.fn()}>
        <p>composer area</p>
      </PhoneChatDetail>,
    );
    expect(screen.getByText("composer area")).toBeTruthy();
  });

  it("the back-arrow has min-h-[44px] for tap target", () => {
    render(
      <PhoneChatDetail title="x" onBack={vi.fn()}>
        <p>x</p>
      </PhoneChatDetail>,
    );
    const back = screen.getByRole("button", { name: /back to chat list/i });
    expect(back.className).toMatch(/min-h-\[44px\]/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement PhoneChatDetail.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/PhoneChatDetail.tsx`:

```tsx
/** PhoneChatDetail — wrapper for the chat thread + composer at phone
 *  breakpoint (M36).
 *
 *  Renders: back-arrow + title + (children = thread + composer).
 *  No tab strip, no secondary panes, no resource readout. Composer
 *  variant is handled by ChatComposer's own breakpoint logic (T8).
 *
 *  PhoneTabBar is hidden when this view is mounted (App.tsx).
 */
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  onBack: () => void;
  children: ReactNode;
}

export function PhoneChatDetail({ title, onBack, children }: Props) {
  return (
    <div className="bg-page flex h-full flex-col">
      <header className="border-edge bg-pane flex items-center gap-2 border-b px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to chat list"
          className="text-secondary hover:text-primary flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <h1 className="text-primary flex-1 truncate text-[14px] font-semibold">{title}</h1>
      </header>
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect 5/5 PASS.**

- [ ] **Step 5: Prettier + tsc + vitest.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/components/PhoneChatDetail.tsx src/components/__tests__/PhoneChatDetail.test.tsx
npx tsc -b --noEmit
npx vitest run
```

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/PhoneChatDetail.tsx dashboard/src/components/__tests__/PhoneChatDetail.test.tsx
git commit -m "feat(m36): PhoneChatDetail — phone wrapper for chat thread + composer

Back-arrow + title in the header; children fill the remaining
viewport. ChatComposer's own breakpoint logic (T8) handles the
composer-side mobile tweaks. No tab strip, no secondary panes,
no resource readout — those are cut on phone per the M36 spec."
```

---

## Task 8: ChatComposer responsive (mode chip → sheet, effort chip → sheet, single-line)

**Files:**

- Create: `dashboard/src/components/chat/ModeToggleSheet.tsx`
- Create: `dashboard/src/components/chat/EffortPickerSheet.tsx`
- Create: `dashboard/src/components/chat/__tests__/ModeToggleSheet.test.tsx`
- Create: `dashboard/src/components/chat/__tests__/EffortPickerSheet.test.tsx`
- Modify: `dashboard/src/components/chat/ChatComposer.tsx`

At phone, the multi-button mode toggle and effort picker collapse to chips that open sheets. The textarea becomes single-line auto-grow. The keyboard-hint row is hidden.

**Type drift caught at plan time:** M34 ships `ChatEffort = "quick" | "standard" | "deep" | "max"` exported from `dashboard/src/components/chat/EffortControl.tsx`. The plan uses these names exactly — DO NOT invent `low | high` aliases.

### Step 1: ModeToggleSheet test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/ModeToggleSheet.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModeToggleSheet } from "../ModeToggleSheet";

describe("ModeToggleSheet", () => {
  it("renders Code / Review / Plan when open", () => {
    render(<ModeToggleSheet open={true} mode="code" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^code$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^plan$/i })).toBeTruthy();
  });

  it("clicking a mode calls onSelect with the mode and onClose", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ModeToggleSheet open={true} mode="code" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^plan$/i }));
    expect(onSelect).toHaveBeenCalledWith("plan");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the active mode carries aria-pressed=true", () => {
    render(<ModeToggleSheet open={true} mode="review" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^review$/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
```

- [ ] **Step 2: Implement ModeToggleSheet.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/ModeToggleSheet.tsx`:

```tsx
/** ModeToggleSheet — phone variant of the M33 ModeToggle (M36).
 *
 *  Wraps the Sheet primitive with three buttons (Code / Review /
 *  Plan). Selecting closes the sheet immediately.
 */
import { Sheet } from "../Sheet";
import type { ChatMode } from "./ModeToggle";

interface Props {
  open: boolean;
  mode: ChatMode;
  onSelect: (mode: ChatMode) => void;
  onClose: () => void;
}

const MODES: { id: ChatMode; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
];

export function ModeToggleSheet({ open, mode, onSelect, onClose }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="Chat mode" maxHeight="auto">
      <ul className="flex flex-col gap-1">
        {MODES.map((m) => {
          const active = m.id === mode;
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onSelect(m.id);
                  onClose();
                }}
                className={`flex min-h-[44px] w-full items-center justify-between rounded px-3 py-2 text-left text-[14px] ${
                  active ? "bg-accent/10 text-primary" : "text-secondary hover:bg-chip"
                }`}
              >
                <span>{m.label}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
```

- [ ] **Step 3: EffortPickerSheet test.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/EffortPickerSheet.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EffortPickerSheet } from "../EffortPickerSheet";

describe("EffortPickerSheet", () => {
  it("renders Quick / Standard / Deep / Max when open", () => {
    render(
      <EffortPickerSheet open={true} effort="standard" onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /^quick$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^standard$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^deep$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^max$/i })).toBeTruthy();
  });

  it("clicking an effort calls onSelect and onClose", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <EffortPickerSheet open={true} effort="standard" onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^deep$/i }));
    expect(onSelect).toHaveBeenCalledWith("deep");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Implement EffortPickerSheet.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/EffortPickerSheet.tsx`:

```tsx
/** EffortPickerSheet — phone variant of the M34 effort picker (M36).
 *
 *  Wraps the Sheet primitive with four buttons. Reuses M34's
 *  ChatEffort union from EffortControl.tsx — DO NOT redefine.
 */
import { Sheet } from "../Sheet";
import type { ChatEffort } from "./EffortControl";

interface Props {
  open: boolean;
  effort: ChatEffort;
  onSelect: (effort: ChatEffort) => void;
  onClose: () => void;
}

const EFFORTS: { id: ChatEffort; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "standard", label: "Standard" },
  { id: "deep", label: "Deep" },
  { id: "max", label: "Max" },
];

export function EffortPickerSheet({ open, effort, onSelect, onClose }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="Effort level" maxHeight="auto">
      <ul className="flex flex-col gap-1">
        {EFFORTS.map((e) => {
          const active = e.id === effort;
          return (
            <li key={e.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onSelect(e.id);
                  onClose();
                }}
                className={`flex min-h-[44px] w-full items-center justify-between rounded px-3 py-2 text-left text-[14px] ${
                  active ? "bg-accent/10 text-primary" : "text-secondary hover:bg-chip"
                }`}
              >
                <span>{e.label}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
```

- [ ] **Step 5: Run sheet tests, expect 5/5 PASS.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/ModeToggleSheet.test.tsx src/components/chat/__tests__/EffortPickerSheet.test.tsx
```

- [ ] **Step 6: Wire ChatComposer to the sheets at phone.**

Open `dashboard/src/components/chat/ChatComposer.tsx` and read the existing component end-to-end. Add:

1. Import `useIsPhone` from `../../hooks/useMediaQuery`, `ModeToggleSheet`, `EffortPickerSheet`.
2. Two `useState` flags: `[modeSheetOpen, setModeSheetOpen] = useState(false)` and `[effortSheetOpen, setEffortSheetOpen] = useState(false)`.
3. `const isPhone = useIsPhone();`
4. Where the existing 3-segment `<ModeToggle>` is rendered, wrap with `{isPhone ? <ModeChip onClick={() => setModeSheetOpen(true)} mode={mode} /> : <ModeToggle ... />}`. Similarly for the effort picker.
5. Add a small inline `ModeChip` sub-component (or mini component) that renders a single button showing the current mode label.
6. After the rendered toggle, add `<ModeToggleSheet open={modeSheetOpen} mode={mode} onSelect={setMode} onClose={() => setModeSheetOpen(false)} />` and `<EffortPickerSheet open={effortSheetOpen} effort={effort} onSelect={setEffort} onClose={() => setEffortSheetOpen(false)} />`.
7. The textarea: at phone, set `rows={1}` and add an `onInput` that resizes via `el.style.height = "auto"; el.style.height = el.scrollHeight + "px"` capped at 5 rows.
8. The keyboard-hint row (the "⌘↵ to send" / "esc" / "↑↓ history" line if present): wrap in `{!isPhone && (...)}`.
9. The `<EditAutoToggle>`: also wrap in `{!isPhone && (...)}` — spec calls for moving it into a `⋯` overflow menu on phone, but the M36 plan defers the overflow-menu component (see "Out of scope") and just hides the toggle on phone for now. Edit-auto on phone defaults to off; users who want it on can switch back to desktop / tablet to enable.

Adapt to the actual ChatComposer structure — read the file first. Keep the desktop behavior unchanged.

- [ ] **Step 7: Update ChatComposer tests if any assert the desktop-only chrome.**

Read `dashboard/src/components/chat/__tests__/ChatComposer.test.tsx` and verify nothing breaks. If a test asserts the keyboard-hint row text, gate it (or add a `useIsPhone` mock that returns false so the test reflects the desktop default).

- [ ] **Step 8: Run prettier + tsc + vitest.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/components/chat/
npx tsc -b --noEmit
npx vitest run
```

Expected: vitest 363/363 (352 prior + 5 ModeToggleSheet/EffortPickerSheet + 0 net change in ChatComposer tests if they were properly gated).

- [ ] **Step 9: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/ChatComposer.tsx dashboard/src/components/chat/ModeToggleSheet.tsx dashboard/src/components/chat/EffortPickerSheet.tsx dashboard/src/components/chat/__tests__/
git commit -m "feat(m36): ChatComposer phone variant — chips + sheets + single-line

At phone breakpoint, the mode toggle and effort picker each
collapse to a chip → tap opens a bottom sheet with the
respective options. Textarea becomes single-line auto-grow
(rows=1, capped at 5). Keyboard-hint row hidden.

Desktop behavior unchanged — useIsPhone() gates all the variants."
```

---

## Task 9: MessageActionSheet (long-press → bottom action sheet)

**Files:**

- Create: `dashboard/src/components/chat/MessageActionSheet.tsx`
- Create: `dashboard/src/components/chat/__tests__/MessageActionSheet.test.tsx`
- Modify: `dashboard/src/components/chat/MessageBubble.tsx` (or wherever the hover-revealed action bar lives)

Per M36 spec, on phone the hover-revealed action bar (Retry / Fork / Copy / Edit) is replaced by a bottom action sheet triggered via long-press.

### Step 1: MessageActionSheet test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/__tests__/MessageActionSheet.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageActionSheet } from "../MessageActionSheet";

describe("MessageActionSheet", () => {
  it("renders Retry / Fork / Copy / Edit when open", () => {
    render(
      <MessageActionSheet
        open={true}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onFork={vi.fn()}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^fork$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy();
  });

  it("clicking Copy calls onCopy and onClose", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(
      <MessageActionSheet
        open={true}
        onClose={onClose}
        onRetry={vi.fn()}
        onFork={vi.fn()}
        onCopy={onCopy}
        onEdit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits Edit when onEdit is undefined (e.g. assistant messages)", () => {
    render(
      <MessageActionSheet
        open={true}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onFork={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Implement MessageActionSheet.**

Create `/home/gnava/repos/honeycomb/dashboard/src/components/chat/MessageActionSheet.tsx`:

```tsx
/** MessageActionSheet — bottom action sheet for messages on phone (M36).
 *
 *  Replaces the hover-revealed action bar 1:1. Triggered by long-press
 *  in MessageBubble.
 *
 *  Edit is conditionally rendered (assistant messages don't have an
 *  edit affordance — the source-of-truth is the assistant model).
 */
import { Sheet } from "../Sheet";

interface Props {
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
  onFork: () => void;
  onCopy: () => void;
  onEdit?: () => void; // omit for assistant messages
}

interface ActionRow {
  label: string;
  onClick: () => void;
}

export function MessageActionSheet({ open, onClose, onRetry, onFork, onCopy, onEdit }: Props) {
  const actions: ActionRow[] = [
    { label: "Retry", onClick: onRetry },
    { label: "Fork", onClick: onFork },
    { label: "Copy", onClick: onCopy },
  ];
  if (onEdit) actions.push({ label: "Edit", onClick: onEdit });

  return (
    <Sheet open={open} onClose={onClose} title="Message actions" maxHeight="auto">
      <ul className="flex flex-col gap-1">
        {actions.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              onClick={() => {
                a.onClick();
                onClose();
              }}
              className="text-primary hover:bg-chip flex min-h-[44px] w-full items-center rounded px-3 py-2 text-left text-[14px]"
            >
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
```

- [ ] **Step 3: Wire long-press in MessageBubble.tsx.**

Read `dashboard/src/components/chat/MessageBubble.tsx` (or whichever file owns the hover-revealed action bar). Add at the top:

```tsx
import { useRef } from "react";
import { useIsPhone } from "../../hooks/useMediaQuery";
import { MessageActionSheet } from "./MessageActionSheet";
```

Add a small inline long-press hook OR an `onTouchStart` / `onTouchEnd` pair:

```tsx
const isPhone = useIsPhone();
const [actionSheetOpen, setActionSheetOpen] = useState(false);
const longPressTimer = useRef<number | null>(null);

const handleTouchStart = () => {
  if (!isPhone) return;
  longPressTimer.current = window.setTimeout(() => setActionSheetOpen(true), 500);
};
const handleTouchEnd = () => {
  if (longPressTimer.current !== null) {
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }
};
```

On the message-bubble outer container, attach `onTouchStart={handleTouchStart}` and `onTouchEnd={handleTouchEnd}`. Render `<MessageActionSheet open={actionSheetOpen} onClose={() => setActionSheetOpen(false)} onRetry={...} onFork={...} onCopy={...} onEdit={isUser ? ... : undefined} />` near the existing hover bar.

(The exact wiring depends on the MessageBubble props for retry/fork/copy/edit handlers — read the file first to find them. If they don't exist as props, lift them as needed.)

Skip MessageBubble changes if the hover-revealed action bar is hosted in a different file; in that case, only ship MessageActionSheet + its tests in this task and document the integration as deferred to T15 pre-flight (since the integration is small and can be done alongside any other ChatThread tweaks).

- [ ] **Step 4: Run tests, expect 3/3 PASS for the action sheet, plus all existing MessageBubble tests pass.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/chat/__tests__/
```

- [ ] **Step 5: Prettier + tsc.**

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/chat/MessageActionSheet.tsx dashboard/src/components/chat/__tests__/MessageActionSheet.test.tsx dashboard/src/components/chat/MessageBubble.tsx
git commit -m "feat(m36): MessageActionSheet + long-press handler

Long-press (500ms touchstart→touchend gap) on a message bubble at
phone breakpoint opens a bottom action sheet with Retry / Fork /
Copy / (Edit if user message). Replaces the hover bar 1:1 — no
behavior change on desktop.

Edit is gated on onEdit prop presence so assistant messages don't
expose it."
```

---

## Task 10: Library responsive (FilterChips horizontal-scroll, MoreCustomizationSheet full-screen on phone, stacked detail)

**Files:**

- Modify: `dashboard/src/components/library/LibraryActivity.tsx`
- Modify: `dashboard/src/components/library/FilterChips.tsx`
- Modify: `dashboard/src/components/library/MoreCustomizationSheet.tsx`

At phone:

1. `LibraryActivity` stacks the detail BELOW the sidebar (flex-col instead of flex-row), and the sidebar takes the full viewport when no artifact is selected — tapping a card swaps to a detail-only view.
2. `FilterChips` chip row becomes horizontal-scroll.
3. `MoreCustomizationSheet` becomes a full-screen Sheet on phone (using the new T3 primitive).

### Step 1: Update FilterChips for horizontal-scroll on phone

Read `dashboard/src/components/library/FilterChips.tsx`. The current chip row uses `flex flex-wrap`. Change to `flex flex-nowrap overflow-x-auto tablet:flex-wrap tablet:overflow-x-visible` so phone gets a single horizontal-scrolling row, and tablet+ goes back to wrapping.

Add `snap-x snap-mandatory` to the chip row's parent for nicer scroll feel; add `snap-start` to each chip.

Hide scrollbar visually but keep it accessible. Add this utility to `index.css` if not present:

```css
@layer utilities {
  .scrollbar-hidden {
    scrollbar-width: none;
  }
  .scrollbar-hidden::-webkit-scrollbar {
    display: none;
  }
}
```

Apply `scrollbar-hidden` to the chip row. Keep keyboard navigation working (which it does naturally via `Tab`).

- [ ] **Step 1a: Add the utility to `index.css`.**

(Locate the existing `@layer utilities` block from T1 and append the `.scrollbar-hidden` rules to it.)

- [ ] **Step 1b: Update the chip-row class in FilterChips.tsx.**

Find the outer `<div>` wrapping the chips (the one with `flex flex-wrap`). Change to:

```tsx
<div
  role="group"
  aria-label="Artifact type filter"
  className="flex flex-nowrap items-center gap-1.5 overflow-x-auto px-2 py-1.5 scrollbar-hidden tablet:flex-wrap tablet:overflow-x-visible"
>
```

Add `snap-start shrink-0` to the chip button className inside `ChipButton`. (Read the actual class string and append.)

- [ ] **Step 1c: Verify existing FilterChips tests still pass.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/library/__tests__/FilterChips.test.tsx
```

If a test asserts the prior `flex-wrap` class, update it.

### Step 2: Convert MoreCustomizationSheet to use the new Sheet primitive (full-screen on phone, popover on desktop)

Read `dashboard/src/components/library/MoreCustomizationSheet.tsx`. Refactor:

```tsx
/** MoreCustomizationSheet — full-screen sheet on phone (M36),
 *  popover on tablet+ (M35 desktop variant).
 */
import { useIsPhone } from "../../hooks/useMediaQuery";
import { Sheet } from "../Sheet";
// ... existing imports
```

In the render, branch:

```tsx
const isPhone = useIsPhone();
if (!open) return null;
if (isPhone) {
  return (
    <Sheet open={true} onClose={onClose} title="Customize chips">
      <ul ...>{/* existing 8-row content */}</ul>
    </Sheet>
  );
}
// Existing desktop popover render below
return (
  <>{/* existing backdrop + dialog */}</>
);
```

Update `MoreCustomizationSheet.test.tsx` if necessary — the existing tests use `getByRole("dialog", { name: "Customize artifact chips" })`. The new Sheet render uses `Customize chips` as the title (passed to Sheet). Update the test to match — OR keep the existing label by passing `title="Customize artifact chips"` to Sheet. Choose the latter to avoid test churn.

- [ ] **Step 2a: Refactor with the title preserved.**

```tsx
if (isPhone) {
  return (
    <Sheet open={true} onClose={onClose} title="Customize artifact chips">
      <ul className="flex flex-col gap-1">{/* same 8-row mapping as the desktop variant */}</ul>
    </Sheet>
  );
}
```

Verify `MoreCustomizationSheet.test.tsx` passes against the desktop branch (the test default — jsdom defaults to a wide viewport which is `useIsPhone() === false`).

### Step 3: LibraryActivity responsive layout

Read `dashboard/src/components/library/LibraryActivity.tsx`. The current layout is:

```tsx
<div className="flex h-full min-w-0 flex-1">
  <aside ... className="...w-80...">{/* sidebar */}</aside>
  <main ...>{/* artifact detail or empty */}</main>
</div>
```

At phone, the spec calls for:

- Sidebar fluid-width (no `w-80`).
- Detail STACKS BELOW sidebar (flex-col instead of flex-row).
- When no artifact selected: only sidebar visible (full viewport).
- When artifact selected: only detail visible — sidebar is HIDDEN, with a back-arrow-style "Library" header to return.

Add `useIsPhone()` and branch:

```tsx
const isPhone = useIsPhone();

if (isPhone) {
  if (activeArtifactId) {
    return (
      <div className="bg-page flex h-full min-w-0 flex-1 flex-col">
        <header className="border-edge bg-pane flex items-center gap-2 border-b px-2 py-2">
          <button
            type="button"
            onClick={() => setActiveArtifactId(null)}
            aria-label="Back to library"
            className="text-secondary hover:text-primary flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2"
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
          <h1 className="text-primary flex-1 truncate text-[14px] font-semibold">
            Library
          </h1>
        </header>
        <ArtifactDetail
          artifactId={activeArtifactId}
          allArtifacts={allArtifacts}
          onSelectContainer={onSelectContainer}
        />
      </div>
    );
  }
  // No artifact selected — render the sidebar full-width.
  return (
    <div className="bg-page flex h-full min-w-0 flex-1 flex-col">
      <header className="border-edge flex flex-col gap-1.5 border-b px-3 py-2">
        <h2 className="text-secondary text-[10px] font-semibold tracking-wider uppercase">
          Library
        </h2>
        <ScopeToggle activeContainerName={activeContainer?.project_name ?? null} onScopeChange={setScope} />
      </header>
      <FilterChips selected={selectedTypes} onSelectedChange={setSelectedTypes} artifacts={allArtifacts} />
      <div className="px-2 pb-1">
        <SearchInput value={search} onChange={setSearch} />
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {allArtifacts.length === 0 ? (
          <p className="text-secondary px-2 py-4 text-[12px]">
            {single.isLoading ? "Loading…" : "No artifacts yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {allArtifacts.map((a) => (
              <li key={a.artifact_id}>
                <ArtifactCard
                  artifact={a}
                  active={a.artifact_id === activeArtifactId}
                  onSelect={setActiveArtifactId}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Desktop / tablet: existing layout
return (
  <div className="flex h-full min-w-0 flex-1">
    <aside ...>...</aside>
    <main ...>...</main>
  </div>
);
```

Add the `import { ChevronLeft } from "lucide-react";` at the top.

- [ ] **Step 3a: Apply the refactor; existing desktop tests pass unchanged.**

The existing M35 LibraryActivity has no shell test (per the T8 review), so there's nothing to update beyond the JSX body.

- [ ] **Step 4: Prettier + tsc + vitest.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/components/library/ src/index.css
npx tsc -b --noEmit
npx vitest run
```

Expected: vitest 363+/363+ (no test count change for chips/sheet, since the existing tests cover desktop default). If any test breaks, address it.

- [ ] **Step 5: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/library/ dashboard/src/index.css
git commit -m "feat(m36): Library responsive — chips horizontal-scroll, full-screen sheet, stacked detail

FilterChips chip row becomes horizontal-scroll at phone (snap-x,
scrollbar-hidden). MoreCustomizationSheet uses the new Sheet
primitive at phone (full-screen) and stays a popover at tablet+.
LibraryActivity stacks the detail BELOW the sidebar at phone:
sidebar-only when no artifact selected, detail-only with back-arrow
when one is. Tablet + desktop layouts unchanged.

Adds .scrollbar-hidden utility to index.css for the chip row."
```

---

## Task 11: PTY pane responsive — visualViewport listener for virtual keyboard

**Files:**

- Modify: `dashboard/src/components/PtyPane.tsx`

xterm.js sizes itself via a ResizeObserver (verify by reading PtyPane.tsx). On mobile, the virtual keyboard covers the bottom of the layout viewport — but `window.innerHeight` doesn't change, so the terminal renders behind the keyboard. The fix is to listen to `window.visualViewport.resize` and adjust the terminal's container height when the visual viewport shrinks.

### Step 1: Read PtyPane to find the resize logic

```bash
grep -n "ResizeObserver\|resize\|visualViewport" /home/gnava/repos/honeycomb/dashboard/src/components/PtyPane.tsx
```

Locate the existing resize hook / observer.

### Step 2: Add visualViewport listener

Add near the existing resize logic:

```tsx
useEffect(() => {
  if (typeof window === "undefined" || !window.visualViewport) return;
  const vv = window.visualViewport;
  const handler = () => {
    // The container holding the xterm element. Find via ref if PtyPane
    // already has one; otherwise add a useRef<HTMLDivElement>(null) on
    // the outer div and use it here.
    const el = containerRef.current;
    if (!el) return;
    // Force the container to match the visual viewport height so the
    // terminal doesn't render behind the virtual keyboard.
    el.style.height = `${vv.height}px`;
    // Trigger xterm's fit if FitAddon is wired:
    fitAddonRef.current?.fit();
  };
  vv.addEventListener("resize", handler);
  return () => vv.removeEventListener("resize", handler);
}, []);
```

Adapt to whatever `containerRef` and `fitAddonRef` are actually called in PtyPane.tsx. Read the file first.

If the xterm fit logic is owned by a different effect, prefer dispatching a `window.dispatchEvent(new Event("resize"))` from the visualViewport handler — that triggers the existing ResizeObserver / window-resize listener naturally.

### Step 3: Verify desktop behavior unchanged

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

The visualViewport listener is a no-op on desktop (visualViewport.resize fires only when the visual viewport actually changes, which happens on mobile keyboard open). No tests should change.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/PtyPane.tsx
git commit -m "feat(m36): PtyPane responds to visualViewport resize (mobile keyboard)

The virtual keyboard on iOS/Android shrinks the visual viewport but
not window.innerHeight, so the terminal renders BEHIND the keyboard.
Listen to window.visualViewport.resize and re-fit the terminal when
the visual viewport changes.

No-op on desktop — visualViewport.resize fires only when the visual
viewport actually shrinks."
```

---

## Task 12: DiffViewerTab — force unified mode at phone

**Files:**

- Modify: `dashboard/src/components/DiffViewerTab.tsx`

Per the M36 spec ("Diff viewer forces unified mode on phone — split unreadable below 768"), the Split toolbar button should be hidden at phone and the `mode` state should default to `unified` at phone regardless of the persisted localStorage value.

### Step 1: Read DiffViewerTab

```bash
grep -n "split\|unified\|mode" /home/gnava/repos/honeycomb/dashboard/src/components/DiffViewerTab.tsx | head -20
```

Identify the mode state hook + the Split button.

### Step 2: Apply the gate

At the top of the component:

```tsx
import { useIsPhone } from "../hooks/useMediaQuery";
// ... existing imports

export function DiffViewerTab({ event, onOpenFile }: Props) {
  const isPhone = useIsPhone();
  const [mode, setMode] = useState<"unified" | "split">(() => {
    if (typeof window === "undefined") return "unified";
    const stored = window.localStorage.getItem("hive:diff-viewer:mode");
    return stored === "split" ? "split" : "unified";
  });

  // Phone forces unified.
  const effectiveMode = isPhone ? "unified" : mode;

  // ...

  return (
    <div ...>
      <header ...>
        {/* Unified button — always visible */}
        <button ... onClick={() => setMode("unified")} data-on={effectiveMode === "unified"}>
          Unified
        </button>
        {/* Split button — hidden at phone */}
        {!isPhone && (
          <button ... onClick={() => setMode("split")} data-on={effectiveMode === "split"}>
            Split
          </button>
        )}
        {/* ... */}
      </header>
      {/* Body uses effectiveMode */}
    </div>
  );
}
```

Read the actual file structure and adapt. The key invariant: at phone, `effectiveMode === "unified"` regardless of the persisted state.

### Step 3: Verify existing DiffViewerTab tests pass

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/DiffViewerTab.test.tsx
```

If any test asserts the Split button is visible by default (jsdom defaults to wide viewport, so `useIsPhone() === false`, so the button stays visible), no change needed.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/DiffViewerTab.tsx
git commit -m "feat(m36): DiffViewerTab forces unified mode at phone

Split mode is unreadable below 768px. At phone, the Split toolbar
button is hidden and the mode state is forced to unified regardless
of persisted localStorage. Desktop / tablet behavior unchanged."
```

---

## Task 13: Wire App.tsx — phone vs tablet vs desktop layouts

**Files:**

- Modify: `dashboard/src/App.tsx`

This is the integration capstone for the layout swaps. Wire `useIsPhone() / useIsTablet() / useIsDesktop()` to render:

- Phone: `<PhoneTabBar>` at the bottom; main content swaps between PhoneChatList ↔ PhoneChatDetail (or the appropriate phone view per route — Library uses LibraryActivity's own phone branch from T10).
- Tablet: existing layout BUT sidebar moves into `<TabletSidebarDrawer>` (toggled by a hamburger button in the header).
- Desktop: existing layout unchanged.

### Step 1: Read App.tsx

Read end-to-end. Find the existing top-level structure (the main shell, where ActivityBar + sidebar + content live). Note where the route switching happens (M32 router).

### Step 2: Add the layout-switching logic

Near the top:

```tsx
import { useIsPhone, useIsTablet } from "./hooks/useMediaQuery";
import { PhoneTabBar } from "./components/PhoneTabBar";
import { TabletSidebarDrawer } from "./components/TabletSidebarDrawer";
import { PhoneChatList } from "./components/PhoneChatList";
import { PhoneChatDetail } from "./components/PhoneChatDetail";
import { Menu } from "lucide-react";

export function App() {
  const isPhone = useIsPhone();
  const isTablet = useIsTablet();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // existing state...

  // Map the M32 activity to a PhoneTab id:
  const phoneTab: PhoneTab =
    activity === "chats" ? "chats"
      : activity === "diff-events" ? "library" // legacy alias for library
      : activity === "files" ? "files"
      : activity === "git-ops" ? "git"
      : "more";

  if (isPhone) {
    // Phone branch — PhoneChatList <-> PhoneChatDetail for the chats route;
    // other routes render their normal components which already have phone variants
    // (Library handled by LibraryActivity's own phone branch from T10).
    return (
      <div className="bg-page flex h-screen flex-col">
        <main className="flex-1 overflow-hidden pb-14">
          {/* Reserve 56px (pb-14) for PhoneTabBar */}
          {phoneTab === "chats"
            ? activeNamedSession
              ? (
                <PhoneChatDetail
                  title={activeNamedSession.name}
                  onBack={() => setActiveSessionId(null)}
                >
                  {/* existing ChatThread + ChatComposer; they handle their own phone variants */}
                  <ChatThread ... />
                  <ChatComposer ... />
                </PhoneChatDetail>
              )
              : (
                <PhoneChatList
                  workspaceName={activeContainer?.project_name ?? "(no workspace)"}
                  sessions={namedSessions}
                  onSelectSession={setActiveSessionId}
                  onNewChat={handleNewChat}
                />
              )
            : phoneTab === "library"
              ? <LibraryRoute containers={containers} activeContainerId={activeContainerId} onSelectContainer={...} />
              : phoneTab === "files"
                ? <FilesRoute ... />
                : phoneTab === "git"
                  ? <GitOpsRoute ... />
                  : <MoreRoute ... />}
        </main>
        <PhoneTabBar
          activeTab={phoneTab}
          onTabChange={(t) => goToRoute(routeForPhoneTab(t))}
          visible={!(phoneTab === "chats" && activeNamedSession !== null)}
        />
      </div>
    );
  }

  // Tablet OR desktop: existing layout. At tablet, sidebar becomes a drawer.
  return (
    <div className="bg-page flex h-screen">
      <ActivityBar ... />
      {isTablet ? (
        <>
          <TabletSidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
            <ContainerList ... />
          </TabletSidebarDrawer>
          <main className="flex-1">
            <header className="...">
              <button onClick={() => setDrawerOpen(true)} aria-label="Open sidebar" className="...">
                <Menu size={20} />
              </button>
              {/* existing header content */}
            </header>
            {/* existing main content */}
          </main>
        </>
      ) : (
        <>
          <aside className="...">
            <ContainerList ... />
          </aside>
          <main className="flex-1">{/* existing content */}</main>
        </>
      )}
    </div>
  );
}

function routeForPhoneTab(t: PhoneTab): string {
  if (t === "chats") return "/chats";
  if (t === "library") return "/library";
  if (t === "files") return "/files";
  if (t === "git") return "/git";
  return "/more";
}
```

Adapt to the actual App.tsx structure — read the file before editing. The above is a structural sketch; the real props on `ChatThread`, `ChatComposer`, `ContainerList`, etc. need to be threaded.

A `MoreRoute` may not exist yet — for M36, render a simple list of secondary routes (Settings, Problems) as a placeholder:

```tsx
function MoreRoute({ goToRoute }: { goToRoute: (path: string) => void }) {
  return (
    <ul className="flex flex-col">
      <li>
        <button
          onClick={() => goToRoute("/settings")}
          className="flex min-h-[44px] w-full items-center px-4 py-3 text-left"
        >
          Settings
        </button>
      </li>
      <li>
        <button
          onClick={() => goToRoute("/problems")}
          className="flex min-h-[44px] w-full items-center px-4 py-3 text-left"
        >
          Problems
        </button>
      </li>
    </ul>
  );
}
```

### Step 3: Run vitest + tsc + prettier

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write src/App.tsx
npx tsc -b --noEmit
npx vitest run
```

Expected: existing tests pass. No new component tests added in this task (App.tsx is too integration-heavy to unit-test cleanly; Playwright covers it in T15).

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/App.tsx
git commit -m "feat(m36): App.tsx wires phone/tablet/desktop layout swaps

Phone: PhoneTabBar at the bottom + PhoneChatList <-> PhoneChatDetail
for the chats route; other routes use their existing components
(Library has its own phone branch from T10).

Tablet: ContainerList moves into TabletSidebarDrawer behind a
hamburger button in the header.

Desktop: unchanged.

PhoneTab visibility is gated when in a chat-detail view so the
composer gets full vertical room."
```

---

## Task 14: Viewport meta + manifest sanity

**Files:**

- Modify: `dashboard/index.html`
- Create or verify: `dashboard/public/manifest.webmanifest`
- Modify: `dashboard/index.html` (link to manifest, add theme-color meta)

### Step 1: Update viewport meta

Open `dashboard/index.html`. Find the existing viewport meta:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

Replace with:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"
/>
```

`viewport-fit=cover` enables the iOS safe-area insets. `interactive-widget=resizes-content` is the modern hint for iOS Safari to reflow when the virtual keyboard opens.

### Step 2: Add theme-color meta

Below the viewport line, add:

```html
<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#fdfaf3" media="(prefers-color-scheme: light)" />
```

Values match the M31 dark / Warm Workshop light page backgrounds.

### Step 3: Create the manifest

Create `/home/gnava/repos/honeycomb/dashboard/public/manifest.webmanifest`:

```json
{
  "name": "Claude Hive",
  "short_name": "Hive",
  "description": "Multi-container Claude Code orchestrator",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#0d1117",
  "theme_color": "#0d1117",
  "icons": [
    {
      "src": "/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ]
}
```

We're not adding raster icons — the SVG favicon serves both regular and maskable purposes for now. PWA install isn't a stated M36 goal, but the manifest needs to be sane so iOS/Android browsers don't error.

### Step 4: Link the manifest from index.html

In `dashboard/index.html` `<head>`, add:

```html
<link rel="manifest" href="/manifest.webmanifest" />
```

### Step 5: Verify the manifest is served + valid

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm run dev &
sleep 4
curl -s http://localhost:5173/manifest.webmanifest | head -20
kill %1
```

Expected: the JSON content prints. If 404, check the `public/` directory location — Vite serves files from `dashboard/public/` at the root path.

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/index.html dashboard/public/manifest.webmanifest
git commit -m "feat(m36): viewport meta + PWA manifest sanity

Update viewport meta to viewport-fit=cover (enables iOS safe-area
insets) + interactive-widget=resizes-content (modern iOS Safari hint
for virtual-keyboard reflow).

Add theme-color meta for dark + light themes (matches M31 page
backgrounds).

Add a minimal manifest.webmanifest. PWA install is NOT a stated M36
goal, but the manifest needs to be sane so iOS/Android browsers
don't error when the user adds-to-home-screen."
```

---

## Task 15: Playwright responsive specs (mobile-chat + tablet-chat + mobile-library)

**Files:**

- Create: `dashboard/tests/e2e/mobile-chat.spec.ts`
- Create: `dashboard/tests/e2e/tablet-chat.spec.ts`
- Create: `dashboard/tests/e2e/mobile-library.spec.ts`

Three Playwright specs, one per critical surface, at the relevant viewport.

### Step 1: mobile-chat.spec.ts

Create `/home/gnava/repos/honeycomb/dashboard/tests/e2e/mobile-chat.spec.ts`:

```ts
/** M36 — phone chat flow at 375 × 667. */
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 667 } });

const TOKEN = "mobile-chat-token";

const containerFixture = {
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
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const sessionFixture = {
  session_id: "ns-1",
  container_id: 1,
  name: "First chat",
  kind: "claude",
  claude_session_id: null,
  cwd: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );
  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/named-sessions", (r) =>
    r.fulfill(mockJson([sessionFixture])),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
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
});

test("PhoneTabBar renders 5 tabs at 375x667", async ({ page }) => {
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /chats/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /library/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /files/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /git/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /more/i })).toBeVisible();
});

test("ActivityBar is hidden at phone", async ({ page }) => {
  await page.goto("/chats");
  // The activity rail aside should not be in the layout (CSS-hidden).
  // Check by querying for the ActivityBar's distinctive aria-label.
  const rail = page.getByRole("navigation", { name: /activity bar|activity rail/i });
  await expect(rail).toBeHidden();
});

test("PhoneChatList shows the workspace pill and the seeded session", async ({ page }) => {
  await page.goto("/chats");
  await expect(page.getByText("foo")).toBeVisible(); // workspace name in pill
  await expect(page.getByText("First chat")).toBeVisible();
});

test("Tap a session row navigates to PhoneChatDetail with back-arrow", async ({ page }) => {
  await page.goto("/chats");
  await page.getByText("First chat").click();
  await expect(page.getByRole("button", { name: /back to chat list/i })).toBeVisible();
  await expect(page.getByText("First chat")).toBeVisible(); // title in header
});

test("PhoneTabBar is hidden in chat detail view", async ({ page }) => {
  await page.goto("/chats");
  await page.getByText("First chat").click();
  // Tab bar should be hidden
  await expect(page.getByRole("button", { name: /more/i })).toBeHidden();
});

test("No horizontal scroll at 375x667 on the chats list", async ({ page }) => {
  await page.goto("/chats");
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(docWidth).toBeLessThanOrEqual(375);
});
```

### Step 2: tablet-chat.spec.ts

Create `/home/gnava/repos/honeycomb/dashboard/tests/e2e/tablet-chat.spec.ts`:

```ts
/** M36 — tablet chat flow at 768 × 1024. */
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 768, height: 1024 } });

// (Reuse the same TOKEN + containerFixture + sessionFixture + beforeEach
// as mobile-chat.spec.ts. For brevity in this plan, copy them verbatim.)

const TOKEN = "tablet-chat-token";

const containerFixture = {
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
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const sessionFixture = {
  session_id: "ns-1",
  container_id: 1,
  name: "First chat",
  kind: "claude",
  claude_session_id: null,
  cwd: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  // (Same beforeEach as mobile-chat.spec.ts — copy verbatim.)
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );
  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/named-sessions", (r) =>
    r.fulfill(mockJson([sessionFixture])),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
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
});

test("ActivityBar is visible at tablet (768x1024)", async ({ page }) => {
  await page.goto("/chats");
  const rail = page.getByRole("navigation", { name: /activity bar|activity rail/i });
  await expect(rail).toBeVisible();
});

test("ContainerList opens via hamburger drawer at tablet", async ({ page }) => {
  await page.goto("/chats");
  // Hamburger button in the header
  await page.getByRole("button", { name: /open sidebar/i }).click();
  // Drawer renders the container list
  await expect(page.getByRole("dialog", { name: /container sidebar/i })).toBeVisible();
  await expect(page.getByText("foo")).toBeVisible(); // workspace name in the list
});

test("Drawer closes on Escape at tablet", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("button", { name: /open sidebar/i }).click();
  await expect(page.getByRole("dialog", { name: /container sidebar/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /container sidebar/i })).toBeHidden();
});

test("PhoneTabBar is NOT rendered at tablet", async ({ page }) => {
  await page.goto("/chats");
  await expect(page.getByRole("navigation", { name: /phone bottom navigation/i })).toBeHidden();
});

test("No horizontal scroll at 768x1024", async ({ page }) => {
  await page.goto("/chats");
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(docWidth).toBeLessThanOrEqual(768);
});
```

### Step 3: mobile-library.spec.ts

Create `/home/gnava/repos/honeycomb/dashboard/tests/e2e/mobile-library.spec.ts`:

```ts
/** M36 — phone Library at 375 × 667. */
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 667 } });

// (Reuse fixtures from mobile-chat.spec.ts.)

const TOKEN = "mobile-library-token";

const containerFixture = {
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
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const artifacts = [
  {
    artifact_id: "a-plan-1",
    container_id: 1,
    type: "plan",
    title: "Refactor plan",
    body: "## Step 1",
    body_format: "markdown",
    source_chat_id: "ns-1",
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T12:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
  },
];

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );
  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson(artifacts)));
  await context.route("**/api/containers/*/named-sessions", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
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
});

test("Library renders at phone with the chip row + card list (no sidebar)", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByText("Refactor plan")).toBeVisible();
  // Chip row should be present and horizontally scrollable
  const chipRow = page.getByRole("group", { name: /artifact type filter/i });
  await expect(chipRow).toBeVisible();
});

test("Tap a card opens the detail with a back-arrow", async ({ page }) => {
  await page.goto("/library");
  await page.getByText("Refactor plan").click();
  await expect(page.getByRole("button", { name: /back to library/i })).toBeVisible();
  // Plan renderer's title shows
  await expect(page.getByText("Refactor plan").first()).toBeVisible();
});

test("Back-arrow returns to the list", async ({ page }) => {
  await page.goto("/library");
  await page.getByText("Refactor plan").click();
  await page.getByRole("button", { name: /back to library/i }).click();
  // Card visible again in list
  await expect(page.getByText("Refactor plan")).toBeVisible();
  // No back-arrow now
  await expect(page.getByRole("button", { name: /back to library/i })).toBeHidden();
});

test("No horizontal scroll on the Library list at 375x667", async ({ page }) => {
  await page.goto("/library");
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(docWidth).toBeLessThanOrEqual(375);
});

test("MoreCustomizationSheet renders as a full-screen Sheet at phone", async ({ page }) => {
  await page.goto("/library");
  await page.getByRole("button", { name: /customize chips/i }).click();
  await expect(page.getByRole("dialog", { name: /customize artifact chips/i })).toBeVisible();
  // Should be the full-bottom-sheet variant — close button visible
  await expect(page.getByRole("button", { name: /close sheet/i })).toBeVisible();
});
```

### Step 4: Run all three new specs

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test tests/e2e/mobile-chat.spec.ts tests/e2e/tablet-chat.spec.ts tests/e2e/mobile-library.spec.ts --reporter=list
```

Expected: all 17 tests pass (6 mobile-chat + 5 tablet-chat + 5 mobile-library + 1 maybe drift).

Common iteration:

- Selector ambiguity (e.g., "Refactor plan" appears in both list and detail) → scope to a parent.
- The drawer hamburger button name might differ — match the actual aria-label set in T13.

### Step 5: Run full Playwright

```bash
npx playwright test --reporter=list 2>&1 | tail -10
```

Expected: 51 prior + ~17 new = ~68 pass.

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/mobile-chat.spec.ts dashboard/tests/e2e/tablet-chat.spec.ts dashboard/tests/e2e/mobile-library.spec.ts
git commit -m "test(m36): Playwright responsive specs (mobile-chat / tablet-chat / mobile-library)

mobile-chat (375x667): PhoneTabBar visible, ActivityBar hidden,
PhoneChatList renders sessions, tap → PhoneChatDetail with back
arrow, tab bar hidden in detail view, no horizontal scroll.

tablet-chat (768x1024): ActivityBar visible, ContainerList opens
via hamburger drawer, Escape closes drawer, PhoneTabBar not
rendered, no horizontal scroll.

mobile-library (375x667): chip row horizontal-scrollable, tap
card → detail with back arrow, MoreCustomizationSheet renders as
full-screen sheet."
```

---

## Task 16: axe-core sweep across responsive surfaces

**Files:**

- Create: `dashboard/tests/e2e/responsive-axe.spec.ts`

One spec, two themes × three viewports × N surfaces = ~12 axe scans. Catches contrast / touch-target / aria issues across the responsive matrix.

### Step 1: Create the spec

Create `/home/gnava/repos/honeycomb/dashboard/tests/e2e/responsive-axe.spec.ts`:

```ts
/** M36 — axe-core sweep across viewports + themes. */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "axe-token";

const containerFixture = {
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
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const sessionFixture = {
  session_id: "ns-1",
  container_id: 1,
  name: "First chat",
  kind: "claude",
  claude_session_id: null,
  cwd: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};

const artifacts = [
  {
    artifact_id: "a-plan-1",
    container_id: 1,
    type: "plan",
    title: "Refactor plan",
    body: "## Step 1",
    body_format: "markdown",
    source_chat_id: "ns-1",
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T12:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
  },
];

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );
  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/named-sessions", (r) =>
    r.fulfill(mockJson([sessionFixture])),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson(artifacts)));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
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
});

const VIEWPORTS = [
  { name: "phone", w: 375, h: 667 },
  { name: "tablet", w: 768, h: 1024 },
  { name: "desktop", w: 1024, h: 768 },
];

const THEMES = ["dark", "light"] as const;

const ROUTES = ["/chats", "/library"];

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    for (const route of ROUTES) {
      test(`axe-core: ${route} at ${vp.name} (${vp.w}x${vp.h}) in ${theme} theme`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.goto(route);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        // Wait for the route to hydrate
        await page.waitForLoadState("networkidle");
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
```

### Step 2: Run + fix violations

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test tests/e2e/responsive-axe.spec.ts --reporter=list 2>&1 | tail -40
```

Expected: 12 tests (3 viewports × 2 themes × 2 routes). All should pass.

If violations surface:

- Contrast issues → adjust the offending Tailwind token (e.g., `text-muted` → `text-secondary`). Same fix shape as T14 of M35.
- Touch-target violations → bump to `min-h-[44px]`.
- Aria issues → fix the role/label.

For each fix, document in the commit message which violation it resolves.

### Step 3: Run full Playwright

```bash
npx playwright test --reporter=list 2>&1 | tail -10
```

Expected: 51 prior + 17 new (T15) + 12 new (T16) = ~80 pass.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/responsive-axe.spec.ts dashboard/src/  # any source fixes
git commit -m "test(m36): axe-core sweep — 3 viewports × 2 themes × 2 routes

12 scans across the M36 responsive matrix:
- viewports: 375x667 (phone), 768x1024 (tablet), 1024x768 (desktop)
- themes: dark + light
- routes: /chats + /library

All green. Source fixes (if any) listed in the diff."
```

---

## Task 17: Pre-flight regression sweep + prettier

**Files:** none — verification only.

Same shape as M35 T15.

- [ ] **Step 1: Hub regression.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

Expected: 484 passed (no backend changes in M36).

- [ ] **Step 2: hive-agent regression.**

```bash
cd /home/gnava/repos/honeycomb/hive-agent && uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

Expected: 20 passed.

- [ ] **Step 3: Dashboard typecheck + lint + vitest.**

```bash
cd /home/gnava/repos/honeycomb/dashboard && npx tsc -b --noEmit && npm run lint && npx vitest run
```

Expected: tsc clean, lint warnings ≤ M35 baseline (~23) + small delta for M36 (likely ≤ 30 total). Document the count.

vitest expected: 346 prior + (6 useMediaQuery + 6 Sheet + 4 PhoneTabBar + 5 TabletSidebarDrawer + 6 PhoneChatList + 5 PhoneChatDetail + 3 ModeToggleSheet + 2 EffortPickerSheet + 3 MessageActionSheet) ≈ 386 passed.

- [ ] **Step 4: Playwright.**

```bash
cd /home/gnava/repos/honeycomb/dashboard && npx playwright test
```

Expected: 51 prior + 17 (T15) + 12 (T16) = 80 passed.

- [ ] **Step 5: Prettier sweep + commit.**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
cd /home/gnava/repos/honeycomb
git status
git diff
git add -A -- dashboard/
git diff --cached --quiet || git commit -m "style(m36): prettier sweep before push"
```

If prettier rewrites anything, commit it as a style-only change. If nothing changes, skip.

- [ ] **Step 6: pre-commit run --all-files.**

```bash
pre-commit run --all-files
```

All hooks clean. If any hook fails, fix the issue + re-run.

---

## Task 18: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1:** `git push -u origin m36-mobile`

- [ ] **Step 2:** Merge with `--no-ff` (matches M27/M30/M31/M32/M33/M34/M35 pattern):

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff m36-mobile -m "Merge M36: mobile + responsive breakpoints"
```

- [ ] **Step 3:** Tag the merge:

```bash
git tag -a v0.36-mobile -m "M36: mobile + responsive breakpoints — phone bottom-tab-bar, tablet drawer, sheets, long-press actions, 44px tap targets, responsive Library / Chat / PTY / Diff"
```

- [ ] **Step 4:** Push main + tag:

```bash
git push --follow-tags origin main
```

- [ ] **Step 5:** Watch CI:

```bash
sleep 12
gh run list --branch main --limit 1 --json databaseId,status
gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: all 7 CI jobs green. **Known flake:** if hub pytest hangs (M34 saw this once), cancel + `gh run rerun --failed`.

- [ ] **Step 6:** Delete merged branch:

```bash
git branch -d m36-mobile
git push origin --delete m36-mobile
```

---

## Verification Checklist

Before declaring M36 done, confirm:

- [ ] `cd hub && uv run pytest tests -q` — 484/484 green (no hub changes in M36).
- [ ] `cd dashboard && npx vitest run` — 386+/386+ green.
- [ ] `cd dashboard && npx playwright test` — 80/80 green (51 prior + 17 mobile/tablet specs + 12 axe scans).
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint` — clean.
- [ ] `pre-commit run --all-files` — clean.
- [ ] **Manual smoke test (Chrome devtools mobile emulation, iPhone SE 375×667):**
  - Open the dashboard. PhoneTabBar visible at the bottom; ActivityBar hidden.
  - Workspace pill shows the active container name. Search input works.
  - Tap a session row → PhoneChatDetail opens with back-arrow + title.
  - Tab bar disappears in detail view.
  - Tap mode chip → ModeToggleSheet slides up; tap Plan → mode flips.
  - Tap effort chip → EffortPickerSheet slides up; tap High → effort flips.
  - Send a message that produces a response. Long-press the response → MessageActionSheet shows Retry / Fork / Copy.
  - Tap "Library" tab → Library list loads. Chip row scrolls horizontally.
  - Tap "⋯ More" chip → MoreCustomizationSheet renders as full-screen sheet.
  - Tap an artifact card → detail view with back-arrow.
- [ ] **Manual smoke test (Chrome devtools, iPad portrait 768×1024):**
  - ActivityBar visible at the left edge (48px wide).
  - PhoneTabBar NOT rendered.
  - Click hamburger in header → TabletSidebarDrawer slides in with the ContainerList.
  - Escape closes the drawer.
- [ ] `git log --oneline main` shows `Merge M36: mobile + responsive breakpoints` + `v0.36-mobile` tag.
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green.
- [ ] Branch `m36-mobile` deleted local + remote.

---

## Out of scope — future tickets

- **PWA install prompts / service worker** — manifest is sane but no install affordance, no offline cache.
- **Mobile-specific gestures** — no swipe-to-close drawers, no pull-to-refresh, no swipe-left-to-delete on chat list rows (spec mentions but defers).
- **Visual regression snapshots** (Percy / Chromatic).
- **VoiceOver / TalkBack accessibility audit** beyond axe-core.
- **Bottom sheet animations** — current sheets use simple CSS transitions; no spring physics.
- **Tablet-specific dual-column layouts** beyond what stacking gives us.
- **Android-specific Playwright cases** — Chromium is the only browser the project runs.
- **PhoneChatList swipe-left actions** (archive / delete) — spec mentions, deferred to a future M36.x.
- **Voice-to-text mic input** — explicitly cut on phone per spec.
- **Phone variant for `/files`, `/git`, `/problems`, `/settings` routes** beyond what generic stacking gives us — those routes ARE accessible via the More tab but haven't been deliberately responsive-designed.
- **Edit-auto toggle ⋯ overflow on phone** — spec calls for moving it into a `⋯` overflow on the chat detail header. M36 hides it on phone via `!isPhone &&` gating in T8 step 6 instead of building a new overflow component. Deferred to M36.x if users need it.
- **Workspace pill "tap-to-reveal CPU/MEM"** on phone — spec says the resource readout moves behind the pill on phone. PhoneChatList renders the pill but no readout reveal yet. Deferred.

---

## Post-merge: redesign arc complete

After T18 lands and CI is green, the M31 → M36 redesign arc is **feature-complete**. The user said this is the final milestone — the post-merge state should leave the dashboard ready for a v0.36 release-notes / changelog rollup. Suggest opening a follow-up issue / PR titled "v0.36 release notes — M31–M36 redesign rollup" that summarizes:

- M31: Semantic palette + light theme
- M32: URL router + activity bar rebuild
- M33: Chat thread (Claude Code visual grammar)
- M34: Composer (effort + model + slash commands)
- M35: Library (8 artifact types, auto-save hooks)
- M36: Mobile + responsive breakpoints (this milestone)

That issue / PR is OUT OF SCOPE for M36 itself but worth a one-line offer at the end of the merge-confirmation message.
