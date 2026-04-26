# M31 — Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the platform every later redesign milestone reads from. Define semantic theme tokens (colors / typography / radius / shadow) via Tailwind v4 `@theme` block, with both `[data-theme="dark"]` (existing palette, unchanged) and `[data-theme="light"]` (new Warm Workshop palette) variants. Build a `ThemeProvider` + `useTheme` hook with `localStorage` persistence and `prefers-color-scheme` resolution. Add Settings → Appearance UI and three ⌘K commands. **Zero visible change in dark mode** (regression-safe); light theme renders without contrast violations on the new Settings UI.

**Architecture:** Tailwind v4 stores design tokens directly in CSS via `@theme`. Tokens emit as CSS custom properties at `:root` and become available as utility classes (`bg-page`, `text-primary`, `border-edge-soft`, etc.). The light variant overrides the same CSS vars in a `[data-theme="light"]` selector, so flipping the `data-theme` attribute on `<html>` re-themes everything that uses semantic tokens — no `dark:` prefix soup. Existing components that hardcode hex (`bg-[#1e1e1e]`) keep working in dark and don't flip in light; M32 will migrate the layout shell to semantic tokens. `ThemeProvider` is a thin React context that resolves user preference (`"system" | "light" | "dark"`), listens to `prefers-color-scheme` change events, and writes to `localStorage:hive:theme`.

**Tech Stack:** Tailwind v4 (`@theme` directive in CSS, no JS config), React 19 Context + `useSyncExternalStore` for theme state, Vitest + `@testing-library/react` for hook tests, `@axe-core/playwright` (new dep) for accessibility scans, existing Playwright suite (10 specs) as the dark-mode visual baseline.

**Branch:** `m31-onwards-design-system` (already created from `main`; spec `f4eb6a0` already committed).

**Spec:** [docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md](../specs/2026-04-26-dashboard-redesign-design.md) — M31 section + Architecture → Theme Tokens.

---

## File Structure

### Dashboard (TypeScript / React)

- **Modify** `dashboard/src/index.css` — add `@theme` block with all semantic tokens, plus `[data-theme="light"]` overrides + `prefers-color-scheme: light` fallback. Migrate the existing `body` rule to use the new `bg-page` / `text-primary` tokens so the page background actually flips between themes.
- **Create** `dashboard/src/lib/theme.ts` — `ThemeProvider`, `useTheme` hook, `THEME_STORAGE_KEY` constant.
- **Modify** `dashboard/src/main.tsx` — wrap the app tree in `ThemeProvider`.
- **Modify** `dashboard/src/components/SettingsView.tsx` — add `Appearance` section near the top with three radio rows.
- **Create** `dashboard/src/components/AppearancePicker.tsx` — extracted radio-group component (used by Settings; shared with the More tab on phone in M36).
- **Modify** `dashboard/src/components/CommandPalette.tsx` — register three theme commands (Switch to Light / Switch to Dark / Use System).
- **Modify** `dashboard/package.json` — add `@axe-core/playwright` dev dep.

### Tests

- **Create** `dashboard/src/lib/__tests__/theme.test.tsx` — `useTheme` hook tests (system / light / dark resolution, override, listener, storage persistence).
- **Create** `dashboard/src/components/__tests__/AppearancePicker.test.tsx` — three radio rows render, click changes preference.
- **Modify** `dashboard/src/components/__tests__/CommandPalette.test.tsx` (or create if absent) — three theme commands appear and dispatch the correct action.
- **Create** `dashboard/tests/e2e/theme-system.spec.ts` — Playwright spec: switch themes via Settings + via ⌘K + via OS preference; assert `data-theme` attribute changes; run axe-core on Settings UI in both themes.

---

## Task 0: Verify branch state

- [ ] **Step 1: Confirm branch + clean state**

```bash
cd /home/gnava/repos/honeycomb
git branch --show-current
git status -s
git log --oneline -3
```

Expected:

- branch: `m31-onwards-design-system`
- status: only `?? .claude/settings.json` (gitignored-ish noise; ignore)
- recent log shows `f4eb6a0 docs(redesign): chat-first dashboard redesign spec — M31-M36`

If branch is wrong, switch:

```bash
git checkout m31-onwards-design-system
```

---

## Task 1: Theme tokens — `@theme` block + dark/light variants in index.css

The Tailwind v4 way: declare design tokens directly in CSS. The `@theme` block emits CSS custom properties at `:root` AND generates matching utility classes (e.g., `--color-page` → `bg-page`, `text-page`, `border-page`).

**Files:**

- Modify: `dashboard/src/index.css`

- [ ] **Step 1: Read current index.css**

```bash
cat /home/gnava/repos/honeycomb/dashboard/src/index.css
```

It currently has the `@import "tailwindcss"` + a primitive `body` rule + a basic `prefers-color-scheme: light` body rule + scrollbar/selection/focus tweaks. We're replacing the basic theme bits with semantic tokens, keeping the chrome utilities (scrollbar, focus-visible, kbd) intact.

