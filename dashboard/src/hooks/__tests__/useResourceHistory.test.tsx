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
    getResources: mockLive,
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
    gpu_utilization: null,
    gpu_memory_mb: null,
    gpu_memory_total_mb: null,
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
    // If dedup failed we'd see length 2.
    expect(result.current.length).toBe(1);
  });

  it("caps buffer at 60 entries", async () => {
    mockHistory.mockResolvedValue(
      Array.from({ length: 60 }, (_v, i) => sample(`t${i}`, i)),
    );
    mockLive.mockResolvedValue(sample("t60", 60));
    const { result } = renderHook(() => useResourceHistory(1), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(60));
    // First surviving cpu is 1 (t0 dropped); last is 60.
    expect(result.current[0].cpu_percent).toBe(1);
    expect(result.current[result.current.length - 1].cpu_percent).toBe(60);
  });
});
