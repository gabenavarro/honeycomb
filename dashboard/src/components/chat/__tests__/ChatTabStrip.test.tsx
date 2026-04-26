/** ChatTabStrip tests (M33). */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatTabStrip, type ChatTabInfo } from "../ChatTabStrip";

beforeEach(() => {
  window.localStorage.clear();
});

const TABS: ChatTabInfo[] = [
  { id: "t1", name: "Session 1", mode: "code" },
  { id: "t2", name: "Session 2", mode: "review" },
];

function renderStrip(overrides: Partial<React.ComponentProps<typeof ChatTabStrip>> = {}) {
  return render(
    <ChatTabStrip
      tabs={TABS}
      activeId="t1"
      onFocus={() => undefined}
      onClose={() => undefined}
      onNew={() => undefined}
      {...overrides}
    />,
  );
}

describe("ChatTabStrip", () => {
  it("renders one tab per item + a + New button", () => {
    renderStrip();
    expect(screen.getByRole("tab", { name: /Session 1/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Session 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
  });

  it("active tab has aria-selected=true", () => {
    renderStrip({ activeId: "t2" });
    expect(screen.getByRole("tab", { name: /Session 2/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: /Session 1/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("clicking a tab calls onFocus with that tab's id", () => {
    const onFocus = vi.fn();
    renderStrip({ onFocus });
    fireEvent.click(screen.getByRole("tab", { name: /Session 2/ }));
    expect(onFocus).toHaveBeenCalledWith("t2");
  });

  it("clicking the close × calls onClose with that tab's id", () => {
    const onClose = vi.fn();
    renderStrip({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close Session 1" }));
    expect(onClose).toHaveBeenCalledWith("t1");
  });

  it("clicking + New calls onNew", () => {
    const onNew = vi.fn();
    renderStrip({ onNew });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
