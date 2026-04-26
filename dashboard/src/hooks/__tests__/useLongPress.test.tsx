/** useLongPress hook tests (M36). */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLongPress } from "../useLongPress";

function Probe({ onLongPress, ms }: { onLongPress: () => void; ms?: number }) {
  const handlers = useLongPress(onLongPress, { delayMs: ms });
  return <div data-testid="probe" {...handlers} />;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLongPress", () => {
  it("fires onLongPress after the default 500ms delay", () => {
    const cb = vi.fn();
    const { getByTestId } = render(<Probe onLongPress={cb} />);
    fireEvent.touchStart(getByTestId("probe"));
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire if touchEnd happens before the delay elapses", () => {
    const cb = vi.fn();
    const { getByTestId } = render(<Probe onLongPress={cb} />);
    const el = getByTestId("probe");
    fireEvent.touchStart(el);
    vi.advanceTimersByTime(200);
    fireEvent.touchEnd(el);
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });

  it("respects a custom delayMs", () => {
    const cb = vi.fn();
    const { getByTestId } = render(<Probe onLongPress={cb} ms={250} />);
    fireEvent.touchStart(getByTestId("probe"));
    vi.advanceTimersByTime(249);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("touchMove cancels the pending long-press (avoids firing during scroll)", () => {
    const cb = vi.fn();
    const { getByTestId } = render(<Probe onLongPress={cb} />);
    const el = getByTestId("probe");
    fireEvent.touchStart(el);
    vi.advanceTimersByTime(200);
    fireEvent.touchMove(el);
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });
});
