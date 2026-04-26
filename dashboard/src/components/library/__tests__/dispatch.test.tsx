import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderArtifact } from "../renderers/dispatch";
import type { Artifact, ArtifactType } from "../../../lib/types";

// Stub DiffViewerTab so the edit-type case doesn't pull in
// react-diff-view / refractor under jsdom.
vi.mock("../../DiffViewerTab", () => ({
  DiffViewerTab: ({ event }: { event: { path: string } }) => (
    <div data-testid="diff-viewer-tab">{event.path}</div>
  ),
}));

function makeArtifact(type: ArtifactType, overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifact_id: type === "edit" ? "edit-abc123" : `${type}-1`,
    container_id: 1,
    type,
    title: `${type} title`,
    body: type === "edit" ? "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" : "body",
    body_format: type === "edit" ? "diff" : "markdown",
    source_chat_id: null,
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T00:00:00Z",
    updated_at: "2026-04-26T00:00:00Z",
    ...overrides,
  };
}

// One hallmark substring per renderer that proves the right component fired.
const HALLMARK: Record<ArtifactType, RegExp> = {
  plan: /Plan · saved/,
  review: /Review ·/,
  edit: /diff-viewer-tab/, // testid surfaces in the rendered DOM as a data-testid attr
  snippet: /lines/,
  note: /Note ·/,
  skill: /Skill ·/,
  subagent: /Subagent ·/,
  spec: /spec title/,
};

describe("renderArtifact dispatch", () => {
  for (const type of [
    "plan",
    "review",
    "edit",
    "snippet",
    "note",
    "skill",
    "subagent",
    "spec",
  ] as const) {
    it(`dispatches the ${type} renderer for type=${type}`, () => {
      const artifact = makeArtifact(type, {
        metadata:
          type === "snippet"
            ? { language: "python", line_count: 3 }
            : type === "edit"
              ? { paths: ["src/foo.ts"], tool: "Edit" }
              : null,
      });
      const { container } = render(<>{renderArtifact(artifact)}</>);
      if (type === "edit") {
        // EditRenderer delegates through to the mocked DiffViewerTab
        expect(screen.getByTestId("diff-viewer-tab")).toBeTruthy();
      } else {
        expect(container.textContent ?? "").toMatch(HALLMARK[type]);
      }
    });
  }
});
