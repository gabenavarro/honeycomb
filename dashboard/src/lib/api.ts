/** API client for the Claude Hive hub. */

import { clearAuthToken, getAuthToken, UnauthorizedError } from "./auth";
import type {
  CommandResponse,
  ContainerCreate,
  ContainerRecord,
  DiscoverRegisterRequest,
  DiscoveryResponse,
  HubHealth,
  PullRequestSummary,
  RepoStatus,
  ResourceStats,
} from "./types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    // Stale / missing token. Clear it so the AuthGate re-prompts, and
    // throw a dedicated error so UI can distinguish from "real" failures.
    clearAuthToken();
    const body = await res.text().catch(() => "");
    throw new UnauthorizedError(body || "Unauthorized");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

// --- Health ---
export const getHealth = () => request<HubHealth>("/health");

// --- Containers ---
export const listContainers = () => request<ContainerRecord[]>("/containers");

export const getContainer = (id: number) => request<ContainerRecord>(`/containers/${id}`);

export const createContainer = (data: ContainerCreate) =>
  request<ContainerRecord>("/containers", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const deleteContainer = (id: number, force = false) =>
  request<{ deleted: boolean }>(`/containers/${id}?force=${force}`, {
    method: "DELETE",
  });

export const startContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}/start`, { method: "POST" });

export const stopContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}/stop`, { method: "POST" });

export const rebuildContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}/rebuild`, { method: "POST" });

export interface InstallClaudeCliResult {
  installed: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}
export const installClaudeCli = (id: number) =>
  request<InstallClaudeCliResult>(`/containers/${id}/install-claude-cli`, {
    method: "POST",
  });

export const getResources = (id: number) =>
  request<ResourceStats | null>(`/containers/${id}/resources`);

// --- Commands ---
export const execCommand = (containerId: number, command: string) =>
  request<CommandResponse>(`/containers/${containerId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
  });

// --- Discovery ---
export const discoverAll = () => request<DiscoveryResponse>("/discover");

export const registerDiscovered = (data: DiscoverRegisterRequest) =>
  request<ContainerRecord>("/discover/register", {
    method: "POST",
    body: JSON.stringify(data),
  });

// --- GitOps ---
export const listRepos = () => request<RepoStatus[]>("/gitops/repos");

export const listPRs = (state = "open") =>
  request<PullRequestSummary[]>(`/gitops/prs?state=${state}`);

export const mergePR = (
  owner: string,
  repo: string,
  number: number,
  method: "merge" | "squash" | "rebase" = "squash",
  delete_branch = true,
) =>
  request<{ status: string; method: string; pr: number }>(
    `/gitops/prs/${owner}/${repo}/${number}/merge?method=${method}&delete_branch=${delete_branch}`,
    { method: "POST" },
  );

export const reviewPR = (
  owner: string,
  repo: string,
  number: number,
  action: "approve" | "request-changes" | "comment",
  body = "",
) =>
  request<{ status: string; pr: number }>(`/gitops/prs/${owner}/${repo}/${number}/review`, {
    method: "POST",
    body: JSON.stringify({ action, body }),
  });

export const commitChanges = (
  workspace_folder: string,
  message: string,
  files?: string[],
  push_after = true,
) =>
  request<{ success: boolean; commit_hash: string; message: string }>("/gitops/commit", {
    method: "POST",
    body: JSON.stringify({ workspace_folder, message, files, push_after }),
  });
