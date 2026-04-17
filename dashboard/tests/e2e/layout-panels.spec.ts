/** Root-layout panels (M14).
 *
 * With ``react-resizable-panels`` wrapping the primary/editor/secondary
 * trio, we verify two minimum contracts:
 *
 *  1. A drag separator is present between the sidebar and the editor.
 *  2. ``Ctrl+B`` collapses the sidebar to zero width and restores it.
 *
 * The spec uses the same API mocking harness as the other e2e specs —
 * no live hub required.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "layout-token";

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

test("the primary-sidebar drag separator exists", async ({ page }) => {
  await page.goto("/");
  // react-resizable-panels renders separators as role="separator".
  // Our sidebar separator sets aria-label="Resize primary sidebar" so
  // we can target it specifically.
  await expect(page.getByLabel("Resize primary sidebar")).toBeVisible();
});

test("Ctrl+B collapses and restores the primary sidebar", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /primary sidebar/i });
  await expect(sidebar).toBeVisible();

  await page.keyboard.press("Control+B");
  // When the Panel collapses to 0 width the aside is effectively hidden.
  // Playwright's toBeHidden works for 0-size elements with no content
  // visible, and that's what collapsedSize=0 produces.
  await expect(sidebar).toBeHidden();

  await page.keyboard.press("Control+B");
  await expect(sidebar).toBeVisible();
});
