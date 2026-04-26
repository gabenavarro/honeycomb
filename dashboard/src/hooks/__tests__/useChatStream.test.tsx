/** useChatStream hook tests (M33). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStream } from "../useChatStream";
import type { ChatCliEvent, StreamEvent } from "../../components/chat/types";

// In-memory mock of useHiveWebSocket.
type Listener = (frame: { channel: string; event: string; data: ChatCliEvent }) => void;
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

function emit(channel: string, event: ChatCliEvent): void {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of set) cb({ channel, event: event.type, data: event });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  listeners.clear();
  subscribed.clear();
});
afterEach(() => {
  listeners.clear();
});

describe("useChatStream", () => {
  it("subscribes to chat:<id> on mount, unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useChatStream("ns-abc"), { wrapper });
    expect(subscribed.has("chat:ns-abc")).toBe(true);
    unmount();
    expect(subscribed.has("chat:ns-abc")).toBe(false);
  });

  it("does not subscribe when sessionId is null", () => {
    renderHook(() => useChatStream(null), { wrapper });
    expect(subscribed.size).toBe(0);
  });

  it("appends a user turn when a 'user' event arrives", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "user",
        message: {
          id: "msg-u1",
          type: "message",
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        session_id: "claude-s",
        uuid: "u-1",
      });
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].role).toBe("user");
    expect(result.current.turns[0].text).toBe("hi");
  });

  it("starts an assistant turn on message_start", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      const ev: StreamEvent = {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg-1", type: "message", role: "assistant", content: [] },
        },
        session_id: "claude-s",
        uuid: "u-2",
      };
      emit("chat:ns-1", ev);
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].id).toBe("msg-1");
    expect(result.current.turns[0].role).toBe("assistant");
    expect(result.current.turns[0].streaming).toBe(true);
  });

  it("appends text deltas onto the active text block", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        session_id: "s",
        uuid: "u-2",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        session_id: "s",
        uuid: "u-3",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world." },
        },
        session_id: "s",
        uuid: "u-4",
      });
    });
    const turn = result.current.turns[0];
    expect(turn.blocks).toHaveLength(1);
    expect(turn.blocks[0]).toEqual({ kind: "text", text: "Hello world." });
  });

  it("marks turn complete on message_stop", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: { type: "message_stop" },
        session_id: "s",
        uuid: "u-2",
      });
    });
    expect(result.current.turns[0].streaming).toBe(false);
  });

  it("stores tool_use blocks and accumulates partial_json deltas", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
        },
        session_id: "s",
        uuid: "u-2",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls' },
        },
        session_id: "s",
        uuid: "u-3",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: ' /tmp"}' },
        },
        session_id: "s",
        uuid: "u-4",
      });
      emit("chat:ns-1", {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        session_id: "s",
        uuid: "u-5",
      });
    });
    const block = result.current.turns[0].blocks[0];
    expect(block.kind).toBe("tool_use");
    if (block.kind !== "tool_use") throw new Error();
    expect(block.tool).toBe("Bash");
    expect(block.id).toBe("tu-1");
    expect(block.partialJson).toBe('{"command":"ls /tmp"}');
    expect(block.complete).toBe(true);
  });

  it("captures result event metadata onto the last assistant turn", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [] },
        },
        session_id: "s",
        uuid: "u-1",
      });
      emit("chat:ns-1", {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s",
        uuid: "u-2",
        duration_ms: 1500,
        total_cost_usd: 0.001,
        stop_reason: "end_turn",
      });
    });
    expect(result.current.turns[0].result).toEqual({
      duration_ms: 1500,
      total_cost_usd: 0.001,
      stop_reason: "end_turn",
    });
  });

  it("clearTurns resets the cache", () => {
    const { result } = renderHook(() => useChatStream("ns-1"), { wrapper });
    act(() => {
      emit("chat:ns-1", {
        type: "user",
        message: {
          id: "m",
          type: "message",
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        session_id: "s",
        uuid: "u",
      });
    });
    expect(result.current.turns).toHaveLength(1);
    act(() => {
      result.current.clearTurns();
    });
    expect(result.current.turns).toHaveLength(0);
  });
});
