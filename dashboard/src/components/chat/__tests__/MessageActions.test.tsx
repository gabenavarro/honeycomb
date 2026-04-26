import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageActions } from "../MessageActions";
import type { ChatTurn } from "../types";

const userTurn: ChatTurn = {
  id: "u-1",
  role: "user",
  blocks: [{ kind: "text", text: "hi" }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
  text: "hi",
};
const assistantTurn: ChatTurn = { ...userTurn, id: "m-1", role: "assistant", text: undefined };

describe("MessageActions", () => {
  it("user turn: shows Retry, Copy, Edit; not for assistant", () => {
    const { rerender } = render(
      <MessageActions turn={userTurn} onRetry={vi.fn()} onCopy={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    rerender(
      <MessageActions turn={assistantTurn} onRetry={vi.fn()} onCopy={vi.fn()} onEdit={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("Fork shows when onFork is provided regardless of role", () => {
    render(<MessageActions turn={assistantTurn} onFork={vi.fn()} onCopy={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Fork" })).toBeTruthy();
  });

  it("clicking buttons calls the appropriate handlers", () => {
    const onRetry = vi.fn();
    const onCopy = vi.fn();
    const onEdit = vi.fn();
    const onFork = vi.fn();
    render(
      <MessageActions
        turn={userTurn}
        onRetry={onRetry}
        onCopy={onCopy}
        onEdit={onEdit}
        onFork={onFork}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(onRetry).toHaveBeenCalled();
    expect(onCopy).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalled();
    expect(onFork).toHaveBeenCalled();
  });
});
