import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactType } from "../../../lib/types";
import { MoreCustomizationSheet } from "../MoreCustomizationSheet";

const ALL_TYPES: ArtifactType[] = [
  "plan",
  "review",
  "edit",
  "snippet",
  "note",
  "skill",
  "subagent",
  "spec",
];

describe("MoreCustomizationSheet", () => {
  it("renders 8 type rows", () => {
    render(
      <MoreCustomizationSheet
        primaryTypes={["plan", "review", "edit", "snippet"]}
        onPrimaryTypesChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: /customise filter chips/i });
    // All 8 type labels should appear
    for (const type of ALL_TYPES) {
      expect(dialog.textContent).toContain(type[0].toUpperCase() + type.slice(1));
    }
  });

  it("clicking ★ on a non-primary type promotes it", () => {
    const onPrimaryTypesChange = vi.fn();
    render(
      <MoreCustomizationSheet
        primaryTypes={["plan", "review", "edit", "snippet"]}
        onPrimaryTypesChange={onPrimaryTypesChange}
        onClose={vi.fn()}
      />,
    );
    // "note" is not in primary, clicking its star should promote it
    const addNoteBtn = screen.getByRole("button", { name: /add note to primary/i });
    fireEvent.click(addNoteBtn);
    // Cap of 4: "plan" (oldest) gets dropped, result is ["review","edit","snippet","note"]
    expect(onPrimaryTypesChange).toHaveBeenCalledWith(["review", "edit", "snippet", "note"]);
  });

  it("clicking ★ on a primary type demotes it", () => {
    const onPrimaryTypesChange = vi.fn();
    render(
      <MoreCustomizationSheet
        primaryTypes={["plan", "review", "edit", "snippet"]}
        onPrimaryTypesChange={onPrimaryTypesChange}
        onClose={vi.fn()}
      />,
    );
    const removePlanBtn = screen.getByRole("button", { name: /remove plan from primary/i });
    fireEvent.click(removePlanBtn);
    expect(onPrimaryTypesChange).toHaveBeenCalledWith(["review", "edit", "snippet"]);
  });

  it("enforces cap of 4 primary: when adding a 5th, drops the oldest", () => {
    const onPrimaryTypesChange = vi.fn();
    // Start with exactly 4 primaries
    render(
      <MoreCustomizationSheet
        primaryTypes={["plan", "review", "edit", "snippet"]}
        onPrimaryTypesChange={onPrimaryTypesChange}
        onClose={vi.fn()}
      />,
    );
    // Promote "skill" (5th) — should drop "plan" (oldest at index 0)
    const addSkillBtn = screen.getByRole("button", { name: /add skill to primary/i });
    fireEvent.click(addSkillBtn);
    const [nextTypes] = onPrimaryTypesChange.mock.calls[0] as [ArtifactType[]];
    expect(nextTypes).toHaveLength(4);
    expect(nextTypes).not.toContain("plan");
    expect(nextTypes).toContain("skill");
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(
      <MoreCustomizationSheet primaryTypes={[]} onPrimaryTypesChange={vi.fn()} onClose={onClose} />,
    );
    const backdrop = document.querySelector("[aria-hidden='true']");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });
});
