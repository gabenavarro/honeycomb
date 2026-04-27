/** M36 — phone chat chrome at 375 × 667.
 *
 * NOTE: PhoneChatList / PhoneChatDetail are shipped as components
 * but NOT integrated into ChatsRoute (deferred to M36.x). This spec
 * tests only the M36 wiring that DID land: PhoneTabBar visibility,
 * ActivityBar hidden, no horizontal scroll, tab navigation.
 */
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 667 } });

const TOKEN = "mobile-chat-token";

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
  await context.route("**/api/containers/*/named-sessions", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson([])));
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

test("PhoneTabBar renders 5 tabs at 375x667", async ({ page }) => {
  await page.goto("/chats");
  // Scope to the PhoneTabBar nav so we don't accidentally match the activity bar (which is hidden but might still be queryable in some scoping)
  const tabBar = page.getByRole("navigation", { name: /phone bottom navigation/i });
  await expect(tabBar).toBeVisible();
  await expect(tabBar.getByRole("button", { name: /chats/i })).toBeVisible();
  await expect(tabBar.getByRole("button", { name: /library/i })).toBeVisible();
  await expect(tabBar.getByRole("button", { name: /files/i })).toBeVisible();
  await expect(tabBar.getByRole("button", { name: /git/i })).toBeVisible();
  await expect(tabBar.getByRole("button", { name: /more/i })).toBeVisible();
});

test("ActivityBar is hidden at phone", async ({ page }) => {
  await page.goto("/chats");
  // The activity rail should not be in the layout at phone (CSS-hidden via T5).
  const rail = page.getByRole("navigation", { name: /activity bar|activity rail/i });
  await expect(rail).toBeHidden();
});

test("PhoneTabBar's Library tab navigates to /library", async ({ page }) => {
  await page.goto("/chats");
  const tabBar = page.getByRole("navigation", { name: /phone bottom navigation/i });
  await tabBar.getByRole("button", { name: /library/i }).click();
  await expect(page).toHaveURL(/\/library/);
});

test("PhoneTabBar's active tab carries aria-current=page", async ({ page }) => {
  await page.goto("/chats");
  const tabBar = page.getByRole("navigation", { name: /phone bottom navigation/i });
  await expect(tabBar.getByRole("button", { name: /chats/i })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("No horizontal scroll at 375x667 on the chats route", async ({ page }) => {
  await page.goto("/chats");
  const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(docWidth).toBeLessThanOrEqual(375);
});
