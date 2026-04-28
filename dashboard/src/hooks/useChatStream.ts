/** useChatStream — subscribe to chat:<session_id> and read per-session
 * turn state from the module-level store (M37 follow-up).
 *
 * State no longer lives in the component instance — it lives in
 * chatStreamStore. The hook is a thin useSyncExternalStore reader
 * that ALSO sets up the WS subscription for the active sessionId
 * via useEffect. Switching tabs unmounts/remounts the consumer but
 * the store retains every per-session turn array.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { ChatCliEvent, ChatTurn } from "../components/chat/types";
import {
  clearTurns as storeClearTurns,
  dispatchEvent as storeDispatchEvent,
  getTurns,
  subscribeTurns,
} from "./chatStreamStore";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseChatStreamResult {
  turns: ChatTurn[];
  clearTurns: () => void;
}

const EMPTY_TURNS: ChatTurn[] = [];

export function useChatStream(sessionId: string | null): UseChatStreamResult {
  const { subscribe, unsubscribe, onChannel } = useHiveWebSocket();

  // useSyncExternalStore against the store entry for this sessionId.
  const subscribe_ = useCallback(
    (cb: () => void) => {
      if (sessionId === null) return () => undefined;
      return subscribeTurns(sessionId, cb);
    },
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId === null ? EMPTY_TURNS : getTurns(sessionId)),
    [sessionId],
  );
  const turns = useSyncExternalStore(subscribe_, getSnapshot, () => EMPTY_TURNS);

  // WS subscription: same lifecycle as before, dispatch into the store.
  useEffect(() => {
    if (sessionId === null) return;
    const channel = `chat:${sessionId}`;
    subscribe([channel]);
    const remove = onChannel(channel, (frame) => {
      storeDispatchEvent(sessionId, frame.data as ChatCliEvent);
    });
    return () => {
      remove();
      unsubscribe([channel]);
    };
  }, [sessionId, subscribe, unsubscribe, onChannel]);

  const clearTurnsCb = useCallback(() => {
    if (sessionId !== null) storeClearTurns(sessionId);
  }, [sessionId]);

  return { turns, clearTurns: clearTurnsCb };
}
