/** M35 Library end-to-end. */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "library-token";

const containerFixture = {
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
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const artifacts = [
  {
    artifact_id: "a-plan-1",
    container_id: 1,
    type: "plan",
    title: "Refactor plan",
    body: "## Step 1\n\nDo the thing.",
    body_format: "markdown",
    source_chat_id: "ns-1",
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T12:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
  },
  {
    artifact_id: "a-snip-1",
    container_id: 1,
    type: "snippet",
    title: "python snippet (3 lines)",
    body: "import os\nprint(os.getcwd())\nos.exit(0)",
    body_format: "python",
    source_chat_id: null,
    source_message_id: null,
    metadata: { language: "python", line_count: 3 },
    pinned: false,
    archived: false,
    created_at: "2026-04-26T11:00:00Z",
    updated_at: "2026-04-26T11:00:00Z",
  },
];

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    (window as unknown as { __playwright_test: boolean }).__playwright_test = true;
  });
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );

  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/named-sessions", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/problems**", (r) => r.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (r) =>
    r.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (r) => r.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (r) => r.fulfill(mockJson({ status: "ok" })));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson(artifacts)));
});

test("Library renders empty state when no artifacts", async ({ page, context }) => {
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson([])));
  await page.goto("/library");
  await expect(page.getByText(/No artifacts yet/i)).toBeVisible();
});

test("Library renders artifact cards in the sidebar", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByText("Refactor plan")).toBeVisible();
  await expect(page.getByText("python snippet (3 lines)")).toBeVisible();
});

test("Clicking a card opens the renderer in main pane", async ({ page }) => {
  await page.goto("/library");
  await page.getByText("Refactor plan").click();
  await expect(page.getByText("Step 1")).toBeVisible();
  await expect(page.getByRole("button", { name: /Open in chat/i })).toBeVisible();
});

test("Filter chip click filters the artifact list (calls API with type=)", async ({
  page,
  context,
}) => {
  let lastRequestUrl: string | null = null;
  await context.route("**/api/containers/*/artifacts**", (r) => {
    lastRequestUrl = r.request().url();
    return r.fulfill(mockJson(artifacts));
  });
  await page.goto("/library");
  // Scope the Plan chip to the filter chip row to avoid matching "Refactor plan" card title.
  const chipRow = page.locator('aside[aria-label="Library sidebar"] > div').first();
  await chipRow.getByRole("button", { name: /^Plan/i }).click();
  await page.waitForTimeout(200);
  expect(lastRequestUrl).toContain("type=plan");
});

test("Library passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/library");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const results = await new AxeBuilder({ page })
    .include('aside[aria-label="Library sidebar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Library passes axe-core in light theme", async ({ page }) => {
  await page.goto("/library");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const results = await new AxeBuilder({ page })
    .include('aside[aria-label="Library sidebar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

// TODO(M36): Recover e2e coverage for the DiffViewerTab (row-click → viewer →
// Split toggle → Copy-patch toast). The original diff-events.spec.ts
// (deleted in T13, ref: git show 7f8f6dd:dashboard/tests/e2e/diff-events.spec.ts)
// assumed DiffEventsActivity was bridge content inside LibraryRoute. After the
// M35 lift, LibraryRoute renders LibraryActivity exclusively; DiffEventsActivity
// now lives in ChatsRoute (mounted under openedDiffEvent state in App.tsx).
// Recovering the spec requires navigating to "/" with a seeded diff-event,
// clicking through the ChatsRoute's sidebar row to open DiffViewerTab — a
// different shape from the Library tests above. Defer to a standalone
// diff-events-viewer.spec.ts in M36.
