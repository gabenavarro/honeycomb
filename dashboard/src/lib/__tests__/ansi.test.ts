import { describe, it, expect } from "vitest";
import { encodeLine, encodeLines, eraseLineAndReturn, CRLF } from "../ansi";
import type { SessionLine } from "../../hooks/useSessionStore";

// Matches the ESC + `[` + any-params + `m` SGR form. Used to strip
// color codes in assertions that focus on layout/text.
const SGR = /\x1b\[[\d;]*m/g;

function line(type: SessionLine["type"], text: string, ts = "2026-04-14T12:34:56Z"): SessionLine {
  return { type, text, timestamp: ts };
}

describe("encodeLine", () => {
  it("wraps the timestamp in gray (SGR 90)", () => {
    const out = encodeLine(line("output", "hello"), "shell");
    // SGR 90 before the time, reset after.
    expect(out).toMatch(/\x1b\[90m\d\d:\d\d:\d\d\x1b\[0m/);
  });

  it("paints shell input in bold blue", () => {
    const out = encodeLine(line("input", "$ ls"), "shell");
    expect(out).toContain("\x1b[1;34m$ ls\x1b[0m");
  });

  it("paints claude input in bold magenta", () => {
    const out = encodeLine(line("input", "claude> hi"), "claude");
    expect(out).toContain("\x1b[1;35mclaude> hi\x1b[0m");
  });

  it("prefixes errors with a red exclamation bar and passes text through", () => {
    const out = encodeLine(line("error", "oops"), "shell");
    expect(out).toContain("\x1b[1;31m!\x1b[0m oops");
  });

  it("renders system lines as dim italic", () => {
    const out = encodeLine(line("system", "[exit 0]"), "shell");
    expect(out).toContain("\x1b[2;3m[exit 0]\x1b[0m");
  });

  it("passes plain output text through verbatim so container ANSI survives", () => {
    // Simulates `ls --color` output that already has SGR in the text.
    const coloredText = "\x1b[34mfile.ts\x1b[0m";
    const out = encodeLine(line("output", coloredText), "shell");
    // The raw sequence must appear in the encoded output untouched.
    expect(out).toContain(coloredText);
  });

  it("ends every line with CRLF (xterm.js requirement)", () => {
    expect(encodeLine(line("output", "x"), "shell").endsWith(CRLF)).toBe(true);
    expect(encodeLine(line("input", "$ y"), "shell").endsWith(CRLF)).toBe(true);
    expect(encodeLine(line("error", "boom"), "shell").endsWith(CRLF)).toBe(true);
    expect(encodeLine(line("system", "done"), "shell").endsWith(CRLF)).toBe(true);
  });

  it("formats the timestamp as HH:MM:SS in 24-hour form", () => {
    const out = encodeLine(line("output", "x", "2026-04-14T07:05:09Z"), "shell");
    // Stripping SGR leaves a HH:MM:SS  x\r\n shape.
    expect(out.replace(SGR, "")).toMatch(/^\d\d:\d\d:\d\d  x\r\n$/);
  });

  it("emits '--:--:--' for an unparseable timestamp instead of throwing", () => {
    const out = encodeLine(line("output", "x", "not-a-date"), "shell");
    expect(out.replace(SGR, "")).toMatch(/^--:--:--  x\r\n$/);
  });
});

describe("encodeLines", () => {
  it("concatenates in order, preserving CRLFs between lines", () => {
    const out = encodeLines(
      [line("output", "a"), line("output", "b"), line("output", "c")],
      "shell",
    );
    const stripped = out.replace(SGR, "");
    expect(stripped.split(CRLF).filter(Boolean)).toEqual([
      expect.stringContaining("a"),
      expect.stringContaining("b"),
      expect.stringContaining("c"),
    ]);
  });

  it("returns empty string for empty input", () => {
    expect(encodeLines([], "shell")).toBe("");
  });
});

describe("eraseLineAndReturn", () => {
  it("produces \\r + clear-line — the spinner's redraw sequence", () => {
    expect(eraseLineAndReturn()).toBe("\r\x1b[2K");
  });
});
