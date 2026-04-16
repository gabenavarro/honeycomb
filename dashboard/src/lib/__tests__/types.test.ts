import { describe, it, expect } from "vitest";
import type { ContainerRecord, ProjectType, ContainerStatus, AgentStatus } from "../types";

describe("Type definitions", () => {
  it("allows valid project types", () => {
    const types: ProjectType[] = ["base", "ml-cuda", "web-dev", "compbio"];
    expect(types).toHaveLength(4);
  });

  it("allows valid container statuses", () => {
    const statuses: ContainerStatus[] = ["running", "stopped", "starting", "error", "unknown"];
    expect(statuses).toHaveLength(5);
  });

  it("allows valid agent statuses", () => {
    const statuses: AgentStatus[] = ["idle", "busy", "error", "unreachable"];
    expect(statuses).toHaveLength(4);
  });

  it("ContainerRecord shape is correct", () => {
    const record: ContainerRecord = {
      id: 1,
      workspace_folder: "/test",
      project_type: "ml-cuda",
      project_name: "Test",
      project_description: "A test",
      git_repo_url: null,
      container_id: "abc123",
      container_status: "running",
      agent_status: "idle",
      agent_port: 9100,
      has_gpu: true,
      created_at: "2026-03-22T00:00:00",
      updated_at: "2026-03-22T00:00:00",
      has_claude_cli: false,
      claude_cli_checked_at: null,
    };
    expect(record.id).toBe(1);
    expect(record.has_gpu).toBe(true);
    expect(record.project_type).toBe("ml-cuda");
  });
});
