/** ChatsRoute — Lane C: per-session state isolation (M37). */

// react-ipynb-renderer (pulled in transitively through FileViewer →
// NotebookViewer) uses dynamic ESM theme imports that don't resolve under
// Vitest + jsdom.  Stub it out before any component import.
vi.mock("react-ipynb-renderer", () => ({
  IpynbRenderer: () => <div data-testid="ipynb-stub" />,
}));
vi.mock("react-ipynb-renderer/dist/styles/onedork.css", () => ({}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../../hooks/useToasts";
import { ChatsRoute } from "../ChatsRoute";

// Mock the chat stream hook so we can observe its subscribe targets.
const subscribeChannels: string[] = [];
vi.mock("../../../hooks/useChatStream", () => ({
  useChatStream: (sessionId: string | null) => {
    if (sessionId !== null) subscribeChannels.push(sessionId);
    return { turns: [], clearTurns: vi.fn() };
  },
}));

// Mock heavy children we don't care about.
vi.mock("../../ContainerList", () => ({
  ContainerList: () => <div data-testid="container-list" />,
}));
vi.mock("../../chat/ChatThread", () => ({
  ChatThread: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-thread" data-session-id={sessionId} />
  ),
}));

// API mocks — includes all four named exports ChatsRoute imports from lib/api.
vi.mock("../../../lib/api", () => ({
  getSettings: vi.fn().mockResolvedValue({ values: {}, mutable_fields: [] }),
  listContainerSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  postChatTurn: vi.fn(),
  createArtifact: vi.fn(),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  };
}

const mkContainer = (id: number, name: string) => ({
  id,
  workspace_folder: `/repos/${name}`,
  project_type: "base",
  project_name: name,
  project_description: "",
  git_repo_url: null,
  container_id: "abc",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
});

const mkSession = (id: string, name: string) => ({
  session_id: id,
  container_id: 1,
  name,
  kind: "claude" as const,
  position: 1,
  claude_session_id: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
});

describe("ChatsRoute — per-session isolation (M37 Lane C)", () => {
  it("ChatThreadWrapper has key={sessionId} so React remounts on session switch", () => {
    const props = {
      containers: [mkContainer(1, "alpha")],
      activeContainer: mkContainer(1, "alpha"),
      activeContainerId: 1,
      onSelectContainer: vi.fn(),
      activeSessions: [],
      namedSessions: [mkSession("ns-1", "first"), mkSession("ns-2", "second")],
      activeSessionId: "ns-1",
      activeSplitSessionId: null,
      onFocusSession: vi.fn(),
      onCloseSession: vi.fn(),
      onNewChatSession: vi.fn(),
      onNewShellSession: vi.fn(),
      onRenameSession: vi.fn(),
      onReorderSession: vi.fn(),
      onSetSplitSession: vi.fn(),
      onClearSplitSession: vi.fn(),
      activeFsPath: "/repos/alpha",
      onFsPathChange: vi.fn(),
      openedFile: null,
      onOpenFile: vi.fn(),
      openedDiffEvent: null,
      onOpenDiffEvent: vi.fn(),
    };

    const { rerender, getByTestId } = render(<ChatsRoute {...props} />, {
      wrapper: makeWrapper(),
    });

    expect(getByTestId("chat-thread").getAttribute("data-session-id")).toBe("ns-1");
    const firstThread = getByTestId("chat-thread");

    // Switch active session — the same ChatThread test-id should now report ns-2,
    // and (because of the key) it must be a different DOM node from before.
    rerender(<ChatsRoute {...props} activeSessionId="ns-2" />);

    const secondThread = getByTestId("chat-thread");
    expect(secondThread.getAttribute("data-session-id")).toBe("ns-2");

    // The proof: with the key fix, React unmounts and remounts —
    // the DOM node identity differs.
    expect(firstThread).not.toBe(secondThread);
  });
});
