import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewRenderer } from "../renderers/ReviewRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "rv-1",
  container_id: 1,
  type: "review",
  title: "Review: fix auth bug",
  body: "The auth bug is fixed by patching the token refresh logic.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: {
    pr_repo: "org/repo",
    pr_number: 42,
    status: "pending",
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T12:00:00Z",
  updated_at: "2026-04-26T12:00:00Z",
};

describe("ReviewRenderer", () => {
  it("renders the artifact title in an h1", () => {
    render(<ReviewRenderer artifact={sample} />);
    expect(screen.getByRole("heading", { level: 1, name: "Review: fix auth bug" })).toBeTruthy();
  });

  it("renders pr_repo#pr_number in the subtitle when metadata is present", () => {
    render(<ReviewRenderer artifact={sample} />);
    expect(screen.getByText(/org\/repo#42/i)).toBeTruthy();
  });
});
