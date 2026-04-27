import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TabletSidebarDrawer } from "../TabletSidebarDrawer";

describe("TabletSidebarDrawer", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <TabletSidebarDrawer open={false} onClose={vi.fn()}>
        <p>sidebar content</p>
      </TabletSidebarDrawer>,
    );
    expect(container.textContent).toBe("");
  });

  it("renders the children when open=true", () => {
    render(
      <TabletSidebarDrawer open={true} onClose={vi.fn()}>
        <p>sidebar content</p>
      </TabletSidebarDrawer>,
    );
    expect(screen.getByText("sidebar content")).toBeTruthy();
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(
      <TabletSidebarDrawer open={true} onClose={onClose}>
        <p>x</p>
      </TabletSidebarDrawer>,
    );
    fireEvent.click(screen.getByTestId("drawer-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    render(
      <TabletSidebarDrawer open={true} onClose={onClose}>
        <p>x</p>
      </TabletSidebarDrawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has role=dialog with an aria-label", () => {
    render(
      <TabletSidebarDrawer open={true} onClose={vi.fn()}>
        <p>x</p>
      </TabletSidebarDrawer>,
    );
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBeTruthy();
  });
});
