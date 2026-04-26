/** CommandPalette tests — M23 mode transitions + M31 theme commands.
 *
 * We stub both the file-index hook and the suggestion hook so the
 * cmdk rendering logic is exercised independent of the network.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, THEME_STORAGE_KEY } from "../../lib/theme";

import type { UseContainerFileIndexResult } from "../../hooks/useContainerFileIndex";
import type { ContainerSuggestion } from "../../hooks/useContainerSuggestions";
import { CommandPalette } from "../CommandPalette";

const mockUseFileIndex = vi.hoisted(() =>
  vi.fn(
    (): UseContainerFileIndexResult => ({
      entries: [],
      truncated: false,
      isLoading: false,
      error: null,
      refetch: () => {},
    }),
  ),
);
const mockUseSuggestions = vi.hoisted(() => vi.fn((): ContainerSuggestion[] => []));

vi.mock("../../hooks/useContainerFileIndex", () => ({
  useContainerFileIndex: mockUseFileIndex,
}));
vi.mock("../../hooks/useContainerSuggestions", () => ({
  useContainerSuggestions: mockUseSuggestions,
}));

function renderPalette(
  overrides: {
    onOpenFile?: (path: string) => void;
    onRunSuggestion?: (cmd: string) => void;
    onActivity?: (a: string) => void;
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => {};
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <CommandPalette
          open
          onClose={noop}
          containers={[
            {
              id: 1,
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
              has_claude_cli: true,
              claude_cli_checked_at: null,
              created_at: "",
              updated_at: "",
              agent_expected: false,
            },
          ]}
          activeContainerId={1}
          activeWorkdir="/w"
          onFocusContainer={noop}
          onCloseContainer={noop}
          onNewClaudeSession={noop}
          onActivity={(overrides.onActivity as Parameters<typeof CommandPalette>[0]["onActivity"]) ?? noop}
          onOpenProvisioner={noop}
          onOpenFile={overrides.onOpenFile ?? noop}
          onRunSuggestion={overrides.onRunSuggestion ?? noop}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  // Reset localStorage and data-theme for theme tests
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // Stub matchMedia so ThemeProvider doesn't throw in jsdom
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
      onchange: null,
    }) as unknown as MediaQueryList;

  mockUseFileIndex.mockReturnValue({
    entries: [],
    truncated: false,
    isLoading: false,
    error: null,
    refetch: () => {},
  });
  mockUseSuggestions.mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("CommandPalette — M23", () => {
  it("typing 'file:' flips to file mode and shows the Files group", async () => {
    mockUseFileIndex.mockReturnValue({
      entries: [
        { name: "/w/a.ts", kind: "file" as const, size: 1, mode: "", mtime: "", target: null },
      ],
      truncated: false,
      isLoading: false,
      error: null,
      refetch: () => {},
    });
    renderPalette();
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, "file:");
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(screen.getByText("/w/a.ts")).toBeInTheDocument();
  });

  it("pressing Enter on a file entry calls onOpenFile", async () => {
    mockUseFileIndex.mockReturnValue({
      entries: [
        { name: "/w/a.ts", kind: "file" as const, size: 1, mode: "", mtime: "", target: null },
      ],
      truncated: false,
      isLoading: false,
      error: null,
      refetch: () => {},
    });
    const onOpenFile = vi.fn();
    renderPalette({ onOpenFile });
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, "file:");
    await userEvent.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("/w/a.ts");
  });

  it("?' prints the cheat-sheet instead of groups", async () => {
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/type a command/i), "?");
    expect(screen.getByText(/file:<query>/i)).toBeInTheDocument();
    // Regular groups hidden in help mode.
    expect(screen.queryByText("Containers")).not.toBeInTheDocument();
  });

  it("renders the Suggestions group in command mode when hook yields entries", async () => {
    mockUseSuggestions.mockReturnValue([
      {
        id: "sugg:npm:dev",
        title: "Run npm: dev",
        subtitle: "vite — package.json",
        command: "npm run dev",
        source: "package.json",
      },
    ]);
    renderPalette();
    expect(await screen.findByText(/suggestions for demo/i)).toBeInTheDocument();
    expect(screen.getByText("Run npm: dev")).toBeInTheDocument();
  });

  it("clearing the input returns to command mode", async () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, "file:");
    expect(screen.queryByText("Containers")).not.toBeInTheDocument();
    await userEvent.clear(input);
    expect(screen.getByText("Containers")).toBeInTheDocument();
  });
});

describe("CommandPalette — M31 theme commands", () => {
  it("lists the three appearance commands", () => {
    renderPalette();
    expect(screen.getByText(/Switch to Light theme/i)).toBeTruthy();
    expect(screen.getByText(/Switch to Dark theme/i)).toBeTruthy();
    expect(screen.getByText(/Use System theme/i)).toBeTruthy();
  });

  it("clicking 'Switch to Light theme' sets preference to light", () => {
    renderPalette();
    fireEvent.click(screen.getByText(/Switch to Light theme/i));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("⌘⇧L keyboard shortcut sets preference to light", () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("⌘⇧D keyboard shortcut sets preference to dark", () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "D", metaKey: true, shiftKey: true });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("⌘⇧S keyboard shortcut clears preference to system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderPalette();
    fireEvent.keyDown(window, { key: "S", metaKey: true, shiftKey: true });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

describe("CommandPalette — M32 route commands", () => {
  it("lists Go to Chats / Go to Library / Go to Files / Open Settings", () => {
    renderPalette();
    expect(screen.getByText(/Go to Chats/i)).toBeTruthy();
    expect(screen.getByText(/Go to Library/i)).toBeTruthy();
    expect(screen.getByText(/Go to Files/i)).toBeTruthy();
    expect(screen.getByText(/Open Settings/i)).toBeTruthy();
  });

  it("clicking 'Go to Chats' invokes onActivity('containers')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Go to Chats/i));
    expect(onActivity).toHaveBeenCalledWith("containers");
  });

  it("clicking 'Go to Library' invokes onActivity('diff-events')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Go to Library/i));
    expect(onActivity).toHaveBeenCalledWith("diff-events");
  });

  it("clicking 'Go to Files' invokes onActivity('files')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Go to Files/i));
    expect(onActivity).toHaveBeenCalledWith("files");
  });

  it("clicking 'Open Settings' invokes onActivity('settings')", () => {
    const onActivity = vi.fn();
    renderPalette({ onActivity });
    fireEvent.click(screen.getByText(/Open Settings/i));
    expect(onActivity).toHaveBeenCalledWith("settings");
  });
});
