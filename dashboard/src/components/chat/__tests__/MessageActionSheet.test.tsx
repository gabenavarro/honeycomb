import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageActionSheet } from "../MessageActionSheet";

describe("MessageActionSheet", () => {
  it("renders Retry / Fork / Copy / Edit when open", () => {
    render(
      <MessageActionSheet
        open={true}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onFork={vi.fn()}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^fork$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy();
  });

  it("clicking Copy calls onCopy and onClose", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(
      <MessageActionSheet
        open={true}
        onClose={onClose}
        onRetry={vi.fn()}
        onFork={vi.fn()}
        onCopy={onCopy}
        onEdit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits Edit when onEdit is undefined (e.g. assistant messages)", () => {
    render(
      <MessageActionSheet
        open={true}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onFork={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
  });
});
