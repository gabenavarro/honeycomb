/** useArtifacts hook tests (M35). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useArtifacts } from "../useArtifacts";
import type { Artifact } from "../../lib/types";

const mockListArtifacts = vi.fn();
vi.mock("../../lib/api", () => ({
  listArtifacts: (...args: unknown[]) => mockListArtifacts(...args),
}));

type Listener = (frame: { channel: string; event: string; data: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
const subscribed = new Set<string>();

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    subscribe: (channels: string[]) => channels.forEach((c) => subscribed.add(c)),
    unsubscribe: (channels: string[]) => channels.forEach((c) => subscribed.delete(c)),
    onChannel: (channel: string, cb: Listener) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
  }),
}));

function emit(channel: string, event: string, data: unknown): void {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of set) cb({ channel, event, data });
}

// A stable QueryClient that survives re-renders within a single test.
// Must be recreated between tests (done in beforeEach below).
let testQueryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={testQueryClient}>{children}</QueryClientProvider>;
}

const sampleArtifact: Artifact = {
  artifact_id: "a-1",
  container_id: 1,
  type: "note",
  title: "A",
  body: "x",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

beforeEach(() => {
  testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockListArtifacts.mockReset();
  listeners.clear();
  subscribed.clear();
});
afterEach(() => {
  listeners.clear();
});

describe("useArtifacts", () => {
  it("subscribes to library:<id> on mount, unsubscribes on unmount", async () => {
    mockListArtifacts.mockResolvedValue([]);
    const { unmount } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(subscribed.has("library:1")).toBe(true));
    unmount();
    expect(subscribed.has("library:1")).toBe(false);
  });

  it("does not query or subscribe when containerId is null", () => {
    renderHook(() => useArtifacts(null, {}), { wrapper });
    expect(mockListArtifacts).not.toHaveBeenCalled();
    expect(subscribed.size).toBe(0);
  });

  it("returns the artifact list from the API", async () => {
    mockListArtifacts.mockResolvedValue([sampleArtifact]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));
    expect(result.current.artifacts[0].artifact_id).toBe("a-1");
  });

  it("'new' WS event prepends the artifact to the cache", async () => {
    mockListArtifacts.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(subscribed.has("library:1")).toBe(true));

    act(() => {
      emit("library:1", "new", sampleArtifact);
    });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));
    expect(result.current.artifacts[0].artifact_id).toBe("a-1");
  });

  it("'deleted' WS event removes the artifact from the cache", async () => {
    mockListArtifacts.mockResolvedValue([sampleArtifact]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));

    act(() => {
      emit("library:1", "deleted", { artifact_id: "a-1" });
    });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(0));
  });

  it("'updated' WS event refetches the list", async () => {
    mockListArtifacts.mockResolvedValueOnce([sampleArtifact]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));

    mockListArtifacts.mockResolvedValueOnce([{ ...sampleArtifact, pinned: true }]);
    act(() => {
      emit("library:1", "updated", { artifact_id: "a-1" });
    });
    await waitFor(() => expect(result.current.artifacts[0].pinned).toBe(true));
  });

  it("unsubscribes from previous channel and subscribes to new one when containerId changes", async () => {
    mockListArtifacts.mockResolvedValue([]);
    const { rerender } = renderHook(({ id }: { id: number | null }) => useArtifacts(id, {}), {
      wrapper,
      initialProps: { id: 1 as number | null },
    });
    await waitFor(() => expect(subscribed.has("library:1")).toBe(true));
    rerender({ id: 2 });
    await waitFor(() => expect(subscribed.has("library:1")).toBe(false));
    await waitFor(() => expect(subscribed.has("library:2")).toBe(true));
  });

  it("'new' WS events propagate across all param-filtered queries for the same container", async () => {
    // Mount with no filter — first query resolves to empty
    mockListArtifacts.mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(
      ({ params }: { params: { type?: ("note" | "plan")[] } }) => useArtifacts(1, params),
      { wrapper, initialProps: { params: {} as { type?: ("note" | "plan")[] } } },
    );
    await waitFor(() => expect(subscribed.has("library:1")).toBe(true));
    // Wait for first fetch to settle so the cache has data
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Change filter — new query key. Second fetch also resolves to empty.
    mockListArtifacts.mockResolvedValueOnce([]);
    rerender({ params: { type: ["note"] } });
    // Wait for second fetch to settle so the new cache entry exists with data
    await waitFor(() => expect(mockListArtifacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // WS 'new' event after the params change — setQueriesData fans out to
    // ALL ["artifacts", 1, ...] keys, so the active filtered query must update.
    act(() => {
      emit("library:1", "new", sampleArtifact);
    });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));
    expect(result.current.artifacts[0].artifact_id).toBe("a-1");
  });
});
