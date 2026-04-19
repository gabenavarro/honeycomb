/** File viewer with write-back editing (M18 + M24).
 *
 * Read mode: dispatches by MIME ({text, image, notebook, oversize}).
 * Edit mode: swaps the ``<pre>`` for a ``<CodeEditor>`` (CodeMirror
 * 6) with a textarea ErrorBoundary fallback. Save posts the current
 * draft with ``if_match_mtime_ns`` = last-read mtime; 409 responses
 * surface a yellow conflict banner.
 */

import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Download, FileText, Image as ImageIcon, Notebook, Pencil, Save, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  containerFileDownloadUrl,
  readContainerFile,
  writeContainerFile,
} from "../lib/api";
import type { FileContent } from "../lib/types";
import { useToasts } from "../hooks/useToasts";
import { CodeEditor, languageForPath } from "./CodeEditor";
import { ErrorBoundary } from "./ErrorBoundary";
import { NotebookViewer } from "./NotebookViewer";

interface Props {
  containerId: number;
  path: string;
  onClose: () => void;
}

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/x-sh",
  "application/x-yaml",
  "application/toml",
  "application/x-ipynb+json",
];

function isTextMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return TEXT_MIME_PREFIXES.some((p) => m.startsWith(p));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function FileViewer({ containerId, path, onClose }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToasts();
  const { data, error, isLoading } = useQuery<FileContent>({
    queryKey: ["fs:read", containerId, path],
    queryFn: () => readContainerFile(containerId, path),
    staleTime: 30_000,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const isNotebook = path.toLowerCase().endsWith(".ipynb");
  const canEdit =
    data !== undefined &&
    data.content !== null &&
    data.content !== undefined &&
    !data.truncated &&
    !isNotebook &&
    isTextMime(data.mime_type);

  // Seed draft whenever we enter edit mode or swap files.
  useEffect(() => {
    if (!editing) return;
    if (!data) return;
    setDraft(data.content ?? "");
    setBaseMtime(data.mtime_ns ?? 0);
    setConflict(false);
  }, [editing, data]);

  const dirty = editing && data !== undefined && draft !== (data.content ?? "");

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [dirty, onClose]);

  const handleCancel = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setEditing(false);
    setDraft("");
    setConflict(false);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    if (!data || baseMtime === null) return;
    setSaving(true);
    try {
      const updated = (await writeContainerFile(containerId, {
        path,
        content: draft,
        if_match_mtime_ns: baseMtime,
      })) as FileContent;
      toast("success", "Saved", `${humanSize(updated.size_bytes)} written to ${path}`);
      queryClient.setQueryData<FileContent>(["fs:read", containerId, path], updated);
      setBaseMtime(updated.mtime_ns);
      setConflict(false);
      setEditing(false);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setConflict(true);
      } else {
        toast("error", "Save failed", err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [containerId, path, draft, baseMtime, data, toast, queryClient]);

  const handleReload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["fs:read", containerId, path] });
    // The refetch lands asynchronously; rely on the ``useEffect``
    // above keying on ``data`` to reseed once the new content arrives.
    setConflict(false);
  }, [queryClient, containerId, path]);

  const handleSaveAnyway = useCallback(async () => {
    // Re-read to obtain the current mtime; write with that echo so
    // the hub accepts the write. Draft is preserved verbatim.
    const latest = await readContainerFile(containerId, path);
    if (!latest.mtime_ns) {
      toast("error", "Save failed", "Could not re-read file for baseline");
      return;
    }
    setBaseMtime(latest.mtime_ns);
    setSaving(true);
    try {
      const updated = (await writeContainerFile(containerId, {
        path,
        content: draft,
        if_match_mtime_ns: latest.mtime_ns,
      })) as FileContent;
      toast("success", "Saved", `${humanSize(updated.size_bytes)} written to ${path}`);
      queryClient.setQueryData<FileContent>(["fs:read", containerId, path], updated);
      setBaseMtime(updated.mtime_ns);
      setConflict(false);
      setEditing(false);
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [containerId, path, draft, toast, queryClient]);

  const downloadUrl = containerFileDownloadUrl(containerId, path);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <header className="flex items-center gap-2 border-b border-[#2b2b2b] px-3 py-1.5 text-[11px]">
        {isNotebook ? (
          <Notebook size={11} className="text-orange-400" />
        ) : data?.mime_type.startsWith("image/") ? (
          <ImageIcon size={11} className="text-purple-400" />
        ) : (
          <FileText size={11} className="text-blue-400" />
        )}
        <span className="truncate font-mono text-[#e7e7e7]" title={path}>
          {path}
        </span>
        {data && (
          <span className="text-[10px] text-[#858585]">
            {data.mime_type} · {humanSize(data.size_bytes)}
          </span>
        )}
        {editing && dirty && (
          <span className="text-[10px] text-yellow-400" aria-live="polite">
            Modified
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!editing && canEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
              title="Edit"
            >
              <Pencil size={11} />
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1 rounded bg-[#0078d4] px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-[#1188e0] disabled:opacity-60"
                title="Save"
              >
                <Save size={11} />
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
                title="Cancel"
              >
                Cancel
              </button>
            </>
          )}
          <a
            href={downloadUrl}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
            title="Download"
          >
            <Download size={11} />
            Download
          </a>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-0.5 text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
            aria-label="Close file viewer"
            title="Close"
          >
            <X size={11} />
          </button>
        </div>
      </header>

      {editing && conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[#3a3a0a] bg-[#2a2410] px-3 py-1.5 text-[11px] text-yellow-300"
        >
          <span>File changed on disk.</span>
          <button
            type="button"
            onClick={handleReload}
            className="rounded border border-yellow-700 px-1.5 py-0.5 text-[10px] hover:bg-yellow-900/40"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={handleSaveAnyway}
            className="rounded border border-yellow-700 px-1.5 py-0.5 text-[10px] hover:bg-yellow-900/40"
          >
            Save anyway
          </button>
          <span className="text-[10px] text-yellow-400/80">
            Reload fetches the latest; Save anyway re-reads the on-disk baseline and writes your
            draft.
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <p className="p-4 text-xs text-[#858585]">Loading…</p>}
        {error && (
          <p className="p-4 text-xs text-red-400">
            Failed to read: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {data && editing && (
          <ErrorBoundary
            label={`the editor for ${path}`}
            onError={() => toast("warning", "Editor failed", "Using plain-text fallback.")}
            fallback={
              <textarea
                className="m-0 block h-full min-h-full w-full resize-none border-0 bg-[#1e1e1e] px-4 py-3 font-mono text-[12px] leading-relaxed text-[#cccccc] outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                wrap="off"
              />
            }
          >
            <CodeEditor
              value={draft}
              onChange={setDraft}
              language={languageForPath(path)}
            />
          </ErrorBoundary>
        )}
        {data && !editing && (
          <FileBody data={data} downloadUrl={downloadUrl} isNotebook={isNotebook} />
        )}
      </div>
    </div>
  );
}

function FileBody({
  data,
  downloadUrl,
  isNotebook,
}: {
  data: FileContent;
  downloadUrl: string;
  isNotebook: boolean;
}) {
  if (isNotebook && data.content !== null && data.content !== undefined) {
    return <NotebookViewer source={data.content} />;
  }
  if (data.truncated) {
    return (
      <div className="p-4 text-xs text-[#858585]">
        <p>
          File is {(data.size_bytes / (1024 * 1024)).toFixed(2)} MiB — too large to preview inline.
        </p>
        <a
          href={downloadUrl}
          className="mt-2 inline-flex items-center gap-1 rounded bg-[#0078d4] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#1188e0]"
        >
          <Download size={11} /> Download
        </a>
      </div>
    );
  }
  if (data.mime_type.startsWith("image/") && data.content_base64) {
    return (
      <div className="flex min-h-full items-center justify-center p-4">
        <img
          src={`data:${data.mime_type};base64,${data.content_base64}`}
          alt={data.path}
          className="max-h-full max-w-full"
        />
      </div>
    );
  }
  if (data.content !== null && data.content !== undefined) {
    return (
      <pre className="m-0 min-h-full px-4 py-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-[#cccccc]">
        {data.content}
      </pre>
    );
  }
  return (
    <div className="p-4 text-xs text-[#858585]">
      No inline preview available for this MIME type.
      <a
        href={downloadUrl}
        className="ml-2 inline-flex items-center gap-1 rounded bg-[#0078d4] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#1188e0]"
      >
        <Download size={11} /> Download
      </a>
    </div>
  );
}