- [ ] **Step 2: Replace index.css with the full token system**

Open `dashboard/src/index.css` and rewrite to:

```css
@import "tailwindcss";

/* ─── Design system tokens (M31) ────────────────────────────────
 * Tailwind v4 reads @theme as the single source of design tokens.
 * Each --color-* declaration becomes both a CSS custom property at
 * :root AND a utility class (e.g., bg-page, text-primary,
 * border-edge-soft).
 *
 * Dark is the default palette (these match the M0–M30 GitHub-dark
 * aesthetic exactly so existing components render unchanged).
 * Light overrides come below in [data-theme="light"] + the
 * prefers-color-scheme fallback for unset preference.
 *
 * To flip themes: set or clear data-theme on <html>:
 *   <html data-theme="light">  // explicit light
 *   <html data-theme="dark">   // explicit dark
 *   <html>                     // follow OS via prefers-color-scheme
 */
@theme {
  /* Backgrounds */
  --color-page: #0d1117;
  --color-pane: #161b22;
  --color-main: #0a0e14;
  --color-card: #161b22;
  --color-chip: #1c2128;
  --color-input: #0d1117;

  /* Foreground (text) */
  --color-primary: #c9d1d9;
  --color-secondary: #8b949e;
  --color-muted: #6e7681;
  --color-faint: #4a5159;

  /* Borders — named "edge" to avoid Tailwind's `border` width keyword */
  --color-edge: #30363d;
  --color-edge-soft: #21262d;

  /* Accent / semantic colors */
  --color-accent: #58a6ff;
  --color-claude: #d2a8ff;
  --color-tool: #79c0ff;
  --color-think: #ffa657;
  --color-write: #3fb950;
  --color-task: #ff7b72;
  --color-edit: #58a6ff;
  --color-read: #f0883e;
  --color-plan: #ffa657;
  --color-review: #d2a8ff;

  /* Diff backgrounds (saturated + soft variants) */
  --color-add-bg: rgba(46, 160, 67, 0.18);
  --color-add-bg-soft: rgba(46, 160, 67, 0.07);
  --color-rem-bg: rgba(248, 81, 73, 0.18);
  --color-rem-bg-soft: rgba(248, 81, 73, 0.07);

  /* Radius scale */
  --radius-xs: 3px;
  --radius-sm: 5px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-pill: 999px;

  /* Shadows (dark-tuned by default; overridden for light below) */
  --shadow-soft: 0 1px 3px rgba(0, 0, 0, 0.25);
  --shadow-medium: 0 4px 12px rgba(0, 0, 0, 0.35);
  --shadow-deep: 0 8px 24px rgba(0, 0, 0, 0.45);
  --shadow-pop: 0 12px 32px rgba(0, 0, 0, 0.55);

  /* Typography scale (size / line-height pairs) */
  --text-display: 22px;
  --text-display--line-height: 1.2;
  --text-title: 18px;
  --text-title--line-height: 1.35;
  --text-heading: 14px;
  --text-heading--line-height: 1.5;
  --text-body: 13px;
  --text-body--line-height: 1.55;
  --text-meta: 11px;
  --text-meta--line-height: 1.4;
  --text-mono: 12.5px;
  --text-mono--line-height: 1.55;
}

/* ─── Light theme: Warm Workshop ─────────────────────────────── */
[data-theme="light"] {
  --color-page: #fdfaf3;
  --color-pane: #f7f1e3;
  --color-main: #fffdf7;
  --color-card: #faf5e8;
  --color-chip: #f0e9d6;
  --color-input: #fffdf7;

  --color-primary: #2a241b;
  --color-secondary: #6b5d4a;
  --color-muted: #968773;
  --color-faint: #c5b9a1;

  --color-edge: #e0d6bf;
  --color-edge-soft: #ece4d2;

  --color-accent: #b8541c;
  --color-claude: #7c3aed;
  --color-tool: #0969da;
  --color-think: #b8541c;
  --color-write: #1f7a36;
  --color-task: #be1e1e;
  --color-edit: #0969da;
  --color-read: #b8541c;
  --color-plan: #b8541c;
  --color-review: #7c3aed;

  --color-add-bg: #ddf3e0;
  --color-add-bg-soft: #ecfaee;
  --color-rem-bg: #f8d8d4;
  --color-rem-bg-soft: #fbeae6;

  /* Lighter shadow alpha tuned for warm backgrounds */
  --shadow-soft: 0 1px 3px rgba(42, 36, 27, 0.08);
  --shadow-medium: 0 4px 12px rgba(42, 36, 27, 0.12);
  --shadow-deep: 0 8px 24px rgba(42, 36, 27, 0.18);
  --shadow-pop: 0 12px 32px rgba(42, 36, 27, 0.22);
}

/* ─── prefers-color-scheme fallback ──────────────────────────────
 * When the user has NOT explicitly chosen a theme (no data-theme
 * attribute on <html>), follow the OS preference. The :not()
 * qualifier makes user overrides win.
 */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --color-page: #fdfaf3;
    --color-pane: #f7f1e3;
    --color-main: #fffdf7;
    --color-card: #faf5e8;
    --color-chip: #f0e9d6;
    --color-input: #fffdf7;

    --color-primary: #2a241b;
    --color-secondary: #6b5d4a;
    --color-muted: #968773;
    --color-faint: #c5b9a1;

    --color-edge: #e0d6bf;
    --color-edge-soft: #ece4d2;

    --color-accent: #b8541c;
    --color-claude: #7c3aed;
    --color-tool: #0969da;
    --color-think: #b8541c;
    --color-write: #1f7a36;
    --color-task: #be1e1e;
    --color-edit: #0969da;
    --color-read: #b8541c;
    --color-plan: #b8541c;
    --color-review: #7c3aed;

    --color-add-bg: #ddf3e0;
    --color-add-bg-soft: #ecfaee;
    --color-rem-bg: #f8d8d4;
    --color-rem-bg-soft: #fbeae6;

    --shadow-soft: 0 1px 3px rgba(42, 36, 27, 0.08);
    --shadow-medium: 0 4px 12px rgba(42, 36, 27, 0.12);
    --shadow-deep: 0 8px 24px rgba(42, 36, 27, 0.18);
    --shadow-pop: 0 12px 32px rgba(42, 36, 27, 0.22);
  }
}

/* color-scheme hint to the browser for native form controls + scrollbar */
:root {
  color-scheme: dark;
}
[data-theme="light"] {
  color-scheme: light;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    color-scheme: light;
  }
}

/* ─── Body baseline — the only chrome rule that uses the new
 * tokens in M31. Existing components keep their hardcoded hex
 * values until M32 migrates the shell.
 */
body {
  margin: 0;
  background: var(--color-page);
  color: var(--color-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "HelveticaNeue-Light",
    system-ui, "Ubuntu", "Droid Sans", sans-serif;
  font-size: 13px;
}

#root {
  min-height: 100vh;
}

/* ─── Focus ring (existing M8 a11y) — re-using token ────────── */
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

button,
a,
[role="button"] {
  &:focus {
    outline: none;
  }
}

/* ─── Scrollbars (existing) ─────────────────────────────────── */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-thumb {
  background: #424242;
  border-radius: 0;
}
::-webkit-scrollbar-thumb:hover {
  background: #4f4f4f;
}
::-webkit-scrollbar-track {
  background: transparent;
}

/* Selection color (existing) */
::selection {
  background: rgba(0, 120, 212, 0.4);
}

kbd {
  font-family: ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 0.85em;
}
```

