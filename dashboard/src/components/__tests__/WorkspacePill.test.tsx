/** WorkspacePill tests (M32). */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspacePill } from "../WorkspacePill";
import type { ContainerRecord } from "../../lib/types";

function fixture(over: Partial<ContainerRecord> = {}): ContainerRecord {
  return {
    id: 1,
    workspace_folder: "/repos/foo",
    project_type: "base",
    project_name: "foo",
    project_description: "",
    git_repo_url: null,
    container_id: "deadbeef",
    container_status: "running",
    agent_status: "idle",
    agent_port: 0,
    has_gpu: false,
    has_claude_cli: false,
    claude_cli_checked_at: null,
    created_at: "2026-04-26",
    updated_at: "2026-04-26",
    agent_expected: false,
    ...over,
  };
}

describe("WorkspacePill", () => {
  it("renders the active workspace name when present", () => {
    render(
      <WorkspacePill
        containers={[fixture({ id: 1, project_name: "foo" })]}
        activeContainerId={1}
        onSelectContainer={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /foo/ })).toBeTruthy();
  });

  it("renders 'No workspace' when activeContainerId is null", () => {
    render(
      <WorkspacePill
        containers={[fixture({ id: 1 })]}
        activeContainerId={null}
        onSelectContainer={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /No workspace/i })).toBeTruthy();
  });

  it("clicking the pill opens the picker popover", () => {
    render(
      <WorkspacePill
        containers={[
          fixture({ id: 1, project_name: "foo" }),
          fixture({ id: 2, project_name: "bar" }),
        ]}
        activeContainerId={1}
        onSelectContainer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /foo/ }));
    // Picker is rendered into a portal — check the document body
    const picker = within(document.body).getByRole("listbox", { name: /Workspaces/i });
    expect(picker).toBeTruthy();
    expect(within(document.body).getAllByRole("option")).toHaveLength(2);
  });

  it("selecting a row in the popover calls onSelectContainer + closes the popover", () => {
    const onSelect = vi.fn();
    render(
      <WorkspacePill
        containers={[
          fixture({ id: 1, project_name: "foo" }),
          fixture({ id: 2, project_name: "bar" }),
        ]}
        activeContainerId={1}
        onSelectContainer={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /foo/ }));
    // Click the bar row inside the listbox
    fireEvent.click(within(document.body).getByRole("option", { name: /bar/ }));
    expect(onSelect).toHaveBeenCalledWith(2);
    // After close, listbox should be gone from the body
    expect(within(document.body).queryByRole("listbox", { name: /Workspaces/i })).toBeNull();
  });
});
