/** M36 — axe-core sweep across viewports + themes.
 *
 * Matrix: 3 viewports × 2 themes × 2 routes = 12 scans. Catches
 * contrast / touch-target / aria issues across the responsive matrix.
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "axe-token";

const containerFixture = {
  id: 1,
  workspace_folder: "/repos/foo",
  project_type: "base",
  project_name: "foo",
  project_description: "",
  git_repo_url: null,
  container_id: "deadbeef",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const sessionFixture = {
  session_id: "ns-1",
  container_id: 1,
  name: "First chat",
  kind: "claude",
  position: 1,
  claude_session_id: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};

const artifacts = [
  {
    artifact_id: "a-plan-1",
    container_id: 1,
    type: "plan",
    title: "Refactor plan",
    body: "## Step 1",
    body_format: "markdown",
    source_chat_id: "ns-1",
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T12:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
  },
];

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );
  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/named-sessions", (r) =>
    r.fulfill(mockJson([sessionFixture])),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson(artifacts)));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/problems**", (r) => r.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (r) =>
    r.fulfill(
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
  await context.route("**/api/keybindings**", (r) => r.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (r) => r.fulfill(mockJson({ status: "ok" })));
});

const VIEWPORTS = [
  { name: "phone", w: 375, h: 667 },
  { name: "tablet", w: 768, h: 1024 },
  { name: "desktop", w: 1024, h: 768 },
];

const THEMES = ["dark", "light"] as const;

const ROUTES = ["/chats", "/library"];

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    for (const route of ROUTES) {
      test(`axe-core: ${route} at ${vp.name} (${vp.w}x${vp.h}) in ${theme} theme`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.goto(route);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        // Wait for the route's <main> landmark to render before scanning;
        // `networkidle` alone races the React commit on busy parallel
        // workers and can scan a half-mounted DOM.
        await page.locator("main").first().waitFor({ state: "visible" });
        await page.waitForLoadState("networkidle");
        // Scope: the route's <main> content + the M36 PhoneTabBar.
        // We deliberately exclude the StatusBar / ActivityBar /
        // ContainerList sidebar — those predate M36 and have separate
        // a11y debt (bg-accent + text-white contrast, listbox structure)
        // that is out of scope for the responsive sweep. Pattern matches
        // M35 T14's `.include('aside[aria-label="Library sidebar"]')`.
        const builder = new AxeBuilder({ page })
          .include("main")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
        if (vp.name === "phone") {
          builder.include('nav[aria-label="Phone bottom navigation"]');
        }
        const results = await builder.analyze();
        expect(results.violations).toEqual([]);
      });
    }
  }
}
