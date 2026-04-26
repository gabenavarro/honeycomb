import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageThinking } from "../MessageThinking";

describe("MessageThinking", () => {
  it("renders collapsed by default with first-line preview", () => {
    const { container } = render(<MessageThinking thinking={"line one\nline two"} />);
    const toggle = screen.getByRole("button", { name: /Toggle thinking block/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // First-line preview visible in the header button
    expect(toggle.textContent).toContain("line one");
    // Body <pre> is not rendered when collapsed
    expect(container.querySelector("pre")).toBeNull();
  });

  it("expands on click and reveals full body", () => {
    render(<MessageThinking thinking="line one\nline two" />);
    fireEvent.click(screen.getByRole("button", { name: /Toggle thinking block/i }));
    // Now the full body (including line two) is visible
    expect(screen.getByText(/line two/)).toBeTruthy();
  });

  it("shows streaming indicator when streaming=true", () => {
    render(<MessageThinking thinking="..." streaming />);
    expect(screen.getByText(/streaming…/i)).toBeTruthy();
  });
});
