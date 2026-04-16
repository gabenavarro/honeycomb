/** Terminal input with bash-style history recall and lightweight
 * autocomplete.
 *
 *  ↑ / ↓  — walk through session history (most recent first). While
 *           navigating, the live draft is stashed so Esc (or Down past
 *           the newest entry) restores it.
 *  Tab    — accept the currently-highlighted autocomplete suggestion,
 *           or the top one if no highlight. Only when the suggestion
 *           list is non-empty; otherwise falls through to browser
 *           default (focus move).
 *  Esc    — dismiss the suggestion list and restore the live draft if
 *           the user was mid-history-walk.
 *
 * Suggestions are ranked: history matches first (prefix match on the
 * typed text), then built-in commands appropriate to the kind. We only
 * render the dropdown when there's something to show AND the user has
 * typed something; empty-input focus is silent.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";
import type { SessionKind } from "../hooks/useSessionStore";

interface Props {
  kind: SessionKind;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  history: string[];
  // Extra suggestions to merge in on top of the built-ins.
  extraSuggestions?: string[];
}

const MAX_SUGGESTIONS = 6;

// Built-in completions — small, kind-aware set chosen to be useful
// without feeling opinionated. Users' history is what really matters.
const BUILTIN_SHELL = [
  "ls -la",
  "pwd",
  "cat ",
  "cd ",
  "git status",
  "git log --oneline -20",
  "git diff",
  "pip list",
  "python --version",
  "uname -a",
  "ps aux",
  "df -h",
];
const BUILTIN_CLAUDE = [
  "Summarize the structure of this repo.",
  "What does this project do?",
  "List the key files I should read first.",
  "Explain the CI pipeline.",
  "Write unit tests for ",
  "Refactor ",
];

export function TerminalInput({
  kind,
  value,
  onChange,
  onSubmit,
  disabled,
  history,
  extraSuggestions = [],
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Index into `history`. -1 means "live draft, not walking".
  const [historyIdx, setHistoryIdx] = useState(-1);
  // The draft the user had typed before entering history-walk, so we can
  // restore it when they press Down past the newest entry or Esc.
  const stashedDraftRef = useRef<string>("");

  // Autocomplete state.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionIdx, setSuggestionIdx] = useState(0);

  const builtIns = useMemo(
    () => (kind === "shell" ? BUILTIN_SHELL : BUILTIN_CLAUDE),
    [kind],
  );

  const suggestions = useMemo(() => {
    const q = value.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();
    const seen = new Set<string>();
    const ranked: string[] = [];

    // 1. History — prefix match, most recent first.
    for (const h of history) {
      if (h.toLowerCase().startsWith(qLower) && h !== value) {
        if (!seen.has(h)) {
          ranked.push(h);
          seen.add(h);
          if (ranked.length >= MAX_SUGGESTIONS) return ranked;
        }
      }
    }
    // 2. Caller-provided suggestions (future: file paths, etc.).
    for (const s of extraSuggestions) {
      if (s.toLowerCase().startsWith(qLower) && s !== value && !seen.has(s)) {
        ranked.push(s);
        seen.add(s);
        if (ranked.length >= MAX_SUGGESTIONS) return ranked;
      }
    }
    // 3. Built-ins — prefix match.
    for (const b of builtIns) {
      if (b.toLowerCase().startsWith(qLower) && b !== value && !seen.has(b)) {
        ranked.push(b);
        seen.add(b);
        if (ranked.length >= MAX_SUGGESTIONS) return ranked;
      }
    }
    return ranked;
  }, [value, history, extraSuggestions, builtIns]);

  // Keep the highlighted index in bounds as the list shrinks.
  useEffect(() => {
    setSuggestionIdx((prev) => Math.min(prev, Math.max(0, suggestions.length - 1)));
  }, [suggestions.length]);

  // Show the dropdown whenever there's something to show and the user
  // isn't currently mid-history-walk (history-walk takes over ↑/↓).
  useEffect(() => {
    setShowSuggestions(suggestions.length > 0 && historyIdx === -1);
  }, [suggestions.length, historyIdx]);

  const applySuggestion = useCallback(
    (s: string) => {
      onChange(s);
      setShowSuggestions(false);
      // Return focus to the input so the user can keep editing.
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [onChange],
  );

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setHistoryIdx(-1);
    stashedDraftRef.current = "";
    setShowSuggestions(false);
  }, [value, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Tab — accept suggestion.
      if (e.key === "Tab" && showSuggestions && suggestions.length > 0) {
        e.preventDefault();
        applySuggestion(suggestions[suggestionIdx] ?? suggestions[0]);
        return;
      }

      // Escape — dismiss / restore draft.
      if (e.key === "Escape") {
        if (historyIdx !== -1) {
          onChange(stashedDraftRef.current);
          setHistoryIdx(-1);
          stashedDraftRef.current = "";
          e.preventDefault();
          return;
        }
        if (showSuggestions) {
          setShowSuggestions(false);
          e.preventDefault();
          return;
        }
        return;
      }

      // ↑ / ↓ — suggestions nav if open, otherwise history.
      if (e.key === "ArrowUp") {
        if (showSuggestions && suggestions.length > 0) {
          e.preventDefault();
          setSuggestionIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (history.length === 0) return;
        e.preventDefault();
        if (historyIdx === -1) {
          // Entering history walk — stash whatever the user was typing.
          stashedDraftRef.current = value;
        }
        const nextIdx = Math.min(history.length - 1, historyIdx + 1);
        setHistoryIdx(nextIdx);
        onChange(history[nextIdx]);
        return;
      }
      if (e.key === "ArrowDown") {
        if (showSuggestions && suggestions.length > 0) {
          e.preventDefault();
          setSuggestionIdx((i) => Math.min(suggestions.length - 1, i + 1));
          return;
        }
        if (historyIdx === -1) return;
        e.preventDefault();
        const nextIdx = historyIdx - 1;
        if (nextIdx < 0) {
          // Walked past newest — restore the stash.
          onChange(stashedDraftRef.current);
          setHistoryIdx(-1);
          stashedDraftRef.current = "";
        } else {
          setHistoryIdx(nextIdx);
          onChange(history[nextIdx]);
        }
        return;
      }

      // Enter — if a suggestion is open and the user is hovering one
      // (via ↑↓), accept; otherwise submit. Submit dispatches in the
      // form `onSubmit` handler so the Send button path stays identical.
      if (e.key === "Enter") {
        if (showSuggestions && suggestions.length > 0 && suggestionIdx >= 0) {
          // Only treat Enter as "accept suggestion" when the user has
          // moved off the top (i.e. explicitly chose one). Otherwise
          // fall through to submit — otherwise the first suggestion
          // would be silently forced every time.
          if (suggestionIdx > 0) {
            e.preventDefault();
            applySuggestion(suggestions[suggestionIdx]);
            return;
          }
        }
        // Form onSubmit handles it.
        return;
      }
    },
    [
      showSuggestions,
      suggestions,
      suggestionIdx,
      applySuggestion,
      historyIdx,
      history,
      value,
      onChange,
    ],
  );

  // Any plain edit drops us out of history-walk mode.
  const handleChange = useCallback(
    (v: string) => {
      onChange(v);
      if (historyIdx !== -1) {
        setHistoryIdx(-1);
        stashedDraftRef.current = "";
      }
    },
    [onChange, historyIdx],
  );

  const accentColor = kind === "shell" ? "text-green-500" : "text-purple-400";
  const prompt = kind === "shell" ? "$" : "claude>";

  return (
    <div className="relative">
      {showSuggestions && suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label="Command suggestions"
          className="absolute bottom-full left-0 right-0 mb-1 max-h-44 overflow-y-auto rounded border border-[#454545] bg-[#252526] text-xs shadow-lg"
        >
          {suggestions.map((s, idx) => (
            <li
              key={s}
              role="option"
              aria-selected={idx === suggestionIdx}
              onMouseDown={(e) => {
                // mouseDown (not click) so the input doesn't blur first
                // and the suggestion still applies.
                e.preventDefault();
                applySuggestion(s);
              }}
              onMouseEnter={() => setSuggestionIdx(idx)}
              className={`cursor-pointer truncate px-3 py-1 ${
                idx === suggestionIdx
                  ? "bg-[#094771] text-white"
                  : "text-[#cccccc]"
              }`}
            >
              {s}
            </li>
          ))}
          <li className="border-t border-[#3a3a3a] px-3 py-0.5 text-[10px] italic text-[#858585]">
            Tab accept · ↑↓ nav · Esc dismiss · ↑ (empty) recall history
          </li>
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-2 border-t border-gray-800 px-3 py-2"
      >
        <span className={`text-xs ${accentColor}`}>{prompt}</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            kind === "shell"
              ? "ls -la   ↑ for history   Tab for autocomplete"
              : "Ask Claude anything…   ↑ for history   Tab for autocomplete"
          }
          className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-700"
          disabled={disabled}
          aria-label={`${kind} command input`}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="rounded p-1 text-gray-600 hover:text-blue-400 disabled:opacity-30"
          aria-label="Send command"
        >
          <Send size={12} />
        </button>
      </form>
    </div>
  );
}
