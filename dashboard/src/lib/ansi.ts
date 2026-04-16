/** ANSI encoding helpers for the xterm.js output pane.
 *
 * We pass command output through **verbatim** so programs like `ls --color`,
 * `pytest`, `htop`-style curses apps render correctly. We only synthesize
 * ANSI for the *metadata* we add: the "$" / "claude>" prefix on user
 * input, the italic-dim system lines, and the red error channel.
 *
 * Rationale for minimal encoding: if we stripped or re-wrapped container
 * ANSI we'd lose cursor-up redraws (pip progress bars, tqdm, etc.).
 */

import type { SessionKind, SessionLine } from "../hooks/useSessionStore";

// SGR = Select Graphic Rendition. Each helper returns a self-contained
// string that resets after the content so it doesn't bleed into the
// next write.
const RESET = "\x1b[0m";
const CLEAR_LINE = "\x1b[2K";
const CARRIAGE_RETURN = "\r";

function sgr(params: string, text: string): string {
  return `\x1b[${params}m${text}${RESET}`;
}

/** Dim + italic for system/info lines (e.g. `[exit 0] via docker_exec`). */
export const dim = (text: string): string => sgr("2;3", text);
/** Bold red for error output. */
export const red = (text: string): string => sgr("1;31", text);
/** Bold green — shell prompt accent. */
export const green = (text: string): string => sgr("1;32", text);
/** Bold yellow — spinner accent / warnings. */
export const yellow = (text: string): string => sgr("1;33", text);
/** Bold blue — shell input line. */
export const blue = (text: string): string => sgr("1;34", text);
/** Bold magenta — claude input line. */
export const magenta = (text: string): string => sgr("1;35", text);
/** Plain gray — timestamp gutter. */
export const gray = (text: string): string => sgr("90", text);

/** Redraw the current line in place — used for spinners.
 * `\r` returns cursor to column 0, `\x1b[2K` erases the line. */
export const eraseLineAndReturn = (): string => CARRIAGE_RETURN + CLEAR_LINE;

/** xterm.js uses `\r\n` for newlines (NOT `\n`). Without the `\r` the
 * cursor column isn't reset and the next line starts indented to where
 * the last line ended. Common footgun. */
export const CRLF = "\r\n";

function formatTs(iso: string): string {
  // `new Date(<garbage>)` does NOT throw — it returns an `Invalid Date`
  // whose `toLocaleTimeString()` returns the literal string "Invalid Date".
  // Check validity explicitly so the try/catch is not our only defense.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  try {
    return d.toLocaleTimeString([], { hour12: false });
  } catch {
    return "--:--:--";
  }
}

/** Encode one SessionLine into an ANSI-decorated string ready for
 * `term.write()`. The trailing CRLF is included so callers can
 * concatenate without extra bookkeeping. */
export function encodeLine(line: SessionLine, kind: SessionKind): string {
  const ts = gray(formatTs(line.timestamp));
  switch (line.type) {
    case "input": {
      // Inputs already include the "$ " or "claude> " prefix from
      // TerminalPane; we just recolor it.
      const colored = kind === "claude" ? magenta(line.text) : blue(line.text);
      return `${ts}  ${colored}${CRLF}`;
    }
    case "error": {
      // Preserve any embedded ANSI from the container, but paint a red
      // prefix bar for at-a-glance error visibility.
      return `${ts}  ${red("!")} ${line.text}${CRLF}`;
    }
    case "system": {
      return `${ts}  ${dim(line.text)}${CRLF}`;
    }
    case "output":
    default:
      return `${ts}  ${line.text}${CRLF}`;
  }
}

/** Encode multiple lines in one call — same as mapping + joining, but
 * hoisted because write-then-concatenate in React renders benefits from
 * a single string allocation. */
export function encodeLines(lines: SessionLine[], kind: SessionKind): string {
  let out = "";
  for (const line of lines) out += encodeLine(line, kind);
  return out;
}
