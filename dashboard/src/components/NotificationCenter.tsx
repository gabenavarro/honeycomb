/** Bell icon + popover history of past toasts (M22.3).
 *
 * Replaces the always-visible "unreachable" banner. Toasts still pop
 * briefly (shortened durations per kind in ``useToasts``), then persist
 * here for review. The bell shows an unread badge; opening the popover
 * clears it via ``markHistoryRead``.
 *
 * Kept intentionally small — a header, a scrollable list, an empty
 * state. Clearing the history is explicit; the list is capped at 50
 * entries server-side (ring-buffered inside ``useToasts``).
 */

import * as Popover from "@radix-ui/react-popover";
import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info, Trash2 } from "lucide-react";

import { type ToastKind, useToasts, type ToastRecord } from "../hooks/useToasts";

function KindIcon({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case "error":
      return <AlertCircle size={11} className="text-red-400" aria-hidden="true" />;
    case "warning":
      return <AlertTriangle size={11} className="text-yellow-400" aria-hidden="true" />;
    case "success":
      return <CheckCircle2 size={11} className="text-green-400" aria-hidden="true" />;
    case "info":
    default:
      return <Info size={11} className="text-blue-400" aria-hidden="true" />;
  }
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function NotificationCenter() {
  const { history, clearHistory, markHistoryRead, unreadCount } = useToasts();

  return (
    <Popover.Root onOpenChange={(open) => (open ? markHistoryRead() : undefined)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative flex items-center rounded px-1.5 py-0.5 text-[10px] text-white/90 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          aria-label={unreadCount > 0 ? `Notifications — ${unreadCount} unread` : "Notifications"}
          title="Recent notifications"
        >
          <Bell size={11} />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-1 min-w-[14px] rounded-full bg-[#e81123] px-1 text-[8px] leading-none font-bold text-white"
              aria-hidden="true"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          className="z-50 w-80 rounded-md border border-edge bg-page text-primary shadow-xl outline-none"
        >
          <header className="flex items-center justify-between border-b border-edge px-3 py-1.5">
            <h4 className="text-[10px] font-semibold tracking-wider text-secondary uppercase">
              Recent notifications ({history.length})
            </h4>
            <button
              type="button"
              onClick={clearHistory}
              disabled={history.length === 0}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-secondary hover:bg-[#2a2a2a] hover:text-primary disabled:opacity-40"
              aria-label="Clear notification history"
              title="Clear history"
            >
              <Trash2 size={10} />
              Clear
            </button>
          </header>
          <div className="max-h-80 overflow-y-auto">
            {history.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-muted">Nothing recent.</p>
            ) : (
              <ul className="divide-y divide-edge/50">
                {/* Most recent first — history is appended in order, so
                    reverse the slice for display without mutating. */}
                {[...history].reverse().map((item) => (
                  <Row key={item.id} item={item} />
                ))}
              </ul>
            )}
          </div>
          <Popover.Arrow className="fill-edge" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({ item }: { item: ToastRecord }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-[11px]">
      <KindIcon kind={item.kind} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-primary">{item.title}</div>
        {item.body && (
          <div className="mt-0.5 line-clamp-2 text-[10px] text-secondary">{item.body}</div>
        )}
        <div className="mt-0.5 text-[10px] text-muted">{relativeTime(item.created_at)}</div>
      </div>
    </li>
  );
}
