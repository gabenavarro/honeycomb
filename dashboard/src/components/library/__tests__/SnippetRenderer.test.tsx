import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SnippetRenderer } from "../renderers/SnippetRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "snip-1",
  container_id: 1,
  type: "snippet",
  title: "My Script",
  body: "print('hello')\nprint('world')\n",
  body_format: "python",
  source_chat_id: null,
  source_message_id: null,
  metadata: {
    language: "python",
    line_count: 2,
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T10:00:00Z",
  updated_at: "2026-04-26T10:00:00Z",
};

describe("SnippetRenderer", () => {
  it("renders the artifact body in a pre element", () => {
    render(<SnippetRenderer artifact={sample} />);
    const pre = screen.getByText(/print\('hello'\)/);
    expect(pre.tagName.toLowerCase()).toBe("pre");
  });

  it("renders a copy button that calls clipboard.writeText", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeMock },
    });

    render(<SnippetRenderer artifact={sample} />);
    const copyBtn = screen.getByRole("button", { name: /copy snippet/i });
    fireEvent.click(copyBtn);

    // clipboard call is async (void-awaited); flush microtasks
    await Promise.resolve();
    expect(writeMock).toHaveBeenCalledWith(sample.body);
  });

  it("renders the header with language and line count", () => {
    render(<SnippetRenderer artifact={sample} />);
    expect(screen.getByRole("heading", { level: 1, name: "My Script" })).toBeTruthy();
    expect(screen.getByText(/python\s*·\s*2\s*lines/i)).toBeTruthy();
  });
});
