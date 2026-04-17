/** ErrorBoundary tests (M8).
 *
 * Renders a child that throws, asserts the fallback UI is visible,
 * then clicks the reset button and verifies the child re-renders
 * successfully on the next attempt.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "../ErrorBoundary";

function Boom(): never {
  throw new Error("synthetic failure");
}

/** A child that throws on the first render and renders "Recovered" on
 * subsequent ones. We flip the flag via a module-scoped variable so
 * the test can toggle behaviour without needing state or refs. */
let boomArmed = true;

function ConditionalBoom() {
  if (boomArmed) {
    throw new Error("synthetic failure");
  }
  return <div>Recovered</div>;
}

describe("ErrorBoundary", () => {
  it("shows the fallback when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something broke");
    expect(screen.getByRole("alert")).toHaveTextContent("synthetic failure");
    spy.mockRestore();
  });

  it("honours the label prop in the fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="the ML pane">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something broke in the ML pane");
    spy.mockRestore();
  });

  it("recovers when the user clicks the reset button", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    boomArmed = true;
    render(
      <ErrorBoundary>
        <ConditionalBoom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something broke");

    // Flip the flag BEFORE clicking so the next render doesn't throw.
    boomArmed = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Recovered")).toBeInTheDocument();
    spy.mockRestore();
  });
});
