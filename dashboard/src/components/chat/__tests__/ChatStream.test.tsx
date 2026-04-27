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
      <ChatStream turns={[userTurn]} renderTurn={(t) => <div data-testid="custom">{t.id}</div>} />,
    );
    expect(screen.getByTestId("custom").textContent).toBe("user-1");
  });
});

/** ChatStream — loading affordance tests (M37 Lane B). */
describe("ChatStream — pending placeholder (M37 Lane B)", () => {
  it("renders a 'thinking' placeholder when pending and no turns yet", () => {
    render(<ChatStream turns={[]} pending />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("renders the placeholder when pending and the last turn has zero blocks", () => {
    const turns: ChatTurn[] = [
      {
        id: "u1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
        streaming: false,
        startedAt: "2026-04-27T00:00:00Z",
        text: "hi",
      },
    ];
    render(<ChatStream turns={turns} pending />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("does NOT render the placeholder when not pending", () => {
    render(<ChatStream turns={[]} pending={false} />);
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it("does NOT render the placeholder when an assistant turn has blocks (deltas arrived)", () => {
    const turns: ChatTurn[] = [
      {
        id: "a1",
        role: "assistant",
        blocks: [{ kind: "text", text: "Hello" }],
        streaming: true,
        startedAt: "2026-04-27T00:00:00Z",
      },
    ];
    render(<ChatStream turns={turns} pending />);
    // Once content has started arriving the placeholder yields to the
    // real streaming text — only show it during the silent window.
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });
});
