import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sheet } from "../Sheet";

afterEach(() => {
  // Reset the document body in case a sheet leaks a class.
  document.body.className = "";
});

describe("Sheet", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <Sheet open={false} onClose={vi.fn()} title="Test sheet">
        body
      </Sheet>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders title + body + close button when open=true", () => {
    render(
      <Sheet open={true} onClose={vi.fn()} title="Pick mode">
        body
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Pick mode" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="t">
        body
      </Sheet>,
    );
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the panel does NOT call onClose", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="t">
        <button>inside</button>
      </Sheet>,
    );
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} onClose={onClose} title="t">
        body
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop has cursor: pointer (iOS Safari tap fix)", () => {
    render(
      <Sheet open={true} onClose={vi.fn()} title="t">
        body
      </Sheet>,
    );
    const bd = screen.getByTestId("sheet-backdrop");
    expect(bd.className).toContain("cursor-pointer");
  });
});
