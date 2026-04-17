/** Breadcrumbs smoke tests (M17).
 *
 * Covers: rendering from a seeded path, segment click → onPathChange
 * with the cumulative prefix, and toggling into the edit input.
 *
 * We mock the workdir query with MSW-style ``fetch`` override instead
 * of pulling MSW into every test — the component only calls one
 * endpoint, so a narrow stub is simpler.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Breadcrumbs } from "../Breadcrumbs";

function renderWith(path: string, onPathChange: (p: string) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Breadcrumbs containerId={1} path={path} onPathChange={onPathChange} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Silence the WORKDIR fetch — the component tolerates a missing
  // response, the tests just don't want network noise.
  globalThis.fetch = vi.fn(
    async () => new Response("{}", { status: 404 }),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Breadcrumbs", () => {
  it("renders a segment button for each path component", () => {
    renderWith("/workspace/app/src", () => {});
    // Every segment is a button; the root is labelled "/" and each
    // subsequent part is its own button.
    expect(screen.getByRole("button", { name: /^\/$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "src" })).toBeInTheDocument();
  });

  it("clicking a segment asks the parent to navigate to that prefix", async () => {
    const onPathChange = vi.fn();
    renderWith("/workspace/app/src", onPathChange);
    await userEvent.click(screen.getByRole("button", { name: "app" }));
    expect(onPathChange).toHaveBeenCalledWith("/workspace/app");
  });

  it("edit button swaps in a text input pre-filled with the current path", async () => {
    renderWith("/workspace/app", () => {});
    await userEvent.click(screen.getByRole("button", { name: /edit path/i }));
    const input = screen.getByRole("textbox", { name: /absolute path/i });
    expect(input).toHaveValue("/workspace/app");
  });
});
