/** Unified "how healthy is the dashboard talking to everything?"
 * chip for the StatusBar (M21 item I).
 *
 * Aggregates three signals:
 *
 *  1. Hub WebSocket — the singleton connection drives live container
 *     updates; while it's out, the UI is read-only-ish.
 *  2. Hub HTTP — derived from the ``/api/health`` query landing within
 *     the last 60 s. Covers the case where the WS looks OK but the
 *     hub has stopped responding to REST.
 *  3. Active container PTY liveness — reuses ``/api/containers/{id}/
 *     sessions`` to decide whether the focused container has at least
 *     one attached PTY. Purely informational — doesn't affect the
 *     overall status colour.
 *
 * Worst-of-three wins: red if any critical signal is offline, amber if
 * WS is reconnecting, green otherwise. Clicking opens a Radix Popover
 * with a per-signal breakdown.
 */

import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDot, CircleX } from "lucide-react";

import { getHealth, listContainerSessions } from "../lib/api";
import { useHiveWebSocket } from "../hooks/useWebSocket";
import { backoffRefetch } from "../hooks/useSmartPoll";

type ChipStatus = "ok" | "warn" | "down";

interface Props {
  activeContainerId: number | null;
}

function statusColor(s: ChipStatus): string {
  switch (s) {
    case "ok":
      return "text-green-300";
    case "warn":
      return "text-yellow-200";
    case "down":
      return "text-red-200";
  }
}

function StatusDot({ s }: { s: ChipStatus }) {
  const Icon = s === "ok" ? CircleCheck : s === "warn" ? CircleDot : CircleX;
  return <Icon size={10} className={statusColor(s)} aria-hidden="true" />;
}

export function ConnectivityChip({ activeContainerId }: Props) {
  const { connected } = useHiveWebSocket();
  const { data: health, isFetching: healthFetching } = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: backoffRefetch({ baseMs: 10_000, maxMs: 120_000 }),
  });
  const { data: sessionsData } = useQuery({
    queryKey: ["sessions", activeContainerId ?? 0],
    queryFn: () =>
      activeContainerId === null
        ? Promise.resolve({ sessions: [] })
        : listContainerSessions(activeContainerId),
    enabled: activeContainerId !== null,
    refetchInterval: 10_000,
  });

  const wsStatus: ChipStatus = connected ? "ok" : "warn";
  const httpStatus: ChipStatus = health ? "ok" : healthFetching ? "warn" : "down";
  const anyPty = sessionsData?.sessions.some((s) => s.attached) ?? false;
  const ptyStatus: ChipStatus = activeContainerId === null ? "ok" : anyPty ? "ok" : "warn";

  // Worst-of-two (WS + HTTP). PTY is informational only — its status
  // feeds the popover but doesn't demote the whole chip.
  const statuses: ChipStatus[] = [wsStatus, httpStatus];
  const overall: ChipStatus = statuses.includes("down")
    ? "down"
    : statuses.includes("warn")
      ? "warn"
      : "ok";

  const label =
    overall === "ok" ? "hub" : overall === "warn" ? "hub (reconnecting)" : "hub offline";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          aria-label="Connectivity details"
          title="Connectivity status — click for detail"
        >
          <StatusDot s={overall} />
          <span className={overall === "ok" ? "text-white" : statusColor(overall)}>{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-md border border-edge bg-page p-3 text-[11px] text-primary shadow-xl outline-none"
        >
          <h4 className="mb-2 text-[10px] font-semibold tracking-wider text-secondary uppercase">
            Connectivity
          </h4>
          <ul className="space-y-1.5">
            <li className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <StatusDot s={wsStatus} />
                Multiplex WebSocket
              </span>
              <span className="text-secondary">{connected ? "connected" : "reconnecting"}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <StatusDot s={httpStatus} />
                Hub REST
              </span>
              <span className="text-secondary">
                {health ? `v${health.version}` : "no response"}
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <StatusDot s={ptyStatus} />
                Active PTY
              </span>
              <span className="text-secondary">
                {activeContainerId === null
                  ? "no container focused"
                  : anyPty
                    ? `${sessionsData?.sessions.filter((s) => s.attached).length} attached`
                    : "none attached"}
              </span>
            </li>
          </ul>
          <Popover.Arrow className="fill-edge" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
