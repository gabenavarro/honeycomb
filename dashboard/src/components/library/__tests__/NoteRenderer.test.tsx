import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NoteRenderer } from "../renderers/NoteRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "n-1",
  container_id: 1,
  type: "note",
  title: "Quick Note",
  body: "Just a quick note with some **bold** text.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T10:00:00Z",
  updated_at: "2026-04-26T10:00:00Z",
};

describe("NoteRenderer", () => {
  it("renders the artifact title in an h2 (lighter chrome than Plan)", () => {
    render(<NoteRenderer artifact={sample} />);
    expect(screen.getByRole("heading", { level: 2, name: "Quick Note" })).toBeTruthy();
  });

  it('renders the "Note ·" meta subtitle', () => {
    render(<NoteRenderer artifact={sample} />);
    expect(screen.getByText(/Note\s*·\s*saved/i)).toBeTruthy();
  });

  it("renders markdown body content", () => {
    render(<NoteRenderer artifact={sample} />);
    // react-markdown renders **bold** as <strong>
    expect(screen.getByText(/Quick note with some/i)).toBeTruthy();
    expect(screen.getByText("bold")).toBeTruthy();
  });
});
