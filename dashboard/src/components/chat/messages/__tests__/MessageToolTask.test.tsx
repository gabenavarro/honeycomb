import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageToolTask } from "../MessageToolTask";

describe("MessageToolTask", () => {
  it("renders Task header with subagent + description target", () => {
    render(
      <MessageToolTask
        block={{
          id: "tu-1",
          tool: "Task",
          input: {},
          partialJson:
            '{"subagent_type":"general-purpose","description":"Find the bug","prompt":"Find the bug in main.py"}',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("Task")).toBeTruthy();
    expect(screen.getByText(/general-purpose: Find the bug/)).toBeTruthy();
  });

  it("prompt is in a <details> (collapsed by default)", () => {
    const { container } = render(
      <MessageToolTask
        block={{
          id: "tu-2",
          tool: "Task",
          input: {},
          partialJson: '{"subagent_type":"x","description":"y","prompt":"long prompt"}',
          complete: true,
        }}
      />,
    );
    const details = container.querySelector("details");
    expect(details).toBeTruthy();
    expect(details?.hasAttribute("open")).toBe(false);
  });
});
