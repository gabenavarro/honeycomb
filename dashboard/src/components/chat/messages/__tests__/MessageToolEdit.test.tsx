import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageToolEdit } from "../MessageToolEdit";

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("MessageToolEdit", () => {
  it("renders Edit header + file path", () => {
    render(
      <MessageToolEdit
        block={{
          id: "tu-e1",
          tool: "Edit",
          input: {},
          partialJson: JSON.stringify({
            file_path: "/src/foo.ts",
            old_string: "const x = 1;",
            new_string: "const x = 2;",
          }),
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("Edit")).toBeTruthy();
    // file path appears in header target
    expect(screen.getAllByText("/src/foo.ts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Complete")).toBeTruthy();
  });

  it("renders 'Streaming…' placeholder when not complete", () => {
    render(
      <MessageToolEdit
        block={{
          id: "tu-e2",
          tool: "Edit",
          input: {},
          partialJson: '{"file_path":"/src/foo.ts","old_string":"a","new_string":',
          complete: false,
        }}
      />,
    );
    expect(screen.getByText("Streaming…")).toBeTruthy();
  });

  it("collapses to stat header when diff exceeds 20 total lines", () => {
    // 11 old + 11 new = 22 total lines → should collapse
    const oldText = makeLines(11);
    const newText = makeLines(11);
    render(
      <MessageToolEdit
        block={{
          id: "tu-e3",
          tool: "Edit",
          input: {},
          partialJson: JSON.stringify({
            file_path: "/big.ts",
            old_string: oldText,
            new_string: newText,
          }),
          complete: true,
        }}
      />,
    );
    // Stat header should appear with arrow between line counts
    expect(screen.getByText(/→/)).toBeTruthy();
    // The inline Diff component should NOT be rendered (no hunk content)
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders inline diff when diff is within 20 total lines", () => {
    // 3 old + 3 new = 6 total lines → should show diff view
    const oldText = makeLines(3);
    const newText = makeLines(3);
    render(
      <MessageToolEdit
        block={{
          id: "tu-e4",
          tool: "Edit",
          input: {},
          partialJson: JSON.stringify({
            file_path: "/small.ts",
            old_string: oldText,
            new_string: newText,
          }),
          complete: true,
        }}
      />,
    );
    // Stat line should NOT be shown (no arrow)
    expect(screen.queryByText(/→/)).toBeNull();
    // The diff view renders a table
    expect(screen.getByRole("table")).toBeTruthy();
  });
});
