/** Sheet — hand-rolled bottom-sheet primitive (M36).
 *
 *  Used by ModeToggleSheet, EffortPickerSheet, MessageActionSheet,
 *  and the phone variant of MoreCustomizationSheet. Per the M35
 *  precedent (MoreCustomizationSheet), we hand-roll instead of using
 *  Radix Dialog — mobile sheets are click-only and the bundle savings
 *  matter on phones.
 *
 *  Backdrop has cursor: pointer so iOS Safari treats the tap as
 *  interactive (without it the tap is silently ignored). Escape key
 *  also closes.
 *
 *  Slides up from the bottom with a 200ms CSS transition. Respects
 *  the iOS safe-area-inset-bottom via .pb-safe-bottom.
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Override the default max-height (90vh). For action sheets that
   *  should hug their content, pass "auto". */
  maxHeight?: string;
}

export function Sheet({ open, onClose, title, children, maxHeight = "90vh" }: Props) {
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
        data-testid="sheet-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-pointer bg-black/50"
      />
      <div
        role="dialog"
        aria-label={title}
        className="border-edge bg-pane pb-safe-bottom shadow-pop fixed right-0 bottom-0 left-0 z-50 flex flex-col rounded-t-xl border-t"
        style={{ maxHeight }}
      >
        <header className="border-edge flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-primary text-[14px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sheet"
            className="text-secondary hover:text-primary rounded p-1.5"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </>
  );
}
