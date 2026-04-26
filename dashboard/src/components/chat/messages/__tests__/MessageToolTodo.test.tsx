import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageToolTodo } from "../MessageToolTodo";

describe("MessageToolTodo", () => {
  it("renders todos with correct symbol per status", () => {
    render(
      <MessageToolTodo
        block={{
          id: "tu-1",
          tool: "TodoWrite",
          input: {},
          partialJson: JSON.stringify({
            todos: [
              { content: "Task A", activeForm: "Doing A", status: "completed" },
              { content: "Task B", activeForm: "Doing B", status: "in_progress" },
              { content: "Task C", activeForm: "Doing C", status: "pending" },
            ],
          }),
          complete: true,
        }}
      />,
    );
    // Symbols
    expect(screen.getByText("☑")).toBeTruthy();
    expect(screen.getByText("▶")).toBeTruthy();
    expect(screen.getByText("☐")).toBeTruthy();
    // In-progress shows activeForm; completed/pending show content
    expect(screen.getByText("Task A")).toBeTruthy();
    expect(screen.getByText("Doing B")).toBeTruthy();
    expect(screen.getByText("Task C")).toBeTruthy();
  });

  it("header target shows item count (singular vs plural)", () => {
    const { rerender } = render(
      <MessageToolTodo
        block={{
          id: "tu-1",
          tool: "TodoWrite",
          input: {},
          partialJson: JSON.stringify({
            todos: [{ content: "X", activeForm: "x", status: "pending" }],
          }),
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("1 item")).toBeTruthy();

    rerender(
      <MessageToolTodo
        block={{
          id: "tu-2",
          tool: "TodoWrite",
          input: {},
          partialJson: JSON.stringify({
            todos: [
              { content: "X", activeForm: "x", status: "pending" },
              { content: "Y", activeForm: "y", status: "pending" },
            ],
          }),
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("2 items")).toBeTruthy();
  });
});
