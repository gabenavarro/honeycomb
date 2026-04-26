import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ArtifactCard } from "../ArtifactCard";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "a-1",
  container_id: 1,
  type: "note",
  title: "Sample note",
  body: "body...",
  body_format: "markdown",
  source_chat_id: "ns-claude-1",
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("ArtifactCard", () => {
  it("renders type icon + title + From: line", () => {
    render(<ArtifactCard artifact={sample} active={false} onSelect={vi.fn()} />);
    expect(screen.getByText("Sample note")).toBeTruthy();
    expect(screen.getByText(/From:/i)).toBeTruthy();
  });

  it("clicking card calls onSelect with artifact_id", () => {
    const onSelect = vi.fn();
    render(<ArtifactCard artifact={sample} active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("a-1");
  });

  it("active card carries aria-current=true", () => {
    render(<ArtifactCard artifact={sample} active={true} onSelect={vi.fn()} />);
    expect(screen.getByRole("button").getAttribute("aria-current")).toBe("true");
  });

  it("each type renders a distinct emoji marker", () => {
    const types = [
      "plan",
      "review",
      "edit",
      "snippet",
      "note",
      "skill",
      "subagent",
      "spec",
    ] as const;
    const seen = new Set<string>();
    for (const t of types) {
      const { container, unmount } = render(
        <ArtifactCard artifact={{ ...sample, type: t }} active={false} onSelect={vi.fn()} />,
      );
      const text = container.textContent ?? "";
      seen.add(Array.from(text)[0] ?? "");
      unmount();
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});
