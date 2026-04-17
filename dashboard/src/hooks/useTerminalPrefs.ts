/** User-editable terminal preferences (M21 item F).
 *
 * Font size and cursor style are the two knobs users actually ask for;
 * everything else (colour palette, font family) we keep opinionated to
 * match the VSCode-dark look. Preferences persist to localStorage so
 * every PTY and ``TerminalPane`` picks them up on mount.
 */

import { useLocalStorage } from "./useLocalStorage";

export interface TerminalPrefs {
  fontSize: number;
  cursorStyle: "block" | "underline" | "bar";
  /** When true, xterm.js copies any mouse-selected range to the
   * clipboard on release — matches VSCode / iTerm2 defaults. */
  copyOnSelect: boolean;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 13,
  cursorStyle: "bar",
  copyOnSelect: true,
};

const MIN_FONT = 10;
const MAX_FONT = 28;

function isTerminalPrefs(v: unknown): v is TerminalPrefs {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.fontSize === "number" &&
    o.fontSize >= MIN_FONT &&
    o.fontSize <= MAX_FONT &&
    (o.cursorStyle === "block" || o.cursorStyle === "underline" || o.cursorStyle === "bar") &&
    typeof o.copyOnSelect === "boolean"
  );
}

export function useTerminalPrefs(): [TerminalPrefs, (next: TerminalPrefs) => void] {
  const [value, setValue] = useLocalStorage<TerminalPrefs>(
    "hive:terminal:prefs",
    DEFAULT_TERMINAL_PREFS,
    { validate: isTerminalPrefs },
  );
  return [value, setValue];
}

export { MIN_FONT as TERMINAL_MIN_FONT, MAX_FONT as TERMINAL_MAX_FONT };
