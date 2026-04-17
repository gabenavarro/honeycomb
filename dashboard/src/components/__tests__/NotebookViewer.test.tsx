/** NotebookViewer smoke tests (M19).
 *
 * We mock ``react-ipynb-renderer`` — its transitive
 * ``react-syntax-highlighter`` pulls in a theme module via dynamic
 * ESM imports that don't resolve under Vitest + jsdom. The real
 * renderer is still exercised at dev/prod runtime; the test's job is
 * to pin the parse/error boundary, which is pure JSON.parse logic
 * that lives in our component, not the library.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-ipynb-renderer", () => ({
  IpynbRenderer: ({ ipynb }: { ipynb: { cells?: { cell_type: string }[] } }) => (
    <div data-testid="ipynb-stub">cells: {ipynb.cells?.length ?? 0}</div>
  ),
}));

vi.mock("react-ipynb-renderer/dist/styles/onedork.css", () => ({}));

import { NotebookViewer } from "../NotebookViewer";

const TINY_IPYNB = JSON.stringify({
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: ["# Hello"],
    },
    {
      cell_type: "code",
      execution_count: 1,
      metadata: {},
      outputs: [
        { name: "stdout", output_type: "stream", text: ["hi from code cell\n"] },
      ],
      source: ["print('hi from code cell')"],
    },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
});

describe("NotebookViewer", () => {
  it("parses valid ipynb JSON and forwards it to the renderer", () => {
    render(<NotebookViewer source={TINY_IPYNB} />);
    expect(screen.getByTestId("ipynb-stub")).toHaveTextContent("cells: 2");
  });

  it("falls through to an error state on invalid JSON", () => {
    render(<NotebookViewer source="not json" />);
    expect(screen.getByText(/could not be parsed/i)).toBeInTheDocument();
  });
});
