import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatStream } from "../ChatStream";
import type { ChatTurn } from "../types";

const userTurn: ChatTurn = {
  id: "user-1",
  role: "user",
  blocks: [{ kind: "text", text: "hi" }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
  text: "hi",
};

const assistantTurn: ChatTurn = {
  id: "msg-1",
  role: "assistant",
  blocks: [{ kind: "text", text: "Hello." }],
  streaming: true,
  startedAt: "2026-04-26T00:00:01Z",
};

describe("ChatStream", () => {
  it("renders empty state when no turns", () => {
    render(<ChatStream turns={[]} />);
    expect(screen.getByText(/No turns yet/i)).toBeTruthy();
  });

  it("renders one placeholder per turn when no renderTurn provided", () => {
    render(<ChatStream turns={[userTurn, assistantTurn]} />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("streaming…")).toBeTruthy();
  });

  it("delegates to renderTurn when provided", () => {
    render(
      <ChatStream
        turns={[userTurn]}
        renderTurn={(t) => <div data-testid="custom">{t.id}</div>}
      />,
    );
    expect(screen.getByTestId("custom").textContent).toBe("user-1");
  });
});
