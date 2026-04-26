import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageToolBash } from "../MessageToolBash";

describe("MessageToolBash", () => {
  it("renders Bash header + parsed command from partialJson", () => {
    render(
      <MessageToolBash
        block={{
          id: "tu-1",
          tool: "Bash",
          input: {},
          partialJson: '{"command":"ls /tmp","description":"List tmp"}',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("ls /tmp")).toBeTruthy();
    expect(screen.getByText("List tmp")).toBeTruthy();
    expect(screen.getByLabelText("Complete")).toBeTruthy();
  });

  it("shows running spinner when complete=false", () => {
    render(
      <MessageToolBash
        block={{
          id: "tu-2",
          tool: "Bash",
          input: {},
          partialJson: '{"command":"echo hi"}',
          complete: false,
        }}
      />,
    );
    expect(screen.getByLabelText("Running")).toBeTruthy();
  });

  it("falls back to block.input when partialJson is invalid", () => {
    render(
      <MessageToolBash
        block={{
          id: "tu-3",
          tool: "Bash",
          input: { command: "git status" },
          partialJson: '{"command":',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("git status")).toBeTruthy();
  });
});
