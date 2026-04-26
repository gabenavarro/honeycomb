import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewRenderer } from "../renderers/ReviewRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "r-1",
  container_id: 1,
  type: "review",
  title: "Review of PR #42",
  body: "Some markdown body.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: { pr_repo: "owner/repo", pr_number: 42, status: "open" },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("ReviewRenderer", () => {
  it("renders title + repo + PR number", () => {
    render(<ReviewRenderer artifact={sample} />);
    expect(screen.getByText("Review of PR #42")).toBeTruthy();
    expect(screen.getByText(/owner\/repo#42/)).toBeTruthy();
  });

  it("shows the M35-deferral notice", () => {
    render(<ReviewRenderer artifact={sample} />);
    expect(screen.getByText(/PR thread loading.+arrive/i)).toBeTruthy();
  });
});
