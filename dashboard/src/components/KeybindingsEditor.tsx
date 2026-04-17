/** Keybindings editor (M10).
 *
 * Minimal JSON-backed editor mirroring VSCode's ``keybindings.json``.
 * The hub persists overrides at ``~/.config/honeycomb/keybindings.json``
 * so another dashboard window (or a future VSCode extension) picks up
 * the same set. The default set is defined in ``DEFAULT_KEYBINDINGS``
 * and surfaced read-only so the user knows what they're overriding.
 *
 * Editing is a single JSON ``{"command": "Ctrl+Shift+K", ...}`` blob.
 * A live JSON.parse preview gives immediate feedback; save is disabled
 * while the text is invalid.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getKeybindings, putKeybindings } from "../lib/api";
import { DEFAULT_KEYBINDINGS } from "../lib/keybindings";
import { useToasts } from "../hooks/useToasts";

export function KeybindingsEditor() {
  const { toast } = useToasts();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["keybindings"],
    queryFn: getKeybindings,
  });

  const [text, setText] = useState<string>("{}");

  useEffect(() => {
    if (!data) return;
    setText(JSON.stringify(data.bindings, null, 2));
  }, [data]);

  const parsed = safeParse(text);
  const valid = parsed !== null;

  const mutation = useMutation({
    mutationFn: (bindings: Record<string, string>) => putKeybindings(bindings),
    onSuccess: () => {
      toast("success", "Keybindings saved");
      queryClient.invalidateQueries({ queryKey: ["keybindings"] });
    },
    onError: (err) =>
      toast("error", "Keybindings save failed", err instanceof Error ? err.message : String(err)),
  });

  const save = () => {
    if (!valid) return;
    mutation.mutate(parsed);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[#2b2b2b] px-3 py-2">
        <h3 className="text-xs font-medium tracking-wider text-[#858585] uppercase">Keybindings</h3>
        <button
          type="button"
          onClick={save}
          disabled={!valid || mutation.isPending}
          className="rounded bg-[#0078d4] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#1188e0] disabled:opacity-50"
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 text-xs">
        <p className="mb-2 text-[11px] text-[#858585]">
          Overrides the default shortcuts. Leave a command&apos;s value empty to reset it to the
          default. The hub persists this at <code>~/.config/honeycomb/keybindings.json</code>.
        </p>
        {isLoading ? (
          <p className="text-[11px] text-[#858585]">Loading…</p>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            spellCheck={false}
            aria-invalid={!valid}
            className={`w-full rounded border bg-[#2a2a2a] px-2 py-1 font-mono text-[11px] ${
              valid ? "border-[#3c3c3c]" : "border-red-700"
            }`}
          />
        )}
        {!valid && <p className="mt-1 text-[10px] text-red-400">Invalid JSON. Save is disabled.</p>}
        <h4 className="mt-4 text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
          Defaults
        </h4>
        <ul className="mt-1 space-y-0.5 text-[11px]">
          {Object.entries(DEFAULT_KEYBINDINGS).map(([cmd, shortcut]) => (
            <li key={cmd} className="flex items-center justify-between gap-3">
              <code className="text-[#c0c0c0]">{cmd}</code>
              <kbd className="rounded border border-[#444] px-1.5 py-0.5 text-[10px]">
                {shortcut}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function safeParse(text: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== "string" || typeof v !== "string") return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
