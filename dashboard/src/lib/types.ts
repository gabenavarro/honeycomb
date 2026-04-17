/** Shared types matching the hub API schemas. */

export type ProjectType = "base" | "ml-cuda" | "web-dev" | "compbio";
export type ContainerStatus = "running" | "stopped" | "starting" | "error" | "unknown";
export type AgentStatus = "idle" | "busy" | "error" | "unreachable";

export interface ContainerRecord {
  id: number;
  workspace_folder: string;
  project_type: ProjectType;
  project_name: string;
  project_description: string;
  git_repo_url: string | null;
  container_id: string | null;
  container_status: ContainerStatus;
  agent_status: AgentStatus;
  agent_port: number;
  has_gpu: boolean;
  has_claude_cli: boolean;
  claude_cli_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContainerCreate {
  workspace_folder: string;
  project_type: ProjectType;
  project_name: string;
  project_description?: string;
  git_repo_url?: string;
  auto_provision?: boolean;
  auto_start?: boolean;
  force_gpu?: boolean;
}

// --- Discovery ---

export interface WorkspaceCandidate {
  workspace_folder: string;
  project_name: string;
  inferred_project_type: ProjectType;
  has_dockerfile: boolean;
  has_claude_md: boolean;
  devcontainer_path: string;
}

export interface ContainerCandidate {
  container_id: string;
  name: string;
  image: string;
  status: string;
  inferred_workspace_folder: string | null;
  inferred_project_name: string;
  inferred_project_type: ProjectType;
  has_hive_agent: boolean;
  agent_port: number | null;
}

export interface DiscoveryResponse {
  workspaces: WorkspaceCandidate[];
  containers: ContainerCandidate[];
  discover_roots: string[];
}

export interface DiscoverRegisterRequest {
  workspace_folder?: string;
  container_id?: string;
  project_name: string;
  project_type: ProjectType;
  project_description?: string;
  auto_provision?: boolean;
  auto_start?: boolean;
  force_gpu?: boolean;
}

export interface ResourceStats {
  container_id: string;
  cpu_percent: number;
  memory_mb: number;
  memory_limit_mb: number;
  memory_percent: number;
  gpu_utilization: number | null;
  gpu_memory_mb: number | null;
  gpu_memory_total_mb: number | null;
  timestamp: string;
}

export interface CommandResponse {
  command_id: string;
  pid: number | null;
  status: string;
  relay_path: "agent" | "devcontainer_exec" | "docker_exec";
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
}

export interface RepoStatus {
  workspace_folder: string;
  repo_url: string | null;
  branch: string;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  dirty: boolean;
  untracked_count: number;
  modified_count: number;
  staged_count: number;
  open_pr_count: number;
  last_commit_message: string;
  last_commit_date: string;
}

export interface PullRequestSummary {
  repo: string;
  number: number;
  title: string;
  author: string;
  state: string;
  created_at: string;
  updated_at: string;
  url: string;
  review_status: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface WSFrame {
  channel: string;
  event: string;
  data: unknown;
}

export interface HubHealth {
  status: string;
  version: string;
  registered_containers: number;
}

// M10 — Settings/Problems/SourceControl/Keybindings

export interface HubSettings {
  values: Record<string, unknown>;
  mutable_fields: string[];
}

export interface HubSettingsPatch {
  log_level?: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  discover_roots?: string[];
  metrics_enabled?: boolean;
}

export type ProblemSeverity = "info" | "warning" | "error";
export type ProblemSource = "health" | "agent" | "relay" | "registry" | "other";

export interface Problem {
  id: number;
  severity: ProblemSeverity;
  source: ProblemSource;
  message: string;
  container_id: string | null;
  project_name: string | null;
  created_at: string;
}

export interface GitFileStatus {
  workspace_folder: string;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface KeybindingsPayload {
  bindings: Record<string, string>;
}
