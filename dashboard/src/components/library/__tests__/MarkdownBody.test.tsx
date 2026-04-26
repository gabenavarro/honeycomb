import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "../renderers/MarkdownBody";

describe("MarkdownBody", () => {
  it("inline code carries the chip styling", () => {
    const { container } = render(<MarkdownBody source="See `value` here." />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.className).toContain("bg-input");
    expect(code!.className).toContain("text-tool");
  });

  it("fenced code blocks do NOT carry the chip styling", () => {
    const source = "```ts\nconst x = 1;\nconst y = 2;\n```";
    const { container } = render(<MarkdownBody source={source} />);
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    // Fenced blocks: className should be language-ts (no chip styling).
    expect(code!.className).not.toContain("bg-input");
    expect(code!.className).not.toContain("text-tool");
    expect(code!.className).toContain("language-ts");
  });

  it("renders external link with target=_blank rel=noreferrer", () => {
    render(<MarkdownBody source="[ex](https://example.com)" />);
    const link = screen.getByRole("link", { name: "ex" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });
});
