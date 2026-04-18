/** Activity-bar double-click collapse (M22.2).
 *
 * VSCode toggles the sidebar when you double-click any activity-rail
 * icon. We verify that the ``Containers`` icon in Honeycomb does the
 * same: single click keeps the sidebar open (and may change activity);
 * the *second* click inside a double-click window collapses the sidebar
 * to zero width. Another double-click restores it.
 *
 * Harness mirrors layout-panels.spec.ts — all backend calls are stubbed
 * so no live hub is required.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "activity-token";

test.beforeEach(async ({ context }) => {
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("hive:auth:token", t);
    } catch {
      // ignore
    }
  }, TOKEN);

  const mockJson = (data: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  await context.route("**/api/containers", (route) => route.fulfill(mockJson([])));
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
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
});

test("double-clicking the Containers activity icon collapses the sidebar", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /primary sidebar/i });
  await expect(sidebar).toBeVisible();

  const containersIcon = page.getByRole("button", { name: /^Containers$/ });
  await containersIcon.dblclick();
  await expect(sidebar).toBeHidden();

  await containersIcon.dblclick();
  await expect(sidebar).toBeVisible();
});
