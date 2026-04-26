/** M31 theme system end-to-end.
 *
 * Verifies:
 *   1. Default state (no localStorage) follows OS via prefers-color-scheme
 *      — no data-theme attribute is set on <html>
 *   2. Settings -> Appearance: Dark / Light / System radios flip data-theme
 *   3. Ctrl+Shift+L keyboard shortcut switches to light
 *   4. Ctrl+Shift+D keyboard shortcut switches to dark
 *   5. Ctrl+Shift+S keyboard shortcut clears back to system
 *   6. Appearance UI passes axe-core in dark theme
 *   7. Appearance UI passes axe-core in light theme
 *
 * Mirrors the auth + route fixture pattern from smoke.spec.ts and
 * diff-events.spec.ts. Token is seeded via addInitScript; every
 * API endpoint the dashboard polls on boot is stubbed via context.route.
 *
 * Note: The keyboard shortcuts are defined in CommandPalette.tsx with
 * `(e.metaKey || e.ctrlKey) && e.shiftKey`, so Ctrl+Shift+L/D/S works on
 * Linux where Meta (Windows key) is not available.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "theme-system-token";

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

test.beforeEach(async ({ context }) => {
  // Seed auth token via initScript (matches smoke.spec.ts / diff-events.spec.ts pattern).
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("hive:auth:token", t);
    } catch {
      // ignore
    }
  }, TOKEN);

  // Stub every endpoint the dashboard polls on boot.
  // Empty containers list — no container tabs needed for theme tests.
  await context.route("**/api/containers", (route) => route.fulfill(mockJson([])));
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
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
});

// ── 1: default boot does not set data-theme ───────────────────────────────────

test("default boot does not set data-theme (system mode, OS drives CSS)", async ({ page }) => {
  await page.goto("/");
  // When no hive:theme key is in localStorage, ThemeProvider defaults to
  // "system" and never sets data-theme, so prefers-color-scheme takes effect.
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});

// ── 2: Settings -> Appearance radio group ─────────────────────────────────────

test("Settings -> Appearance radios flip data-theme correctly", async ({ page }) => {
  await page.goto("/");

  // The activity rail renders a button with aria-label="Settings"
  // (ActivityBar.tsx line 178: aria-label="Settings").
  await page.getByRole("button", { name: "Settings" }).click();

  // The AppearancePicker renders a <fieldset aria-label="Appearance"> with
  // three radio inputs. Each input is associated to a <label> containing the
  // option name + description, so the accessible name is the full label text.
  // We use a partial substring match (/light/i etc.) rather than anchored
  // regex so the description text doesn't cause a mismatch.
  await page.getByRole("radio", { name: /light/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("radio", { name: /dark/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("radio", { name: /system/i }).click();
  // "system" → ThemeProvider calls root.removeAttribute("data-theme")
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});

// ── 3-5: Global keyboard shortcuts ───────────────────────────────────────────
// Bound in CommandPalette.tsx: (e.metaKey || e.ctrlKey) && e.shiftKey.
// Ctrl+Shift+L/D/S works on Linux; Meta is the Windows key and unavailable.

test("Ctrl+Shift+L keyboard shortcut switches to light theme", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("Ctrl+Shift+D keyboard shortcut switches to dark theme", async ({ page }) => {
  await page.goto("/");
  // Start from light so the assertion is meaningful.
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.keyboard.press("Control+Shift+D");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("Ctrl+Shift+S keyboard shortcut clears to system (removes data-theme)", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+Shift+L");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.keyboard.press("Control+Shift+S");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});

// ── 6-7: axe-core accessibility scans ────────────────────────────────────────
// Scoped to `fieldset[aria-label="Appearance"]` to avoid false positives
// from pre-existing hardcoded-hex chrome that migrates in M32.

test("Appearance section passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: /dark/i }).click();

  const results = await new AxeBuilder({ page })
    .include('fieldset[aria-label="Appearance"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Appearance section passes axe-core in light theme", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: /light/i }).click();

  const results = await new AxeBuilder({ page })
    .include('fieldset[aria-label="Appearance"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
