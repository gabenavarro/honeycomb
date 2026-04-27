/** SessionSubTabs — tab strip for the active container's sessions.
 *
 * M36-hotfix: split the single "+ New" button into two explicit
 * affordances ("+ Chat" creates a kind="claude" session; "+ Shell"
 * creates a kind="shell" session). The pre-hotfix single button
 * silently hardcoded kind="shell" in App.tsx, leaving the M33
 * ChatThread surface only reachable via ⌘K.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionSubTabs } from "../SessionSubTabs";

const sessions = [{ id: "s-1", name: "Main" }];

const baseProps = {
  sessions,
  activeId: "s-1" as string | null,
  onFocus: vi.fn(),
  onClose: vi.fn(),
  onRename: vi.fn(),
  onReorder: vi.fn(),
};

describe("SessionSubTabs", () => {
  it("renders a + Chat button (creates a claude-kind session)", () => {
    render(<SessionSubTabs {...baseProps} onNewChat={vi.fn()} onNewShell={vi.fn()} />);
    expect(screen.getByRole("button", { name: /new chat session/i })).toBeTruthy();
  });

  it("renders a + Shell button (creates a shell-kind session)", () => {
    render(<SessionSubTabs {...baseProps} onNewChat={vi.fn()} onNewShell={vi.fn()} />);
    expect(screen.getByRole("button", { name: /new shell session/i })).toBeTruthy();
  });

  it("clicking + Chat calls onNewChat (and not onNewShell)", () => {
    const onNewChat = vi.fn();
    const onNewShell = vi.fn();
    render(<SessionSubTabs {...baseProps} onNewChat={onNewChat} onNewShell={onNewShell} />);
    fireEvent.click(screen.getByRole("button", { name: /new chat session/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewShell).not.toHaveBeenCalled();
  });

  it("clicking + Shell calls onNewShell (and not onNewChat)", () => {
    const onNewChat = vi.fn();
    const onNewShell = vi.fn();
    render(<SessionSubTabs {...baseProps} onNewChat={onNewChat} onNewShell={onNewShell} />);
    fireEvent.click(screen.getByRole("button", { name: /new shell session/i }));
    expect(onNewShell).toHaveBeenCalledTimes(1);
    expect(onNewChat).not.toHaveBeenCalled();
  });
});
