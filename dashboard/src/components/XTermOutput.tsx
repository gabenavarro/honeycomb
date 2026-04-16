/** xterm.js-backed output pane.
 *
 * Replaces the DOM-list renderer we had in TerminalPane. Benefits:
 *   - Real ANSI: `ls --color`, tqdm, pytest, htop — all render.
 *   - GPU-accelerated (WebGL addon, ~9× faster than DOM at scale).
 *   - Native scrollback, line selection, link highlighting.
 *
 * Design:
 *   - Terminal instance is owned by this component; disposed on unmount.
 *   - On mount, we *replay* the full cached `lines[]` (from the session
 *     store) so reloads show everything.
 *   - On subsequent prop changes we write only the tail — new lines
 *     since the last render — so we don't flicker by re-clearing.
 *   - When `streaming=true`, a spinner animates on the bottom row
 *     (rewriting via `\r\x1b[2K`). Cleared on streaming flip or exit.
 *
 * We use xterm.js *directly*, not a wrapper package. The research turned
 * up three React wrappers, all of which are ~30-line useEffect shims —
 * not worth the dep weight when we're going to own the mount logic
 * anyway (session-store integration, replay, spinner coordination).
 */

import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import spinners from "cli-spinners";
import "@xterm/xterm/css/xterm.css";

import type { SessionKind, SessionLine } from "../hooks/useSessionStore";
import { CRLF, encodeLines, eraseLineAndReturn, yellow, gray } from "../lib/ansi";

interface Props {
  lines: SessionLine[];
  kind: SessionKind;
  streaming: boolean;
  // Short human label shown next to the spinner ("Running command…",
  // "Installing Claude CLI…", etc.). Defaults to a generic message.
  waitingLabel?: string;
  // Applied on mount; the caller rarely needs to change this at runtime.
  fontSize?: number;
}

// VSCode dark+ palette — keeps the terminal visually coherent with the
// rest of the dashboard's VSCode-inspired theme.
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

const SCROLLBACK = 10_000;

export function XTermOutput({
  lines,
  kind,
  streaming,
  waitingLabel,
  fontSize = 12,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Count of lines already written to the terminal — lets us diff
  // against the incoming `lines` prop and write only the tail.
  const writtenCountRef = useRef(0);
  // Interval id for the spinner animation; null when idle.
  const spinnerTimerRef = useRef<number | null>(null);
  // Whether the cursor is currently parked on the spinner row. We track
  // this so the first real output line can erase the spinner first.
  const spinnerActiveRef = useRef(false);

  // Mount once per container/kind pair. Parent component remounts us
  // via `key={containerId}` on container switch, so we don't need to
  // handle the "replace terminal in place" case.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: THEME,
      fontSize,
      fontFamily:
        'ui-monospace, "Cascadia Code", "Fira Code", Consolas, "DejaVu Sans Mono", monospace',
      cursorBlink: false,
      // Output-only pane: cursor stays hidden, keyboard input goes to
      // the React input below. xterm.js still needs an internal cursor
      // position for the spinner's \r + \x1b[2K tricks.
      cursorStyle: "bar",
      disableStdin: true,
      scrollback: SCROLLBACK,
      convertEol: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    term.open(host);

    // WebGL is ~9× faster than the DOM fallback but some WSL/container
    // browsers can't initialize WebGL2. Probe, then fall back silently.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      // Keep DOM renderer. Log once so the user can diagnose if needed.
      console.info("[hive-xterm] WebGL unavailable, using DOM renderer:", err);
    }

    try {
      fit.fit();
    } catch {
      // fit() can throw if the host is zero-sized during the first
      // paint; the ResizeObserver below retries.
    }

    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      // Debounce-ish: use rAF so multiple synchronous size changes from
      // sidebar-toggle animations collapse to one fit() call.
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // ignore
        }
      });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      if (spinnerTimerRef.current !== null) {
        window.clearInterval(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenCountRef.current = 0;
      spinnerActiveRef.current = false;
    };
  }, [fontSize]);

  // Replay + tail-append. This is the hot path — runs on every
  // appendLines in the session store.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // If the lines array shrank (clear transcript), wipe and replay.
    if (lines.length < writtenCountRef.current) {
      term.clear();
      writtenCountRef.current = 0;
      spinnerActiveRef.current = false;
    }

    if (lines.length === writtenCountRef.current) return;

    // If the spinner is parked on the current line, erase it first so
    // the new output doesn't stack on top of the spinner frame.
    if (spinnerActiveRef.current) {
      term.write(eraseLineAndReturn());
      spinnerActiveRef.current = false;
    }

    const tail = lines.slice(writtenCountRef.current);
    term.write(encodeLines(tail, kind));
    writtenCountRef.current = lines.length;
  }, [lines, kind]);

  // Spinner lifecycle. Starts writing a frame every ~80ms when
  // streaming flips on; stops and erases when it flips off.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (streaming && spinnerTimerRef.current === null) {
      const frames = spinners.dots.frames;
      const interval = spinners.dots.interval;
      const label = waitingLabel ?? "Waiting for command output…";
      let i = 0;

      const paint = () => {
        if (!termRef.current) return;
        const frame = frames[i % frames.length];
        i += 1;
        // \r + \x1b[2K erases the line, then we write the spinner row.
        // The next appendLines call will replace this line (see above).
        termRef.current.write(
          `${eraseLineAndReturn()}${yellow(frame)} ${gray(label)}`,
        );
        spinnerActiveRef.current = true;
      };

      paint(); // First frame immediately for responsiveness.
      spinnerTimerRef.current = window.setInterval(paint, interval);
      return;
    }

    if (!streaming && spinnerTimerRef.current !== null) {
      window.clearInterval(spinnerTimerRef.current);
      spinnerTimerRef.current = null;
      if (spinnerActiveRef.current) {
        term.write(eraseLineAndReturn());
        spinnerActiveRef.current = false;
      }
    }
  }, [streaming, waitingLabel]);

  // Empty-state hint — shown only until the user's first command.
  useEffect(() => {
    const term = termRef.current;
    if (!term || lines.length > 0) return;
    const hint =
      kind === "claude"
        ? gray(
            "Claude session. Type a prompt below — ↑ for history, Tab for autocomplete.",
          )
        : gray(
            "Shell session. Commands run via docker / devcontainer / hive-agent.",
          );
    term.write(hint + CRLF);
  }, [kind, lines.length]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full min-w-0 flex-1"
      aria-label={`${kind} terminal output`}
    />
  );
}
