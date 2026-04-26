import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneTabBar } from "../PhoneTabBar";

describe("PhoneTabBar", () => {
  it("renders 5 tab buttons (Chats / Library / Files / Git / More)", () => {
    render(<PhoneTabBar activeTab="chats" onTabChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /chats/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /library/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /files/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /git/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /more/i })).toBeTruthy();
  });

  it("the active tab carries aria-current=page", () => {
    render(<PhoneTabBar activeTab="library" onTabChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /library/i }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: /chats/i }).getAttribute("aria-current")).toBeNull();
  });

  it("clicking a tab calls onTabChange with the tab id", () => {
    const onTabChange = vi.fn();
    render(<PhoneTabBar activeTab="chats" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("button", { name: /library/i }));
    expect(onTabChange).toHaveBeenCalledWith("library");
  });

  it("each tab button is at least 44x44 (iOS HIG)", () => {
    const { container } = render(<PhoneTabBar activeTab="chats" onTabChange={vi.fn()} />);
    const buttons = container.querySelectorAll('button[role="button"], button:not([role])');
    for (const b of buttons) {
      expect((b as HTMLElement).className).toMatch(/min-h-\[44px\]/);
    }
  });
});
