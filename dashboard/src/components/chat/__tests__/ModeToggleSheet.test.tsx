import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModeToggleSheet } from "../ModeToggleSheet";

describe("ModeToggleSheet", () => {
  it("renders Code / Review / Plan when open", () => {
    render(<ModeToggleSheet open={true} mode="code" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^code$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^plan$/i })).toBeTruthy();
  });

  it("clicking a mode calls onSelect with the mode and onClose", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ModeToggleSheet open={true} mode="code" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^plan$/i }));
    expect(onSelect).toHaveBeenCalledWith("plan");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the active mode carries aria-pressed=true", () => {
    render(<ModeToggleSheet open={true} mode="review" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^review$/i }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
