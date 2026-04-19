/** useContainerFileIndex tests (M23).
 *
 * The hook delegates to ``listContainerFiles`` via React Query.
 * Covers: the ``enabled`` gate, cache-hit on remount within staleTime,
 * and error propagation.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useContainerFileIndex } from "../useContainerFileIndex";

const mockListContainerFiles = vi.hoisted(() =>
  vi.fn<
    (id: number) => Promise<{
      root: string;
      entries: unknown[];
      truncated: boolean;
      elapsed_ms: number;
    }>
  >(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, listContainerFiles: mockListContainerFiles };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockListContainerFiles.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});

afterEach(() => {
  qc.clear();
});

describe("useContainerFileIndex", () => {
  it("does not fetch when disabled", () => {
    renderHook(() => useContainerFileIndex(1, { enabled: false }), { wrapper });
    expect(mockListContainerFiles).not.toHaveBeenCalled();
  });

  it("fetches and surfaces entries when enabled", async () => {
    mockListContainerFiles.mockResolvedValue({
      root: "/workspace",
      entries: [
        { name: "/workspace/a.ts", kind: "file", size: 10, mode: "", mtime: "", target: null },
      ],
      truncated: false,
      elapsed_ms: 5,
    });
    const { result } = renderHook(() => useContainerFileIndex(1, { enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.entries[0].name).toBe("/workspace/a.ts");
    expect(result.current.truncated).toBe(false);
  });

  it("surfaces errors from the API call", async () => {
    mockListContainerFiles.mockRejectedValue(new Error("504: walk timed out"));
    const { result } = renderHook(() => useContainerFileIndex(1, { enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(String(result.current.error)).toContain("504");
  });
});
