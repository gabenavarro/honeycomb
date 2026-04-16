import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeContainerSessions, useSession } from "../useSessionStore";

describe("useSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty for a fresh (containerId, kind) pair", () => {
    const { result } = renderHook(() => useSession(1, "shell"));
    expect(result.current.state.lines).toEqual([]);
    expect(result.current.state.draft).toBe("");
    expect(result.current.state.activeCommandId).toBeNull();
  });

  it("appends lines and persists them across rerenders", () => {
    const { result, rerender } = renderHook(() => useSession(1, "shell"));
    act(() => {
      result.current.appendLines([
        { text: "hello", timestamp: "2026-04-14T00:00:00Z", type: "output" },
      ]);
    });
    rerender();
    expect(result.current.state.lines.map((l) => l.text)).toEqual(["hello"]);
  });

  it("keeps shell and claude sessions independent for the same container", () => {
    const shell = renderHook(() => useSession(7, "shell"));
    const claude = renderHook(() => useSession(7, "claude"));

    act(() => {
      shell.result.current.appendLines([
        { text: "ls", timestamp: "2026-04-14T00:00:00Z", type: "input" },
      ]);
    });
    act(() => {
      claude.result.current.appendLines([
        { text: "hi", timestamp: "2026-04-14T00:00:00Z", type: "input" },
      ]);
    });

    expect(shell.result.current.state.lines.map((l) => l.text)).toEqual(["ls"]);
    expect(claude.result.current.state.lines.map((l) => l.text)).toEqual(["hi"]);
  });

  it("reloads persisted state when rendered in a new hook instance", () => {
    // First instance writes.
    const first = renderHook(() => useSession(42, "shell"));
    act(() => {
      first.result.current.appendLines([
        { text: "persistent", timestamp: "2026-04-14T00:00:00Z", type: "output" },
      ]);
      first.result.current.setDraft("half-typed");
    });
    first.unmount();

    // Second instance — simulates reopening the container.
    const second = renderHook(() => useSession(42, "shell"));
    expect(second.result.current.state.lines.map((l) => l.text)).toEqual(["persistent"]);
    expect(second.result.current.state.draft).toBe("half-typed");
  });

  it("clear() wipes lines and draft but not the session key", () => {
    const { result } = renderHook(() => useSession(3, "claude"));
    act(() => {
      result.current.appendLines([
        { text: "hello", timestamp: "2026-04-14T00:00:00Z", type: "input" },
      ]);
      result.current.setDraft("draft");
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.state.lines).toEqual([]);
    expect(result.current.state.draft).toBe("");
  });

  it("purgeContainerSessions drops both kinds", () => {
    const shell = renderHook(() => useSession(9, "shell"));
    const claude = renderHook(() => useSession(9, "claude"));
    act(() => {
      shell.result.current.appendLines([
        { text: "a", timestamp: "2026-04-14T00:00:00Z", type: "output" },
      ]);
      claude.result.current.appendLines([
        { text: "b", timestamp: "2026-04-14T00:00:00Z", type: "output" },
      ]);
    });
    shell.unmount();
    claude.unmount();

    purgeContainerSessions(9);

    const reloadedShell = renderHook(() => useSession(9, "shell"));
    const reloadedClaude = renderHook(() => useSession(9, "claude"));
    expect(reloadedShell.result.current.state.lines).toEqual([]);
    expect(reloadedClaude.result.current.state.lines).toEqual([]);
  });

  it("caps line retention to prevent unbounded growth", () => {
    const { result } = renderHook(() => useSession(99, "shell"));
    act(() => {
      // 2500 lines — should clamp at 2000.
      const batch = Array.from({ length: 2500 }, (_, i) => ({
        text: `line ${i}`,
        timestamp: "2026-04-14T00:00:00Z",
        type: "output" as const,
      }));
      result.current.appendLines(batch);
    });
    expect(result.current.state.lines.length).toBe(2000);
    // Oldest kept is line 500.
    expect(result.current.state.lines[0].text).toBe("line 500");
  });

  it("pushHistory stores entries most-recent-first, deduping consecutive", () => {
    const { result } = renderHook(() => useSession(5, "shell"));
    act(() => {
      result.current.pushHistory("ls");
      result.current.pushHistory("pwd");
      result.current.pushHistory("pwd"); // consecutive dup → skipped
      result.current.pushHistory("git status");
    });
    expect(result.current.state.history).toEqual(["git status", "pwd", "ls"]);
  });

  it("pushHistory ignores blank entries", () => {
    const { result } = renderHook(() => useSession(5, "shell"));
    act(() => {
      result.current.pushHistory("   ");
      result.current.pushHistory("");
      result.current.pushHistory("ls");
    });
    expect(result.current.state.history).toEqual(["ls"]);
  });

  it("clear() preserves history (so arrow-up still recalls after a clear)", () => {
    const { result } = renderHook(() => useSession(6, "claude"));
    act(() => {
      result.current.pushHistory("summarize repo");
      result.current.appendLines([
        { text: "out", timestamp: "2026-04-14T00:00:00Z", type: "output" },
      ]);
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.state.lines).toEqual([]);
    expect(result.current.state.history).toEqual(["summarize repo"]);
  });
});
