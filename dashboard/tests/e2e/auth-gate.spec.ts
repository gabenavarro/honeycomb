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
  // ``/api/containers`` is the gate's probe endpoint — answer it based on
  // whether the expected token is present. Anything else returns 401.
  await context.route("**/api/containers", (route) => {
    const auth = route.request().headers()["authorization"];
    if (auth === `Bearer ${GOOD_TOKEN}`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }
    return route.fulfill({ status: 401, body: "Unauthorized" });
  });
  // Silence every other API call so the dashboard's queries don't log
  // noise while the gate is the only thing we care about.
  await context.route("**/api/**", (route) => {
    if (route.request().url().includes("/api/containers")) return route.fallback();
    return route.fulfill({ status: 401, body: "Unauthorized" });
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
