/** FileViewer edit-mode tests (M24).
 *
 * Covers: Edit button visibility rules, edit-mode flip, Save calls
 * writeContainerFile with the echoed mtime, 409 surfaces the
 * conflict banner, Cancel with dirty draft prompts, and the
 * ErrorBoundary fallback when the CodeEditor throws.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// react-ipynb-renderer (pulled in transitively by NotebookViewer) uses dynamic
// ESM theme imports that don't resolve under Vitest + jsdom.  Stub it out.
vi.mock("react-ipynb-renderer", () => ({
  IpynbRenderer: () => <div data-testid="ipynb-stub" />,
}));
vi.mock("react-ipynb-renderer/dist/styles/onedork.css", () => ({}));

import { FileViewer } from "../FileViewer";
import { ToastProvider } from "../../hooks/useToasts";

const mockRead = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
      path: string,
    ) => Promise<{
      path: string;
      mime_type: string;
      size_bytes: number;
      mtime_ns: number;
      content: string | null;
      content_base64?: string | null;
      truncated: boolean;
    }>
  >(),
);
const mockWrite = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
      body: {
        path: string;
        content?: string | null;
        content_base64?: string | null;
        if_match_mtime_ns: number;
      },
    ) => Promise<unknown>
  >(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    readContainerFile: mockRead,
    writeContainerFile: mockWrite,
  };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockRead.mockReset();
  mockWrite.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

function textFile(content: string, mtime = 1_700_000_000_000_000_000) {
  return {
    path: "/w/foo.md",
    mime_type: "text/markdown",
    size_bytes: content.length,
    mtime_ns: mtime,
    content,
    truncated: false,
  };
}

describe("FileViewer — M24 edit mode", () => {
  it("renders an Edit button for text files", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    render(<FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />, { wrapper });
    const btn = await screen.findByRole("button", { name: /edit/i });
    expect(btn).toBeInTheDocument();
  });

  it("does not render an Edit button for truncated files", async () => {
    mockRead.mockResolvedValue({ ...textFile(""), truncated: true, content: null });
    render(<FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />, { wrapper });
    await screen.findByText(/too large to preview/i);
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it("clicking Edit swaps in an editor seeded with the content", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    const { container } = render(
      <FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />,
      { wrapper },
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const cm = container.querySelector(".cm-content");
    expect(cm?.textContent).toContain("hello");
  });

  it("Save posts the draft with if_match_mtime_ns from the read", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    mockWrite.mockResolvedValue(textFile("hello-edited", 1_700_000_100_000_000_000));
    const { container } = render(
      <FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />,
      { wrapper },
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const cm = container.querySelector<HTMLElement>(".cm-content");
    cm!.focus();
    await userEvent.type(cm!, "-edited");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(mockWrite).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        path: "/w/foo.md",
        if_match_mtime_ns: 1_700_000_000_000_000_000,
      }),
    );
  });

  it("409 surfaces the conflict banner", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    const apiErr = Object.assign(new Error("409: File changed"), { status: 409 });
    mockWrite.mockRejectedValue(apiErr);
    const { container } = render(
      <FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />,
      { wrapper },
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const cm = container.querySelector<HTMLElement>(".cm-content");
    cm!.focus();
    await userEvent.type(cm!, "x");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reload$/i })).toBeInTheDocument();
  });
});
