/** Minimal toast system for surfacing mutation errors and backend events.
 *
 * No extra dependency: a tiny context holds a queue; a portal-free overlay
 * renders in the corner. Meant for dashboard-wide, transient messages
 * (mutation errors, success confirmations, state-change notices).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "error" | "success" | "info" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  durationMs: number;
}

interface ToastContextValue {
  toast: (kind: ToastKind, title: string, body?: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (kind: ToastKind, title: string, body?: string, durationMs = 5000) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev, { id, kind, title, body, durationMs }]);
      if (durationMs > 0) {
        const timer = window.setTimeout(() => dismiss(id), durationMs);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastOverlay toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastOverlay({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={`rounded-md border px-3 py-2 text-xs shadow-lg ${kindClasses(t.kind)}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[11px] opacity-80">{t.body}</div>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="opacity-60 hover:opacity-100"
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
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
