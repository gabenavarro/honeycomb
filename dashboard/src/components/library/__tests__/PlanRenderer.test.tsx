import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlanRenderer } from "../renderers/PlanRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "p-1",
  container_id: 1,
  type: "plan",
  title: "My Plan",
  body: "## Overview\n\nThis is the plan body.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T12:00:00Z",
  updated_at: "2026-04-26T12:00:00Z",
};

describe("PlanRenderer", () => {
  it("renders the artifact title in an h1", () => {
    render(<PlanRenderer artifact={sample} />);
    expect(screen.getByRole("heading", { level: 1, name: "My Plan" })).toBeTruthy();
  });

  it('renders the "Plan ·" meta subtitle', () => {
    render(<PlanRenderer artifact={sample} />);
    expect(screen.getByText(/Plan\s*·\s*saved/i)).toBeTruthy();
  });

  it("renders markdown body content", () => {
    render(<PlanRenderer artifact={sample} />);
    // react-markdown renders ## Overview as an h2
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeTruthy();
    expect(screen.getByText(/This is the plan body\./i)).toBeTruthy();
  });
});
