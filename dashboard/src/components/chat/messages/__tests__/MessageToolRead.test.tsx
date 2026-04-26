import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageToolRead } from "../MessageToolRead";

describe("MessageToolRead", () => {
  it("renders Read header + file path", () => {
    render(
      <MessageToolRead
        block={{
          id: "tu-4",
          tool: "Read",
          input: {},
          partialJson: '{"file_path":"/src/main.ts"}',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("Read")).toBeTruthy();
    // file_path appears in both target (header) and body — getAllByText
    expect(screen.getAllByText("/src/main.ts").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText("Complete")).toBeTruthy();
  });

  it("shows line range when offset and limit are provided", () => {
    render(
      <MessageToolRead
        block={{
          id: "tu-5",
          tool: "Read",
          input: {},
          partialJson: '{"file_path":"/foo.py","offset":10,"limit":50}',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("lines 10-60")).toBeTruthy();
  });

  it("shows running spinner when complete=false", () => {
    render(
      <MessageToolRead
        block={{
          id: "tu-6",
          tool: "Read",
          input: {},
          partialJson: '{"file_path":"/bar.ts"}',
          complete: false,
        }}
      />,
    );
    expect(screen.getByLabelText("Running")).toBeTruthy();
  });
});
