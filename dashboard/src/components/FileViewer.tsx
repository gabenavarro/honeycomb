/** Read-only file viewer for container files (M18).
 *
 * Dispatches by MIME type reported by the hub's ``file --mime-type``
 * sniff:
 *
 * - ``text/*``, JSON, YAML, XML, ``.ipynb`` → ``<pre>`` with the raw
 *   content. Syntax highlighting is deliberately deferred to M19+ —
 *   a monospace pre-formatted block is useful enough for v1 and keeps
 *   the bundle trim.
 * - ``image/*`` → data-URL ``<img>`` using the base64 payload.
 * - anything oversize → explicit "File is too large to preview" state
 *   with a download link that hits the streaming endpoint.
 * - the ``.ipynb`` special case is handled by a separate milestone
 *   component; for M18 we just render the JSON verbatim.
 */

import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Image as ImageIcon, X } from "lucide-react";

import { readContainerFile, containerFileDownloadUrl } from "../lib/api";
import type { FileContent } from "../lib/types";

interface Props {
  containerId: number;
  path: string;
  onClose: () => void;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function FileViewer({ containerId, path, onClose }: Props) {
  const { data, error, isLoading } = useQuery<FileContent>({
    queryKey: ["fs:read", containerId, path],
    queryFn: () => readContainerFile(containerId, path),
    staleTime: 30_000,
  });

  const downloadUrl = containerFileDownloadUrl(containerId, path);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <header className="flex items-center gap-2 border-b border-[#2b2b2b] px-3 py-1.5 text-[11px]">
        {data?.mime_type.startsWith("image/") ? (
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
        <a
          href={downloadUrl}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
          title="Download"
        >
          <Download size={11} />
          Download
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
          aria-label="Close file viewer"
          title="Close"
        >
          <X size={11} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <p className="p-4 text-xs text-[#858585]">Loading…</p>}
        {error && (
          <p className="p-4 text-xs text-red-400">
            Failed to read: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {data && <FileBody data={data} downloadUrl={downloadUrl} />}
      </div>
    </div>
  );
}

function FileBody({ data, downloadUrl }: { data: FileContent; downloadUrl: string }) {
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
