import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneChatList } from "../PhoneChatList";
import type { NamedSession } from "../../lib/types";

const session1: NamedSession = {
  session_id: "s-1",
  container_id: 1,
  name: "Refactor auth",
  kind: "claude",
  position: 1,
  claude_session_id: null,
  created_at: "2026-04-26T08:00:00Z",
  updated_at: "2026-04-26T08:00:00Z",
};
const session2: NamedSession = {
  session_id: "s-2",
  container_id: 1,
  name: "Fix bug 42",
  kind: "claude",
  position: 2,
  claude_session_id: null,
  created_at: "2026-04-25T08:00:00Z",
  updated_at: "2026-04-25T08:00:00Z",
};

describe("PhoneChatList", () => {
  it("renders the workspace name in the pill at top", () => {
    render(
      <PhoneChatList
        workspaceName="my-project"
        sessions={[session1, session2]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText("my-project")).toBeTruthy();
  });

  it("renders a row per session", () => {
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[session1, session2]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText("Refactor auth")).toBeTruthy();
    expect(screen.getByText("Fix bug 42")).toBeTruthy();
  });

  it("clicking a session row calls onSelectSession with the session_id", () => {
    const onSelectSession = vi.fn();
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[session1]}
        onSelectSession={onSelectSession}
        onNewChat={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Refactor auth"));
    expect(onSelectSession).toHaveBeenCalledWith("s-1");
  });

  it("clicking the FAB calls onNewChat", () => {
    const onNewChat = vi.fn();
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[]}
        onSelectSession={vi.fn()}
        onNewChat={onNewChat}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("renders an empty state when no sessions", () => {
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText(/no chats yet/i)).toBeTruthy();
  });

  it("typing in the search filters the visible rows", () => {
    render(
      <PhoneChatList
        workspaceName="x"
        sessions={[session1, session2]}
        onSelectSession={vi.fn()}
        onNewChat={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Fix" } });
    expect(screen.queryByText("Refactor auth")).toBeNull();
    expect(screen.getByText("Fix bug 42")).toBeTruthy();
  });
});
