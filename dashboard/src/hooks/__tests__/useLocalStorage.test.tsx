/** useLocalStorage tests (M9).
 *
 * Covers the three failure modes we care about: corrupt JSON falling
 * back to the default, validator rejection falling back to the
 * default, and a write throwing QuotaExceededError emitting the
 * ``hive:localStorage:quota`` event that the watcher component
 * subscribes to.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onLocalStorageQuota, useLocalStorage } from "../useLocalStorage";

describe("useLocalStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns the stored value when present", () => {
    localStorage.setItem("k", JSON.stringify(42));
    const { result } = renderHook(() => useLocalStorage<number>("k", 0));
    expect(result.current[0]).toBe(42);
  });

  it("falls back to the default when JSON is corrupt", () => {
    localStorage.setItem("k", "not-json");
    const { result } = renderHook(() => useLocalStorage<number>("k", 99));
    expect(result.current[0]).toBe(99);
  });

  it("falls back to the default when the validator rejects", () => {
    localStorage.setItem("k", JSON.stringify("banana"));
    const isNumber = (v: unknown): v is number => typeof v === "number";
    const { result } = renderHook(() => useLocalStorage<number>("k", 7, { validate: isNumber }));
    expect(result.current[0]).toBe(7);
  });

  it("persists writes to localStorage", () => {
    const { result } = renderHook(() => useLocalStorage<number>("k", 0));
    act(() => {
      result.current[1](11);
    });
    expect(JSON.parse(localStorage.getItem("k")!)).toBe(11);
  });

  it("emits a quota event when setItem throws", () => {
    const fired: string[] = [];
    const off = onLocalStorageQuota(({ key }) => fired.push(key));
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    const { result } = renderHook(() => useLocalStorage<number>("k", 0));
    act(() => {
      result.current[1](1);
    });

    expect(fired).toContain("k");
    setItem.mockRestore();
    off();
  });
});
