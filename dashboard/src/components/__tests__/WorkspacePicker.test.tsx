/** WorkspacePicker tests (M32). */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspacePicker } from "../WorkspacePicker";
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

describe("WorkspacePicker", () => {
  it("renders a row for each container with name + workspace folder", () => {
    const containers = [
      fixture({ id: 1, project_name: "foo", workspace_folder: "/repos/foo" }),
      fixture({ id: 2, project_name: "bar", workspace_folder: "/repos/bar" }),
    ];
    render(<WorkspacePicker containers={containers} activeContainerId={1} onSelect={vi.fn()} />);
    // Project names render exactly (not as substrings) inside their own span
    const opts = screen.getAllByRole("option");
    expect(opts).toHaveLength(2);
    expect(opts[0].textContent).toContain("foo");
    expect(opts[0].textContent).toContain("/repos/foo");
    expect(opts[1].textContent).toContain("bar");
    expect(opts[1].textContent).toContain("/repos/bar");
  });

  it("the active workspace is marked aria-current", () => {
    const containers = [fixture({ id: 1 }), fixture({ id: 2, project_name: "bar" })];
    render(<WorkspacePicker containers={containers} activeContainerId={2} onSelect={vi.fn()} />);
    const rows = screen.getAllByRole("option");
    const active = rows.find((r) => r.getAttribute("aria-current") === "true");
    expect(active?.textContent).toContain("bar");
  });

  it("clicking a row calls onSelect with that container's id", () => {
    const onSelect = vi.fn();
    const containers = [fixture({ id: 1 }), fixture({ id: 2, project_name: "bar" })];
    render(<WorkspacePicker containers={containers} activeContainerId={1} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("option", { name: /bar/ }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("renders an empty state when no containers", () => {
    render(<WorkspacePicker containers={[]} activeContainerId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/No workspaces/i)).toBeTruthy();
  });

  it("status dot color follows container_status", () => {
    const containers = [
      fixture({ id: 1, project_name: "running-one", container_status: "running" }),
      fixture({ id: 2, project_name: "stopped-one", container_status: "stopped" }),
    ];
    render(<WorkspacePicker containers={containers} activeContainerId={1} onSelect={vi.fn()} />);
    const dots = document.querySelectorAll('[data-testid="workspace-status-dot"]');
    expect(dots.length).toBe(2);
    expect(dots[0].getAttribute("data-state")).toBe("ok");
    expect(dots[1].getAttribute("data-state")).toBe("stopped");
  });
});
