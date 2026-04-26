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
    <ul
      role="listbox"
      aria-label="Slash command suggestions"
      className="z-20 max-h-60 overflow-y-auto rounded border border-edge bg-pane shadow-medium"
    >
      {matches.map((cmd) => (
        <li key={cmd.name}>
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onSelect(`${cmd.name} `)}
            className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-chip"
          >
            <span className="font-mono text-tool">{cmd.name}</span>
            {cmd.argHint && <span className="font-mono text-muted">{cmd.argHint}</span>}
            <span className="ml-auto text-[11px] text-secondary">{cmd.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
