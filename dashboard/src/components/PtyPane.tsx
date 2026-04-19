/** Persistent PTY terminal backed by a hub WebSocket.
 *
 * Unlike the one-shot session pane (XTermOutput + React input), this
 * component hands full keystroke control to xterm.js. `cd` persists,
 * vim works, Ctrl+C reaches the process, bash's history is the real
 * bash history. Each browser tab keeps a stable `session_label` in
 * sessionStorage so reloads re-attach to the same PTY; closing the
 * browser for <5 min and reopening does the same.
 *
 * Frame protocol (matches hub/routers/pty.py):
 *   client→server text: "d<utf8>"   stdin
 *                        "r<c>,<r>"  resize
 *                        "p"         ping
 *                        "k"         kill (explicit close, no grace)
 *   server→client binary           : raw PTY output → term.write
 *   server→client text "s<msg>"    : control (attached, replay:N, closed:*, pong)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Power, Loader2, AlertTriangle } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getAuthToken } from "../lib/auth";
import { scanForAttention } from "../hooks/useAttention";
import { useTerminalPrefs } from "../hooks/useTerminalPrefs";
import { useToasts } from "../hooks/useToasts";
import { subscribePretype } from "../lib/pretypeBus";

type PtyStatus = "connecting" | "connected" | "reattached" | "disconnected" | "closed";

interface Props {
  recordId: number;
  containerName: string;
  // One of "bash" (default) | "sh" | "claude" | bare binary name.
  command?: string;
  // Override to force a new session (otherwise one stable label per
  // (recordId, sessionKind) per browser tab).
  sessionKey: string;
}

const THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(0, 120, 212, 0.35)",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function labelFor(recordId: number, sessionKey: string): string {
  // Stable per-tab label so reloads re-attach. `sessionStorage` scope is
  // per-tab, so opening the same URL in two tabs gives two PTYs (the
  // server enforces single-writer; the second tab displaces the first).
  const storageKey = `hive:pty:label:${recordId}:${sessionKey}`;
  let label = sessionStorage.getItem(storageKey);
  if (!label) {
    label = `${sessionKey}-${crypto.randomUUID().slice(0, 8)}`;
    sessionStorage.setItem(storageKey, label);
  }
  return label;
}

export function PtyPane({ recordId, containerName, command = "bash", sessionKey }: Props) {
  const { toast } = useToasts();
  const [prefs] = useTerminalPrefs();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<PtyStatus>("connecting");
  const [banner, setBanner] = useState<string | null>(null);
  // M21 B — true while xterm.js reports the terminal has focus, drives
  // the editor-border glow via the ``data-term-focused`` attribute a
  // parent sets on its wrapper.
  const [focused, setFocused] = useState(false);

  const label = labelFor(recordId, sessionKey);
  // M15 — the reattach toast is composed from TWO WS control frames
  // arriving back-to-back: ``sreattached:<secs>`` then ``sreplay:<bytes>``.
  // We hold the seconds in a ref until the bytes land so the toast
  // reads "Replayed K KiB after Ns" rather than firing two half-toasts.
  const pendingReattachSecsRef = useRef<number | null>(null);

  // Build the WS URL from current viewport size + label. The bearer
  // token is read at call time (not closed over) so a freshly-pasted
  // token applies to the next reconnect without reloading the page.
  const buildUrl = useCallback(
    (cols: number, rows: number) => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({
        cols: String(cols),
        rows: String(rows),
        cmd: command,
        label,
      });
      const token = getAuthToken();
      if (token) params.set("token", token);
      return `${scheme}://${window.location.host}/ws/pty/${recordId}?${params.toString()}`;
    },
    [recordId, command, label],
  );

  const sendCtrl = useCallback((tag: string, body = "") => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(tag + body);
    }
  }, []);

  // Mount terminal once per (recordId, sessionKey). Parent remounts via
  // `key=` on those values so this runs exactly when it should.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: THEME,
      fontSize: prefs.fontSize,
      fontFamily:
        'ui-monospace, "Cascadia Code", "Fira Code", Consolas, "DejaVu Sans Mono", monospace',
      cursorBlink: true,
      cursorStyle: prefs.cursorStyle,
      scrollback: 10_000,
      convertEol: false, // PTY is already sending \r\n
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer fallback (WSL/headless)
    }
    try {
      fit.fit();
    } catch {
      // ignored — re-fitted on first ResizeObserver tick
    }

    termRef.current = term;
    fitRef.current = fit;

    // M21 G — copy-on-select: write the selection to the clipboard
    // whenever xterm reports a non-empty selection. We subscribe via
    // onSelectionChange and gate on hasSelection() so a click-to-
    // deselect doesn't churn the clipboard. Navigator.clipboard can
    // reject when the page isn't focused; failures are silent.
    const copyOnSelectDisposable = term.onSelectionChange(() => {
      if (!prefs.copyOnSelect) return;
      const text = term.getSelection();
      if (!text) return;
      navigator.clipboard?.writeText(text).catch(() => undefined);
    });

    // M21 B — mirror xterm's focus state into React so the parent can
    // render a focus glow on the editor border.
    const focusDisposable = term.onRender(() => undefined); // placeholder; real focus hooks below
    const focusHandler = () => setFocused(true);
    const blurHandler = () => setFocused(false);
    host.addEventListener("focusin", focusHandler);
    host.addEventListener("focusout", blurHandler);

    // Forward keystrokes → WebSocket. We send stdin as *binary* frames
    // to avoid the "d"-prefix UTF-8 encoding overhead for paste paths.
    const disposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const cols = term.cols;
        const rows = term.rows;
        sendCtrl("r", `${cols},${rows}`);
      });
    });
    ro.observe(host);

    return () => {
      disposable.dispose();
      copyOnSelectDisposable.dispose();
      focusDisposable.dispose();
      host.removeEventListener("focusin", focusHandler);
      host.removeEventListener("focusout", blurHandler);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [recordId, sessionKey, sendCtrl, prefs.fontSize, prefs.cursorStyle, prefs.copyOnSelect]);

  // M23 — palette "run suggestion" dispatches text at us via
  // ``dispatchPretype``. Match on (recordId, sessionKey) and forward
  // to the live WS. The text is NOT auto-submitted — we strip any
  // trailing newline so the user still sees the command in their
  // prompt and presses Enter themselves.
  useEffect(() => {
    return subscribePretype(({ recordId: targetId, sessionKey: targetKey, text }) => {
      if (targetId !== recordId || targetKey !== sessionKey) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const sanitised = text.replace(/\r?\n+$/, "");
      ws.send(new TextEncoder().encode(sanitised));
    });
  }, [recordId, sessionKey]);

  // WebSocket lifecycle. Separate from the terminal effect so we can
  // reconnect without remounting the Terminal — keeps scrollback.
  useEffect(() => {
    let cancelled = false;
    let reconnectAttempts = 0;

    const connect = () => {
      if (cancelled) return;
      const term = termRef.current;
      if (!term) return;

      setStatus("connecting");
      setBanner(null);
      const url = buildUrl(term.cols, term.rows);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts = 0;
        if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("p");
        }, 20_000);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Control frame: "s<msg>". We only treat frames with that
          // prefix as control; anything else is raw text output, which
          // shouldn't occur with our server but is passed through safely.
          if (ev.data.startsWith("s")) {
            const msg = ev.data.slice(1);
            handleControl(msg);
          } else {
            term.write(ev.data);
          }
          return;
        }
        // Binary = PTY stdout. The ArrayBuffer comes straight from
        // docker; xterm.js handles it via Uint8Array.
        const bytes = new Uint8Array(ev.data);
        term.write(bytes);
        // M20: scan decoded output for interactive-prompt markers so
        // the container tab can flash a "needs attention" icon. ANSI
        // sequences confuse the regex, so strip them crudely — a real
        // terminal parser would be overkill for tail-end prompt text.
        try {
          // eslint-disable-next-line no-control-regex -- ANSI CSI sequences
          const ansiRe = /\u001b\[[0-9;?]*[A-Za-z]/g;
          const text = new TextDecoder().decode(bytes).replace(ansiRe, "");
          scanForAttention(recordId, text);
        } catch {
          // ignore decoder failures — they don't hurt anything.
        }
      };

      const handleControl = (msg: string) => {
        if (msg.startsWith("attached")) {
          setStatus("connected");
        } else if (msg.startsWith("reattached:")) {
          const secsStr = msg.slice("reattached:".length);
          const secs = Number(secsStr);
          setStatus("reattached");
          pendingReattachSecsRef.current = Number.isFinite(secs) ? secs : 0;
          // Don't toast yet — the paired ``sreplay:<N>`` frame that
          // follows carries the byte count we want to surface.
        } else if (msg.startsWith("replay:")) {
          const bytesStr = msg.slice("replay:".length);
          const bytes = Number(bytesStr);
          if (pendingReattachSecsRef.current !== null && Number.isFinite(bytes) && bytes > 0) {
            const secs = pendingReattachSecsRef.current;
            const kib = Math.max(1, Math.round(bytes / 1024));
            const when = secs > 0 ? `after ${secs}s` : "";
            toast(
              "info",
              "Reattached to PTY",
              `${containerName}: replayed ${kib} KiB${when ? " " + when : ""}.`,
              4000,
            );
          }
          pendingReattachSecsRef.current = null;
        } else if (msg.startsWith("closed:")) {
          setStatus("closed");
          setBanner(`Session closed: ${msg.slice("closed:".length)}`);
        } else if (msg === "pong") {
          // Heartbeat ack; nothing to do.
        }
      };

      ws.onclose = () => {
        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (cancelled) return;
        setStatus("disconnected");
        setBanner("Disconnected — reconnecting…");
        // Exponential backoff capped at 10s. Most disconnects are
        // transient (browser tab suspend) and reconnect is instant.
        const delay = Math.min(10_000, 500 * Math.pow(2, reconnectAttempts));
        reconnectAttempts += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles recovery; avoid double-toasting.
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close(1000, "component unmount");
        } catch {
          // ignore
        }
      }
      wsRef.current = null;
    };
  }, [buildUrl]);

  const kill = useCallback(() => {
    if (!window.confirm(`Kill the ${command} session on ${containerName}?`)) return;
    sendCtrl("k");
    // Also wipe the sessionStorage label so the next mount gets a fresh PTY.
    sessionStorage.removeItem(`hive:pty:label:${recordId}:${sessionKey}`);
  }, [command, containerName, recordId, sessionKey, sendCtrl]);

  const reconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close(4000, "manual reconnect");
      } catch {
        // ignore
      }
    }
  }, []);

  return (
    <div
      data-term-focused={focused || undefined}
      className="flex h-full w-full min-w-0 flex-col rounded-sm ring-0 ring-[#0078d4] transition-[box-shadow] data-[term-focused]:shadow-[inset_0_0_0_1px_rgba(0,120,212,0.55)]"
    >
      {/* Status strip */}
      <div className="flex items-center justify-between gap-2 border-b border-gray-800 px-2 py-1 text-[10px]">
        <StatusPill status={status} command={command} />
        {banner && (
          <span className="mx-2 flex-1 truncate text-yellow-300" role="status">
            {banner}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={reconnect}
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            aria-label="Reconnect"
            title="Reconnect (keeps server-side PTY)"
          >
            <RotateCcw size={11} />
          </button>
          <button
            type="button"
            onClick={kill}
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-800 hover:text-red-400"
            aria-label="Kill session"
            title="Kill session (end server-side PTY)"
          >
            <Power size={11} />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}

function StatusPill({ status, command }: { status: PtyStatus; command: string }) {
  const label = {
    connecting: "connecting",
    connected: "live",
    reattached: "live (reattached)",
    disconnected: "reconnecting",
    closed: "closed",
  }[status];
  const color = {
    connecting: "text-gray-500",
    connected: "text-green-400",
    reattached: "text-green-400",
    disconnected: "text-yellow-400",
    closed: "text-red-400",
  }[status];
  const icon =
    status === "connecting" || status === "disconnected" ? (
      <Loader2 size={10} className="animate-spin" />
    ) : status === "closed" ? (
      <AlertTriangle size={10} />
    ) : (
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
    );
  return (
    <span className={`flex items-center gap-1.5 ${color}`}>
      {icon}
      <span>{label}</span>
      <span className="text-gray-600">· {command}</span>
    </span>
  );
}
