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

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    listNamedSessions: mockList,
    createNamedSession: mockCreate,
    renameNamedSession: mockRename,
    deleteNamedSession: mockDelete,
  };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function session(id: string, name = "Main", kind = "shell") {
  return {
    session_id: id,
    container_id: 1,
    name,
    kind,
    created_at: "2026-04-20T00:00:00",
    updated_at: "2026-04-20T00:00:00",
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockRename.mockReset();
  mockDelete.mockReset();
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
