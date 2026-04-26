/** Spec artifact renderer (M35).
 *
 * Two-column layout: left aside (TOC built from metadata.headings),
 * right main (header with title + filename + markdown body).
 * The aside is only rendered when headings.length > 0.
 */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function SpecRenderer({ artifact }: Props) {
  const headings = (artifact.metadata?.headings as string[] | undefined) ?? [];
  const filePath = (artifact.metadata?.file_path as string | undefined) ?? null;

  return (
    <div className="flex h-full min-w-0">
      {headings.length > 0 && (
        <aside
          aria-label="Table of contents"
          className="hidden w-48 shrink-0 overflow-y-auto border-r border-edge-soft px-3 py-4 md:block"
        >
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
            Contents
          </p>
          <nav>
            <ul className="flex flex-col gap-1">
              {headings.map((heading) => (
                <li key={heading}>
                  <span className="block truncate text-[12px] text-secondary hover:text-primary">
                    {heading}
                  </span>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      )}

      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
        <header className="mb-4 border-b border-edge-soft pb-2">
          <h1 className="text-[18px] font-semibold text-primary">{artifact.title}</h1>
          <p className="mt-1 text-[11px] text-muted">
            Spec
            {filePath && (
              <>
                {" · "}
                <span className="font-mono">{filePath}</span>
              </>
            )}
            {" · "}saved {new Date(artifact.created_at).toLocaleString()}
          </p>
        </header>
        <MarkdownBody source={artifact.body} />
      </main>
    </div>
  );
}
