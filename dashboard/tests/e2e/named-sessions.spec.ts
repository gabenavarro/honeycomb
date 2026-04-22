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
        window.localStorage.setItem("hive:layout:sessionsMigratedAt", "2026-04-20T00:00:00");
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

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
  await context.route("**/api/containers/7/named-sessions", async (route) => {
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
  });
  await page.goto("/");
  const tablist = page.getByRole("tablist", { name: /container sessions/i });
  await expect(tablist.getByRole("tab", { name: /Main/ }).first()).toBeVisible();
  // The auto-seed POST fired with the expected body.
  expect(posts).toContainEqual({ name: "Main", kind: "shell" });
});

test("drag a session tab to position 1 reorders via PATCH", async ({ context, page }) => {
  const initialSessions = [
    {
      session_id: "s-a",
      container_id: 7,
      name: "a",
      kind: "shell",
      position: 1,
      created_at: "2026-04-21T00:00:00",
      updated_at: "2026-04-21T00:00:00",
    },
    {
      session_id: "s-b",
      container_id: 7,
      name: "b",
      kind: "shell",
      position: 2,
      created_at: "2026-04-21T00:00:01",
      updated_at: "2026-04-21T00:00:01",
    },
    {
      session_id: "s-c",
      container_id: 7,
      name: "c",
      kind: "shell",
      position: 3,
      created_at: "2026-04-21T00:00:02",
      updated_at: "2026-04-21T00:00:02",
    },
  ];

  await seedRoutes(context, initialSessions);

  // Capture PATCH calls to /named-sessions/*.
  const patches: Array<{ sid: string; body: unknown }> = [];
  await context.route("**/api/named-sessions/*", async (route) => {
    const url = new URL(route.request().url());
    const sid = url.pathname.split("/").pop() ?? "";
    if (route.request().method() === "PATCH") {
      patches.push({ sid, body: JSON.parse(route.request().postData() ?? "null") });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...initialSessions[2], position: 1 }),
      });
    } else {
      await route.fallback();
    }
  });

  await page.goto("/");

  // Wait for the session tabs to render.
  const tabList = page.getByRole("tablist", { name: /container sessions/i });
  const tabC = tabList.getByRole("tab", { name: /^c/ }).first();
  const tabA = tabList.getByRole("tab", { name: /^a/ }).first();
  await expect(tabC).toBeVisible();
  await expect(tabA).toBeVisible();

  // Drag tab c onto tab a's slot using manual HTML5 DnD event dispatch.
  // SessionSubTabs uses onDragStart/onDragEnter/onDrop handlers that read
  // from React state (draggingId), not dataTransfer — Playwright's dragTo()
  // sometimes fails to trigger React synthetic events on tab strips, so we
  // fire the events manually for reliability.
  await tabC.evaluate((el, target) => {
    const dt = new DataTransfer();
    dt.setData("text/x-hive-session", el.getAttribute("data-session-id") ?? "s-c");
    el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
    (target as HTMLElement).dispatchEvent(
      new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }),
    );
    (target as HTMLElement).dispatchEvent(
      new DragEvent("dragover", { dataTransfer: dt, bubbles: true }),
    );
    (target as HTMLElement).dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
    );
    el.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
  }, await tabA.elementHandle());

  // Expect one PATCH to s-c with position=1.
  await expect
    .poll(() => patches.length, { timeout: 3000 })
    .toBeGreaterThan(0);
  const call = patches[0];
  expect(call.sid).toBe("s-c");
  expect(call.body).toEqual({ position: 1 });
});
