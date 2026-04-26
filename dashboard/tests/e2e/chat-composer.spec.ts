/** M34 composer end-to-end.
 *
 * Verifies:
 *   1. Typing '/' shows the slash autocomplete with 8 commands
 *   2. Typing '/clear' + Send clears the chat (no POST)
 *   3. Typing '/plan' + Send flips the mode toggle to Plan (no POST)
 *   4. Typing '/edit foo.py' + Send POSTs with text "Please open foo.py for me to edit."
 *   5. Effort change → next POST carries the new effort field
 *   6. Edit-auto toggle ON + Send carries edit_auto: true
 *   7. axe-core scan on the composer in dark + light themes
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "chat-composer-token";

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

const claudeSession = {
  session_id: "ns-claude-1",
  container_id: 1,
  name: "Main",
  kind: "claude",
  position: 1,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  claude_session_id: null,
};

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

// Capture the most recent /turns POST payload for assertion.
let lastTurnPayload: Record<string, unknown> | null = null;

test.beforeEach(async ({ context }) => {
  lastTurnPayload = null;
  await context.addInitScript(() => {
    (window as unknown as { __playwright_test: boolean }).__playwright_test = true;
  });
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
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/named-sessions", (r) =>
    r.fulfill(mockJson([claudeSession])),
  );
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
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
  await context.route("**/api/named-sessions/*/turns", async (route) => {
    try {
      const post = route.request().postData();
      if (post) {
        lastTurnPayload = JSON.parse(post) as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: '{"accepted":true,"session_id":"ns-claude-1"}',
    });
  });
});

test("typing '/' shows the slash autocomplete with 8 commands", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/");
  const listbox = page.getByRole("listbox", { name: /Slash command suggestions/i });
  await expect(listbox).toBeVisible();
  const options = await listbox.getByRole("option").all();
  expect(options.length).toBe(8);
});

test("typing '/clear' + Send clears the chat (no POST)", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/clear");
  await page.getByRole("button", { name: /^send$/i }).click();
  // Brief wait to confirm no network call landed
  await page.waitForTimeout(150);
  expect(lastTurnPayload).toBeNull();
});

test("typing '/plan' + Send flips mode toggle to Plan (no POST)", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/plan");
  await page.getByRole("button", { name: /^send$/i }).click();
  await page.waitForTimeout(150);
  expect(lastTurnPayload).toBeNull();
  // Plan radio is now active in the ModeToggle (radiogroup)
  const planRadio = page.getByRole("radio", { name: "Plan" });
  await expect(planRadio).toHaveAttribute("aria-checked", "true");
});

test("typing '/edit foo.py' + Send POSTs the transformed userText", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("textbox", { name: /chat input/i }).fill("/edit foo.py");
  await page.getByRole("button", { name: /^send$/i }).click();
  // Wait for the POST to land
  await expect.poll(() => lastTurnPayload).not.toBeNull();
  expect(lastTurnPayload?.text).toBe("Please open foo.py for me to edit.");
});

test("changing Effort + Send carries the new effort in payload", async ({ page }) => {
  await page.goto("/chats");
  // Pick "Max" from the EffortControl
  await page.getByRole("radio", { name: "Max" }).click();
  await page.getByRole("textbox", { name: /chat input/i }).fill("hello");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect.poll(() => lastTurnPayload).not.toBeNull();
  expect(lastTurnPayload?.effort).toBe("max");
});

test("Edit-auto toggle ON + Send carries edit_auto: true", async ({ page }) => {
  await page.goto("/chats");
  await page.getByRole("switch").click();
  await page.getByRole("textbox", { name: /chat input/i }).fill("hello");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect.poll(() => lastTurnPayload).not.toBeNull();
  expect(lastTurnPayload?.edit_auto).toBe(true);
});

test("composer passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/chats");
  // Wait for the composer to be present before scoping the axe scan.
  await expect(page.getByRole("textbox", { name: /chat input/i })).toBeVisible();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  // Scope to the composer region via data-testid added to ChatComposer.
  const results = await new AxeBuilder({ page })
    .include('[data-testid="chat-composer"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("composer passes axe-core in light theme", async ({ page }) => {
  await page.goto("/chats");
  await expect(page.getByRole("textbox", { name: /chat input/i })).toBeVisible();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const results = await new AxeBuilder({ page })
    .include('[data-testid="chat-composer"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
