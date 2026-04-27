/** M36 — phone Library at 375 × 667. */
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 667 } });

const TOKEN = "mobile-library-token";

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
    body: "## Step 1",
    body_format: "markdown",
    source_chat_id: "ns-1",
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T12:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
  },
];

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
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
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson(artifacts)));
  await context.route("**/api/containers/*/named-sessions", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
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
});

test("Library renders at phone with the chip row + card list (no sidebar)", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByText("Refactor plan")).toBeVisible();
  // Chip row has aria-label="Artifact type filter" (T10 spec fix)
  const chipRow = page.getByRole("group", { name: /artifact type filter/i });
  await expect(chipRow).toBeVisible();
});

test("Tap a card opens the detail with a back-arrow at phone", async ({ page }) => {
  await page.goto("/library");
  await page.getByText("Refactor plan").click();
  await expect(page.getByRole("button", { name: /back to library/i })).toBeVisible();
});

test("Back-arrow returns to the list", async ({ page }) => {
  await page.goto("/library");
  await page.getByText("Refactor plan").click();
  await page.getByRole("button", { name: /back to library/i }).click();
  // Card visible again in list; back-arrow gone
  await expect(page.getByText("Refactor plan")).toBeVisible();
  await expect(page.getByRole("button", { name: /back to library/i })).toBeHidden();
});

test("No horizontal scroll on the Library list at 375x667", async ({ page }) => {
  await page.goto("/library");
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(docWidth).toBeLessThanOrEqual(375);
});

test("MoreCustomizationSheet renders as a full-screen Sheet at phone", async ({ page }) => {
  await page.goto("/library");
  await page.getByRole("button", { name: /more filter options/i }).click();
  await expect(page.getByRole("dialog", { name: /customize artifact chips/i })).toBeVisible();
  // Sheet primitive's close button (T3)
  await expect(page.getByRole("button", { name: /close sheet/i })).toBeVisible();
});
