/** M24 — file write-back round trip.
 *
 * Stubs ``/fs/read`` and ``/fs/write`` to avoid spinning up a real
 * container. Asserts that Edit → type → Save sends the correct PUT
 * body and that a 409 response surfaces the conflict banner.
 */

import { expect, test, type Route } from "@playwright/test";

const TOKEN = "file-write-token";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t, openTab, activeTab]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", openTab);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

  const mockJson = (data: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  await context.route("**/api/containers", (route) =>
    route.fulfill(
      mockJson([
        {
          id: 7,
          workspace_folder: "/w",
          project_type: "base",
          project_name: "demo",
          project_description: "",
          git_repo_url: null,
          container_id: "dead",
          container_status: "running",
          agent_status: "idle",
          agent_port: 0,
          has_gpu: false,
          has_claude_cli: false,
          claude_cli_checked_at: null,
          created_at: "2026-04-19",
          updated_at: "2026-04-19",
          agent_expected: false,
        },
      ]),
    ),
  );
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
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
  await context.route("**/api/containers/7/resources/history", (route) =>
    route.fulfill(mockJson([])),
  );
  await context.route("**/api/containers/7/resources", (route) => route.fulfill(mockJson(null)));
  await context.route("**/api/health", (route) =>
    route.fulfill(mockJson({ status: "ok", version: "0.2.0" })),
  );
  // Catch-all for fs/read (project-detection probes). Per-test stubs registered
  // after this are tried first (Playwright matches last-registered first), so
  // individual tests can still override specific paths.
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill(mockJson(null)),
  );
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
  await context.route("**/api/containers/7/fs/walk*", (route) =>
    route.fulfill(
      mockJson({
        root: "/w",
        entries: [
          { name: "/w/README.md", kind: "file", size: 11, mode: "", mtime: "", target: null },
        ],
        truncated: false,
        elapsed_ms: 1,
      }),
    ),
  );
});

async function openFileFromPalette(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // Wait for the container tab to appear so the app has finished seeding
  // the active-container state from localStorage + the containers query.
  // Without this, the panel Group re-keys when ``active`` changes, which
  // unmounts and immediately remounts the palette, detaching the input.
  await expect(page.getByText("demo").first()).toBeVisible();
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/type a command/i).fill("file:README");
  await page.getByText("/w/README.md").click();
  await expect(page.getByRole("button", { name: /close file viewer/i })).toBeVisible();
}

test("Edit → type → Save posts the draft + echoes new mtime", async ({ context, page }) => {
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "/w/README.md",
        mime_type: "text/markdown",
        size_bytes: 5,
        mtime_ns: 1_700_000_000_000_000_000,
        content: "hello",
        truncated: false,
      }),
    }),
  );

  const writeCalls: unknown[] = [];
  await context.route("**/api/containers/7/fs/write", async (route: Route) => {
    writeCalls.push(JSON.parse(route.request().postData() ?? "null"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "/w/README.md",
        mime_type: "text/markdown",
        size_bytes: 8,
        mtime_ns: 1_700_000_100_000_000_000,
        content: "hello!!!",
        truncated: false,
      }),
    });
  });

  await openFileFromPalette(page);
  await page.getByRole("button", { name: /^edit$/i }).click();

  // Focus the CodeMirror content and type three "!" characters.
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.type("!!!");

  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/saved/i).first()).toBeVisible();
  expect(writeCalls).toHaveLength(1);
  expect((writeCalls[0] as { path: string }).path).toBe("/w/README.md");
  expect((writeCalls[0] as { if_match_mtime_ns: number }).if_match_mtime_ns).toBe(
    1_700_000_000_000_000_000,
  );
});

test("409 response shows the conflict banner with Reload + Save anyway", async ({
  context,
  page,
}) => {
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "/w/README.md",
        mime_type: "text/markdown",
        size_bytes: 5,
        mtime_ns: 1_700_000_000_000_000_000,
        content: "hello",
        truncated: false,
      }),
    }),
  );
  await context.route("**/api/containers/7/fs/write", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        detail: "File changed on disk",
        current_mtime_ns: 1_700_000_500_000_000_000,
      }),
    }),
  );

  await openFileFromPalette(page);
  await page.getByRole("button", { name: /^edit$/i }).click();
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.type("X");
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/changed on disk/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^reload$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^save anyway$/i })).toBeVisible();
});
