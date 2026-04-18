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

/** M22.3 — persisted log of everything the toast system has fired,
 * alive or dismissed. Consumed by the ``NotificationCenter`` bell in
 * the StatusBar. Capped at 50 entries — the user never wants to scroll
 * forever, and we clear on demand. */
export interface ToastRecord extends ToastItem {
  /** Wall-clock when the toast was created. Cheaper than holding Date
   * objects in the list; we format at render time. */
  created_at: string;
}

interface ToastContextValue {
  toast: (kind: ToastKind, title: string, body?: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
  /** Full history (oldest first). Capped at 50 entries; older entries
   * are dropped as new ones arrive. */
  history: ToastRecord[];
  /** Manually wipe the history. Does not dismiss live toasts. */
  clearHistory: () => void;
  /** Mark every history entry as seen so the unread badge clears. */
  markHistoryRead: () => void;
  /** Number of history entries added since the last ``markHistoryRead``. */
  unreadCount: number;
}

// M22.3 — per-kind default duration. Callers can still override with
// an explicit ``durationMs`` arg. Errors linger longest so the user has
// time to read them; info/success auto-dismiss fastest because they
// usually confirm a completed action.
const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  info: 3000,
  success: 3000,
  warning: 5000,
  error: 8000,
};

const HISTORY_CAP = 50;

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<ToastRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const nextIdRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, open: false } : t)));
  }, []);

  const toast = useCallback(
    (kind: ToastKind, title: string, body?: string, durationMs?: number) => {
      const id = nextIdRef.current++;
      const resolvedDuration = durationMs ?? DEFAULT_DURATIONS[kind];
      const record: ToastRecord = {
        id,
        kind,
        title,
        body,
        durationMs: resolvedDuration,
        open: true,
        created_at: new Date().toISOString(),
      };
      setToasts((prev) => [...prev, record]);
      setHistory((prev) => {
        const next = [...prev, record];
        // Ring-buffer discipline — drop from the front when we exceed
        // the cap so .slice() returns most-recent-last.
        return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
      });
      setUnreadCount((n) => n + 1);
      return id;
    },
    [],
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    setUnreadCount(0);
  }, []);

  const markHistoryRead = useCallback(() => {
    setUnreadCount(0);
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

  const value = useMemo(
    () => ({ toast, dismiss, history, clearHistory, markHistoryRead, unreadCount }),
    [toast, dismiss, history, clearHistory, markHistoryRead, unreadCount],
  );

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <Toast.Root
            key={t.id}
            // Radix sets an ``aria-live`` announcement region automatically,
            // but ``<Toast.Root>`` itself renders an ``<li>`` with no role.
            // Errors additionally carry ``role="alert"`` so the visible
            // node is also flagged as assertive — matching the pre-Radix
            // behaviour and what most users expect when grepping the DOM.
            role={t.kind === "error" ? "alert" : "status"}
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
