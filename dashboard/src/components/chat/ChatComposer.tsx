/** Composer (M33).
 *
 * Multi-line auto-grow textarea, attach/slash/send icons on the
 * right, foot row with Effort + active-mode label + keyboard hints.
 *
 * Real semantics for effort/model/slash/attachments arrive in M34.
 * M33: the controls render and persist their state, but only the
 * text payload is sent to the hub.
 */
import { Paperclip, Send, Slash } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { EffortControl } from "./EffortControl";
import type { ChatMode } from "./ModeToggle";

interface Props {
  sessionId: string;
  mode: ChatMode;
  disabled?: boolean;
  onSend: (text: string) => void;
}

const MODE_LABEL: Record<ChatMode, string> = {
  code: "Code",
  review: "Review",
  plan: "Plan",
};

export function ChatComposer({ sessionId, mode, disabled, onSend }: Props) {
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

  return (
    <div className="border-edge bg-pane border-t">
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
          aria-label="Attach file"
          title="Attach file (M34)"
          className="text-secondary hover:bg-chip hover:text-primary rounded p-1"
        >
          <Paperclip size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Insert slash command"
          title="Slash commands (M34)"
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
      {/* Footer text is bumped from text-muted/text-faint to text-secondary
          so 10px labels clear WCAG AA contrast against bg-pane in both
          themes (axe color-contrast). EffortControl picks its own token. */}
      <div className="border-edge-soft text-secondary flex items-center justify-between gap-2 border-t px-3 py-1 text-[10px]">
        <div className="flex items-center gap-2">
          <EffortControl sessionId={sessionId} />
          <span>
            Mode: <span className="text-primary">{MODE_LABEL[mode]}</span>
          </span>
        </div>
        <span className="text-secondary font-mono">⌘↵ send · esc cancel</span>
      </div>
    </div>
  );
}
