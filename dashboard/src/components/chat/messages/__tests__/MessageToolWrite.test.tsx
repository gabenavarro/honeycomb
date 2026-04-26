import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MessageToolWrite } from "../MessageToolWrite";

function makeContent(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("MessageToolWrite", () => {
  it("renders Write header + file path + content preview", () => {
    render(
      <MessageToolWrite
        block={{
          id: "tu-7",
          tool: "Write",
          input: {},
          partialJson: '{"file_path":"/out/file.ts","content":"hello world"}',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("Write")).toBeTruthy();
    expect(screen.getByText("hello world")).toBeTruthy();
    expect(screen.getByLabelText("Complete")).toBeTruthy();
  });

  it("shows 'Show N more lines' button when content exceeds 8 lines", () => {
    const content = makeContent(12);
    render(
      <MessageToolWrite
        block={{
          id: "tu-8",
          tool: "Write",
          input: {},
          partialJson: JSON.stringify({ file_path: "/long.ts", content }),
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("Show 4 more lines")).toBeTruthy();
  });

  it("expands to full content when 'Show N more lines' is clicked", async () => {
    const user = userEvent.setup();
    const content = makeContent(12);
    render(
      <MessageToolWrite
        block={{
          id: "tu-9",
          tool: "Write",
          input: {},
          partialJson: JSON.stringify({ file_path: "/long.ts", content }),
          complete: true,
        }}
      />,
    );
    const btn = screen.getByText("Show 4 more lines");
    await user.click(btn);
    // After expanding the button should be gone
    expect(screen.queryByText("Show 4 more lines")).toBeNull();
    // All 12 lines should be visible now
    expect(screen.getByText(/line 12/)).toBeTruthy();
  });

  it("shows running spinner when complete=false", () => {
    render(
      <MessageToolWrite
        block={{
          id: "tu-10",
          tool: "Write",
          input: {},
          partialJson: '{"file_path":"/x.ts","content":""}',
          complete: false,
        }}
      />,
    );
    expect(screen.getByLabelText("Running")).toBeTruthy();
  });
});
