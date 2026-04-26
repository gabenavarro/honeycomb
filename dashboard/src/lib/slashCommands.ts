/** Slash-command parser for the chat composer (M34).
 *
 * Pure function that takes raw input text and returns a SlashAction
 * describing what the dispatcher (in ChatThreadWrapper) should do:
 *
 *   - "none"               → no slash command; send text verbatim
 *   - "transform-and-send" → send `userText` (transformed) as the user message
 *   - "set-mode"           → flip the ModeToggle to `mode`; optional toast
 *   - "clear-chat"         → call clearTurns()
 *   - "toast"              → show toast with `text`
 *   - "unknown"            → command was recognized as a slash but invalid;
 *                            include `raw` + a human `reason` for the toast
 *
 * Eight commands (see AVAILABLE_SLASH_COMMANDS). The dispatcher in
 * ChatThreadWrapper is responsible for the side-effects.
 */

import type { ChatMode } from "../components/chat/ModeToggle";

export type SlashAction =
  | { kind: "none" }
  | { kind: "transform-and-send"; userText: string }
  | { kind: "set-mode"; mode: ChatMode; toast?: string }
  | { kind: "clear-chat" }
  | { kind: "toast"; text: string }
  | { kind: "unknown"; raw: string; reason: string };

export interface SlashCommandSpec {
  name: string; // e.g. "/edit"
  hint: string; // short description shown in autocomplete
  argHint?: string; // optional argument placeholder (e.g. "<path>")
}

export const AVAILABLE_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: "/edit", hint: "Ask Claude to open a file for editing", argHint: "<path>" },
  { name: "/git", hint: "Run a git subcommand via Bash", argHint: "<subcmd>" },
  { name: "/compact", hint: "Compact the conversation context to free tokens" },
  { name: "/plan", hint: "Switch to Plan mode (read-only)" },
  { name: "/review", hint: "Switch to Review mode", argHint: "[<pr>]" },
  { name: "/clear", hint: "Clear the chat history (UI only)" },
  { name: "/save", hint: "Save the prior message as an artifact (M35)", argHint: "note <title>" },
  { name: "/skill", hint: "Invoke a saved skill (future)", argHint: "<name>" },
];

/** Filter the available commands by what the user has typed so far.
 *  Returns matches in declaration order; empty for non-slash prefix.
 *  An empty prefix `""` returns all commands. */
export function filterSlashCommands(prefix: string): readonly SlashCommandSpec[] {
  if (prefix === "") return AVAILABLE_SLASH_COMMANDS;
  if (!prefix.startsWith("/")) return [];
  return AVAILABLE_SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/** Parse the user input. Non-slash text returns kind="none". */
export function parseSlashCommand(input: string): SlashAction {
  if (!input.startsWith("/")) return { kind: "none" };

  const trimmed = input.trim();
  // First token is the command name (without the rest of the args)
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "/edit": {
      if (rest === "") {
        return { kind: "unknown", raw: trimmed, reason: "/edit requires a path argument" };
      }
      return { kind: "transform-and-send", userText: `Please open ${rest} for me to edit.` };
    }
    case "/git": {
      if (rest === "") {
        return { kind: "unknown", raw: trimmed, reason: "/git requires a subcommand" };
      }
      return { kind: "transform-and-send", userText: `Run \`git ${rest}\` via the Bash tool.` };
    }
    case "/compact":
      return { kind: "transform-and-send", userText: "/compact" };
    case "/plan":
      return { kind: "set-mode", mode: "plan" };
    case "/review":
      return {
        kind: "set-mode",
        mode: "review",
        toast: "PR thread loading arrives in M35.",
      };
    case "/clear":
      return { kind: "clear-chat" };
    case "/save": {
      // M34 supports only "note <title>"; other artifact types arrive in M35
      if (!rest.startsWith("note ") && rest !== "note") {
        return {
          kind: "unknown",
          raw: trimmed,
          reason: "/save expects 'note <title>' (other artifact types arrive in M35)",
        };
      }
      return { kind: "toast", text: "Notes arrive in M35 (Library)." };
    }
    case "/skill":
      return { kind: "toast", text: "Skills arrive in a future milestone." };
    default:
      return { kind: "unknown", raw: trimmed, reason: `Unknown command: ${cmd}` };
  }
}
