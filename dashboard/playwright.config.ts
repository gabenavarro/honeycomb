/** Playwright configuration (M11).
 *
 * The dashboard is a static SPA; the only thing Playwright needs is a
 * running Vite dev server. ``webServer`` boots it for CI and local
 * runs. The tests target the built-in test token via
 * ``VITE_HIVE_TEST_TOKEN`` so the AuthGate flows through automatically
 * — see ``hooks/auth.ts``'s initial-token read.
 *
 * We deliberately test against a MOCKED hub (route interception in the
 * specs themselves). A full hub + docker stack would be brittle in CI
 * and is covered by the hub's pytest suite.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 60_000,
  },
});
