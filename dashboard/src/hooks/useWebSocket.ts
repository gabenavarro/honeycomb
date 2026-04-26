/** Singleton WebSocket client for the multiplexed hub stream.
 *
 * Every hook consumer shares one underlying socket — calling
 * `useHiveWebSocket()` from N components opens 1 socket, not N.
 *
 * The socket auto-reconnects with exponential backoff. On reconnect we
 * re-send the union of every live subscription so downstream `onChannel`
 * callers don't have to re-subscribe manually.
 *
 * Vite's dev proxy is sensitive to abandoned sockets (EPIPE stack
 * traces in the terminal). The singleton avoids the pile-up that caused
 * those, and closes cleanly when the page unloads.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getAuthToken, onAuthTokenChange } from "../lib/auth";
import type { WSFrame } from "../lib/types";

const WS_BASE = `ws://${window.location.host}/ws`;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/** Build the multiplex-WS URL including the current bearer token.
 *
 * The hub's WebSocket handshake requires the token as a query param
 * because browsers cannot attach custom headers to WebSocket upgrades.
 */
function buildWsUrl(): string {
  const token = getAuthToken();
  if (!token) return WS_BASE;
  const sep = WS_BASE.includes("?") ? "&" : "?";
  return `${WS_BASE}${sep}token=${encodeURIComponent(token)}`;
}

type Listener = (frame: WSFrame) => void;

/** Event fired when a subscribed listener throws during dispatch. A
 * companion component ``WebSocketListenerErrorWatcher`` subscribes to
 * this and surfaces a warning toast — decoupling the singleton from
 * the React toast context keeps the socket initialisable outside of
 * React (SSR, tests, etc.). */
const LISTENER_ERROR_EVENT = "hive:ws:listenerError";

function safeInvoke(cb: Listener, frame: WSFrame): void {
  try {
    cb(frame);
  } catch (err) {
    console.warn("[hive-ws] listener threw while handling frame", { channel: frame.channel, err });
    try {
      window.dispatchEvent(
        new CustomEvent(LISTENER_ERROR_EVENT, { detail: { channel: frame.channel, error: err } }),
      );
    } catch {
      // ignore — dispatch failure should never cascade into the socket.
    }
  }
}

export function onWebSocketListenerError(
  cb: (detail: { channel: string; error: unknown }) => void,
): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<{ channel: string; error: unknown }>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(LISTENER_ERROR_EVENT, handler);
  return () => window.removeEventListener(LISTENER_ERROR_EVENT, handler);
}

class HiveSocket {
  private ws: WebSocket | null = null;
  private connected = false;
  // Channel → set of listener callbacks.
  private listeners = new Map<string, Set<Listener>>();
  // Ref-count subscriptions so `subscribe(["x"])` from N components
  // collapses to one upstream SUBSCRIBE until all N unsubscribe.
  private subCounts = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectedSubscribers = new Set<() => void>();
  private disposed = false;

  constructor() {
    // Close cleanly when the page goes away so Vite's proxy doesn't see
    // a half-open client on reload.
    window.addEventListener("beforeunload", () => this.dispose());
    // When the user pastes a new token (or the current one is cleared
    // by a 401), drop the existing socket and reconnect so the next
    // handshake uses the fresh credentials.
    onAuthTokenChange(() => this.bounce());
    this.connect();
  }

  /** Close the current socket and reconnect immediately. */
  private bounce(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore — close() failures are non-fatal, the socket will be
        // replaced by the reconnect below regardless.
      }
      this.ws = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  // ─── React integration ────────────────────────────────────────────

  subscribeConnected(cb: () => void): () => void {
    this.connectedSubscribers.add(cb);
    return () => {
      this.connectedSubscribers.delete(cb);
    };
  }

  getConnected = (): boolean => this.connected;

  // ─── Connection lifecycle ─────────────────────────────────────────

