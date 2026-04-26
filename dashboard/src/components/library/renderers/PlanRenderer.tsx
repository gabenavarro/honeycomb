/** Plan artifact renderer (M35). Markdown body with optional headings TOC. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function PlanRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-edge-soft border-b pb-2">
        <h1 className="text-primary text-[18px] font-semibold">{artifact.title}</h1>
        <p className="text-muted mt-1 text-[11px]">
          Plan · saved {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
