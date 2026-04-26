import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Artifact } from "../../../lib/types";
import { FilterChips } from "../FilterChips";

function makeArtifact(type: Artifact["type"], id: string): Artifact {
  return {
    artifact_id: id,
    container_id: 1,
    type,
    title: `${type} ${id}`,
    body: "body",
    body_format: "markdown",
    source_chat_id: null,
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T00:00:00Z",
    updated_at: "2026-04-26T00:00:00Z",
  };
}

const sampleArtifacts: Artifact[] = [
  makeArtifact("plan", "p-1"),
  makeArtifact("plan", "p-2"),
  makeArtifact("review", "r-1"),
  makeArtifact("snippet", "s-1"),
];

describe("FilterChips", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders 'All' chip plus 4 default primary chips", () => {
    render(<FilterChips selected={[]} onSelectedChange={vi.fn()} artifacts={sampleArtifacts} />);
    // All chip
    expect(screen.getByRole("button", { name: /^all/i })).toBeTruthy();
    // Default primary: plan, review, edit, snippet
    expect(screen.getByRole("button", { name: /^plan/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^review/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^edit/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^snippet/i })).toBeTruthy();
  });

  it("clicking a type chip toggles its aria-pressed state and calls onSelectedChange", () => {
    const onSelectedChange = vi.fn();
    render(
      <FilterChips selected={[]} onSelectedChange={onSelectedChange} artifacts={sampleArtifacts} />,
    );
    const planChip = screen.getByRole("button", { name: /^plan/i });
    expect(planChip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(planChip);
    expect(onSelectedChange).toHaveBeenCalledWith(["plan"]);
  });

  it("count badge shows the count of matching artifacts for each type", () => {
    render(<FilterChips selected={[]} onSelectedChange={vi.fn()} artifacts={sampleArtifacts} />);
    // plan: 2 artifacts — unique count
    expect(screen.getByLabelText("2 artifacts")).toBeTruthy();
    // Multiple chips show "1 artifacts" (review, snippet) — use getAllByLabelText
    const oneCountBadges = screen.getAllByLabelText("1 artifacts");
    expect(oneCountBadges.length).toBeGreaterThanOrEqual(1);
    // edit: 0 artifacts
    expect(screen.getByLabelText("0 artifacts")).toBeTruthy();
  });

  it("clicking ⋯ More opens the customisation sheet", () => {
    render(<FilterChips selected={[]} onSelectedChange={vi.fn()} artifacts={sampleArtifacts} />);
    const moreBtn = screen.getByRole("button", { name: /more filter options/i });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(moreBtn);
    expect(screen.getByRole("dialog", { name: /customize artifact chips/i })).toBeTruthy();
  });
});
