/** ThemeProvider + useTheme tests (M31). */
import { act, renderHook } from "@testing-library/react";
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
