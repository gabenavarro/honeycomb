/** Single artifact card in the Library sidebar (M35).
 *
 * Per spec lines 360-369: each type has a distinct icon + accent color.
 * Card shows type icon + title + meta line (From: <chat name> · <relative time>).
 */
import type { Artifact } from "../../lib/types";
import { TYPE_ICON, TYPE_ACCENT } from "../../lib/artifact-meta";

interface Props {
  artifact: Artifact;
  active: boolean;
  onSelect: (artifactId: string) => void;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ArtifactCard({ artifact, active, onSelect }: Props) {
  const icon = TYPE_ICON[artifact.type];
  const accent = TYPE_ACCENT[artifact.type];
  const fromLabel = artifact.source_chat_id
    ? `From: ${artifact.source_chat_id.slice(0, 8)}`
    : `From: ${artifact.type}`;
  return (
    <button
      type="button"
      title={artifact.type}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(artifact.artifact_id)}
      className={`flex w-full items-start gap-2 rounded border px-3 py-2 text-left transition-colors ${
        active
          ? "border-accent bg-chip"
          : "border-edge bg-pane hover:border-edge-soft hover:bg-chip"
      }`}
    >
      <span className={`shrink-0 font-mono text-[14px] ${accent}`} aria-hidden="true">
        {icon}
      </span>
      <span className="flex flex-1 flex-col overflow-hidden">
        <span className="text-primary truncate text-[12px] font-medium">{artifact.title}</span>
        <span className="text-secondary mt-0.5 truncate text-[10px]">
          {fromLabel} · {relativeTime(artifact.created_at)}
        </span>
      </span>
    </button>
  );
}
