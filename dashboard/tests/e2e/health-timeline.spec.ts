/** M25 — container-health timeline end-to-end.
 *
 * Stubs ``/resources/history`` and ``/resources`` to drive the
 * sparkline render, then asserts the strip is visible and its
 * click opens the ResourceMonitor popover. Also verifies that
 * flipping ``timeline_visible`` to false hides the strip.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "health-timeline-token";

const containerFixture = {
  id: 7,
  workspace_folder: "/w",
  project_type: "base",
  project_name: "demo",
  project_description: "",
  git_repo_url: null,
  container_id: "dead",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: false,
  claude_cli_checked_at: null,
  created_at: "2026-04-19",
  updated_at: "2026-04-19",
  agent_expected: false,
};

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function seedAuthAndSharedRoutes(
  context: import("@playwright/test").BrowserContext,
  settingsOverride?: Record<string, unknown>,
) {
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

  await context.route("**/api/containers", (route) =>
    route.fulfill(mockJson([containerFixture])),
  );
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/gitops/prs**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/problems**", (route) => route.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (route) =>
    route.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: true,
          ...(settingsOverride ?? {}),
        },
        mutable_fields: [
          "log_level",
          "discover_roots",
          "metrics_enabled",
          "timeline_visible",
        ],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) =>
    route.fulfill(mockJson({ bindings: {} })),
  );
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  // Stub fs routes so unhandled ones don't fall through to the hub and
  // return 401 (which would clear the test token and open the AuthGate).
  await context.route("**/api/containers/7/fs/**", (route) =>
    route.fulfill(mockJson(null)),
  );
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
}

async function seedTimelineRoutes(
  context: import("@playwright/test").BrowserContext,
) {
  const history = Array.from({ length: 12 }, (_v, i) => ({
    container_id: "dead",
    cpu_percent: i * 5,
    memory_mb: 100,
    memory_limit_mb: 1024,
    memory_percent: 20 + i,
    gpu_utilization: null,
    gpu_memory_mb: null,
    gpu_memory_total_mb: null,
    timestamp: `2026-04-19T00:00:${String(i).padStart(2, "0")}`,
  }));
  await context.route("**/api/containers/7/resources/history", (route) =>
    route.fulfill(mockJson(history)),
  );
  await context.route("**/api/containers/7/resources", (route) =>
    route.fulfill(
      mockJson({
        container_id: "dead",
        cpu_percent: 60,
        memory_mb: 130,
        memory_limit_mb: 1024,
        memory_percent: 34,
        gpu_utilization: null,
        gpu_memory_mb: null,
        gpu_memory_total_mb: null,
        timestamp: "2026-04-19T00:01:00",
      }),
    ),
  );
}

test("timeline strip renders and click opens the resource monitor popover", async ({
  context,
  page,
}) => {
  await seedAuthAndSharedRoutes(context);
  await seedTimelineRoutes(context);

  await page.goto("/");

  // The timeline strip renders as a button. Scope label assertions inside it
  // to avoid strict-mode violations (MEM / CPU also appear in ResourcePill).
  const strip = page.getByRole("button", { name: /open resource monitor/i });
  await expect(strip).toBeVisible();
  await expect(strip.getByText("CPU")).toBeVisible();
  await expect(strip.getByText("MEM")).toBeVisible();
  await expect(strip.getByText("GPU")).toBeVisible();

  // Click the timeline to open the popover. The popover Content
  // renders inside a Radix Portal with role="dialog".
  await strip.click();
  await expect(page.locator("[role='dialog']").first()).toBeVisible();
});

test("timeline strip hides when timeline_visible is false", async ({
  context,
  page,
}) => {
  await seedAuthAndSharedRoutes(context, { timeline_visible: false });
  await seedTimelineRoutes(context);

  await page.goto("/");
  // Timeline button should not be present when the setting is off.
  await expect(
    page.getByRole("button", { name: /open resource monitor/i }),
  ).toHaveCount(0);
});
