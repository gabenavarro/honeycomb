import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatTurn } from "../../types";
import { MessageUser } from "../MessageUser";

const turn: ChatTurn = {
  id: "u-1",
  role: "user",
  blocks: [{ kind: "text", text: "Hello there" }],
  streaming: false,
  startedAt: "2026-04-26T00:00:00Z",
  text: "Hello there",
};

describe("MessageUser", () => {
  it("renders the text inside a labelled article", () => {
    render(<MessageUser turn={turn} />);
    const art = screen.getByRole("article", { name: /User message/i });
    expect(art.textContent).toContain("Hello there");
    expect(art.textContent).toContain("You");
  });

  it("falls back to concatenating text blocks when turn.text is undefined", () => {
    const noTurnText: ChatTurn = {
      ...turn,
      text: undefined,
      blocks: [
        { kind: "text", text: "Part 1 " },
        { kind: "text", text: "Part 2" },
      ],
    };
    render(<MessageUser turn={noTurnText} />);
    const art = screen.getByRole("article", { name: /User message/i });
    expect(art.textContent).toContain("Part 1 Part 2");
  });
});
