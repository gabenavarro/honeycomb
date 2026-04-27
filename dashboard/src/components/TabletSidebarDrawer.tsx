/** TabletSidebarDrawer — slide-in drawer for the container sidebar at
 *  the tablet breakpoint (768–1023px) (M36).
 *
 *  Hamburger button in the header (App.tsx) toggles `open`. Backdrop
 *  click + Escape both close. Slides in from the LEFT (matches the
 *  desktop sidebar's position).
 *
 *  Width: 288px (w-72) — matches the desktop sidebar so the hosted
 *  ContainerList renders at its natural size.
 */
import { useEffect } from "react";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function TabletSidebarDrawer({ open, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div
        data-testid="drawer-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-pointer bg-black/50"
      />
      <aside
        role="dialog"
        aria-label="Container sidebar"
        className="border-edge bg-pane shadow-pop fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r"
      >
        {children}
      </aside>
    </>
  );
}
