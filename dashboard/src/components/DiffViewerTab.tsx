/**
 * DiffViewerTab — renders a single DiffEvent as a unified/split diff.
 *
 * Visual treatment follows the M27 mockup:
 *   - Toolbar: tool icon · greyed parent dirs / filename · timestamp ·
 *     +N · −N stat · Unified|Split toggle · Open file · Copy patch
 *   - Diff body: JetBrains Mono, line numbers, gutter +/− markers,
 *     italic hunk headers, Prism syntax highlighting via refractor
 */

import { useState, useEffect, useMemo } from "react";
import { Copy, ExternalLink, FilePlus, FileText, Pencil } from "lucide-react";
import { Diff, Hunk, parseDiff, tokenize } from "react-diff-view";
import "react-diff-view/style/index.css";

import type { DiffEvent, DiffTool } from "../lib/types";
import type { HunkData } from "react-diff-view";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = "unified" | "split";

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL_ACCENT: Record<DiffTool, string> = {
  Edit: "text-sky-400",
  Write: "text-emerald-400",
  MultiEdit: "text-violet-400",
};

const TOOL_ICON: Record<DiffTool, typeof Pencil> = {
  Edit: Pencil,
  Write: FilePlus,
  MultiEdit: FileText,
};

const LS_KEY = "hive:diff-view-mode";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadStoredMode(): ViewMode {
  if (typeof window === "undefined") return "unified";
  const v = window.localStorage.getItem(LS_KEY);
  return v === "split" ? "split" : "unified";
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
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function detectLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    sh: "bash",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? "plaintext";
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  event: DiffEvent;
  onOpenFile: (path: string) => void;
}

export function DiffViewerTab({ event, onOpenFile }: Props) {
  const [mode, setMode] = useState<ViewMode>(loadStoredMode);
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  // Persist view-mode preference
  useEffect(() => {
    window.localStorage.setItem(LS_KEY, mode);
  }, [mode]);

  // Parse the unified diff string into file hunks
  const files = useMemo(() => {
    try {
      return parseDiff(event.diff);
    } catch {
      return [];
    }
  }, [event.diff]);

  // Tokenize for syntax highlighting — lazy-load refractor to avoid
  // breaking jsdom tests if the ESM boundary is awkward
  const tokens = useMemo(() => {
    return files.map((f) => {
      try {
        // Dynamic require so tests can stub without bundler noise
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const refractor = require("refractor");
        const lang = detectLanguage(event.path);
        // refractor may not know every extension; fall back gracefully
        try {
          return tokenize(f.hunks, {
            highlight: true,
            refractor: refractor as { highlight: (code: string, lang: string) => unknown },
            oldSource: undefined,
            language: lang,
          });
        } catch {
          return tokenize(f.hunks, { highlight: false });
        }
      } catch {
        try {
          return tokenize(f.hunks, { highlight: false });
        } catch {
          return null;
        }
      }
    });
  }, [files, event.path]);

  const ToolIcon = TOOL_ICON[event.tool];
  const accent = TOOL_ACCENT[event.tool];

  const handleCopy = async () => {
    await navigator.clipboard.writeText(event.diff);
    setShowCopiedToast(true);
    window.setTimeout(() => setShowCopiedToast(false), 1600);
  };

  return (
    <div className="flex h-full flex-col bg-gray-950 text-gray-200">
      {/* ── Toolbar ── */}
      <div className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-gray-800 px-4">
        {/* Tool icon */}
        <ToolIcon className={`h-4 w-4 flex-shrink-0 ${accent}`} strokeWidth={1.7} />

        {/* Path: greyed parent / bold filename */}
        <div className="min-w-0 flex-1 overflow-hidden font-mono text-[13px] text-ellipsis whitespace-nowrap">
          <span className="text-gray-500">{dirOf(event.path)}/</span>
          <span className="text-gray-200">{baseOf(event.path)}</span>
        </div>

        {/* Meta: timestamp + stat */}
        <div className="flex flex-shrink-0 items-center gap-1.5 text-xs text-gray-500">
          <span>{relativeTime(event.created_at)}</span>
          <span className="text-gray-700">·</span>
          <span className="font-mono font-medium tabular-nums">
            <span className="text-emerald-400">+{event.added_lines}</span>
            <span className="mx-0.5 text-gray-600">·</span>
            <span className="text-rose-400">−{event.removed_lines}</span>
          </span>
        </div>

        {/* Unified / Split toggle */}
        <div className="flex flex-shrink-0 rounded border border-gray-700 bg-gray-900 p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => setMode("unified")}
            data-on={mode === "unified"}
            className={
              mode === "unified"
                ? "rounded bg-gray-950 px-3 py-1 text-gray-100 shadow-[0_0_0_1px_#374151]"
                : "px-3 py-1 text-gray-400 hover:text-gray-200"
            }
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setMode("split")}
            data-on={mode === "split"}
            className={
              mode === "split"
                ? "rounded bg-gray-950 px-3 py-1 text-gray-100 shadow-[0_0_0_1px_#374151]"
                : "px-3 py-1 text-gray-400 hover:text-gray-200"
            }
          >
            Split
          </button>
        </div>

        {/* Open file button */}
        <button
          type="button"
          onClick={() => onOpenFile(event.path)}
          aria-label="Open file"
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-xs font-medium text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-200"
        >
          <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
          Open file
        </button>

        {/* Copy patch button */}
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy patch"
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-xs font-medium text-gray-400 transition-colors hover:border-gray-500 hover:text-gray-200"
        >
          <Copy className="h-3 w-3" strokeWidth={1.8} />
          Copy patch
        </button>
      </div>

      {/* ── Diff body ── */}
      <div className="flex-1 overflow-auto bg-gray-950 font-mono text-[12.5px] leading-[1.55]">
        {files.length === 0 ? (
          <div className="px-4 py-6 text-xs text-gray-600 italic">No changes</div>
        ) : (
          files.map((file, i) => (
            <Diff
              key={`${file.oldPath ?? ""}-${file.newPath ?? ""}-${i}`}
              viewType={mode === "unified" ? "unified" : "split"}
              diffType={file.type ?? "modify"}
              hunks={file.hunks}
              tokens={tokens[i] ?? undefined}
            >
              {(hunks: HunkData[]) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
            </Diff>
          ))
        )}
      </div>

      {/* ── Copy-success toast ── */}
      {showCopiedToast && (
        <div className="pointer-events-none fixed right-8 bottom-8 flex items-center gap-2 rounded-md border border-emerald-500 bg-gray-900 px-4 py-2.5 text-xs text-gray-100 shadow-xl">
          <svg
            className="h-3.5 w-3.5 text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
          Diff copied to clipboard
        </div>
      )}
    </div>
  );
}