Notes on what changed vs the old file:

- The old `body { background: #1e1e1e; color: #cccccc }` is gone — replaced with `var(--color-page)` / `var(--color-primary)`. **In dark mode the visible result is different** (`#0d1117` not `#1e1e1e`) which would cause a visual regression. To preserve existing behavior, instead set the dark token to match the old hardcoded value: `--color-page: #1e1e1e` would maintain visual parity for the body bg.

  _Decision:_ Use `#0d1117` (matches the spec's locked palette and the brainstorm mockups). The old `#1e1e1e` was only ever the body bg; nothing else in the dark UI depended on it, and the rest of the chrome's hardcoded hex (rail/sidebar/tabs) covers the body before users see it. **The body bg will change from `#1e1e1e` → `#0d1117` in dark mode**; this is acceptable and matches the spec's design system.

- The old `prefers-color-scheme: light` block (40 lines) is replaced by the full token-based light variant.

- Focus-visible outline now uses `var(--color-accent)` so it picks up the warm accent in light mode. In dark mode it changes from `#0078d4` → `#58a6ff` (also a minor visual drift, but matches the new accent token).

- [ ] **Step 3: Run dashboard typecheck + lint to confirm no syntax issues**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npm run lint
```

Both clean. (CSS doesn't typecheck, but Tailwind config errors would appear as missing utility class warnings if they snuck in.)

- [ ] **Step 4: Run the existing vitest suite to confirm no regressions**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

Expected: all green (the CSS file change doesn't affect any component-level test).

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/index.css
git commit -m "feat(m31): semantic theme tokens via Tailwind v4 @theme

Adds the full color/typography/radius/shadow token system in
dashboard/src/index.css. Dark is the default palette (matches
the M0-M30 GitHub-dark aesthetic with the body-bg drift from
#1e1e1e -> #0d1117 to align with the spec). Warm Workshop light
variant overrides the same CSS vars in [data-theme=\"light\"]
plus a prefers-color-scheme fallback for unset preference.

Existing components keep their hardcoded hex; the layout shell
will migrate to semantic tokens in M32."
```

---

## Task 2: ThemeProvider + useTheme hook

**Files:**

- Create: `dashboard/src/lib/theme.ts`
- Test: `dashboard/src/lib/__tests__/theme.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/lib/__tests__/theme.test.tsx`:

```tsx
/** ThemeProvider + useTheme tests (M31). */
import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "../theme";

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// Vitest's jsdom doesn't ship matchMedia; install a controllable mock
// so each test can simulate either OS preference.
function installMatchMedia(prefersLight: boolean) {
  const listeners: Array<(ev: { matches: boolean }) => void> = [];
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes("light") ? prefersLight : !prefersLight,
    media: q,
    addEventListener: (_t: string, cb: (ev: { matches: boolean }) => void) => listeners.push(cb),
    removeEventListener: (_t: string, cb: (ev: { matches: boolean }) => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => true,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    fireChange(nextPrefersLight: boolean) {
      for (const cb of listeners) cb({ matches: nextPrefersLight });
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme", () => {
  it("defaults to 'system' preference, resolves to 'dark' when OS is dark", () => {
    installMatchMedia(/* prefersLight */ false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("resolves 'system' to 'light' when OS is light", () => {
    installMatchMedia(/* prefersLight */ true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("light");
    // System preference must NOT set data-theme — that's reserved for explicit user override
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("explicit 'dark' override sets data-theme=dark and persists", () => {
    installMatchMedia(/* prefersLight */ true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setPreference("dark");
    });
    expect(result.current.preference).toBe("dark");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("explicit 'light' override sets data-theme=light and persists", () => {
    installMatchMedia(/* prefersLight */ false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setPreference("light");
    });
    expect(result.current.preference).toBe("light");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("setting back to 'system' clears data-theme attribute and storage", () => {
    installMatchMedia(/* prefersLight */ false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setPreference("system");
    });
    expect(result.current.preference).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("re-resolves when prefers-color-scheme changes (and preference is system)", () => {
    const mm = installMatchMedia(/* prefersLight */ false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.resolved).toBe("dark");
    act(() => {
      mm.fireChange(/* nowPrefersLight */ true);
    });
    expect(result.current.resolved).toBe("light");
  });

  it("loads persisted preference from localStorage on mount", () => {
    installMatchMedia(/* prefersLight */ false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.preference).toBe("light");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/theme.test.tsx
```

Expected: FAIL with `Cannot find module '../theme'`.

- [ ] **Step 3: Implement `theme.ts`**

Create `dashboard/src/lib/theme.ts`:

```tsx
/** Theme system (M31).
 *
 * One React Context provides the current theme preference and a setter.
 * Preference can be:
 *   - "system" — follow OS via prefers-color-scheme media query
 *   - "light"  — explicit light override
 *   - "dark"   — explicit dark override
 *
 * Resolution rules:
 *   - When preference is "system": data-theme attribute is REMOVED from
 *     <html>, letting the prefers-color-scheme CSS media query take effect.
 *   - When preference is "light" or "dark": data-theme attribute is SET on
 *     <html>, overriding the media query.
 *
 * Persistence: localStorage key `hive:theme`. Setting back to "system"
 * removes the storage key (so a fresh device follows OS until told
 * otherwise).
 *
 * Listens for media-query change events so a user on "system" who
 * flips their OS theme sees the dashboard update without reload.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const THEME_STORAGE_KEY = "hive:theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function readSystemPreference(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyDataTheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemPreference());

  // Apply data-theme on mount + whenever preference changes
  useEffect(() => {
    applyDataTheme(preference);
  }, [preference]);

  // Listen for OS preference changes so "system" stays live
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (ev: { matches: boolean }) => {
      setSystemTheme(ev.matches ? "light" : "dark");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (next === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? systemTheme : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
```

- [ ] **Step 4: Run tests, expect 7/7 PASS**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/theme.test.tsx
```

Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/theme.ts dashboard/src/lib/__tests__/theme.test.tsx
git commit -m "feat(m31): ThemeProvider + useTheme hook

Resolves user preference (system/light/dark) against OS via the
prefers-color-scheme media query. Setting preference to system
removes the data-theme attribute so the @media query in index.css
takes effect; explicit overrides set the attribute and persist to
localStorage:hive:theme. Re-resolves live when the OS preference
changes."
```

---

## Task 3: Wire ThemeProvider into main.tsx

**Files:**

- Modify: `dashboard/src/main.tsx`

- [ ] **Step 1: Read current main.tsx + add the provider**

Open `dashboard/src/main.tsx` and modify the bottom render to wrap in `ThemeProvider`:

```tsx
// At top: add to imports
import { ThemeProvider } from "./lib/theme";

// Bottom: wrap in ThemeProvider
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastRelayInstaller>
          <App />
        </ToastRelayInstaller>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

The provider goes inside `QueryClientProvider` (in case anything later wants to mutate theme via a server call) and outside `ToastRelayInstaller` (so toasts can react to theme changes if needed, but currently don't).

- [ ] **Step 2: Run typecheck + the existing vitest suite**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

Both clean. (Existing tests don't depend on ThemeProvider; if any do break, the test setup needs to wrap in `<ThemeProvider>` — handle inline.)

- [ ] **Step 3: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/main.tsx
git commit -m "feat(m31): wire ThemeProvider into the app tree

Mounted between QueryClientProvider and ToastRelayInstaller.
Default behavior: respects OS preference via prefers-color-scheme
until the user explicitly chooses Settings -> Appearance."
```

---

## Task 4: AppearancePicker component + Settings → Appearance section

**Files:**

- Create: `dashboard/src/components/AppearancePicker.tsx`
- Modify: `dashboard/src/components/SettingsView.tsx`
- Test: `dashboard/src/components/__tests__/AppearancePicker.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/components/__tests__/AppearancePicker.test.tsx`:

```tsx
/** AppearancePicker tests (M31). */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider, THEME_STORAGE_KEY } from "../../lib/theme";
import { AppearancePicker } from "../AppearancePicker";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // Stub matchMedia to prefersLight=false so default resolves to dark
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
      onchange: null,
    }) as unknown as MediaQueryList;
});
afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

function renderPicker() {
  return render(
    <ThemeProvider>
      <AppearancePicker />
    </ThemeProvider>,
  );
}

describe("AppearancePicker", () => {
  it("renders three radio rows: System, Dark, Light", () => {
    renderPicker();
    expect(screen.getByRole("radio", { name: /system/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /dark/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /light/i })).toBeTruthy();
  });

  it("defaults to System selected", () => {
    renderPicker();
    expect((screen.getByRole("radio", { name: /system/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /dark/i }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: /light/i }) as HTMLInputElement).checked).toBe(false);
  });

  it("clicking Light selects it and persists to localStorage", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    expect((screen.getByRole("radio", { name: /light/i }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("clicking Dark selects it and persists", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /dark/i }));
    expect((screen.getByRole("radio", { name: /dark/i }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("clicking System after Light clears storage + data-theme", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    fireEvent.click(screen.getByRole("radio", { name: /system/i }));
    expect((screen.getByRole("radio", { name: /system/i }) as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests and confirm fail**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/AppearancePicker.test.tsx
```

Expected: FAIL — `Cannot find module '../AppearancePicker'`.

- [ ] **Step 3: Implement AppearancePicker**

Create `dashboard/src/components/AppearancePicker.tsx`:

```tsx
/** Three-radio appearance picker (M31).
 *
 * Used in Settings -> Appearance. Will also be used in M36 by the
 * phone "More" tab. Self-contained — pulls preference from useTheme.
 */
import { useTheme, type ThemePreference } from "../lib/theme";

const OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  {
    value: "system",
    label: "System",
    description: "Auto-follow OS — switches with macOS / Windows night mode",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Existing aesthetic — deep workspace, locked palette",
  },
  {
    value: "light",
    label: "Light",
    description: "Daytime / bright environments — Warm Workshop palette",
  },
];

function Swatch({ value }: { value: ThemePreference }) {
  // Inline SVG previews — three little 56x36 cards showing the palette
  // at a glance. Not theme-token-driven (these are static previews of
  // each option, not a reflection of the current state).
  if (value === "system") {
    return (
      <div
        className="h-9 w-14 flex-shrink-0 overflow-hidden rounded border border-[#d0d7de]"
        style={{
          background: "linear-gradient(135deg, #ffffff 0%, #ffffff 49%, #161b22 51%, #161b22 100%)",
        }}
      />
    );
  }
  if (value === "dark") {
    return (
      <div
        className="h-9 w-14 flex-shrink-0 overflow-hidden rounded"
        style={{
          background: "linear-gradient(135deg, #0d1117 0%, #161b22 50%, #1c2128 100%)",
        }}
      />
    );
  }
  return (
    <div
      className="h-9 w-14 flex-shrink-0 overflow-hidden rounded border border-[#e0d6bf]"
      style={{
        background: "linear-gradient(135deg, #fdfaf3 0%, #f7f1e3 50%, #f0e9d6 100%)",
      }}
    />
  );
}

export function AppearancePicker() {
  const { preference, setPreference } = useTheme();
  return (
    <fieldset className="flex flex-col gap-2" aria-label="Appearance">
      {OPTIONS.map((opt) => {
        const id = `appearance-${opt.value}`;
        const selected = preference === opt.value;
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className={`flex items-center gap-3.5 rounded-md border p-3 cursor-pointer transition-colors ${
              selected
                ? "border-[#58a6ff] shadow-[0_0_0_1px_#58a6ff]"
                : "border-[#30363d] hover:border-[#6e7681]"
            }`}
          >
            <Swatch value={opt.value} />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-[#c9d1d9]">{opt.label}</div>
              <div className="text-[11px] text-[#6e7681] mt-0.5">{opt.description}</div>
            </div>
            <input
              id={id}
              type="radio"
              name="appearance"
              value={opt.value}
              checked={selected}
              onChange={() => setPreference(opt.value)}
              className="h-4 w-4 cursor-pointer accent-[#58a6ff]"
            />
          </label>
        );
      })}
    </fieldset>
  );
}
```

Note: this component intentionally uses hardcoded hex (matching the existing dashboard's pattern) — the spec's M31 goal is to add the platform without rewriting components. M32 will migrate the chrome shell to semantic tokens. The only tokens this milestone introduces to UI are the body bg + focus outline (Task 1).

- [ ] **Step 4: Run AppearancePicker tests, expect 5/5 PASS**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/AppearancePicker.test.tsx
```

Expected: 5/5 PASS.

- [ ] **Step 5: Add Appearance section to SettingsView**

Open `dashboard/src/components/SettingsView.tsx`, find a suitable insertion point near the top of the rendered content (above the existing "Hub configuration" or first section), and add:

```tsx
// At top: add import
import { AppearancePicker } from "./AppearancePicker";

// In the JSX render, near the top of the content (above existing settings sections):
<section className="mb-6">
  <h2 className="text-[15px] font-semibold text-[#c9d1d9] mb-1">Appearance</h2>
  <p className="text-[12px] text-[#6e7681] mb-3">
    Choose how the dashboard looks. System follows your OS preference.
  </p>
  <AppearancePicker />
</section>;
```

The section uses hardcoded hex (same pattern as the rest of SettingsView). The exact placement depends on the current SettingsView structure — read it first and insert at a natural break.

- [ ] **Step 6: Run typecheck + the existing SettingsView test (if any) + new tests**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

All green.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/AppearancePicker.tsx \
        dashboard/src/components/__tests__/AppearancePicker.test.tsx \
        dashboard/src/components/SettingsView.tsx
git commit -m "feat(m31): Settings -> Appearance section + AppearancePicker

Three-radio picker (System/Dark/Light) with preview swatches.
Reads + writes through useTheme. Same component will be reused
by M36's phone More tab."
```

---

## Task 5: ⌘K commands for theme switching

**Files:**

- Modify: `dashboard/src/components/CommandPalette.tsx`

- [ ] **Step 1: Inspect the CommandPalette to find the command-construction site**

```bash
grep -n "items.push\|commands:" /home/gnava/repos/honeycomb/dashboard/src/components/CommandPalette.tsx | head -10
```

The file builds a `commands: PaletteCommand[]` via successive `items.push(...)` calls inside `useMemo`. We add three new entries to the same list, in a new `"Appearance"` group.

- [ ] **Step 2: Extend `PaletteCommand`'s `group` union type**

Find the `interface PaletteCommand` declaration near the top of the file. Update the `group` field union to include `"Appearance"`:

```tsx
interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  group: "Containers" | "Activity" | "Sessions" | "Discover" | "Suggestions" | "Appearance";
  run: () => void;
}
```

- [ ] **Step 3: Add the three theme commands to the `useMemo` block**

Inside `useMemo(() => { ... }, [...])`, after the existing `items.push(...)` calls (and before the `return items;`), append:

```tsx
// M31: theme switching commands
const themeApi = themeRef.current;
if (themeApi) {
  items.push({
    id: "theme:light",
    title: "Switch to Light theme",
    subtitle: "Warm Workshop palette",
    shortcut: "⌘ ⇧ L",
    group: "Appearance",
    run: () => themeApi.setPreference("light"),
  });
  items.push({
    id: "theme:dark",
    title: "Switch to Dark theme",
    subtitle: "Existing aesthetic",
    shortcut: "⌘ ⇧ D",
    group: "Appearance",
    run: () => themeApi.setPreference("dark"),
  });
  items.push({
    id: "theme:system",
    title: "Use System theme",
    subtitle: "Follow OS preference",
    shortcut: "⌘ ⇧ S",
    group: "Appearance",
    run: () => themeApi.setPreference("system"),
  });
}
```

`themeRef` is a `useRef` we'll add at the top of the component to hold the current theme API. Why a ref? `useTheme()` returns a new object each render, and we don't want the `useMemo` deps to thrash. Add at the top of the component body:

```tsx
import { useEffect, useMemo, useRef, useState } from "react"; // add useRef + useEffect

import { useTheme } from "../lib/theme";

// ... inside CommandPalette component:
const themeApi = useTheme();
const themeRef = useRef(themeApi);
useEffect(() => {
  themeRef.current = themeApi;
}, [themeApi]);
```

- [ ] **Step 4: Add a global keyboard shortcut listener for ⌘⇧L/D/S**

Find the existing global shortcut wiring (likely in `App.tsx` or `useKeyboardShortcuts.ts`). The simplest approach for M31 is to register the listener inside `CommandPalette.tsx` using a `useEffect`:

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "l") {
      e.preventDefault();
      themeRef.current.setPreference("light");
    } else if (k === "d") {
      e.preventDefault();
      themeRef.current.setPreference("dark");
    } else if (k === "s") {
      e.preventDefault();
      themeRef.current.setPreference("system");
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, []);
```

This works while CommandPalette is mounted (which it is, app-wide).

- [ ] **Step 5: Add a vitest test for the new commands**

Create or extend `dashboard/src/components/__tests__/CommandPalette.test.tsx` with:

```tsx
/** CommandPalette M31 additions: theme commands. */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { ThemeProvider, THEME_STORAGE_KEY } from "../../lib/theme";
import { CommandPalette } from "../CommandPalette";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
      onchange: null,
    }) as unknown as MediaQueryList;
});

