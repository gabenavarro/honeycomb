/** M36-hotfix — assert that the "+ Chat" affordance creates a
 * claude-kind session and "+ Shell" creates a shell-kind session.
 *
 * The original bug: the single "+ New" button hardcoded kind="shell"
 * in App.tsx, leaving the M33 ChatThread surface unreachable except
 * via ⌘K → "Start Claude session in {workspace}". This spec is the
 * regression test that would have caught it.
 */
import { expect, test } from "@playwright/test";

const TOKEN = "session-kind-token";

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

// One existing SHELL-kind session (mirrors the real-world situation
// the user hit: their pre-M33 "Main" session is shell-kind). This makes
// the route render the legacy pane where SessionSubTabs lives. With a
// claude-kind fixture the route would render ChatThread instead and
// SessionSubTabs would unmount before the click can land.
const existingSession = {
  session_id: "existing",
  container_id: 1,
  name: "Main",
  kind: "shell" as const,
  position: 1,
  claude_session_id: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};

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
        window.localStorage.setItem(
          "hive:layout:activeSessionByContainer",
          JSON.stringify({ "1": "existing" }),
        );
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );
  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/named-sessions", (r) => {
    if (r.request().method() === "POST") {
      // The route handler is set per-test below; this default returns 200
      // with a stub for the GET path (and is overridden for POST below).
      return r.fulfill(
        mockJson({
          ...existingSession,
          session_id: `created-${Date.now()}`,
          name: "stub",
        }),
      );
    }
    return r.fulfill(mockJson([existingSession]));
  });
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson([])));
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

test('clicking "+ Chat" creates a claude-kind session', async ({ page }) => {
  // Auto-accept the window.prompt() the new-session handler raises.
  page.on("dialog", (dialog) => dialog.accept("test chat session"));

  // Capture the POST request body for /named-sessions specifically.
  const postPromise = page.waitForRequest(
    (req) => req.url().includes("/named-sessions") && req.method() === "POST",
  );

  await page.goto("/chats");
  await page.getByRole("button", { name: /^new chat session$/i }).click();
  const req = await postPromise;
  const body = JSON.parse(req.postData() ?? "{}");
  expect(body.kind).toBe("claude");
  expect(body.name).toBe("test chat session");
});

test('clicking "+ Shell" creates a shell-kind session', async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept("test shell session"));

  const postPromise = page.waitForRequest(
    (req) => req.url().includes("/named-sessions") && req.method() === "POST",
  );

  await page.goto("/chats");
  await page.getByRole("button", { name: /^new shell session$/i }).click();
  const req = await postPromise;
  const body = JSON.parse(req.postData() ?? "{}");
  expect(body.kind).toBe("shell");
  expect(body.name).toBe("test shell session");
});
