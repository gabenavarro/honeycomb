/** ChatHeader tests (M33). */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatHeader } from "../ChatHeader";
import type { ContainerRecord } from "../../../lib/types";

beforeEach(() => {
  window.localStorage.clear();
});

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

describe("ChatHeader", () => {
  it("renders the workspace pill, mode toggle, model chip, and three action buttons", () => {
    render(
      <ChatHeader
        sessionId="s1"
        containers={[fixture({ id: 1, project_name: "foo" })]}
        activeContainerId={1}
        onSelectContainer={vi.fn()}
      />,
    );
    // WorkspacePill trigger
    expect(screen.getByRole("button", { name: /foo/ })).toBeTruthy();
    // ModeToggle radiogroup
    expect(screen.getByRole("radiogroup", { name: "Chat mode" })).toBeTruthy();
    // ModelChip — identified by title
    expect(screen.getByTitle(/Model selection/)).toBeTruthy();
    // Three icon action buttons
    expect(screen.getByRole("button", { name: "Chat history" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compact context" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });
});
