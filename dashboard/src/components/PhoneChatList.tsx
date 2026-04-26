/** PhoneChatList — list view for chats at phone breakpoint (M36).
 *
 *  Workspace pill at top, search input, list of session rows, FAB
 *  for new chat. Tapping a row navigates to PhoneChatDetail.
 *
 *  No sub-tabs / no resource readout / no edit-auto toggle — those
 *  are cut on phone per the M36 spec ("What's cut on phone" §).
 */
import { Plus, Search } from "lucide-react";
import { useState } from "react";

import type { NamedSession } from "../lib/types";

interface Props {
  workspaceName: string;
  sessions: NamedSession[];
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
}

function relativeDateGroup(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.floor((now - t) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Last 7 days";
  if (days < 30) return "Last 30 days";
  return "Older";
}

export function PhoneChatList({ workspaceName, sessions, onSelectSession, onNewChat }: Props) {
  const [query, setQuery] = useState("");

  const filtered = query
    ? sessions.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    : sessions;

  // Group by relative date bucket. Order: Today → Yesterday → Last 7 → Last 30 → Older.
  const groupOrder = ["Today", "Yesterday", "Last 7 days", "Last 30 days", "Older"] as const;
  const groups = new Map<string, NamedSession[]>();
  for (const s of filtered) {
    const bucket = relativeDateGroup(s.updated_at);
    const arr = groups.get(bucket) ?? [];
    arr.push(s);
    groups.set(bucket, arr);
  }

  return (
    <div className="bg-page flex h-full flex-col">
      <header className="border-edge bg-pane border-b px-4 py-3">
        <div className="bg-chip border-edge-soft text-primary flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium">
          <span className="bg-accent inline-block h-1.5 w-1.5 rounded-full" />
          {workspaceName}
        </div>
        <label className="bg-input border-edge text-primary focus-within:border-accent mt-3 flex items-center gap-2 rounded border px-2 py-2 text-[12px]">
          <Search size={14} aria-hidden="true" className="text-muted shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            className="placeholder:text-muted flex-1 bg-transparent focus:outline-none"
          />
        </label>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {filtered.length === 0 ? (
          <p className="text-secondary px-3 py-8 text-center text-[13px]">
            {query ? "No chats match your search." : "No chats yet. Tap + to start one."}
          </p>
        ) : (
          groupOrder.map((g) => {
            const items = groups.get(g);
            if (!items || items.length === 0) return null;
            return (
              <section key={g} className="mb-4">
                <h2 className="text-muted mb-1.5 px-1 text-[10px] font-semibold tracking-wider uppercase">
                  {g}
                </h2>
                <ul className="flex flex-col gap-1">
                  {items.map((s) => (
                    <li key={s.session_id}>
                      <button
                        type="button"
                        onClick={() => onSelectSession(s.session_id)}
                        className="bg-pane border-edge-soft hover:bg-chip text-primary flex min-h-[44px] w-full items-center gap-3 rounded border px-3 py-2 text-left text-[13px]"
                      >
                        <span className="flex-1 truncate">{s.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      <button
        type="button"
        onClick={onNewChat}
        aria-label="New chat"
        className="bg-accent text-primary shadow-pop fixed right-4 bottom-20 z-20 flex h-12 w-12 items-center justify-center rounded-full"
      >
        <Plus size={22} aria-hidden="true" />
      </button>
    </div>
  );
}
