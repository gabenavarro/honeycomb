import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageToolGeneric } from "../MessageToolGeneric";

describe("MessageToolGeneric", () => {
  it("uses block.tool as the header name + dumps parsed input as JSON", () => {
    render(
      <MessageToolGeneric
        block={{
          id: "tu-1",
          tool: "WebFetch",
          input: {},
          partialJson: '{"url":"https://example.com","prompt":"summarise"}',
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("WebFetch")).toBeTruthy();
    // Pretty-printed JSON contains both keys
    const body = screen.getByText(/example.com/);
    expect(body.textContent).toContain('"url"');
    expect(body.textContent).toContain('"prompt"');
  });
});
