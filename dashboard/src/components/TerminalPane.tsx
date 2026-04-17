import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Terminal,
  Bot,
  Trash2,
  ClipboardCopy,
  Download,
  Loader2,
  AlertTriangle,
  Zap,
  MessageSquare,
} from "lucide-react";
import { execCommand, installClaudeCli } from "../lib/api";
import { useCommandOutput } from "../hooks/useCommandOutput";
import { useToasts } from "../hooks/useToasts";
import {
  useSession,
  useSessionSummary,
  type SessionKind,
  type SessionLine,
} from "../hooks/useSessionStore";
import { TerminalInput } from "./TerminalInput";
import { XTermOutput } from "./XTermOutput";
import { PtyPane } from "./PtyPane";

// Claude sub-tab has two modes:
//  - "quick": one-shot `claude -p "<prompt>"` via the commands endpoint.
//             Transcript persists in localStorage. Best for short,
//             scriptable prompts and transcript capture.
//  - "interactive": persistent PTY running `claude` as a REPL. Slash
//             commands (/login, /compact, /resume) work. No localStorage
//             transcript — xterm.js owns the scrollback.
type ClaudeMode = "quick" | "interactive";

interface Props {
  containerId: number;
  containerName: string;
  hasClaudeCli: boolean;
}

export function TerminalPane({ containerId, containerName, hasClaudeCli }: Props) {
  const [kind, setKind] = useState<SessionKind>(() => {
    const stored = localStorage.getItem(`hive:terminal-last-kind:${containerId}`);
    return stored === "claude" ? "claude" : "shell";
  });
  useEffect(() => {
    localStorage.setItem(`hive:terminal-last-kind:${containerId}`, kind);
  }, [containerId, kind]);

  return (
    // w-full + min-w-0 so the pane actually fills its flex parent. Without
    // them, intrinsic-sized children (pre/code with break-words) collapse
    // the whole column to word-width and the terminal looked ~80px wide.
    <div className="flex h-full w-full min-w-0 flex-col rounded-lg border border-gray-800 bg-gray-950">
      <TabHeader
        containerId={containerId}
        containerName={containerName}
        activeKind={kind}
        onSelect={setKind}
      />
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <ShellPaneSlot
          recordId={containerId}
          containerName={containerName}
          hidden={kind !== "shell"}
        />
        <ClaudePaneSlot
          containerId={containerId}
          containerName={containerName}
          hidden={kind !== "claude"}
          hasClaudeCli={hasClaudeCli}
        />
      </div>
    </div>
  );
}

// ─── Tab header ───────────────────────────────────────────────────────

function TabHeader({
  containerId,
  containerName,
  activeKind,
  onSelect,
}: {
  containerId: number;
  containerName: string;
  activeKind: SessionKind;
  onSelect: (k: SessionKind) => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-gray-800 px-3 py-1">
      <div className="flex items-center gap-1">
        <SubTab
          active={activeKind === "shell"}
          onClick={() => onSelect("shell")}
          containerId={containerId}
          kind="shell"
          icon={<Terminal size={10} />}
          label="Shell"
        />
        <SubTab
          active={activeKind === "claude"}
          onClick={() => onSelect("claude")}
          containerId={containerId}
          kind="claude"
          icon={<Bot size={10} />}
          label="Claude"
        />
      </div>
      <div className="flex items-center gap-2 text-[10px] text-gray-600">
        <span>{containerName}</span>
        <span>#{containerId}</span>
      </div>
    </div>
  );
}

