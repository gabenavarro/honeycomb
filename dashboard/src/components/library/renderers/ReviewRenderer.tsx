/** Review artifact renderer (M35 placeholder).
 *
 * Review artifacts are dormant in M35 — auto-save is gated on PR
 * thread loading which arrives in M35.x or M36. The renderer ships
 * for type-discriminator completeness; if a review row somehow
 * exists, render the body as markdown with a placeholder header.
 */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function ReviewRenderer({ artifact }: Props) {
  const prRepo = artifact.metadata?.pr_repo as string | undefined;
  const prNumber = artifact.metadata?.pr_number as number | undefined;
  const status = artifact.metadata?.status as string | undefined;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-edge-soft border-b pb-2">
        <h1 className="text-primary text-[16px] font-semibold">{artifact.title}</h1>
        {prRepo && prNumber !== undefined && (
          <p className="text-secondary mt-1 font-mono text-[11px]">
            {prRepo}#{prNumber}
            {status && <span className="text-muted ml-2">[{status}]</span>}
          </p>
        )}
        <p className="text-muted mt-1 text-[10px]">
          Review · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
      <div className="border-edge-soft bg-pane text-muted rounded border px-3 py-2 text-[11px]">
        PR thread loading + inline comments arrive in a future milestone.
      </div>
    </div>
  );
}