  private connect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl());
    } catch (err) {
      // Construction throws on malformed URLs or blocked protocols.
      // Schedule a retry instead of crashing the app.
      console.warn("[hive-ws] construct failed:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setConnected(true);
      // Replay all live subscriptions — dashboards that subscribed
      // before reconnect should keep receiving frames without manual
      // re-subscription.
      const channels = Array.from(this.subCounts.keys()).filter(
        (ch) => (this.subCounts.get(ch) ?? 0) > 0,
      );
      if (channels.length > 0) {
        this.sendRaw({ action: "subscribe", channels });
      }
    };

    ws.onmessage = (event) => {
      let frame: WSFrame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatch(frame);
    };

    ws.onerror = (event) => {
      // Browsers don't give us much detail in the Event; log once and
      // let onclose drive reconnect.
      void event;
    };

    ws.onclose = () => {
      this.setConnected(false);
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, "page unload");
      } catch {
        // ignore
      }
    }
    this.ws = null;
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) return;
    this.connected = next;
    // Notify all React subscribers so useSyncExternalStore re-renders.
    for (const cb of this.connectedSubscribers) cb();
  }

  private dispatch(frame: WSFrame): void {
    const channelListeners = this.listeners.get(frame.channel);
    if (channelListeners) {
      for (const cb of channelListeners) safeInvoke(cb, frame);
    }
    const wildcards = this.listeners.get("*");
    if (wildcards) {
      for (const cb of wildcards) safeInvoke(cb, frame);
    }
  }

  private sendRaw(msg: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // If the send fails the socket is probably mid-close; ignore.
    }
  }

  // ─── Subscription API (ref-counted) ───────────────────────────────

  subscribe(channels: string[]): void {
    const newly: string[] = [];
    for (const ch of channels) {
      const prev = this.subCounts.get(ch) ?? 0;
      this.subCounts.set(ch, prev + 1);
      if (prev === 0) newly.push(ch);
    }
    if (newly.length > 0) {
      this.sendRaw({ action: "subscribe", channels: newly });
    }
  }

  unsubscribe(channels: string[]): void {
    const gone: string[] = [];
    for (const ch of channels) {
      const prev = this.subCounts.get(ch) ?? 0;
      if (prev <= 1) {
        this.subCounts.delete(ch);
        gone.push(ch);
      } else {
        this.subCounts.set(ch, prev - 1);
      }
    }
    if (gone.length > 0) {
      this.sendRaw({ action: "unsubscribe", channels: gone });
    }
  }

  addListener(channel: string, cb: Listener): () => void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(cb);
    return () => {
      this.listeners.get(channel)?.delete(cb);
    };
  }

  /** Test-only: dispatch a frame as if it came from the server.
   *
   * Lets Playwright + integration tests inject WS frames directly into
   * the singleton's listener map without going through the actual
   * WebSocket connection. Production code never invokes this — the
   * `window.__pumpWsFrame` shim that wraps it lives in main.tsx behind
   * an env check.
   */
  __testDispatch(frame: WSFrame): void {
    this.dispatch(frame);
  }
}

// Lazy-init so SSR / tests don't construct a socket just by importing.
let instance: HiveSocket | null = null;
function getInstance(): HiveSocket {
  if (!instance) instance = new HiveSocket();
  return instance;
}

/** Test-only frame pump.
 *
 * Module-level shim around the singleton's ``__testDispatch``. The
 * ``window.__pumpWsFrame`` global wired in ``main.tsx`` (gated on
 * ``import.meta.env.DEV`` or ``window.__playwright_test``) calls
 * through here so Playwright specs can synthesize stream-json events
 * without spinning up a real WebSocket. Never invoke from production
 * code paths.
 */
export function __test_dispatch(frame: WSFrame): void {
  getInstance().__testDispatch(frame);
}

/** React hook — thin wrapper over the singleton. */
export function useHiveWebSocket() {
  const sock = getInstance();

  const connected = useSyncExternalStore(
    useCallback((cb) => sock.subscribeConnected(cb), [sock]),
    sock.getConnected,
    // SSR fallback — we're client-only, so just report disconnected.
    () => false,
  );

  const subscribe = useCallback((channels: string[]) => sock.subscribe(channels), [sock]);
  const unsubscribe = useCallback((channels: string[]) => sock.unsubscribe(channels), [sock]);
  const onChannel = useCallback(
    (channel: string, cb: Listener) => sock.addListener(channel, cb),
    [sock],
  );

  // Keep sockets alive across StrictMode double-mounts; no cleanup here.
  useEffect(() => undefined, []);

  return { connected, subscribe, unsubscribe, onChannel };
}