function SubTab({
  active,
  onClick,
  containerId,
  kind,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  containerId: number;
  kind: SessionKind;
  icon: React.ReactNode;
  label: string;
}) {
  const { isStreaming, hasLines, lastActive } = useSessionSummary(containerId, kind);
  const accent =
    kind === "claude"
      ? active
        ? "text-purple-300"
        : "text-purple-500/70 hover:text-purple-400"
      : active
        ? "text-green-300"
        : "text-green-500/70 hover:text-green-400";

  const lastActiveStr = lastActive
    ? new Date(lastActive).toLocaleTimeString([], { hour12: false })
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-t px-2.5 py-1 text-[11px] transition-colors ${
        active ? "bg-gray-900" : "hover:bg-gray-900/50"
      } ${accent}`}
      title={lastActiveStr ? `Last active ${lastActiveStr}` : "No activity yet"}
    >
      {icon}
      {label}
      {isStreaming && (
        <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" aria-label="streaming" />
      )}
      {!isStreaming && hasLines && (
        <span className="h-1.5 w-1.5 rounded-full bg-gray-600" aria-label="has history" />
      )}
    </button>
  );
}

// ─── Shell slot (always PTY) ─────────────────────────────────────────

/** Shell sub-tab — persistent PTY. `cd` persists, vim works, etc. */
function ShellPaneSlot({
  recordId,
  containerName,
  hidden,
}: {
  recordId: number;
  containerName: string;
  hidden: boolean;
}) {
  return (
    <div
      className={`absolute inset-0 flex min-w-0 flex-col ${hidden ? "pointer-events-none invisible" : ""}`}
      aria-hidden={hidden}
    >
      <PtyPane
        recordId={recordId}
        containerName={containerName}
        command="bash"
        sessionKey="shell"
      />
    </div>
  );
}

// ─── Claude slot (Quick / Interactive) ───────────────────────────────

function ClaudePaneSlot({
  containerId,
  containerName,
  hidden,
  hasClaudeCli,
}: {
  containerId: number;
  containerName: string;
  hidden: boolean;
  hasClaudeCli: boolean;
}) {
  const [mode, setMode] = useState<ClaudeMode>(() => {
    const stored = localStorage.getItem(`hive:claude-mode:${containerId}`);
    return stored === "interactive" ? "interactive" : "quick";
  });
  useEffect(() => {
    localStorage.setItem(`hive:claude-mode:${containerId}`, mode);
  }, [containerId, mode]);

  return (
    <div
      className={`absolute inset-0 flex min-w-0 flex-col ${hidden ? "pointer-events-none invisible" : ""}`}
      aria-hidden={hidden}
    >
      <div className="flex items-center gap-1 border-b border-gray-800/70 px-2 py-1 text-[10px] text-gray-600">
        <ClaudeModeButton
          active={mode === "quick"}
          onClick={() => setMode("quick")}
          icon={<Zap size={10} />}
          label="Quick"
          title="One-shot `claude -p` prompts. Transcript saved to browser."
        />
        <ClaudeModeButton
          active={mode === "interactive"}
          onClick={() => setMode("interactive")}
          icon={<MessageSquare size={10} />}
          label="Interactive"
          title="Live Claude REPL over PTY. Slash commands (/login, /resume, /compact) work."
        />
        <span className="ml-auto text-gray-700">
          {mode === "interactive"
            ? "/login, /resume, /compact all work"
            : "prompt → response, one shot"}
        </span>
      </div>
      {mode === "quick" ? (
        <SessionPane
          containerId={containerId}
          containerName={containerName}
          kind="claude"
          hidden={false}
          hasClaudeCli={hasClaudeCli}
        />
      ) : !hasClaudeCli ? (
        <ClaudeInstallGate containerId={containerId} containerName={containerName} />
      ) : (
        <PtyPane
          recordId={containerId}
          containerName={containerName}
          command="claude"
          sessionKey="claude-interactive"
        />
      )}
    </div>
  );
}

function ClaudeModeButton({
  active,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
        active
          ? "bg-purple-900/30 text-purple-300"
          : "text-gray-500 hover:bg-gray-800/50 hover:text-gray-300"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── One session pane ─────────────────────────────────────────────────

function SessionPane({
  containerId,
  containerName,
  kind,
  hidden,
  hasClaudeCli,
}: {
  containerId: number;
  containerName: string;
  kind: SessionKind;
  hidden: boolean;
  hasClaudeCli: boolean;
}) {
  const { toast } = useToasts();
  const session = useSession(containerId, kind);

  useCommandOutput(session.state.activeCommandId, (frame) => {
    if (frame.stream === "exit") {
      const code = frame.text.trim();
      session.appendLines([
        {
          text: code === "0" ? "[exit 0]" : `[exit ${code}]`,
          timestamp: frame.ts,
          type: code === "0" ? "system" : "error",
        },
      ]);
      session.setActiveCommandId(null);
      return;
    }
    session.appendLines([
      {
        text: frame.text.replace(/\n$/, ""),
        timestamp: frame.ts,
        type: frame.stream === "stderr" ? "error" : "output",
      },
    ]);
  });

  const execMut = useMutation({
    mutationFn: (command: string) => execCommand(containerId, command),
    onSuccess: (data) => {
      if (data.relay_path === "agent") {
        session.setActiveCommandId(data.command_id);
      } else {
        const ts = new Date().toISOString();
        const lines: SessionLine[] = [];
        if (data.stdout) {
          for (const line of data.stdout.split("\n")) {
            if (!line && data.stdout.endsWith("\n")) continue;
            lines.push({ text: line, timestamp: ts, type: "output" });
          }
        }
        if (data.stderr) {
          for (const line of data.stderr.split("\n")) {
            if (!line && data.stderr.endsWith("\n")) continue;
            lines.push({ text: line, timestamp: ts, type: "error" });
          }
        }
        lines.push({
          text: `[exit ${data.exit_code ?? "?"}] via ${data.relay_path}`,
          timestamp: ts,
          type: data.exit_code === 0 ? "system" : "error",
        });
        session.appendLines(lines);
      }
    },
    onError: (err) => {
      session.appendLines([
        {
          text: `Error: ${err.message}`,
          timestamp: new Date().toISOString(),
          type: "error",
        },
      ]);
    },
  });

  const runInput = useCallback(
    (input: string) => {
      if (kind === "claude" && !hasClaudeCli) {
        session.appendLines([
          {
            text: "Claude CLI is not installed in this container. Use the Install button above to add it.",
            timestamp: new Date().toISOString(),
            type: "error",
          },
        ]);
        return;
      }
      session.pushHistory(input);
      const prefix = kind === "shell" ? "$" : "claude>";
      session.appendLines([
        {
          text: `${prefix} ${input}`,
          timestamp: new Date().toISOString(),
          type: "input",
        },
      ]);
      const command =
        kind === "claude" ? `claude -p ${JSON.stringify(input)} --output-format text` : input;
      execMut.mutate(command);
      session.setDraft("");
    },
    [kind, hasClaudeCli, session, execMut],
  );

  const streaming = session.state.activeCommandId !== null;

  const showClaudeGate = kind === "claude" && !hasClaudeCli;

  return (
    <div
      className={`absolute inset-0 flex min-w-0 flex-col ${hidden ? "pointer-events-none invisible" : ""}`}
      aria-hidden={hidden}
    >
      <div className="flex items-center justify-end gap-1 border-b border-gray-800/70 px-2 py-1 text-[10px] text-gray-600">
        {streaming && (
          <span className="mr-auto flex items-center gap-1 text-yellow-400">
            <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
            streaming
          </span>
        )}
        <button
          type="button"
          onClick={async () => {
            const ok = await session.copyTranscript();
            toast(ok ? "success" : "error", ok ? "Transcript copied" : "Copy failed");
          }}
          disabled={session.state.lines.length === 0}
          className="rounded p-1 hover:bg-gray-800 hover:text-gray-300 disabled:opacity-30"
          aria-label="Copy transcript"
          title="Copy transcript"
        >
          <ClipboardCopy size={11} />
        </button>
        <button
          type="button"
          onClick={() => {
            const name = session.exportTranscript();
            if (name === null) {
              toast("info", "Nothing to export");
              return;
            }
            toast("success", `Exported ${name}`);
          }}
          disabled={session.state.lines.length === 0}
          className="rounded p-1 hover:bg-gray-800 hover:text-gray-300 disabled:opacity-30"
          aria-label="Export transcript as markdown"
          title="Export transcript (.md)"
        >
          <Download size={11} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (session.state.lines.length === 0) return;
            if (window.confirm(`Clear ${kind} session for this container?`)) {
              session.clear();
            }
          }}
          disabled={session.state.lines.length === 0 || streaming}
          className="rounded p-1 hover:bg-gray-800 hover:text-red-400 disabled:opacity-30"
          aria-label="Clear session"
          title="Clear session"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {showClaudeGate && (
        <ClaudeInstallGate containerId={containerId} containerName={containerName} />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden px-2 py-1">
        <XTermOutput
          lines={session.state.lines}
          kind={kind}
          streaming={streaming}
          waitingLabel={
            kind === "claude"
              ? `Waiting for Claude (${containerName})…`
              : `Running in ${containerName}…`
          }
        />
      </div>

      <TerminalInput
        kind={kind}
        value={session.state.draft}
        onChange={session.setDraft}
        onSubmit={runInput}
        disabled={execMut.isPending || showClaudeGate}
        history={session.state.history}
      />
    </div>
  );
}

// ─── Claude install gate ──────────────────────────────────────────────

function ClaudeInstallGate({
  containerId,
  containerName,
}: {
  containerId: number;
  containerName: string;
}) {
  const { toast } = useToasts();
  const queryClient = useQueryClient();

  const installMut = useMutation({
    mutationFn: () => installClaudeCli(containerId),
    onSuccess: (res) => {
      if (res.installed) {
        toast("success", `Claude CLI installed in ${containerName}`);
      } else {
        toast("error", `Install failed in ${containerName}`, res.stderr?.slice(-200));
      }
      queryClient.invalidateQueries({ queryKey: ["containers"] });
    },
  });

  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-yellow-900/60 bg-yellow-900/10 px-3 py-2"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-yellow-400" />
      <div className="flex-1 text-[11px] text-yellow-200">
        <p className="font-medium">Claude CLI is not installed in this container.</p>
        <p className="mt-0.5 text-yellow-200/70">
          Running <code className="text-yellow-100">npm install -g @anthropic-ai/claude-code</code>{" "}
          will add it — typically takes 30–60 seconds.
        </p>
        {installMut.isError && (
          <p className="mt-1 text-red-300">
            Install request failed: {(installMut.error as Error).message}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => installMut.mutate()}
        disabled={installMut.isPending}
        className="flex shrink-0 items-center gap-1 rounded bg-[#0078d4] px-2.5 py-1 text-[11px] text-white hover:bg-[#1188e0] disabled:opacity-60"
      >
        {installMut.isPending ? (
          <>
            <Loader2 size={11} className="animate-spin" /> Installing…
          </>
        ) : (
          <>
            <Download size={11} /> Install
          </>
        )}
      </button>
    </div>
  );
}
