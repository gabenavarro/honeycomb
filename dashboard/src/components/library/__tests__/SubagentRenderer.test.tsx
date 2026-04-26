import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubagentRenderer } from "../renderers/SubagentRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "sa-1",
  container_id: 1,
  type: "subagent",
  title: "Run linter subagent",
  body: "Please lint all Python files under src/ and report issues.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: {
    subagent_type: "linter-agent",
    result_summary: "Found **3 issues** in 2 files.",
    parent_chat_id: "abcdef1234567890",
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T11:00:00Z",
  updated_at: "2026-04-26T11:00:00Z",
};

describe("SubagentRenderer", () => {
  it("renders the artifact title in an h1", () => {
    render(<SubagentRenderer artifact={sample} />);
    expect(screen.getByRole("heading", { level: 1, name: "Run linter subagent" })).toBeTruthy();
  });

  it("renders metadata.subagent_type in the Task → line", () => {
    render(<SubagentRenderer artifact={sample} />);
    expect(screen.getByText("linter-agent")).toBeTruthy();
  });

  it("renders a truncated parent_chat_id when present", () => {
    render(<SubagentRenderer artifact={sample} />);
    // slice(0, 8) of "abcdef1234567890" → "abcdef12"
    expect(screen.getByText(/abcdef12/)).toBeTruthy();
  });

  it("renders result_summary as markdown when present", () => {
    render(<SubagentRenderer artifact={sample} />);
    // react-markdown renders **3 issues** as <strong>
    expect(screen.getByText("3 issues")).toBeTruthy();
  });
});
