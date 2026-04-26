import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditRenderer } from "../renderers/EditRenderer";
import type { Artifact } from "../../../lib/types";

// Stub DiffViewerTab so we don't pull in react-diff-view / refractor in jsdom
vi.mock("../../DiffViewerTab", () => ({
  DiffViewerTab: ({ event }: { event: { path: string } }) => (
    <div data-testid="diff-viewer-tab">{event.path}</div>
  ),
}));

const sample: Artifact = {
  artifact_id: "edit-abc123",
  container_id: 1,
  type: "edit",
  title: "Edit src/foo.ts",
  body: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,3 @@\n+// added\n line1\n line2\n",
  body_format: "diff",
  source_chat_id: "session-1",
  source_message_id: "msg-1",
  metadata: {
    paths: ["src/foo.ts"],
    tool: "Edit",
    lines_added: 1,
    lines_removed: 0,
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T10:00:00Z",
  updated_at: "2026-04-26T10:00:00Z",
};

describe("EditRenderer", () => {
  it("delegates to DiffViewerTab and renders the file path", () => {
    render(<EditRenderer artifact={sample} />);
    expect(screen.getByTestId("diff-viewer-tab")).toBeTruthy();
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
  });
});
