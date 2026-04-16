/** Per-repo, per-kind terminal session store backed by localStorage.
 *
 * Each session is keyed `(containerId, kind)` where kind ∈ "shell" | "claude".
 * Opening a container exposes two parallel transcripts that survive:
 *   - tab switches within a container
 *   - switching between containers
 *   - browser reloads (best-effort, quota-bounded)
 *
 * Shape on disk: one JSON object per session, namespaced under
 * `hive:session:v3:{containerId}:{kind}`. v3 added `history` — the list
 * of previously-submitted inputs used for arrow-up recall and
 * autocomplete ranking. v2 entries are ignored; users will see a clean
 * session on their first open after upgrade.
 */

import { useCallback, useEffect, useState } from "react";

export type SessionKind = "shell" | "claude";

export type LineType = "input" | "output" | "error" | "system";

export interface SessionLine {
  text: string;
  timestamp: string; // ISO8601 so lines survive JSON round-trips
  type: LineType;
}

export interface SessionState {
  containerId: number;
  kind: SessionKind;
  lines: SessionLine[];
  draft: string;
  activeCommandId: string | null;
  lastActive: string; // ISO8601
  // Most recent first. Capped at HISTORY_MAX. Consecutive duplicates
  // collapsed to one entry (bash-style HISTCONTROL=ignoredups).
  history: string[];
}

const MAX_LINES_PER_SESSION = 2000;
const HISTORY_MAX = 200;
const STORAGE_VERSION = "v3";

function storageKey(containerId: number, kind: SessionKind): string {
  return `hive:session:${STORAGE_VERSION}:${containerId}:${kind}`;
}

function emptySession(containerId: number, kind: SessionKind): SessionState {
  return {
    containerId,
    kind,
    lines: [],
    draft: "",
    activeCommandId: null,
    lastActive: new Date().toISOString(),
    history: [],
  };
}

function load(containerId: number, kind: SessionKind): SessionState {
  try {
    const raw = localStorage.getItem(storageKey(containerId, kind));
    if (!raw) return emptySession(containerId, kind);
    const parsed = JSON.parse(raw) as SessionState;
    if (!Array.isArray(parsed.lines)) return emptySession(containerId, kind);
    return {
      containerId,
      kind,
      lines: parsed.lines.slice(-MAX_LINES_PER_SESSION),
      draft: parsed.draft ?? "",
      activeCommandId: parsed.activeCommandId ?? null,
      lastActive: parsed.lastActive ?? new Date().toISOString(),
      history: Array.isArray(parsed.history)
        ? parsed.history.slice(0, HISTORY_MAX)
        : [],
    };
  } catch {
    return emptySession(containerId, kind);
  }
}

function save(state: SessionState): void {
  try {
    const trimmed: SessionState = {
      ...state,
      lines: state.lines.slice(-MAX_LINES_PER_SESSION),
      history: state.history.slice(0, HISTORY_MAX),
    };
    localStorage.setItem(
      storageKey(state.containerId, state.kind),
      JSON.stringify(trimmed),
    );
  } catch {
    // Storage quota exhausted or private mode — sessions remain in memory.
  }
}

export interface SessionHandle {
  state: SessionState;
  appendLines: (lines: SessionLine[]) => void;
  setDraft: (draft: string) => void;
  setActiveCommandId: (id: string | null) => void;
  pushHistory: (entry: string) => void;
  clear: () => void;
  copyTranscript: () => Promise<boolean>;
}

export function useSession(
  containerId: number,
  kind: SessionKind,
): SessionHandle {
  const [state, setState] = useState<SessionState>(() => load(containerId, kind));

  useEffect(() => {
    setState(load(containerId, kind));
  }, [containerId, kind]);

  const commit = useCallback((next: SessionState) => {
    setState(next);
    save(next);
  }, []);

  const appendLines = useCallback((newLines: SessionLine[]) => {
    setState((prev) => {
      const next: SessionState = {
        ...prev,
        lines: [...prev.lines, ...newLines].slice(-MAX_LINES_PER_SESSION),
        lastActive: new Date().toISOString(),
      };
      save(next);
      return next;
    });
  }, []);

  const setDraft = useCallback((draft: string) => {
    setState((prev) => {
      const next = { ...prev, draft };
      save(next);
      return next;
    });
  }, []);

  const setActiveCommandId = useCallback((id: string | null) => {
    setState((prev) => {
      const next = { ...prev, activeCommandId: id };
      save(next);
      return next;
    });
  }, []);

  const pushHistory = useCallback((entry: string) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    setState((prev) => {
      // Dedup consecutive — if the user just ran `ls` and runs it again,
      // one history entry, not two.
      if (prev.history[0] === trimmed) return prev;
      const next: SessionState = {
        ...prev,
        history: [trimmed, ...prev.history].slice(0, HISTORY_MAX),
      };
      save(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    // Keep history — clearing the transcript shouldn't wipe shell recall.
    commit({ ...emptySession(containerId, kind), history: state.history });
  }, [containerId, kind, state.history, commit]);

  const copyTranscript = useCallback(async (): Promise<boolean> => {
    const text = state.lines
      .map((l) => {
        const prefix =
          l.type === "input"
            ? kind === "claude"
              ? "claude> "
              : "$ "
            : "";
        return `${prefix}${l.text}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, [state.lines, kind]);

  return {
    state,
    appendLines,
    setDraft,
    setActiveCommandId,
    pushHistory,
    clear,
    copyTranscript,
  };
}

export function useSessionSummary(
  containerId: number,
  kind: SessionKind,
): { hasLines: boolean; isStreaming: boolean; lastActive: string | null } {
  const [summary, setSummary] = useState(() => {
    const s = load(containerId, kind);
    return {
      hasLines: s.lines.length > 0,
      isStreaming: s.activeCommandId !== null,
      lastActive: s.lines.length > 0 ? s.lastActive : null,
    };
  });

  useEffect(() => {
    const tick = () => {
      const s = load(containerId, kind);
      setSummary({
        hasLines: s.lines.length > 0,
        isStreaming: s.activeCommandId !== null,
        lastActive: s.lines.length > 0 ? s.lastActive : null,
      });
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [containerId, kind]);

  return summary;
}

export function purgeContainerSessions(containerId: number): void {
  for (const kind of ["shell", "claude"] as SessionKind[]) {
    try {
      localStorage.removeItem(storageKey(containerId, kind));
    } catch {
      // ignore
    }
  }
}
