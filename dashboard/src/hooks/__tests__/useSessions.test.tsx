/** useSessions tests (M26).
 *
 * Mocks the four API wrappers so the hook's cache behaviour +
 * optimistic mutations are exercised without network.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessions } from "../useSessions";

const mockList = vi.hoisted(() => vi.fn<(id: number) => Promise<unknown>>());
const mockCreate = vi.hoisted(() => vi.fn<(id: number, body: unknown) => Promise<unknown>>());
const mockRename = vi.hoisted(() => vi.fn<(sid: string, name: string) => Promise<unknown>>());
const mockDelete = vi.hoisted(() => vi.fn<(sid: string) => Promise<void>>());
const mockReorder = vi.hoisted(() => vi.fn<(sid: string, position: number) => Promise<unknown>>());

const mockSubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
const mockUnsubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
type WsFrame = { channel: string; event: string; data: unknown };
type WsListener = (frame: WsFrame) => void;
const mockOnChannel = vi.hoisted(() =>
  vi.fn<(channel: string, cb: WsListener) => () => void>(),
);
const mockListenerRemovers = vi.hoisted(() => [] as Array<() => void>);

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    connected: true,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    onChannel: mockOnChannel,
  }),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    listNamedSessions: mockList,
    createNamedSession: mockCreate,
    renameNamedSession: mockRename,
    deleteNamedSession: mockDelete,
    reorderNamedSession: mockReorder,
  };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function session(id: string, name = "Main", kind: "shell" | "claude" = "shell", position = 0) {
  return {
    session_id: id,
    container_id: 1,
    name,
    kind,
    position,
    created_at: "2026-04-20T00:00:00",
    updated_at: "2026-04-20T00:00:00",
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockRename.mockReset();
  mockDelete.mockReset();
  mockReorder.mockReset();
  mockSubscribe.mockReset();
  mockUnsubscribe.mockReset();
  mockListenerRemovers.length = 0;
  mockOnChannel.mockReset();
  mockOnChannel.mockImplementation(() => {
    const remover = vi.fn();
    mockListenerRemovers.push(remover);
    return remover;
  });
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

describe("useSessions", () => {
  it("returns empty while containerId is null", () => {
    const { result } = renderHook(() => useSessions(null), { wrapper });
    expect(result.current.sessions).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("fetches sessions when containerId is set", async () => {
    mockList.mockResolvedValue([session("a"), session("b", "Claude", "claude")]);
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(2));
    expect(result.current.sessions[0].session_id).toBe("a");
    expect(result.current.sessions[1].kind).toBe("claude");
  });

  it("create appends optimistically and replaces with server row on success", async () => {
    mockList.mockResolvedValue([session("a")]);
    let resolveCreate!: (v: unknown) => void;
    mockCreate.mockImplementation(
      () =>
        new Promise((res) => {
          resolveCreate = res;
        }),
    );
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));

    let newId = "";
    await act(async () => {
      const p = result.current.create({ name: "pending", kind: "shell" });
      // Optimistic row should be visible before resolve.
      await waitFor(() => expect(result.current.sessions.length).toBe(2));
      resolveCreate(session("server-id", "pending", "shell"));
      const resolved = await p;
      newId = resolved.session_id;
    });

    await waitFor(() => {
      const last = result.current.sessions[result.current.sessions.length - 1];
      expect(last.session_id).toBe("server-id");
    });
    expect(newId).toBe("server-id");
  });

  it("rename patches the cached row", async () => {
    mockList.mockResolvedValue([session("a", "orig")]);
    mockRename.mockResolvedValue(session("a", "new"));
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    await act(async () => {
      await result.current.rename("a", "new");
    });
    await waitFor(() => expect(result.current.sessions[0].name).toBe("new"));
  });

  it("close removes the row from cache", async () => {
    mockList.mockResolvedValue([session("a"), session("b")]);
    mockDelete.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(2));
    await act(async () => {
      await result.current.close("a");
    });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    expect(result.current.sessions[0].session_id).toBe("b");
  });
});

// --- M28: reorder ---

describe("useSessions.reorder", () => {
  it("reorders cache optimistically and renumbers 1..N", async () => {
    mockList.mockResolvedValue([
      session("a", "a", "shell", 1),
      session("b", "b", "shell", 2),
      session("c", "c", "shell", 3),
    ]);
    mockReorder.mockResolvedValue(session("c", "c", "shell", 1));
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(3));
    await act(async () => {
      await result.current.reorder("c", 1);
    });
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.session_id)).toEqual(["c", "a", "b"]),
    );
    expect(result.current.sessions.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it("clamps out-of-range targets", async () => {
    mockList.mockResolvedValue([session("a", "a", "shell", 1), session("b", "b", "shell", 2)]);
    mockReorder.mockResolvedValue(session("a", "a", "shell", 2));
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(2));
    await act(async () => {
      await result.current.reorder("a", 999);
    });
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.session_id)).toEqual(["b", "a"]),
    );
  });

  it("rolls back on server error", async () => {
    mockList.mockResolvedValue([
      session("a", "a", "shell", 1),
      session("b", "b", "shell", 2),
      session("c", "c", "shell", 3),
    ]);
    mockReorder.mockRejectedValue(new Error("500"));
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(3));
    await act(async () => {
      try {
        await result.current.reorder("c", 1);
      } catch {
        // expected
      }
    });
    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.session_id)).toEqual(["a", "b", "c"]),
    );
  });
});

// --- M30: WebSocket session-sync push ---

describe("useSessions.ws", () => {
  it("subscribes on mount with non-null containerId", () => {
    mockList.mockResolvedValue([]);
    renderHook(() => useSessions(1), { wrapper });
    expect(mockSubscribe).toHaveBeenCalledWith(["sessions:1"]);
    expect(mockOnChannel).toHaveBeenCalledTimes(1);
    expect(mockOnChannel.mock.calls[0][0]).toBe("sessions:1");
    expect(typeof mockOnChannel.mock.calls[0][1]).toBe("function");
  });

  it("does not subscribe when containerId is null", () => {
    renderHook(() => useSessions(null), { wrapper });
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockOnChannel).not.toHaveBeenCalled();
  });

  it("list frame replaces the cache wholesale", async () => {
    mockList.mockResolvedValue([session("a")]);
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));

    const listener = mockOnChannel.mock.calls[0][1];
    act(() => {
      listener({
        channel: "sessions:1",
        event: "list",
        data: [session("z", "z")],
      });
    });

    await waitFor(() =>
      expect(result.current.sessions.map((s) => s.session_id)).toEqual(["z"]),
    );
  });

  it("unsubscribes + removes listener on containerId change", () => {
    mockList.mockResolvedValue([]);
    const { rerender } = renderHook(({ id }) => useSessions(id), {
      wrapper,
      initialProps: { id: 1 as number | null },
    });
    expect(mockSubscribe).toHaveBeenCalledWith(["sessions:1"]);
    const firstRemover = mockListenerRemovers[0];

    rerender({ id: 2 });

    expect(mockUnsubscribe).toHaveBeenCalledWith(["sessions:1"]);
    expect(firstRemover).toHaveBeenCalled();
    // New subscription on the new container.
    expect(mockSubscribe).toHaveBeenCalledWith(["sessions:2"]);
  });
});
