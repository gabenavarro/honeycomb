/** Snippet artifact renderer (M35). Code block with copy-to-clipboard
 *  + download buttons.
 */
import { Copy, Download } from "lucide-react";

import type { Artifact } from "../../../lib/types";

const LANG_EXT: Record<string, string> = {
  python: "py",
  typescript: "ts",
  javascript: "js",
  jsx: "jsx",
  tsx: "tsx",
  bash: "sh",
  shell: "sh",
  yaml: "yml",
  markdown: "md",
};

function languageToExt(lang: string | undefined): string {
  if (!lang) return "";
  return LANG_EXT[lang.toLowerCase()] ?? lang;
}

function sanitizeFilename(title: string): string {
  return title.replace(/[^a-z0-9-_]/gi, "_").replace(/_+/g, "_");
}

interface Props {
  artifact: Artifact;
}

export function SnippetRenderer({ artifact }: Props) {
  const language = (artifact.metadata?.language as string | undefined) ?? artifact.body_format;
  const lineCount =
    (artifact.metadata?.line_count as number | undefined) ?? artifact.body.split("\n").length;

  const copy = () => {
    void navigator.clipboard.writeText(artifact.body);
  };

  const download = () => {
    const blob = new Blob([artifact.body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ext = languageToExt(language) || "txt";
    a.href = url;
    a.download = `${sanitizeFilename(artifact.title)}.${ext}`;
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
      // Defer revoke to dodge a browser race seen on the same pattern in
      // hooks/useSessionStore.ts (some browsers cancel the download if the
      // URL is revoked synchronously after .click()).
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-edge-soft flex items-center justify-between border-b px-4 py-2">
        <div>
          <h1 className="text-primary text-[14px] font-semibold">{artifact.title}</h1>
          <p className="text-muted mt-0.5 text-[10px]">
            {language} · {lineCount} lines
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            aria-label="Copy snippet"
            title="Copy"
            className="text-secondary hover:bg-chip hover:text-primary rounded p-1"
          >
            <Copy size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={download}
            aria-label="Download snippet"
            title="Download"
            className="text-secondary hover:bg-chip hover:text-primary rounded p-1"
          >
            <Download size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      {/* TODO(M35+): syntax highlight via metadata.language using refractor / Prism. */}
      <pre className="bg-input text-primary flex-1 overflow-auto px-4 py-3 font-mono text-[12px]">
        {artifact.body}
      </pre>
    </div>
  );
}
