/** Slash-command autocomplete dropdown (M34).
 *
 * Shown by ChatComposer when the input starts with `/`. Lists the
 * matching commands (prefix-filter); click selects and inserts the
 * command name (with a trailing space) into the composer input.
 *
 * No keyboard navigation in M34 — Up/Down/Enter is a follow-up.
 */
import { filterSlashCommands } from "../../lib/slashCommands";

interface Props {
  prefix: string;
  onSelect: (text: string) => void;
}

export function SlashAutocomplete({ prefix, onSelect }: Props) {
  if (!prefix.startsWith("/")) return null;
  const matches = filterSlashCommands(prefix);
  if (matches.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash command suggestions"
      className="border-edge bg-pane shadow-medium z-20 max-h-60 overflow-y-auto rounded border"
    >
      {matches.map((cmd) => (
        <div
          key={cmd.name}
          role="option"
          aria-selected={false}
          tabIndex={-1}
          onClick={() => onSelect(`${cmd.name} `)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect(`${cmd.name} `);
          }}
          className="hover:bg-chip flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-[12px]"
        >
          <span className="text-tool font-mono">{cmd.name}</span>
          {cmd.argHint && <span className="text-secondary font-mono">{cmd.argHint}</span>}
          <span className="text-secondary ml-auto text-[11px]">{cmd.hint}</span>
        </div>
      ))}
    </div>
  );
}
