/** Composer (M33 + M34).
 *
 * Multi-line auto-grow textarea with:
 *   - Attachment chips above the input row (drag-drop a file or click
 *     paperclip to prompt for a path)
 *   - Slash autocomplete dropdown above the textarea when input
 *     starts with '/'
 *   - Send button (Cmd+Enter or click)
 *   - Foot row: EffortControl, EditAutoToggle, mode label, kbd hints
 */
import { Paperclip, Send, Slash } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AttachmentChip } from "./AttachmentChip";
import { EditAutoToggle } from "./EditAutoToggle";
import { EffortControl } from "./EffortControl";
import { SlashAutocomplete } from "./SlashAutocomplete";
import type { ChatMode } from "./ModeToggle";

interface Props {
  sessionId: string;
  mode: ChatMode;
  disabled?: boolean;
  onSend: (text: string) => void;
  /** Attachment paths shown as chips above the input. Lifted so the
   *  parent can clear them after send. */
  attachments: string[];
  onAttachmentsChange: (next: string[]) => void;
}

const MODE_LABEL: Record<ChatMode, string> = {
  code: "Code",
  review: "Review",
  plan: "Plan",
};

export function ChatComposer({
  sessionId,
  mode,
  disabled,
  onSend,
  attachments,
  onAttachmentsChange,
}: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const newPaths = files.map((f) => f.name);
    onAttachmentsChange([...attachments, ...newPaths]);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handlePromptAttach = () => {
    const path = window.prompt("Attach a file path (workspace-relative or absolute):");
    if (path === null || path.trim() === "") return;
    onAttachmentsChange([...attachments, path.trim()]);
  };

  const removeAttachment = (idx: number) => {
    const next = [...attachments];
    next.splice(idx, 1);
    onAttachmentsChange(next);
  };

  // Slash autocomplete: visible when value starts with "/" AND there's
  // no whitespace yet (i.e. user is still typing the command name).
  const showSlashDropdown = value.startsWith("/") && !value.includes(" ");

  return (
    <div
      className="border-t border-edge bg-pane"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Attachment chips row */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
          {attachments.map((path, i) => (
            <AttachmentChip key={`${path}-${i}`} path={path} onRemove={() => removeAttachment(i)} />
          ))}
        </div>
      )}

      {/* Slash autocomplete (positioned above the textarea via DOM
          order; the listbox is short enough to never overlap) */}
      {showSlashDropdown && (
        <div className="px-3 pt-2">
          <SlashAutocomplete
            prefix={value}
            onSelect={(filled) => {
              setValue(filled);
              ref.current?.focus();
            }}
          />
        </div>
      )}

      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`Send a message in ${MODE_LABEL[mode]} mode…`}
          aria-label="Chat input"
          disabled={disabled}
          rows={1}
          className="min-h-[2.25rem] flex-1 resize-none rounded border border-edge bg-input px-2 py-1.5 text-[13px] text-primary placeholder:text-muted focus:outline-none focus-visible:border-accent disabled:opacity-60"
        />
        <button
          type="button"
          onClick={handlePromptAttach}
          aria-label="Attach file"
          title="Attach file"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Paperclip size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => {
            // Insert a leading slash so the user sees the autocomplete.
            setValue("/");
            ref.current?.focus();
          }}
          aria-label="Insert slash command"
          title="Slash commands"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Slash size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={send}
          aria-label="Send"
          disabled={disabled || value.trim().length === 0}
          className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Send size={12} aria-hidden="true" />
          <span>Send</span>
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-edge-soft px-3 py-1 text-[10px] text-secondary">
        <div className="flex items-center gap-2">
          <EffortControl sessionId={sessionId} />
          <EditAutoToggle sessionId={sessionId} />
          <span>
            Mode: <span className="text-primary">{MODE_LABEL[mode]}</span>
          </span>
        </div>
        <span className="font-mono text-secondary">⌘↵ send · esc cancel</span>
      </div>
    </div>
  );
}
