/** ActivityBar tests (M32 rebuild). */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityBar } from "../ActivityBar";

const noop = () => undefined;

function renderBar(overrides: Partial<React.ComponentProps<typeof ActivityBar>> = {}) {
  return render(
    <ActivityBar
      active="containers"
      onChange={noop}
      containerCount={0}
      prCount={0}
      problemCount={0}
      onOpenCommandPalette={noop}
      {...overrides}
    />,
  );
}

describe("ActivityBar (M32)", () => {
  it("renders exactly four labelled entries", () => {
    renderBar();
    expect(screen.getByRole("button", { name: /Chats/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Library/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Files/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeTruthy();
    // Sanity: no stale entries
    expect(screen.queryByRole("button", { name: /Git Ops/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Recent Edits/ })).toBeNull();
  });

  it("Chats shows aria-pressed=true when active='containers'", () => {
    renderBar({ active: "containers" });
    expect(screen.getByRole("button", { name: /Chats/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Library/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("Library shows aria-pressed=true when active='diff-events'", () => {
    renderBar({ active: "diff-events" });
    expect(screen.getByRole("button", { name: /Library/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("Files shows aria-pressed=true for any of files/scm/problems/keybindings", () => {
    for (const a of ["files", "scm", "problems", "keybindings"] as const) {
      const { unmount } = renderBar({ active: a });
      expect(screen.getByRole("button", { name: /Files/ }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      unmount();
    }
  });

  it("Reviews counter renders on Chats when prCount > 0", () => {
    renderBar({ prCount: 3 });
    const chats = screen.getByRole("button", { name: /Chats/ });
    expect(chats.textContent).toContain("3");
  });

  it("Reviews counter omitted when prCount === 0", () => {
    renderBar({ prCount: 0 });
    const chats = screen.getByRole("button", { name: /Chats/ });
    expect(chats.textContent).not.toMatch(/\d/);
  });

  it("Reviews counter caps at 99+", () => {
    renderBar({ prCount: 150 });
    const chats = screen.getByRole("button", { name: /Chats/ });
    expect(chats.textContent).toContain("99+");
  });

  it("clicking Chats emits onChange('containers')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Chats/ }));
    expect(onChange).toHaveBeenCalledWith("containers");
  });

  it("clicking Library emits onChange('diff-events')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Library/ }));
    expect(onChange).toHaveBeenCalledWith("diff-events");
  });

  it("clicking Files emits onChange('files')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    expect(onChange).toHaveBeenCalledWith("files");
  });

  it("clicking Settings emits onChange('settings')", () => {
    const onChange = vi.fn();
    renderBar({ onChange });
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(onChange).toHaveBeenCalledWith("settings");
  });

  it("Settings is rendered in the bottom group (DOM order)", () => {
    renderBar();
    const buttons = screen.getAllByRole("button");
    const ids = buttons.map((b) => b.getAttribute("aria-label"));
    expect(ids[ids.length - 1]).toBe("Settings");
  });
});
