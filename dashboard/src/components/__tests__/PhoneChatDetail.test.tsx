import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhoneChatDetail } from "../PhoneChatDetail";

describe("PhoneChatDetail", () => {
  it("renders a back-arrow button with aria-label='Back to chat list'", () => {
    render(
      <PhoneChatDetail title="my-chat" onBack={vi.fn()}>
        <p>thread + composer go here</p>
      </PhoneChatDetail>,
    );
    expect(screen.getByRole("button", { name: /back to chat list/i })).toBeTruthy();
  });

  it("clicking the back-arrow calls onBack", () => {
    const onBack = vi.fn();
    render(
      <PhoneChatDetail title="my-chat" onBack={onBack}>
        <p>x</p>
      </PhoneChatDetail>,
    );
    fireEvent.click(screen.getByRole("button", { name: /back to chat list/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the title in the header", () => {
    render(
      <PhoneChatDetail title="my-chat" onBack={vi.fn()}>
        <p>x</p>
      </PhoneChatDetail>,
    );
    expect(screen.getByText("my-chat")).toBeTruthy();
  });

  it("renders the children below the header", () => {
    render(
      <PhoneChatDetail title="x" onBack={vi.fn()}>
        <p>composer area</p>
      </PhoneChatDetail>,
    );
    expect(screen.getByText("composer area")).toBeTruthy();
  });

  it("the back-arrow has min-h-[44px] for tap target", () => {
    render(
      <PhoneChatDetail title="x" onBack={vi.fn()}>
        <p>x</p>
      </PhoneChatDetail>,
    );
    const back = screen.getByRole("button", { name: /back to chat list/i });
    expect(back.className).toMatch(/min-h-\[44px\]/);
  });
});
