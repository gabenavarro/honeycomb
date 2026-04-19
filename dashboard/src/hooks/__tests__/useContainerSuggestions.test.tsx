/** useContainerSuggestions tests (M23).
 *
 * Manifests: package.json scripts, pyproject.toml [project.scripts]
 * and [tool.poetry.scripts], Makefile top-level targets. Each source
 * fails independently without failing the whole suggestion set.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useContainerSuggestions } from "../useContainerSuggestions";

const mockRead = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
      path: string,
    ) => Promise<{
      content: string | null;
      content_base64?: string | null;
      truncated: boolean;
      mime_type: string;
      size_bytes: number;
      path: string;
    }>
  >(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, readContainerFile: mockRead };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ok(content: string): {
  content: string;
  truncated: boolean;
  mime_type: string;
  size_bytes: number;
  path: string;
} {
  return {
    path: "/fake",
    mime_type: "text/plain",
    size_bytes: content.length,
    content,
    truncated: false,
  };
}

beforeEach(() => {
  mockRead.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
});

describe("useContainerSuggestions", () => {
  it("parses package.json scripts", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("package.json")) {
        return ok(JSON.stringify({ scripts: { dev: "vite", test: "vitest run" } }));
      }
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((s) => s.title).sort()).toEqual([
      "Run npm: dev",
      "Run npm: test",
    ]);
  });

  it("parses pyproject.toml project + poetry scripts", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("pyproject.toml")) {
        return ok(
          `[project.scripts]
hive-cli = "hive.cli:main"

[tool.poetry.scripts]
run-tests = "scripts:pytest"
`,
        );
      }
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    const titles = result.current.map((s) => s.title).sort();
    expect(titles).toEqual(["Run python: hive-cli", "Run python: run-tests"]);
  });

  it("parses Makefile top-level targets and skips .PHONY + comments", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("Makefile")) {
        return ok(
          `.PHONY: test build

# build the app
build:
\tgo build

test:
\tgo test ./...

 indented-not-target:
\techo no
`,
        );
      }
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    const titles = result.current.map((s) => s.title).sort();
    expect(titles).toEqual(["make build", "make test"]);
  });

  it("tolerates a missing manifest and still emits others", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("package.json")) return ok('{"scripts":{"dev":"vite"}}');
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].title).toBe("Run npm: dev");
  });

  it("returns empty when no containerId or workdir", () => {
    const { result } = renderHook(() => useContainerSuggestions(null, ""), { wrapper });
    expect(result.current).toEqual([]);
  });
});
