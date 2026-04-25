import { useState, useMemo } from "react";
import { History, Pencil, FilePlus, FileText, Search } from "lucide-react";

import { useDiffEvents } from "../hooks/useDiffEvents";
import type { DiffEvent, DiffTool } from "../lib/types";

const TOOL_ICON: Record<DiffTool, typeof Pencil> = {
  Edit: Pencil,
  Write: FilePlus,
  MultiEdit: FileText,
};

const TOOL_BORDER: Record<DiffTool, string> = {
  Edit: "border-l-sky-400",
  Write: "border-l-emerald-400",
  MultiEdit: "border-l-violet-400",
};

const TOOL_TEXT: Record<DiffTool, string> = {
  Edit: "text-sky-400",
  Write: "text-emerald-400",
  MultiEdit: "text-violet-400",
};

interface Props {
  containerId: number;
  onOpenEvent: (event: DiffEvent) => void;
}

export function DiffEventsActivity({ containerId, onOpenEvent }: Props) {
  const { events } = useDiffEvents(containerId);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return events;
    const q = filter.toLowerCase();
    return events.filter((e) => e.path.toLowerCase().includes(q));
  }, [events, filter]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <div className="flex h-full flex-col bg-gray-900 text-gray-200">
      <header className="border-b border-gray-800 p-3">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <History className="h-3 w-3" strokeWidth={1.8} />
          Recent Edits
          <span className="ml-auto rounded-full bg-gray-800 px-1.5 py-px text-[10px] font-medium text-gray-500">
            {events.length}
          </span>
        </div>
        <div className="relative">
          <Search
            className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-600"
            strokeWidth={1.8}
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by path…"
            className="w-full rounded border border-gray-700 bg-gray-950 py-1.5 pl-7 pr-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-sky-500 focus:outline-none"
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => (
          <section key={g.label}>
            <h3 className="sticky top-0 z-10 bg-gray-900 px-4 pb-1.5 pt-3 font-mono text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              {g.label}
            </h3>
            {g.items.map((e) => {
              const Icon = TOOL_ICON[e.tool];
              return (
                <div
                  key={e.event_id}
                  data-row
                  data-tool={e.tool}
                  onClick={() => onOpenEvent(e)}
                  className={`flex cursor-pointer items-center gap-2.5 border-l-2 px-3.5 py-2 hover:bg-gray-800 ${TOOL_BORDER[e.tool]}`}
                >
                  <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${TOOL_TEXT[e.tool]}`} strokeWidth={1.7} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] leading-tight">
                      <span className="text-gray-600">{dirOf(e.path)}/</span>
                      <span className="text-gray-200">{baseOf(e.path)}</span>
                    </div>
                    <div className="mt-px text-[11px] text-gray-600">
                      {relativeTime(e.created_at)}
                    </div>
                  </div>
                  <div className="flex-shrink-0 font-mono text-[11px] tabular-nums">
                    {e.added_lines > 0 && (
                      <span className="text-emerald-400">+{e.added_lines}</span>
                    )}
                    {e.added_lines > 0 && e.removed_lines > 0 && (
                      <span className="mx-0.5 text-gray-600">·</span>
                    )}
                    {e.removed_lines > 0 && (
                      <span className="text-rose-400">−{e.removed_lines}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        {groups.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-gray-600">
            {filter.trim() ? "No files match the filter." : "No diff events yet."}
          </div>
        )}
      </div>
    </div>
  );
}

interface Group {
  label: string;
  items: DiffEvent[];
}

function groupByDate(events: DiffEvent[]): Group[] {
  const today: DiffEvent[] = [];
  const yesterday: DiffEvent[] = [];
  const thisWeek: DiffEvent[] = [];
  const older: DiffEvent[] = [];

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfDay - 86_400_000;
  const startOfWeek = startOfDay - 6 * 86_400_000;

  for (const e of events) {
    const t = new Date(e.created_at).getTime();
    if (t >= startOfDay) today.push(e);
    else if (t >= startOfYesterday) yesterday.push(e);
    else if (t >= startOfWeek) thisWeek.push(e);
    else older.push(e);
  }

  const groups: Group[] = [];
  if (today.length) groups.push({ label: "today", items: today });
  if (yesterday.length) groups.push({ label: "yesterday", items: yesterday });
  if (thisWeek.length) groups.push({ label: "this week", items: thisWeek });
  if (older.length) groups.push({ label: "older", items: older });
  return groups;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function relativeTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
