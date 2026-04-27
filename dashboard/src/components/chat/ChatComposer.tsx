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

import { useIsPhone } from "../../hooks/useMediaQuery";
import { AttachmentChip } from "./AttachmentChip";
import { EditAutoToggle } from "./EditAutoToggle";
import type { ChatEffort } from "./EffortControl";
import { EffortControl } from "./EffortControl";
import { EffortPickerSheet } from "./EffortPickerSheet";
import { dispatchModeChange } from "./ModeToggle";
import type { ChatMode } from "./ModeToggle";
import { ModeToggleSheet } from "./ModeToggleSheet";
import { SlashAutocomplete } from "./SlashAutocomplete";

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

  const isPhone = useIsPhone();
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const [effortSheetOpen, setEffortSheetOpen] = useState(false);
  const [phoneEffort, setPhoneEffort] = useState<ChatEffort>(() => {
    if (typeof window === "undefined") return "standard";
    const v = window.localStorage.getItem(`hive:chat:${sessionId}:effort`);
    return v === "quick" || v === "deep" || v === "max" ? (v as ChatEffort) : "standard";
  });
  // Re-read on sessionId change so phone effort chip stays in sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = window.localStorage.getItem(`hive:chat:${sessionId}:effort`);
    setPhoneEffort(v === "quick" || v === "deep" || v === "max" ? (v as ChatEffort) : "standard");
  }, [sessionId]);

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
      data-testid="chat-composer"
      className="border-edge bg-pane border-t"
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
          className="border-edge bg-input text-primary placeholder:text-muted focus-visible:border-accent min-h-[2.25rem] flex-1 resize-none rounded border px-2 py-1.5 text-[13px] focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={handlePromptAttach}
          aria-label="Attach file"
          title="Attach file"
          className="text-secondary hover:bg-chip hover:text-primary rounded p-1"
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
          className="text-secondary hover:bg-chip hover:text-primary rounded p-1"
        >
          <Slash size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={send}
          aria-label="Send"
          disabled={disabled || value.trim().length === 0}
          className="bg-accent hover:bg-accent inline-flex items-center gap-1 rounded px-3 py-1.5 text-[12px] font-semibold text-white transition-colors disabled:opacity-50"
        >
          <Send size={12} aria-hidden="true" />
          <span>Send</span>
        </button>
      </div>

      <div className="border-edge-soft text-secondary flex items-center justify-between gap-2 border-t px-3 py-1 text-[10px]">
        {isPhone ? (
          <div className="flex items-center gap-2">
            {/* Effort chip → opens EffortPickerSheet */}
            <button
              type="button"
              onClick={() => setEffortSheetOpen(true)}
              aria-label="Effort level"
              className="bg-chip border-edge-soft text-primary flex min-h-[44px] items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]"
            >
              <span className="text-secondary">Effort:</span>
              <span className="font-medium capitalize">{phoneEffort}</span>
            </button>
            {/* Mode chip → opens ModeToggleSheet */}
            <button
              type="button"
              onClick={() => setModeSheetOpen(true)}
              aria-label="Chat mode"
              className="bg-chip border-edge-soft text-primary flex min-h-[44px] items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]"
            >
              <span className="text-secondary">Mode:</span>
              <span className="font-medium">{MODE_LABEL[mode]}</span>
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <EffortControl sessionId={sessionId} />
              <EditAutoToggle sessionId={sessionId} />
              <span>
                Mode: <span className="text-primary">{MODE_LABEL[mode]}</span>
              </span>
            </div>
            <span className="text-secondary font-mono">⌘↵ send · esc cancel</span>
          </>
        )}
      </div>

      {/* M36 — sheets only render at phone via the open flag */}
      {isPhone && (
        <>
          <ModeToggleSheet
            open={modeSheetOpen}
            mode={mode}
            onSelect={(m) => dispatchModeChange(sessionId, m)}
            onClose={() => setModeSheetOpen(false)}
          />
          <EffortPickerSheet
            open={effortSheetOpen}
            effort={phoneEffort}
            onSelect={(e) => {
              setPhoneEffort(e);
              window.localStorage.setItem(`hive:chat:${sessionId}:effort`, e);
            }}
            onClose={() => setEffortSheetOpen(false)}
          />
        </>
      )}
    </div>
  );
}