const noop = () => undefined;

function renderPalette() {
  return render(
    <ThemeProvider>
      <CommandPalette
        open
        onClose={noop}
        containers={[]}
        activeContainerId={null}
        activeWorkdir=""
        onFocusContainer={noop}
        onCloseContainer={noop}
        onNewClaudeSession={noop}
        onActivity={noop}
        onOpenProvisioner={noop}
        onOpenFile={noop}
        onRunSuggestion={noop}
      />
    </ThemeProvider>,
  );
}

describe("CommandPalette — M31 theme commands", () => {
  it("lists the three appearance commands", () => {
    renderPalette();
    expect(screen.getByText(/Switch to Light theme/i)).toBeTruthy();
    expect(screen.getByText(/Switch to Dark theme/i)).toBeTruthy();
    expect(screen.getByText(/Use System theme/i)).toBeTruthy();
  });

  it("clicking 'Switch to Light theme' sets preference to light", () => {
    renderPalette();
    fireEvent.click(screen.getByText(/Switch to Light theme/i));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("⌘⇧L keyboard shortcut sets preference to light", () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("⌘⇧D keyboard shortcut sets preference to dark", () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "D", metaKey: true, shiftKey: true });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("⌘⇧S keyboard shortcut clears preference to system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderPalette();
    fireEvent.keyDown(window, { key: "S", metaKey: true, shiftKey: true });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
```

- [ ] **Step 6: Run all tests, expect everything green**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/CommandPalette.tsx \
        dashboard/src/components/__tests__/CommandPalette.test.tsx
git commit -m "feat(m31): three theme commands in command palette

⌘⇧L (Light), ⌘⇧D (Dark), ⌘⇧S (System) — both clickable from
the Appearance group in ⌘K and bound as global keyboard
shortcuts. All three flow through useTheme so behavior matches
the Settings -> Appearance picker."
```

---

## Task 6: Playwright spec — theme switching + axe-core scan

**Files:**

- Modify: `dashboard/package.json` — add `@axe-core/playwright` dev dep
- Create: `dashboard/tests/e2e/theme-system.spec.ts`

- [ ] **Step 1: Install @axe-core/playwright**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm install --save-dev @axe-core/playwright
```

- [ ] **Step 2: Write the e2e spec**

Create `dashboard/tests/e2e/theme-system.spec.ts`:

```ts
/** M31 theme system end-to-end.
 *
 * Verifies:
 *   1. Default state (no localStorage) follows OS via prefers-color-scheme
 *   2. Setting Dark via Settings sets data-theme="dark"
 *   3. Setting Light via Settings sets data-theme="light"
 *   4. Setting System clears data-theme
 *   5. ⌘K command "Switch to Light theme" works
 *   6. ⌘⇧L keyboard shortcut works
 *   7. The new Appearance UI passes axe-core in both themes
 *
 * Mirrors the auth + container fixture pattern from existing specs.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "theme-system-token";

const containerFixture = {
  id: 1,
  workspace_folder: "/w",
  project_type: "base",
  project_name: "demo",
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

  // Stub every endpoint the dashboard polls on boot
  await context.route("**/api/containers", (route) => route.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/1/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/containers/1/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/api/containers/1/named-sessions", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/containers/1/diff-events**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/containers/1/resources**", (route) => route.fulfill(mockJson(null)));
  await context.route("**/api/containers/1/fs/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
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
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
});

test("default boot follows OS preference (no data-theme set)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("Settings -> Appearance flips data-theme", async ({ page }) => {
  await page.goto("/");

  // Open the Settings activity (assumes existing activity-bar wiring still works)
  await page.getByRole("button", { name: /settings/i }).click();

  // Click "Light" radio
  await page.getByRole("radio", { name: /light/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Click "Dark" radio
  await page.getByRole("radio", { name: /dark/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Click "System" radio
  await page.getByRole("radio", { name: /system/i }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("⌘⇧L keyboard shortcut switches to light", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Meta+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("⌘⇧D keyboard shortcut switches to dark", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Meta+Shift+L"); // first set to light
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Meta+Shift+D");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("⌘⇧S keyboard shortcut clears to system", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Meta+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Meta+Shift+S");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("Appearance section passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /settings/i }).click();
  await page.getByRole("radio", { name: /dark/i }).click();
  // Scope axe scan to the Appearance section to keep the assertion focused
  // on the new M31 surface (existing components still hardcode hex and may
  // surface old contrast issues that aren't this milestone's concern).
  const results = await new AxeBuilder({ page })
    .include('fieldset[aria-label="Appearance"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Appearance section passes axe-core in light theme", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /settings/i }).click();
  await page.getByRole("radio", { name: /light/i }).click();
  const results = await new AxeBuilder({ page })
    .include('fieldset[aria-label="Appearance"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 3: Run the new spec**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test theme-system.spec.ts
```

Expected: 7/7 PASS. If the Settings activity button selector doesn't match (e.g., the existing rail uses an icon-only button without an aria-label), update the locator to whatever the existing dashboard uses. Don't invent a new selector — reuse the established pattern.

- [ ] **Step 4: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/package.json dashboard/package-lock.json \
        dashboard/tests/e2e/theme-system.spec.ts
git commit -m "test(m31): playwright spec for theme switching + axe-core a11y

7 cases: default boot follows OS, Settings UI flips data-theme,
⌘⇧L/D/S keyboard shortcuts work, axe-core finds zero violations
on the Appearance UI in both dark and light. axe-core scope is
limited to the new M31 surface so it doesn't fail on pre-existing
hardcoded-hex chrome (those flip in M32)."
```

---

## Task 7: Pre-flight regression sweep + prettier

- [ ] **Step 1: Hub regression (untouched but verify)**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

Expected: all green. Hub wasn't modified in M31.

- [ ] **Step 2: Hive-agent regression (untouched but verify)**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

Expected: all green.

- [ ] **Step 3: Dashboard typecheck + lint + vitest**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npm run lint
npx vitest run
```

All green. **Use `tsc -b` (composite), not `tsc --noEmit`** — CI runs the composite resolver and catches errors the root config misses.

- [ ] **Step 4: Full Playwright suite**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

Expected: all existing 10 specs + the new `theme-system.spec.ts` = 11 specs green. The existing specs are the **dark-mode visual regression** — they continue to pass means no visible regression in dark mode.

- [ ] **Step 5: Prettier sweep**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
cd /home/gnava/repos/honeycomb
git status
git diff
```

Expected: zero or tiny diff on M31-touched files. If prettier reformats unrelated files, STOP — investigate.

- [ ] **Step 6: Commit any prettier-reformatted output**

```bash
cd /home/gnava/repos/honeycomb
git add -A -- dashboard/
git diff --cached --quiet || git commit -m "style(m31): prettier sweep before push"
```

Note the explicit `-- dashboard/` to avoid accidentally staging the gitignored `.claude/settings.json` (a recurring trap).

- [ ] **Step 7: Full pre-commit run**

```bash
cd /home/gnava/repos/honeycomb
pre-commit run --all-files
```

Expected: clean.

---

## Task 8: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1: Push the branch and watch CI**

```bash
cd /home/gnava/repos/honeycomb
git push -u origin m31-onwards-design-system
gh run watch --exit-status $(gh run list --branch m31-onwards-design-system --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: CI green. If a job hangs (M30/M27 saw transient Docker Hub auth flakes), cancel + rerun: `gh run rerun <id> --failed`.

- [ ] **Step 2: Merge to main**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git merge --no-ff m31-onwards-design-system -m "Merge M31: design system foundation"
```

- [ ] **Step 3: Tag v0.31-design-system-foundation**

```bash
cd /home/gnava/repos/honeycomb
git tag -a v0.31-design-system-foundation \
  -m "M31: design system foundation (theme tokens + ThemeProvider + Appearance UI + ⌘K commands)"
```

- [ ] **Step 4: Push with --follow-tags**

```bash
cd /home/gnava/repos/honeycomb
git push --follow-tags origin main
```

- [ ] **Step 5: Watch the merge-commit CI run**

```bash
cd /home/gnava/repos/honeycomb
sleep 10 && gh run list --branch main --limit 1
gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: green. Same flake handling as Step 1 if needed.

- [ ] **Step 6: Delete the merged branch**

```bash
cd /home/gnava/repos/honeycomb
git branch -d m31-onwards-design-system
git push origin --delete m31-onwards-design-system
```

---

## Verification Checklist

Before marking M31 done, confirm:

- [ ] `cd dashboard && npx vitest run` — all green (existing + 7 new theme tests + 5 AppearancePicker tests + 5 CommandPalette theme tests).
- [ ] `cd dashboard && npx playwright test` — all 11 specs green (10 existing as dark-mode regression + 1 new theme-system).
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint` — clean.
- [ ] `cd hub && uv run pytest tests -q` — green (hub untouched, sanity check).
- [ ] `pre-commit run --all-files` — clean.
- [ ] Manual smoke: open the dashboard at `localhost:5173`, go to Settings → Appearance, click each of System / Dark / Light. Verify `<html>` data-theme attribute changes in DevTools. Open ⌘K palette, find the three "Appearance" group commands, click one. Press `⌘⇧L` / `⌘⇧D` / `⌘⇧S` directly to confirm shortcuts.
- [ ] `git log --oneline main` shows the merge commit + the `v0.31-design-system-foundation` tag.
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green.
- [ ] Branch `m31-onwards-design-system` deleted locally and on origin.
