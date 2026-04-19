/** Pretype bus — inject text into the active PTY without coupling
 * ``CommandPalette`` to ``PtyPane`` (M23).
 *
 * Palette dispatches a ``CustomEvent`` on ``window``. ``PtyPane``'s
 * mount effect subscribes and filters by ``(recordId, sessionKey)``.
 * The subscriber is responsible for matching its own identity — the
 * palette has no knowledge of which PTYs are mounted.
 *
 * Design note: a module-level singleton (plain EventEmitter) would
 * work too, but ``CustomEvent`` gives us cross-tree delivery in one
 * line and free compatibility with DevTools' event listeners view.
 */

export interface PretypeDetail {
  recordId: number;
  sessionKey: string;
  text: string;
}

const EVENT_NAME = "hive:pretype";

export function dispatchPretype(detail: PretypeDetail): void {
  window.dispatchEvent(new CustomEvent<PretypeDetail>(EVENT_NAME, { detail }));
}

export function subscribePretype(listener: (detail: PretypeDetail) => void): () => void {
  const handler = (e: Event) => {
    const ev = e as CustomEvent<PretypeDetail>;
    if (ev.detail) listener(ev.detail);
  };
  window.addEventListener(EVENT_NAME, handler as EventListener);
  return () => window.removeEventListener(EVENT_NAME, handler as EventListener);
}
