/** API client for the Claude Hive hub.
 *
 * Every response is fed through a zod schema (M9). On a schema mismatch
 * we log to the console and return the raw payload — the dashboard
 * keeps rendering instead of a cascade of undefined-property errors. */

import { clearAuthToken, getAuthToken, UnauthorizedError } from "./auth";
import {
  CommandResponseSchema,
  ContainerRecordListSchema,
  ContainerRecordSchema,
  DiscoveryResponseSchema,
  HubHealthSchema,
  PullRequestListSchema,
  RepoStatusListSchema,
  ResourceStatsSchema,
  validateResponse,
} from "./schemas";
import type {
  CommandResponse,
  ContainerCreate,
  ContainerRecord,
  ContainerWorkdir,
  DirectoryListing,
  DiscoverRegisterRequest,
  DiscoveryResponse,
  FileContent,
  GitFileStatus,
  HubHealth,
  HubSettings,
  HubSettingsPatch,
  KeybindingsPayload,
  Problem,
  PullRequestSummary,
  RepoStatus,
  ResourceStats,
} from "./types";
import { z } from "zod";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit, schema?: z.ZodType<T>): Promise<T> {
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
  const json = (await res.json()) as unknown;
  if (schema) return validateResponse(schema, path, json);
  return json as T;
}

// --- Health ---
export const getHealth = () => request<HubHealth>("/health", undefined, HubHealthSchema);

// --- Containers ---
export const listContainers = () =>
  request<ContainerRecord[]>("/containers", undefined, ContainerRecordListSchema);

export const getContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}`, undefined, ContainerRecordSchema);

export const createContainer = (data: ContainerCreate) =>
  request<ContainerRecord>(
    "/containers",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    ContainerRecordSchema,
  );

export const deleteContainer = (id: number, force = false) =>
  request<{ deleted: boolean }>(`/containers/${id}?force=${force}`, {
    method: "DELETE",
  });

export const startContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}/start`, { method: "POST" }, ContainerRecordSchema);

export const stopContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}/stop`, { method: "POST" }, ContainerRecordSchema);

export const rebuildContainer = (id: number) =>
  request<ContainerRecord>(`/containers/${id}/rebuild`, { method: "POST" }, ContainerRecordSchema);

/** M21 J — partial update. Today only rename (``project_name``) is
 * used from the dashboard, but the endpoint accepts every field in
 * ``ContainerUpdate`` so this signature keeps wider updates a line away. */
export interface ContainerPatch {
  project_name?: string;
  project_description?: string;
  git_repo_url?: string | null;
  agent_port?: number;
}
export const patchContainer = (id: number, patch: ContainerPatch) =>
  request<ContainerRecord>(
    `/containers/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    ContainerRecordSchema,
  );

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
  request<ResourceStats | null>(
    `/containers/${id}/resources`,
    undefined,
    // The resources endpoint returns null when stats aren't available
    // yet — tolerate that without a schema warning.
    ResourceStatsSchema.nullable(),
  );

// --- Commands ---
export const execCommand = (containerId: number, command: string) =>
  request<CommandResponse>(
    `/containers/${containerId}/commands`,
    {
      method: "POST",
      body: JSON.stringify({ command }),
    },
    CommandResponseSchema,
  );

// --- Discovery ---
export const discoverAll = () =>
  request<DiscoveryResponse>("/discover", undefined, DiscoveryResponseSchema);

export const registerDiscovered = (data: DiscoverRegisterRequest) =>
  request<ContainerRecord>(
    "/discover/register",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    ContainerRecordSchema,
  );

// --- GitOps ---
export const listRepos = () =>
  request<RepoStatus[]>("/gitops/repos", undefined, RepoStatusListSchema);

export const listPRs = (state = "open") =>
  request<PullRequestSummary[]>(`/gitops/prs?state=${state}`, undefined, PullRequestListSchema);

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

// --- M10 endpoints ---

export const getSettings = () => request<HubSettings>("/settings");

export const patchSettings = (patch: HubSettingsPatch) =>
  request<HubSettings>("/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const listProblems = () => request<{ problems: Problem[] }>("/problems");

export const clearProblems = () => request<{ cleared: boolean }>("/problems", { method: "DELETE" });

export const getRepoFileStatus = (workspaceFolder: string) => {
  // workspace_folder is treated as a path param; strip the leading slash
  // because FastAPI's path converter expects it relative.
  const stripped = workspaceFolder.startsWith("/") ? workspaceFolder.slice(1) : workspaceFolder;
  return request<GitFileStatus>(`/gitops/status/${stripped}`);
};

export const getKeybindings = () => request<KeybindingsPayload>("/keybindings");

export const putKeybindings = (bindings: Record<string, string>) =>
  request<KeybindingsPayload>("/keybindings", {
    method: "PUT",
    body: JSON.stringify({ bindings }),
  });

// --- M17 endpoints (container filesystem browse) ---

export const getContainerWorkdir = (id: number) =>
  request<ContainerWorkdir>(`/containers/${id}/workdir`);

export const listContainerDirectory = (id: number, path: string) =>
  request<DirectoryListing>(`/containers/${id}/fs?path=${encodeURIComponent(path)}`);

export const readContainerFile = (id: number, path: string) =>
  request<FileContent>(`/containers/${id}/fs/read?path=${encodeURIComponent(path)}`);

export function containerFileDownloadUrl(id: number, path: string): string {
  // Returns the hub URL the browser should GET directly (auth header
  // attached via the user's active fetch token is handled by the
  // ``request`` wrapper in the normal-preview path — for downloads we
  // use a new-tab navigation and rely on the session's cookie/header
  // already existing). Callers should preferentially use a fetch-based
  // blob download instead; this helper exists for the "open in new
  // tab" hint link.
  return `/api/containers/${id}/fs/download?path=${encodeURIComponent(path)}`;
}

export interface ContainerSessionInfo {
  session_id: string;
  container_id: string;
  cols: number;
  rows: number;
  attached: boolean;
  detached_for_seconds: number | null;
}

export const listContainerSessions = (id: number) =>
  request<{ sessions: ContainerSessionInfo[] }>(`/containers/${id}/sessions`);

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
