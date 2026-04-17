/** NotebookViewer smoke tests (M19).
 *
 * Keeps the scope tight: valid .ipynb JSON renders without crashing,
 * invalid JSON falls through to the error state. The underlying
 * react-ipynb-renderer owns cell-level rendering — we don't try to
 * assert on every cell type.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
        {
          name: "stdout",
          output_type: "stream",
          text: ["hi from code cell\n"],
        },
      ],
      source: ["print('hi from code cell')"],
    },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
});

describe("NotebookViewer", () => {
  it("renders a markdown heading + code output from a minimal ipynb", () => {
    render(<NotebookViewer source={TINY_IPYNB} />);
    // react-ipynb-renderer emits the markdown heading text.
    expect(screen.getByText(/hello/i)).toBeInTheDocument();
    expect(screen.getByText(/hi from code cell/i)).toBeInTheDocument();
  });

  it("falls through to an error state on invalid JSON", () => {
    render(<NotebookViewer source="not json" />);
    expect(screen.getByText(/could not be parsed/i)).toBeInTheDocument();
  });
});
