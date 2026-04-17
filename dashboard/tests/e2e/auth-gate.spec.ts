/** Auth gate — the dashboard's first-load gate (M11).
 *
 * Without a token, the AuthGate dialog should open. Pasting a token
 * and submitting should close it and persist for future reloads. The
 * gate verifies the token by calling ``/api/containers`` — we
 * intercept that route so the spec doesn't need a running hub.
 */

import { test, expect } from "@playwright/test";

const GOOD_TOKEN = "demo-playwright-token";

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await context.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });
  // Single dispatching handler — removes any ambiguity about Playwright's
  // route evaluation order and keeps the auth-gated response shape in
  // one place.
  await context.route("**/api/**", (route) => {
    const auth = route.request().headers()["authorization"] ?? "";
    const hasBearer = auth.startsWith("Bearer ") && auth.length > "Bearer ".length;
    if (!hasBearer) {
      return route.fulfill({ status: 401, body: "Unauthorized" });
    }
    // Once the gate has persisted a token, every subsequent API call
    // must return a successful (though empty) shape. Returning 401
    // anywhere here would trigger ``clearAuthToken`` on the client and
    // reopen the gate, which is exactly the regression the spec is
    // here to prevent.
    const url = route.request().url();
    if (url.includes("/api/problems")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ problems: [] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
});

test("the auth gate dialog renders on first load", async ({ page }) => {
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: /paste your honeycomb auth token/i });
  await expect(dialog).toBeVisible();
});

test("pasting a token and saving closes the gate and persists it", async ({ page }) => {
  await page.goto("/");

  const tokenInput = page.getByLabel(/bearer token/i);
  await tokenInput.fill(GOOD_TOKEN);
  await page.getByRole("button", { name: /unlock dashboard/i }).click();

  await expect(page.getByRole("dialog", { name: /paste your honeycomb auth token/i })).toBeHidden();

  const persisted = await page.evaluate(() => window.localStorage.getItem("hive:auth:token"));
  expect(persisted).toBe(GOOD_TOKEN);
});
