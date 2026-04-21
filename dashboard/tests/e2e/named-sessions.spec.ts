/** M26 — persistent named sessions end-to-end.
 *
 * Stubs /named-sessions to avoid a real hub. Asserts:
 *   - list populates the SessionSubTabs strip
 *   - first-empty container auto-creates a "Main" session
 */

import { expect, test } from "@playwright/test";

const TOKEN = "named-sessions-token";

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
  created_at: "2026-04-20",
  updated_at: "2026-04-20",
  agent_expected: false,
};

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function seedRoutes(
  context: import("@playwright/test").BrowserContext,
  namedSessions: unknown[],
) {
  await context.addInitScript(
    ([t, openTab, activeTab]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", openTab);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
        // Pre-mark the guard so auto-migration skips during this test.
        window.localStorage.setItem(
          "hive:layout:sessionsMigratedAt",
          "2026-04-20T00:00:00",
        );
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

  await context.route("**/api/containers", (route) =>
    route.fulfill(mockJson([containerFixture])),
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
  await context.route("**/api/keybindings**", (route) =>
    route.fulfill(mockJson({ bindings: {} })),
  );
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/api/containers/7/resources**", (route) =>
    route.fulfill(mockJson(null)),
  );
  await context.route("**/api/containers/7/fs/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));

  // Distinguish GET (return the seeded list) from POST (auto-create guard
  // fires on empty-state mount — return the first session as a stub so the
  // mutation's onSuccess receives the right shape).
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
          created_at: "2026-04-20T00:00:00",
          updated_at: "2026-04-20T00:00:00",
        }),
      );
    } else {
      await route.fulfill(mockJson(namedSessions));
    }
  });
}

test("renders existing sessions from the hub", async ({ context, page }) => {
  await seedRoutes(context, [
    {
      session_id: "abc",
      container_id: 7,
      name: "Main",
      kind: "shell",
      created_at: "2026-04-20T00:00:00",
      updated_at: "2026-04-20T00:00:00",
    },
    {
      session_id: "def",
      container_id: 7,
      name: "Claude",
      kind: "claude",
      created_at: "2026-04-20T00:00:01",
      updated_at: "2026-04-20T00:00:01",
    },
  ]);
  await page.goto("/");

  // Two tabs rendered. The tab strip has role="tablist"; individual buttons
  // have role="tab". Because the rename/close affordances also carry
  // aria-labels containing the session name, /Main/ can match multiple
  // elements — scope to the tablist and take the first match.
  const tablist = page.getByRole("tablist", { name: /container sessions/i });
  await expect(tablist.getByRole("tab", { name: /Main/ }).first()).toBeVisible();
  await expect(tablist.getByRole("tab", { name: /Claude/ }).first()).toBeVisible();
});

test("first-empty container auto-creates a Main session", async ({ context, page }) => {
  await seedRoutes(context, []);

  // Capture POST body; respond with a server-assigned UUID.
  const posts: unknown[] = [];
  await context.route(
    "**/api/containers/7/named-sessions",
    async (route) => {
      if (route.request().method() === "POST") {
        posts.push(JSON.parse(route.request().postData() ?? "null"));
        await route.fulfill(
          mockJson({
            session_id: "auto",
            container_id: 7,
            name: "Main",
            kind: "shell",
            created_at: "2026-04-20T00:00:00",
            updated_at: "2026-04-20T00:00:00",
          }),
        );
      } else {
        await route.fulfill(mockJson([]));
      }
    },
  );
  await page.goto("/");
  const tablist = page.getByRole("tablist", { name: /container sessions/i });
  await expect(tablist.getByRole("tab", { name: /Main/ }).first()).toBeVisible();
  // The auto-seed POST fired with the expected body.
  expect(posts).toContainEqual({ name: "Main", kind: "shell" });
});
