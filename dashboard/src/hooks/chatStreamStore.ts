/** Module-level chat turn store (M37 follow-up).
 *
 * useReducer state lives in the React component instance. The previous
 * fix used key={sessionId} to isolate per-session history but that
 * unmounted the component on tab switch and destroyed the state.
 * This store lifts turns out of React entirely — they survive
 * mount/unmount cycles and live as long as the page is loaded.
 *
 * Per-session: turns array + subscriber set. The hook subscribes
 * to the entry for its sessionId via useSyncExternalStore. WS
 * events from useChatStream's effect call dispatchEvent which
 * updates the entry and notifies subscribers.
 */
import type { ChatCliEvent, ChatTurn } from "../components/chat/types";
import { applyEvent } from "./chatStreamReducer";

const EMPTY: ChatTurn[] = [];
const turnsBySession = new Map<string, ChatTurn[]>();
const subscribersBySession = new Map<string, Set<() => void>>();

export function getTurns(sessionId: string): ChatTurn[] {
  return turnsBySession.get(sessionId) ?? EMPTY;
}

export function dispatchEvent(sessionId: string, event: ChatCliEvent): void {
  const prev = getTurns(sessionId);
  const next = applyEvent(prev, event);
  if (next === prev) return; // no-op (e.g., observational events)
  turnsBySession.set(sessionId, next);
  notify(sessionId);
}

export function clearTurns(sessionId: string): void {
  if (!turnsBySession.has(sessionId)) return;
  turnsBySession.delete(sessionId);
  notify(sessionId);
}

export function subscribeTurns(sessionId: string, cb: () => void): () => void {
  let set = subscribersBySession.get(sessionId);
  if (!set) {
    set = new Set();
    subscribersBySession.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribersBySession.delete(sessionId);
  };
}

function notify(sessionId: string): void {
  const set = subscribersBySession.get(sessionId);
  if (!set) return;
  for (const cb of set) cb();
}

/** Test-only: drop all in-memory state. */
export function __resetForTests(): void {
  turnsBySession.clear();
  subscribersBySession.clear();
}
