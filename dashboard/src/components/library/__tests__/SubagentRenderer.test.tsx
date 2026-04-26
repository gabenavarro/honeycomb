import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubagentRenderer } from "../renderers/SubagentRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "sub-1",
  container_id: 1,
  type: "subagent",
  title: "Find the bug",
  body: "Find the bug in main.py",
  body_format: "markdown",
  source_chat_id: "ns-1",
  source_message_id: "tu-1",
  metadata: {
    subagent_type: "general-purpose",
    parent_chat_id: "ns-1",
    result_summary: "Found the bug in line 42.",
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("SubagentRenderer", () => {
  it("renders the prompt body inside a <pre>", () => {
    const { container } = render(<SubagentRenderer artifact={sample} />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("Find the bug in main.py");
  });

  it("shows the agent_type in the header", () => {
    render(<SubagentRenderer artifact={sample} />);
    expect(screen.getByText(/general-purpose/)).toBeTruthy();
  });

  it("renders the result_summary section when present", () => {
    render(<SubagentRenderer artifact={sample} />);
    expect(screen.getByText(/Found the bug in line 42/)).toBeTruthy();
  });

  it("omits the result section when result_summary is absent", () => {
    const noResult: Artifact = {
      ...sample,
      metadata: { ...sample.metadata, result_summary: undefined },
    };
    render(<SubagentRenderer artifact={noResult} />);
    expect(screen.queryByText(/Result/)).toBeNull();
  });
});
