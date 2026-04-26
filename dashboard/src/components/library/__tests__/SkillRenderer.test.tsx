import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkillRenderer } from "../renderers/SkillRenderer";
import type { Artifact } from "../../../lib/types";

const base: Artifact = {
  artifact_id: "sk-1",
  container_id: 1,
  type: "skill",
  title: "my-skill",
  body: "No frontmatter here, just markdown body.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T09:00:00Z",
  updated_at: "2026-04-26T09:00:00Z",
};

const withFrontmatter: Artifact = {
  ...base,
  body: [
    "---",
    "name: awesome-skill",
    'description: "Does awesome things"',
    "---",
    "",
    "## Usage",
    "",
    "Call this skill to do awesome things.",
  ].join("\n"),
};

describe("SkillRenderer", () => {
  it("falls back to artifact.title when no frontmatter present", () => {
    render(<SkillRenderer artifact={base} />);
    expect(screen.getByRole("heading", { level: 1, name: "my-skill" })).toBeTruthy();
  });

  it("uses frontmatter.name when present", () => {
    render(<SkillRenderer artifact={withFrontmatter} />);
    expect(screen.getByRole("heading", { level: 1, name: "awesome-skill" })).toBeTruthy();
  });

  it("renders frontmatter.description in a subtitle paragraph", () => {
    render(<SkillRenderer artifact={withFrontmatter} />);
    expect(screen.getByText("Does awesome things")).toBeTruthy();
  });

  it("renders the rest of the body as markdown (not the frontmatter block)", () => {
    render(<SkillRenderer artifact={withFrontmatter} />);
    // Frontmatter lines should NOT appear as text
    expect(screen.queryByText(/name: awesome-skill/)).toBeNull();
    // Body after frontmatter should appear
    expect(screen.getByText(/Call this skill to do awesome things\./i)).toBeTruthy();
  });

  it("uses metadata.skill_name when no frontmatter and metadata provides it", () => {
    const withMeta: Artifact = {
      ...base,
      metadata: { skill_name: "from-metadata" },
    };
    render(<SkillRenderer artifact={withMeta} />);
    expect(screen.getByRole("heading", { level: 1, name: "from-metadata" })).toBeTruthy();
  });
});
