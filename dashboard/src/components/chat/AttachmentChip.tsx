/** Single attachment chip rendered above the composer textarea (M34).
 *
 * M34 attachments are reference strings only (filename or path); the
 * actual file content isn't uploaded — the CLI loads files referenced
 * via @<path> from the workspace.
 */
import { Paperclip, X } from "lucide-react";

interface Props {
  path: string;
  onRemove: () => void;
}

export function AttachmentChip({ path, onRemove }: Props) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 rounded border border-edge bg-chip px-2 py-0.5 text-[11px]">
      <Paperclip size={11} aria-hidden="true" className="text-secondary" />
      <span className="truncate font-mono text-primary" title={path}>
        {path}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${path}`}
        className="rounded p-0.5 text-faint hover:bg-edge hover:text-primary"
      >
        <X size={10} aria-hidden="true" />
      </button>
    </span>
  );
}
