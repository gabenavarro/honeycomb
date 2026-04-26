import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../ChatComposer";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("ChatComposer", () => {
  it("renders an input + send button (disabled when empty)", () => {
    render(<ChatComposer sessionId="s" mode="code" onSend={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /chat input/i })).toBeTruthy();
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send.hasAttribute("disabled")).toBe(true);
  });

  it("clicking Send calls onSend with trimmed text + clears input", () => {
    const onSend = vi.fn();
    render(<ChatComposer sessionId="s" mode="code" onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: /chat input/i }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(input.value).toBe("");
  });

  it("Cmd+Enter sends", () => {
    const onSend = vi.fn();
    render(<ChatComposer sessionId="s" mode="code" onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("ping");
  });

  it("displays the active mode label in the foot", () => {
    render(<ChatComposer sessionId="s" mode="plan" onSend={vi.fn()} />);
    expect(screen.getByText(/Mode:/)).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  it("disabled prop blocks Send + Cmd+Enter", () => {
    const onSend = vi.fn();
    render(<ChatComposer sessionId="s" mode="code" disabled onSend={onSend} />);
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
