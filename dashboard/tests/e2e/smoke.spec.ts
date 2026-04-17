/** Smoke tests (M11).
 *
 * With a valid token pre-seeded in localStorage and every API call
 * mocked at the network layer, the dashboard should boot into its
 * normal layout: activity bar, primary sidebar, empty-editor state.
 *
 * These specs exercise routing + top-level rendering; they do NOT
 * verify the terminal/PTY flow. Those require real WebSocket
 * round-trips and live under hub/integration tests.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "smoke-token";

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
        values: { log_level: "INFO", discover_roots: [], metrics_enabled: true, host: "127.0.0.1" },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
});

test("activity bar + empty editor render with a valid token", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: /activity bar/i })).toBeVisible();
  await expect(page.getByRole("complementary", { name: /primary sidebar/i })).toBeVisible();
  await expect(page.getByText(/no containers registered yet/i)).toBeVisible();
});

test("Ctrl+K opens the command palette", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");

  const palette = page.getByRole("dialog", { name: /command palette/i });
  await expect(palette).toBeVisible();
});

test("activity bar toggle switches to the Problems pane", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^problems$/i }).click();

  // ProblemsPanel renders a "No problems" empty-state paragraph whenever
  // the GET /api/problems mock returns an empty list. That string is
  // only present in the Problems view, so it's a unique-enough assertion
  // that the activity actually switched (the sidebar + panel both say
  // "Problems" — matching on the heading text is ambiguous).
  await expect(page.getByText(/health transitions and agent disconnects/i)).toBeVisible();
});
