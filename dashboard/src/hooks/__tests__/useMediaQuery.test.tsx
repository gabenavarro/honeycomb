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
