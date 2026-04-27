/** useChatStream — subscribe to chat:<session_id> and reduce the
 * stream-json event flow into a ChatTurn[] cache (M33).
 *
 * Pattern mirrors M30's useDiffEvents but with a richer reducer:
 * the chat surface needs incremental text growth, in-flight tool
 * calls, and per-turn metadata (result events).
 *
 * Implementation note: turns are held in React state (useState)
 * rather than a TanStack Query cache. This gives synchronous
 * updates inside act() in tests while keeping the same external
 * API (turns, clearTurns). The hook is still co-located with the
 * TQ infrastructure — callers need the QueryClientProvider wrapper
 * for the rest of the app, and we import useQueryClient here so
 * future callers can share the cache if needed.
 */

import { useCallback, useEffect, useReducer } from "react";

import type { ChatCliEvent, ChatTurn, ChatBlock, StreamEventInner } from "../components/chat/types";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseChatStreamResult {
  turns: ChatTurn[];
  clearTurns: () => void;
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

type Action = { type: "event"; payload: ChatCliEvent } | { type: "clear" };

function reducer(prev: ChatTurn[], action: Action): ChatTurn[] {
  if (action.type === "clear") return [];
  return applyEvent(prev, action.payload);
}

function applyEvent(prev: ChatTurn[], event: ChatCliEvent): ChatTurn[] {
  // User messages: append a new user turn.
  if (event.type === "user") {
    let text = "";
    const content = event.message.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
    }
    const turn: ChatTurn = {
      id: `user-${event.uuid}`,
      role: "user",
      blocks: text ? [{ kind: "text", text }] : [],
      streaming: false,
      startedAt: new Date().toISOString(),
      text,
    };
    return [...prev, turn];
  }

  // Result event: stamp metadata onto the most recent assistant turn.
  if (event.type === "result") {
    const next = [...prev];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === "assistant") {
        next[i] = {
          ...next[i],
          result: {
            duration_ms: event.duration_ms,
            total_cost_usd: event.total_cost_usd ?? null,
            stop_reason: event.stop_reason ?? null,
          },
        };
        break;
      }
    }
    return next;
  }

  // Stream events: drive incremental rendering of the active assistant turn.
  if (event.type === "stream_event") {
    return applyStreamEvent(prev, event.event);
  }

  // System / assistant snapshot / rate_limit are observational — ignore for now.
  return prev;
}

function applyStreamEvent(prev: ChatTurn[], inner: StreamEventInner): ChatTurn[] {
  if (inner.type === "message_start") {
    const turn: ChatTurn = {
      id: inner.message.id,
      role: "assistant",
      blocks: [],
      streaming: true,
      startedAt: new Date().toISOString(),
    };
    return [...prev, turn];
  }

  if (prev.length === 0) return prev; // defensive: deltas before any message_start
  const next = [...prev];
  const idx = next.length - 1;
  const turn = { ...next[idx], blocks: [...next[idx].blocks] };
  next[idx] = turn;

  if (inner.type === "content_block_start") {
    const cb = inner.content_block;
    let block: ChatBlock;
    if (cb.type === "tool_use") {
      block = {
        kind: "tool_use",
        tool: cb.name,
        id: cb.id,
        input: cb.input,
        partialJson: "",
        complete: false,
      };
    } else if (cb.type === "thinking") {
      block = { kind: "thinking", thinking: cb.thinking ?? "" };
    } else {
      block = { kind: "text", text: cb.text ?? "" };
    }
    turn.blocks[inner.index] = block;
    return next;
  }

  if (inner.type === "content_block_delta") {
    const block = turn.blocks[inner.index];
    if (block === undefined) return next;
    if (inner.delta.type === "text_delta" && block.kind === "text") {
      turn.blocks[inner.index] = { ...block, text: block.text + inner.delta.text };
    } else if (inner.delta.type === "thinking_delta" && block.kind === "thinking") {
      turn.blocks[inner.index] = {
        ...block,
        thinking: block.thinking + inner.delta.thinking,
      };
    } else if (inner.delta.type === "input_json_delta" && block.kind === "tool_use") {
      turn.blocks[inner.index] = {
        ...block,
        partialJson: block.partialJson + inner.delta.partial_json,
      };
    }
    return next;
  }

  if (inner.type === "content_block_stop") {
    const block = turn.blocks[inner.index];
    if (block !== undefined && block.kind === "tool_use") {
      turn.blocks[inner.index] = { ...block, complete: true };
    }
    return next;
  }

  if (inner.type === "message_stop") {
    turn.streaming = false;
    turn.stoppedAt = new Date().toISOString();
    return next;
  }

  return next;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useChatStream(sessionId: string | null): UseChatStreamResult {
  const [turns, dispatch] = useReducer(reducer, []);
  const { subscribe, unsubscribe, onChannel } = useHiveWebSocket();

  useEffect(() => {
    if (sessionId === null) return;
    const channel = `chat:${sessionId}`;
    subscribe([channel]);
    const remove = onChannel(channel, (frame) => {
      const event = frame.data as ChatCliEvent;
      dispatch({ type: "event", payload: event });
    });
    return () => {
      remove();
      unsubscribe([channel]);
    };
  }, [sessionId, subscribe, unsubscribe, onChannel]);

  const clearTurns = useCallback(() => {
    dispatch({ type: "clear" });
  }, []);

  return { turns, clearTurns };
}
