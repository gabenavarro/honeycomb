import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDiffEvents } from "../useDiffEvents";
import type { DiffEvent } from "../../lib/types";

const mockList = vi.hoisted(() => vi.fn<(id: number) => Promise<DiffEvent[]>>());
const mockSubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
const mockUnsubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
type WsFrame = { channel: string; event: string; data: unknown };
type WsListener = (frame: WsFrame) => void;
const mockOnChannel = vi.hoisted(() => vi.fn<(c: string, cb: WsListener) => () => void>());

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    listDiffEvents: mockList,
  };
});

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    connected: true,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    onChannel: mockOnChannel,
  }),
}));

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ev(id: string, path: string, ts = "2026-04-23T07:38:00Z"): DiffEvent {
  return {
    event_id: id,
    container_id: 1,
    claude_session_id: null,
    tool_use_id: "t-" + id,
    tool: "Edit",
    path,
    diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
    added_lines: 1,
    removed_lines: 1,
    size_bytes: 30,
    timestamp: ts,
    created_at: ts,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockSubscribe.mockReset();
  mockUnsubscribe.mockReset();
  mockOnChannel.mockReset();
  mockOnChannel.mockImplementation(() => () => {});
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  qc.clear();
});

describe("useDiffEvents", () => {
  it("returns empty when containerId is null", () => {
    const { result } = renderHook(() => useDiffEvents(null), { wrapper });
    expect(result.current.events).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("fetches via REST when containerId is set", async () => {
    mockList.mockResolvedValue([ev("a", "/a"), ev("b", "/b")]);
    const { result } = renderHook(() => useDiffEvents(1), { wrapper });
    await waitFor(() => expect(result.current.events.length).toBe(2));
    expect(result.current.events[0].event_id).toBe("a");
  });

  it("subscribes to diff-events:<id> on mount and unsubscribes on change", () => {
    mockList.mockResolvedValue([]);
    const { rerender } = renderHook(({ id }: { id: number | null }) => useDiffEvents(id), {
      wrapper,
      initialProps: { id: 1 as number | null },
    });
    expect(mockSubscribe).toHaveBeenCalledWith(["diff-events:1"]);
    rerender({ id: 2 });
    expect(mockUnsubscribe).toHaveBeenCalledWith(["diff-events:1"]);
    expect(mockSubscribe).toHaveBeenCalledWith(["diff-events:2"]);
  });

  it("prepends incoming `new` frames to the cache", async () => {
    mockList.mockResolvedValue([ev("a", "/a")]);
    const { result } = renderHook(() => useDiffEvents(1), { wrapper });
    await waitFor(() => expect(result.current.events.length).toBe(1));
    const listener = mockOnChannel.mock.calls[0][1];
    act(() => {
      listener({
        channel: "diff-events:1",
        event: "new",
        data: ev("z", "/z"),
      });
    });
    await waitFor(() => expect(result.current.events.map((e) => e.event_id)).toEqual(["z", "a"]));
  });

  it("caps the cache at 200 client-side", async () => {
    const initial = Array.from({ length: 200 }, (_, i) =>
      ev(`e${i}`, `/p${i}`, `2026-04-23T07:${String(i % 60).padStart(2, "0")}:00Z`),
    );
    mockList.mockResolvedValue(initial);
    const { result } = renderHook(() => useDiffEvents(1), { wrapper });
    await waitFor(() => expect(result.current.events.length).toBe(200));
    const listener = mockOnChannel.mock.calls[0][1];
    act(() => {
      listener({ channel: "diff-events:1", event: "new", data: ev("z", "/z") });
    });
    await waitFor(() => {
      expect(result.current.events.length).toBe(200);
      expect(result.current.events[0].event_id).toBe("z");
      expect(result.current.events.find((e) => e.event_id === "e199")).toBeUndefined();
    });
  });
});
