import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatTurn } from "../../types";
import { MessageAssistantText } from "../MessageAssistantText";

const baseTurn: ChatTurn = {
  id: "m-1",
  role: "assistant",
  blocks: [{ kind: "text", text: "Hello world." }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
};

describe("MessageAssistantText", () => {
  it("renders 'Claude' label + text", () => {
    render(<MessageAssistantText turn={baseTurn} />);
    const art = screen.getByRole("article", { name: /Assistant message/i });
    expect(art.textContent).toContain("Claude");
    expect(art.textContent).toContain("Hello world.");
  });

  it("renders a streaming cursor when turn.streaming is true", () => {
    const { container } = render(<MessageAssistantText turn={{ ...baseTurn, streaming: true }} />);
    // The cursor is an aria-hidden span with animate-pulse — find by class
    const cursor = container.querySelector("span.animate-pulse");
    expect(cursor).toBeTruthy();
  });

  it("does not render a cursor when not streaming", () => {
    const { container } = render(<MessageAssistantText turn={baseTurn} />);
    const cursor = container.querySelector("span.animate-pulse");
    expect(cursor).toBeNull();
  });
});
