/** Plan artifact renderer (M35). Markdown body with optional headings TOC. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function PlanRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[18px] font-semibold text-primary">{artifact.title}</h1>
        <p className="mt-1 text-[11px] text-muted">
          Plan · saved {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
