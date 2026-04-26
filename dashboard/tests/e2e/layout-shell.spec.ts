/** M32 layout-shell end-to-end.
 *
 * Verifies:
 *   1. Default boot lands on /chats (root redirects)
 *   2. Clicking each rail entry navigates to the corresponding route
 *   3. ⌘1/⌘2/⌘3/⌘, keyboard shortcuts route correctly
 *   4. ⌘K palette's "Go to X" entries route correctly
 *   5. WorkspacePill click → picker opens → row click → workspace switches
 *   6. Reviews counter on Chats reflects open PR count from the GitOps query
 *   7. axe-core scan passes on the new ActivityBar in DARK theme
 *   8. axe-core scan passes on the new ActivityBar in LIGHT theme
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "layout-shell-token";

const containerA = {
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
};

const containerB = { ...containerA, id: 2, project_name: "bar", workspace_folder: "/repos/bar" };

const prFixture = {
  number: 42,
  title: "Test PR",
  state: "open",
  url: "https://example.com/pr/42",
  repo_dir: "/repos/foo",
  head_branch: "feat/xyz",
  base_branch: "main",
  author: "alice",
  draft: false,
  mergeable_state: "clean",
};

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );

  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerA, containerB])));
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
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([prFixture])));
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
  await context.route("**/ws**", (r) => r.fulfill({ status: 404 }));
});

test("default boot lands on /chats (root redirects)", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/chats$/);
});

test("clicking rail entries navigates to each route", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page).toHaveURL(/\/files$/);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Chats" }).click();
  await expect(page).toHaveURL(/\/chats$/);
});

test("⌘1/⌘2/⌘3/⌘, keyboard shortcuts route correctly", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+2");
  await expect(page).toHaveURL(/\/library$/);
  await page.keyboard.press("Control+3");
  await expect(page).toHaveURL(/\/files$/);
  await page.keyboard.press("Control+,");
  await expect(page).toHaveURL(/\/settings$/);
  await page.keyboard.press("Control+1");
  await expect(page).toHaveURL(/\/chats$/);
});

test("⌘K 'Go to Files' palette command routes to /files", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  await page.getByText(/Go to Files/i).click();
  await expect(page).toHaveURL(/\/files$/);
});

test("WorkspacePill: click pill → click bar in picker → active changes to bar", async ({
  page,
}) => {
  await page.goto("/");
  // Select container 'foo' first from the container list so the pill renders that label.
  // ContainerList renders items as <li role="option"> — click the project name text.
  await page
    .locator('[role="listbox"][aria-label="Containers"] [role="option"]')
    .filter({ hasText: "foo" })
    .click();
  // Click the pill (top of Chats main pane). WorkspacePill wraps its
  // trigger in a div with border-b; scope to that wrapper to avoid
  // colliding with the Breadcrumbs segment button (same text, no aria-label).
  const pillWrapper = page.locator("div.border-b.border-edge.bg-pane").first();
  const pill = pillWrapper.getByRole("button", { name: /^foo$/ });
  await pill.click();
  // Picker is in a Radix Portal; wait for the listbox
  await expect(page.getByRole("listbox", { name: /Workspaces/i })).toBeVisible();
  // Click the 'bar' row in the Workspaces picker (not the ContainerList listbox)
  await page
    .getByRole("listbox", { name: /Workspaces/i })
    .getByRole("option", { name: /bar/ })
    .click();
  // Pill now reads 'bar'
  await expect(pillWrapper.getByRole("button", { name: /^bar$/ })).toBeVisible();
});

test("Reviews counter on Chats matches open PR count", async ({ page }) => {
  await page.goto("/");
  // The fixture includes one open PR — Chats button should show "1"
  const chats = page.getByRole("button", { name: "Chats" });
  await expect(chats).toContainText("1");
});

test("Activity rail passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/");
  // Ensure dark explicitly (in case test env prefers-color-scheme is light)
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  const results = await new AxeBuilder({ page })
    .include('nav[aria-label="Activity bar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Activity rail passes axe-core in light theme", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
  });
  const results = await new AxeBuilder({ page })
    .include('nav[aria-label="Activity bar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
