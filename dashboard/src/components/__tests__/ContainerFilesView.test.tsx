/** ContainerFilesView tests (M22.1).
 *
 * Locks in the split interaction model introduced in M22.1:
 *   - directories sort before files, both alphabetically case-insensitive;
 *   - the chevron button toggles in-place expansion without navigating;
 *   - double-clicking a directory label calls ``onNavigate`` with the
 *     full child path, without toggling the chevron.
 *
 * The API is mocked at the module level so the component's ``useQuery``
 * resolves synchronously in the test environment.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContainerFilesView } from "../ContainerFilesView";
import type { DirectoryListing, FsEntry } from "../../lib/types";

const mockListDirectory = vi.hoisted(() =>
  vi.fn<(id: number, path: string) => Promise<DirectoryListing>>(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, listContainerDirectory: mockListDirectory };
});

function makeEntry(name: string, kind: FsEntry["kind"]): FsEntry {
  return { name, kind, size: 0, mode: "-rw-r--r--", mtime: "", target: null };
}

function renderTree(path: string, onNavigate = vi.fn(), onOpenFile = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onNavigate,
    onOpenFile,
    ...render(
      <QueryClientProvider client={qc}>
        <ContainerFilesView
          containerId={1}
          path={path}
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  mockListDirectory.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ContainerFilesView — M22.1 sort + interactions", () => {
  it("sorts folders before files, each alphabetically case-insensitive", async () => {
    mockListDirectory.mockResolvedValue({
      path: "/workspace",
      truncated: false,
      entries: [
        makeEntry("zeta.txt", "file"),
        makeEntry("Apple", "dir"),
        makeEntry("alpha.txt", "file"),
        makeEntry("beta", "dir"),
        makeEntry("Charlie.md", "file"),
      ],
    });
    renderTree("/workspace");

    // Names render in DOM order; the expected order is:
    //   Apple, beta (dirs, case-insensitive) then alpha.txt, Charlie.md, zeta.txt
    await waitFor(() => expect(screen.queryByText("Apple")).toBeInTheDocument());
    const labels = screen
      .getAllByText(/Apple|beta|alpha\.txt|Charlie\.md|zeta\.txt/)
      .map((n) => n.textContent);
    expect(labels).toEqual(["Apple", "beta", "alpha.txt", "Charlie.md", "zeta.txt"]);
  });

  it("chevron click toggles expansion without calling onNavigate", async () => {
    mockListDirectory.mockImplementation(async (_id, p) => {
      if (p === "/workspace") {
        return { path: p, truncated: false, entries: [makeEntry("sub", "dir")] };
      }
      return { path: p, truncated: false, entries: [makeEntry("inner.txt", "file")] };
    });
    const { onNavigate } = renderTree("/workspace");
    await waitFor(() => expect(screen.queryByText("sub")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /expand sub/i }));
    await waitFor(() => expect(screen.queryByText("inner.txt")).toBeInTheDocument());
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("double-click on a directory name fires onNavigate with the child path", async () => {
    mockListDirectory.mockResolvedValue({
      path: "/workspace",
      truncated: false,
      entries: [makeEntry("sub", "dir")],
    });
    const { onNavigate } = renderTree("/workspace");
    await waitFor(() => expect(screen.queryByText("sub")).toBeInTheDocument());

    await userEvent.dblClick(screen.getByText("sub"));
    expect(onNavigate).toHaveBeenCalledWith("/workspace/sub");
  });

  it("single-clicking a file opens it via onOpenFile", async () => {
    mockListDirectory.mockResolvedValue({
      path: "/workspace",
      truncated: false,
      entries: [makeEntry("readme.md", "file")],
    });
    const { onOpenFile } = renderTree("/workspace");
    await waitFor(() => expect(screen.queryByText("readme.md")).toBeInTheDocument());

    await userEvent.click(screen.getByText("readme.md"));
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/readme.md");
  });
});
