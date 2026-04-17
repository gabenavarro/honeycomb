/** Unreachable-banner suppression for non-agent-expected containers (M13).
 *
 * Regression guard: a container registered via the Discover tab with
 * ``agent_expected=false`` must not surface the yellow
 * "{name} is unreachable" banner, even when its ``agent_status`` is
 * ``unreachable`` (which is the legitimate steady state for a container
 * that never installed hive-agent).
 */

import { expect, test } from "@playwright/test";

const TOKEN = "banner-token";

const baseRecord = {
  id: 7,
  workspace_folder: "/workspace/kibra",
  project_type: "base",
  project_name: "kibra-peptide-analysis",
  project_description: "",
  git_repo_url: null,
  container_id: "de8317b49bcb",
  container_status: "running",
  agent_status: "unreachable",
  agent_port: 9100,
  has_gpu: false,
  has_claude_cli: false,
  claude_cli_checked_at: null,
  created_at: "2026-04-17T12:00:00",
  updated_at: "2026-04-17T12:00:00",
};

test.describe("Unreachable banner — agent_expected=false", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(
      ([t, openTab, activeTab]) => {
        try {
          window.localStorage.setItem("hive:auth:token", t);
          window.localStorage.setItem("hive:layout:openTabs", openTab);
          window.localStorage.setItem("hive:layout:activeTab", activeTab);
        } catch {
          // ignore
        }
      },
      [TOKEN, "[7]", "7"],
    );

    const mockJson = (data: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });

    await context.route("**/api/gitops/prs**", (route) => route.fulfill(mockJson([])));
    await context.route("**/api/gitops/repos**", (route) => route.fulfill(mockJson([])));
    await context.route("**/api/problems**", (route) => route.fulfill(mockJson({ problems: [] })));
    await context.route("**/api/settings", (route) =>
      route.fulfill(
        mockJson({
          values: { log_level: "INFO", discover_roots: [], metrics_enabled: true },
          mutable_fields: ["log_level", "discover_roots", "metrics_enabled"],
        }),
      ),
    );
    await context.route("**/api/keybindings**", (route) =>
      route.fulfill(mockJson({ bindings: {} })),
    );
    await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
  });

  test("does NOT render the banner when agent_expected is false", async ({ context, page }) => {
    await context.route("**/api/containers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ ...baseRecord, agent_expected: false }]),
      }),
    );
    await page.goto("/");

    // Tab header should mount for the active container.
    await expect(page.getByText("kibra-peptide-analysis").first()).toBeVisible();
    // No unreachable banner anywhere.
    await expect(page.getByText(/is unreachable/i)).toHaveCount(0);
  });

  test("DOES render the banner when agent_expected is true", async ({ context, page }) => {
    await context.route("**/api/containers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ ...baseRecord, agent_expected: true }]),
      }),
    );
    await page.goto("/");

    await expect(page.getByText(/is unreachable/i)).toBeVisible();
  });
});
