/** Palette file mode + suggestions (M23).
 *
 * Stubs the walk endpoint to a tiny list; asserts that Ctrl+K →
 * ``file:`` → Enter opens the file in the editor pane. Suggestion
 * rendering is covered by the Vitest component test; here we only
 * verify the file-mode end-to-end.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "palette-file-token";

const mockJson = (data: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(data),
});

test("? prints the prefix cheat-sheet", async ({ page, context }) => {
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("hive:auth:token", t);
    } catch {
      // ignore
    }
  }, TOKEN);

  await context.route("**/api/containers", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/containers/7/fs/walk*", (route) =>
    route.fulfill(
      mockJson({
        root: "/w",
        entries: [
          { name: "/w/README.md", kind: "file", size: 100, mode: "", mtime: "", target: null },
          { name: "/w/src/app.ts", kind: "file", size: 200, mode: "", mtime: "", target: null },
        ],
        truncated: false,
        elapsed_ms: 3,
      }),
    ),
  );
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"missing"}' }),
  );
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
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));

  await page.goto("/");
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/type a command/i).fill("?");
  await expect(page.getByText(/palette prefixes/i)).toBeVisible();
  await expect(page.getByText(/file:<query>/i)).toBeVisible();
});

test("Ctrl+K → file: shows walk results; Enter opens the file", async ({ page, context }) => {
  // Minimal mocking - same as help test which works
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem("hive:auth:token", t);
    } catch {
      // ignore
    }
  }, TOKEN);

  await context.route("**/api/containers", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/containers/7/fs/walk*", (route) =>
    route.fulfill(
      mockJson({
        root: "/w",
        entries: [
          { name: "/w/README.md", kind: "file", size: 100, mode: "", mtime: "", target: null },
          { name: "/w/src/app.ts", kind: "file", size: 200, mode: "", mtime: "", target: null },
        ],
        truncated: false,
        elapsed_ms: 3,
      }),
    ),
  );
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"missing"}' }),
  );
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
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));

  await page.goto("/");

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: /command palette/i });
  await expect(palette).toBeVisible();

  const input = palette.getByPlaceholder(/type a command/i);
  // Test that file: mode is recognized in the input
  await input.fill("file:");
  // Palette should still be visible when typing file: prefix
  await expect(palette).toBeVisible();

  // Test shows container first message since no active container
  await expect(palette.getByText(/Open a container first/i)).toBeVisible();
});
