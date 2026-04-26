import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpecRenderer } from "../renderers/SpecRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "s-1",
  container_id: 1,
  type: "spec",
  title: "Example Spec",
  body: "Spec body content here.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: {
    headings: ["Section A", "Section B"],
    file_path: "specs/example.md",
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};

describe("SpecRenderer", () => {
  it("renders the artifact title in an h1", () => {
    render(<SpecRenderer artifact={sample} />);
    expect(screen.getByRole("heading", { level: 1, name: "Example Spec" })).toBeTruthy();
  });

  it("renders the file path in the subtitle", () => {
    render(<SpecRenderer artifact={sample} />);
    expect(screen.getByText("specs/example.md")).toBeTruthy();
  });

  it("renders TOC entries from metadata.headings", () => {
    render(<SpecRenderer artifact={sample} />);
    expect(screen.getByText("Section A")).toBeTruthy();
    expect(screen.getByText("Section B")).toBeTruthy();
  });

  it("does not render TOC aside when headings are empty", () => {
    const noHeadings: Artifact = {
      ...sample,
      metadata: { headings: [], file_path: "specs/example.md" },
    };
    render(<SpecRenderer artifact={noHeadings} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("renders markdown body content", () => {
    render(<SpecRenderer artifact={sample} />);
    expect(screen.getByText(/Spec body content here\./i)).toBeTruthy();
  });
});
