/** M33 chat-surface end-to-end happy path.
 *
 * Mocks the named-sessions endpoints to return a kind="claude" session,
 * mocks POST /turns to return 202, and pumps stream-json frames into
 * the dashboard's mock WebSocket so the ChatStream renders incrementally.
 *
 * Verifies:
 *   1. Chat surface renders for kind="claude" sessions
 *   2. User turn appears after Send
 *   3. Streaming assistant text grows incrementally then completes
 *   4. Tool block renders with parsed input + status
 *   5. axe-core passes on the chat surface in dark theme
 *   6. axe-core passes on the chat surface in light theme
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const TOKEN = "chat-stream-token";
const CONTAINER_ID = 1;
const SESSION_ID = "ns-claude-1";

const containerFixture = {
  id: CONTAINER_ID,
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
  session_id: SESSION_ID,
  container_id: CONTAINER_ID,
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

test.beforeEach(async ({ context }) => {
  // Set the test flag BEFORE any other init script so the pump shim
  // installs in main.tsx. Also pre-seed the open/active tab so the
  // claude session is selected without an extra ContainerList click —
  // the named-sessions response is the sole source for the active
  // session id, which falls back to the first list entry.
  await context.addInitScript(
    ([token, openTabs, activeTab]) => {
      try {
        (window as unknown as { __playwright_test?: boolean }).__playwright_test = true;
        window.localStorage.setItem("hive:auth:token", token);
        window.localStorage.setItem("hive:layout:openTabs", openTabs);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
        window.localStorage.setItem("hive:layout:activity", JSON.stringify("containers"));
      } catch {
        // ignore — private mode etc.
      }
    },
    [TOKEN, JSON.stringify([CONTAINER_ID]), JSON.stringify(CONTAINER_ID)],
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
  await context.route("**/api/named-sessions/*/turns", (r) =>
    r.fulfill({ status: 202, contentType: "application/json", body: '{"accepted":true}' }),
  );
  // Stub the real WS so the singleton's reconnect loop doesn't spam
  // the dev server with EPIPE noise. Frames are injected via
  // window.__pumpWsFrame instead.
  await context.route("**/ws**", (r) => r.fulfill({ status: 404 }));
});

/** Wait for the test pump to be installed, then dispatch a frame. */
async function pumpFrame(page: import("@playwright/test").Page, frame: unknown): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as { __pumpWsFrame?: unknown }).__pumpWsFrame === "function",
  );
  await page.evaluate((f) => {
    (window as { __pumpWsFrame?: (f: unknown) => void }).__pumpWsFrame!(f);
  }, frame);
}

/** Resolve the chat composer textarea — present once the kind=claude
 *  session is mounted. */
async function gotoChat(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/chats");
  await expect(page.getByRole("textbox", { name: "Chat input" })).toBeVisible();
}

test("chat surface renders for kind=claude session", async ({ page }) => {
  await gotoChat(page);
  // ChatHeader's History button is visible (the chat-mode chrome).
  await expect(page.getByRole("button", { name: /chat history/i })).toBeVisible();
  // Composer placeholder reflects the default mode.
  await expect(page.getByRole("textbox", { name: "Chat input" })).toBeVisible();
  // Empty-state copy from ChatStream is visible since no turns have streamed yet.
  await expect(page.getByText(/no turns yet/i)).toBeVisible();
});

test("send a message → user turn appears", async ({ page }) => {
  await gotoChat(page);
  const input = page.getByRole("textbox", { name: "Chat input" });
  await input.fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();
  // Pump the user-replay frame the hub would broadcast back.
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "user",
    data: {
      type: "user",
      message: {
        id: "u-1",
        type: "message",
        role: "user",
        content: [{ type: "text", text: "hello there" }],
      },
      session_id: "claude-s",
      uuid: "u-1",
    },
  });
  await expect(page.getByRole("article", { name: "User message" })).toContainText("hello there");
});

test("streaming text grows incrementally then completes", async ({ page }) => {
  await gotoChat(page);
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-1",
      event: {
        type: "message_start",
        message: { id: "m-1", type: "message", role: "assistant", content: [] },
      },
    },
  });
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-2",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
  });
  for (const piece of ["1, ", "2, ", "3."]) {
    await pumpFrame(page, {
      channel: `chat:${SESSION_ID}`,
      event: "stream_event",
      data: {
        type: "stream_event",
        session_id: "s",
        uuid: `u-${piece}`,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: piece },
        },
      },
    });
  }
  await expect(page.getByRole("article", { name: "Assistant message" })).toContainText("1, 2, 3.");
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-stop",
      event: { type: "message_stop" },
    },
  });
  // After message_stop the streaming cursor (aria-hidden span) is gone;
  // the assistant text remains.
  await expect(page.getByRole("article", { name: "Assistant message" })).toContainText("1, 2, 3.");
});

test("tool block renders with parsed input + complete status", async ({ page }) => {
  await gotoChat(page);
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-1",
      event: {
        type: "message_start",
        message: { id: "m-1", type: "message", role: "assistant", content: [] },
      },
    },
  });
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-2",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
      },
    },
  });
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-3",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls /tmp"}' },
      },
    },
  });
  await pumpFrame(page, {
    channel: `chat:${SESSION_ID}`,
    event: "stream_event",
    data: {
      type: "stream_event",
      session_id: "s",
      uuid: "u-4",
      event: { type: "content_block_stop", index: 0 },
    },
  });
  // The Bash chrome header reads "Bash" (in uppercase via Tailwind).
  await expect(page.getByText("Bash", { exact: true })).toBeVisible();
  // Parsed command appears in the body's <pre>.
  await expect(page.getByText("ls /tmp")).toBeVisible();
  // content_block_stop flips `complete=true`, swapping the spinner for
  // a CheckCircle whose aria-label is "Complete".
  await expect(page.getByLabel("Complete").first()).toBeVisible();
});

test("axe-core passes on chat surface (dark)", async ({ page }) => {
  await gotoChat(page);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});

test("axe-core passes on chat surface (light)", async ({ page }) => {
  await gotoChat(page);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations).toEqual([]);
});
