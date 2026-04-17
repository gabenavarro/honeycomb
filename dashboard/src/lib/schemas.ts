/** Runtime schemas for every REST response the dashboard consumes (M9).
 *
 * The hand-written ``types.ts`` gives us TypeScript guarantees at
 * compile time; these zod schemas give us the matching *runtime* check
 * so a hub-side schema drift surfaces as a single warning line in the
 * console instead of N render errors deep inside components.
 *
 * The API wrapper in ``api.ts`` runs ``.safeParse`` on every response —
 * if parsing fails the raw payload is returned with a console warning,
 * so a benign extra field on the hub side doesn't break the dashboard.
 */

import { z } from "zod";

export const ProjectTypeSchema = z.enum(["base", "ml-cuda", "web-dev", "compbio"]);
export const ContainerStatusSchema = z.enum(["running", "stopped", "starting", "error", "unknown"]);
export const AgentStatusSchema = z.enum(["idle", "busy", "error", "unreachable"]);

export const ContainerRecordSchema = z
  .object({
    id: z.number(),
    workspace_folder: z.string(),
    project_type: ProjectTypeSchema,
    project_name: z.string(),
    project_description: z.string(),
    git_repo_url: z.string().nullable(),
    container_id: z.string().nullable(),
    container_status: ContainerStatusSchema,
    agent_status: AgentStatusSchema,
    // M13. Legacy servers without this field default to true so the
    // dashboard preserves the pre-M13 behaviour against an older hub.
    agent_expected: z.boolean().default(true),
    agent_port: z.number(),
    has_gpu: z.boolean(),
    has_claude_cli: z.boolean(),
    claude_cli_checked_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const ContainerRecordListSchema = z.array(ContainerRecordSchema);

export const WorkspaceCandidateSchema = z
  .object({
    workspace_folder: z.string(),
    project_name: z.string(),
    inferred_project_type: ProjectTypeSchema,
    has_dockerfile: z.boolean(),
    has_claude_md: z.boolean(),
    devcontainer_path: z.string(),
  })
  .passthrough();

export const ContainerCandidateSchema = z
  .object({
    container_id: z.string(),
    name: z.string(),
    image: z.string(),
    status: z.string(),
    inferred_workspace_folder: z.string().nullable(),
    inferred_project_name: z.string(),
    inferred_project_type: ProjectTypeSchema,
    has_hive_agent: z.boolean(),
    agent_port: z.number().nullable(),
  })
  .passthrough();

export const DiscoveryResponseSchema = z
  .object({
    workspaces: z.array(WorkspaceCandidateSchema),
    containers: z.array(ContainerCandidateSchema),
    discover_roots: z.array(z.string()),
  })
  .passthrough();

export const ResourceStatsSchema = z
  .object({
    container_id: z.string(),
    cpu_percent: z.number(),
    memory_mb: z.number(),
    memory_limit_mb: z.number(),
    memory_percent: z.number(),
    gpu_utilization: z.number().nullable(),
    gpu_memory_mb: z.number().nullable(),
    gpu_memory_total_mb: z.number().nullable(),
    timestamp: z.string(),
  })
  .passthrough();

export const CommandResponseSchema = z
  .object({
    command_id: z.string(),
    pid: z.number().nullable(),
    status: z.string(),
    relay_path: z.enum(["agent", "devcontainer_exec", "docker_exec"]),
    exit_code: z.number().nullable(),
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
  })
  .passthrough();

export const RepoStatusSchema = z
  .object({
    workspace_folder: z.string(),
    repo_url: z.string().nullable(),
    branch: z.string(),
    ahead: z.number(),
    behind: z.number(),
    has_upstream: z.boolean(),
    dirty: z.boolean(),
    untracked_count: z.number(),
    modified_count: z.number(),
    staged_count: z.number(),
    open_pr_count: z.number(),
    last_commit_message: z.string(),
    last_commit_date: z.string(),
  })
  .passthrough();

export const RepoStatusListSchema = z.array(RepoStatusSchema);

export const PullRequestSummarySchema = z
  .object({
    repo: z.string(),
    number: z.number(),
    title: z.string(),
    author: z.string(),
    state: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    url: z.string(),
    review_status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    changed_files: z.number(),
  })
  .passthrough();

export const PullRequestListSchema = z.array(PullRequestSummarySchema);

export const HubHealthSchema = z
  .object({
    status: z.string(),
    version: z.string(),
    registered_containers: z.number(),
  })
  .passthrough();

/** Runtime-validate a hub response against ``schema``. On success,
 * returns the parsed value (which is structurally identical to ``data``
 * because of ``.passthrough()``). On failure, logs the issue list and
 * returns ``data`` unchanged so the UI keeps rendering.
 *
 * We deliberately do *not* throw on mismatch: the hand-written
 * ``types.ts`` is the authoritative compile-time contract. The zod
 * schemas are a safety net, not a gate. */
export function validateResponse<T>(schema: z.ZodType<T>, path: string, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  console.warn(`[hive-api] schema mismatch on ${path}`, result.error.issues);
  return data as T;
}
