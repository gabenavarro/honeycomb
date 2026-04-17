/** Toast notifications, backed by Radix Toast since M8.
 *
 * The public API (``useToasts()`` returning ``{toast, dismiss}``) is
 * unchanged from the hand-rolled pre-M8 system — every call site
 * continues to work. The wins from Radix:
 *
 * * ``<Toast.Viewport>`` is a real ARIA live region; screen readers
 *   announce new toasts without us manually wiring ``aria-live``.
 * * Hover-pause, swipe-to-dismiss, and Esc-closes-last are handled by
 *   the primitive.
 * * Focus management is correct when a toast is actionable — the
 *   button inside gets the focus trap treatment automatically.
 *
 * Kind → ARIA role mapping: ``error`` stays an ``alert`` (assertive);
 * everything else is a ``status`` (polite). Radix forwards ``type``
 * to the DOM: ``foreground`` for alerts, ``background`` for polite.
 */

import * as Toast from "@radix-ui/react-toast";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type ToastKind = "error" | "success" | "info" | "warning";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  durationMs: number;
  open: boolean;
}

interface ToastContextValue {
  toast: (kind: ToastKind, title: string, body?: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, open: false } : t)));
  }, []);

  const toast = useCallback((kind: ToastKind, title: string, body?: string, durationMs = 5000) => {
    const id = nextIdRef.current++;
    setToasts((prev) => [...prev, { id, kind, title, body, durationMs, open: true }]);
    return id;
  }, []);

  // When Radix finishes its close transition (open=false for a bit
  // plus SWIPE_THRESHOLD_DURATION), reap the record so the list stays
  // bounded.
  useEffect(() => {
    if (!toasts.some((t) => !t.open)) return;
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.open));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <Toast.Root
            key={t.id}
            type={t.kind === "error" ? "foreground" : "background"}
            open={t.open}
            duration={t.durationMs > 0 ? t.durationMs : undefined}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            className={`data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:fade-in rounded-md border px-3 py-2 text-xs shadow-lg ${kindClasses(
              t.kind,
            )}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <Toast.Title className="font-medium">{t.title}</Toast.Title>
                {t.body && (
                  <Toast.Description className="mt-0.5 text-[11px] opacity-80">
                    {t.body}
                  </Toast.Description>
                )}
              </div>
              <Toast.Close
                className="opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                aria-label="Dismiss notification"
              >
                ×
              </Toast.Close>
            </div>
          </Toast.Root>
        ))}
        <Toast.Viewport
          className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 outline-none"
          label="Notifications"
        />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

function kindClasses(kind: ToastKind): string {
  switch (kind) {
    case "error":
      return "bg-red-950/90 border-red-800 text-red-100";
    case "success":
      return "bg-green-950/90 border-green-800 text-green-100";
    case "warning":
      return "bg-yellow-950/90 border-yellow-800 text-yellow-100";
    case "info":
    default:
      return "bg-gray-900/90 border-gray-700 text-gray-100";
  }
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToasts must be used inside <ToastProvider>");
  }
  return ctx;
}
