import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../ChatComposer";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("ChatComposer", () => {
  it("renders an input + send button (disabled when empty)", () => {
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: /chat input/i })).toBeTruthy();
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send.hasAttribute("disabled")).toBe(true);
  });

  it("clicking Send calls onSend with trimmed text + clears input", () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={onSend}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: /chat input/i }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(input.value).toBe("");
  });

  it("Cmd+Enter sends", () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={onSend}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("ping");
  });

  it("displays the active mode label in the foot", () => {
    render(
      <ChatComposer
        sessionId="s"
        mode="plan"
        onSend={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Mode:/)).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
  });

  it("disabled prop blocks Send + Cmd+Enter", () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        disabled
        onSend={onSend}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("typing '/' shows the slash autocomplete dropdown", () => {
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: /Slash command suggestions/i })).toBeTruthy();
  });

  it("typing past a space hides the slash autocomplete", () => {
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: /chat input/i });
    fireEvent.change(input, { target: { value: "/edit src/main.tsx" } });
    expect(screen.queryByRole("listbox", { name: /Slash command suggestions/i })).toBeNull();
  });

  it("attachment chips render above the textarea", () => {
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={vi.fn()}
        attachments={["foo.py", "bar.tsx"]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("foo.py")).toBeTruthy();
    expect(screen.getByText("bar.tsx")).toBeTruthy();
  });

  it("removing a chip calls onAttachmentsChange with the chip dropped", () => {
    const onAttachmentsChange = vi.fn();
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={vi.fn()}
        attachments={["foo.py", "bar.tsx"]}
        onAttachmentsChange={onAttachmentsChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Remove foo.py/i }));
    expect(onAttachmentsChange).toHaveBeenCalledWith(["bar.tsx"]);
  });

  it("EditAutoToggle is rendered in the foot row", () => {
    render(
      <ChatComposer
        sessionId="s"
        mode="code"
        onSend={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch")).toBeTruthy();
  });
});
