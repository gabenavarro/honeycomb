/** M27 — diff event sidebar + viewer happy-path end-to-end.
 *
 * Stubs /api/containers and /api/containers/7/diff-events to avoid a
 * real hub. Asserts:
 *   - "Recent Edits" activity bar button opens the sidebar
 *   - seeded event row appears with the file name
 *   - clicking the row opens the DiffViewerTab with the Unified/Split toggle
 *   - toggling Split mode flips the button's data-on attribute
 *   - clicking "Copy patch" shows the "Diff copied to clipboard" toast
 *
 * Mirrors the pattern from health-timeline.spec.ts and named-sessions.spec.ts:
 *   - addInitScript sets auth token + open/active tab in localStorage
 *   - context.route() stubs every API the dashboard polls on boot
 *   - diff-events endpoint returns a single seeded DiffEvent
 *   - navigator.clipboard is patched via addInitScript so the copy
 *     operation never throws in headless Chromium
 */

import { expect, test } from "@playwright/test";

const TOKEN = "diff-events-token";

const containerFixture = {
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
  created_at: "2026-04-23",
  updated_at: "2026-04-23",
  agent_expected: false,
};

/** A diff event recorded today so it lands in the "today" group bucket. */
const SEEDED_EVENT = {
  event_id: "test-event-1",
  container_id: 7,
  claude_session_id: null,
  tool_use_id: "toolu_test",
  tool: "Edit",
  path: "/workspace/dashboard/src/components/Foo.tsx",
  diff: "--- a/Foo.tsx\n+++ b/Foo.tsx\n@@ -1,3 +1,3 @@\n const x = 1;\n-const y = 2;\n+const y = 99;\n const z = 3;\n",
  added_lines: 1,
  removed_lines: 1,
  size_bytes: 120,
  timestamp: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

test.beforeEach(async ({ context }) => {
  // Seed auth token + open container 7 as the active tab.
  await context.addInitScript(
    ([t, openTab, activeTab]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", openTab);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
        // Skip the M26 session-migration guard.
        window.localStorage.setItem("hive:layout:sessionsMigratedAt", "2026-04-23T00:00:00");
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

  // Patch navigator.clipboard so headless Chromium doesn't reject the
  // writeText call inside DiffViewerTab.handleCopy.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.resolve(""),
      },
      writable: true,
      configurable: true,
    });
  });

  // ── Shared API stubs ────────────────────────────────────────────────────────
  await context.route("**/api/containers", (route) => route.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
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
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/api/containers/7/resources**", (route) => route.fulfill(mockJson(null)));
  await context.route("**/api/containers/7/fs/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
  // M26 — stub named-sessions to prevent 401 which would clear the token.
  await context.route("**/api/containers/7/named-sessions", async (route) => {
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "null") as {
        name?: string;
        kind?: string;
      };
      await route.fulfill(
        mockJson({
          session_id: `stub-${Date.now()}`,
          container_id: 7,
          name: body?.name ?? "Main",
          kind: body?.kind ?? "shell",
          created_at: "2026-04-23T00:00:00",
          updated_at: "2026-04-23T00:00:00",
        }),
      );
    } else {
      await route.fulfill(mockJson([]));
    }
  });

  // ── Diff events endpoint ────────────────────────────────────────────────────
  await context.route("**/api/containers/7/diff-events**", (route) =>
    route.fulfill(mockJson([SEEDED_EVENT])),
  );
});

test("diff event renders in sidebar and opens in viewer tab", async ({ page }) => {
  await page.goto("/");

  // Wait for the container tab to appear — confirms the active-container
  // state has been read from localStorage + the containers query resolved.
  await expect(page.getByText("demo").first()).toBeVisible();

  // ── Step 1: open Recent Edits via the activity bar ──────────────────────────
  await page.getByRole("button", { name: /recent edits/i }).click();

  // ── Step 2: verify the seeded path appears as a row ────────────────────────
  await expect(page.getByText("Foo.tsx")).toBeVisible({ timeout: 5000 });

  // ── Step 3: click the row to open the diff viewer ──────────────────────────
  await page.getByText("Foo.tsx").click();

  // ── Step 4: verify the diff viewer toolbar is present ──────────────────────
  // DiffViewerTab always renders Unified + Split buttons in the toolbar.
  await expect(page.getByRole("button", { name: /^unified$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^split$/i })).toBeVisible();

  // ── Step 5: toggle split mode ──────────────────────────────────────────────
  // Initial state: mode persists to localStorage; in a fresh test context it
  // should be "unified" (no prior LS entry), so the Split button has
  // data-on="false". After clicking it should flip to data-on="true".
  const splitBtn = page.getByRole("button", { name: /^split$/i });
  await splitBtn.click();
  await expect(splitBtn).toHaveAttribute("data-on", "true");

  // ── Step 6: Copy patch and verify the success toast ────────────────────────
  await page.getByRole("button", { name: /copy patch/i }).click();
  await expect(page.getByText(/diff copied to clipboard/i)).toBeVisible({ timeout: 3000 });
});
