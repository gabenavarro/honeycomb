/** Container-level "needs user input" signal (M20).
 *
 * Any producer (PtyPane, command output handler, future Claude-output
 * parser) can call ``markAttention(containerId)`` when it detects an
 * interactive prompt. The active tab's ``ContainerTabs`` subscribes
 * via ``useContainerAttention`` and renders a pulsing dot. Focusing a
 * container tab clears its flag.
 *
 * The store is deliberately plain — a module-level ``Map`` + a set of
 * React subscribers. No Zustand / Redux overhead for what is
 * effectively a per-id boolean.
 */

import { useSyncExternalStore } from "react";

type Listener = () => void;
const flags = new Map<number, boolean>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

export function markAttention(containerId: number): void {
  if (flags.get(containerId)) return; // no-op if already set — avoids noisy notifications
  flags.set(containerId, true);
  emit();
}

export function clearAttention(containerId: number): void {
  if (!flags.get(containerId)) return;
  flags.delete(containerId);
  emit();
}

function snapshot(): Record<number, boolean> {
  return Object.fromEntries(flags.entries());
}

let lastSnapshot: Record<number, boolean> = {};

function getSnapshot(): Record<number, boolean> {
  // useSyncExternalStore needs a stable reference when nothing changed —
  // rebuild only when a listener is notified.
  const next = snapshot();
  // Fast-path reference equality check: if the key set and values
  // match, return the previous snapshot.
  const prevKeys = Object.keys(lastSnapshot);
  const nextKeys = Object.keys(next);
  if (prevKeys.length === nextKeys.length && prevKeys.every((k) => lastSnapshot[+k] === next[+k])) {
    return lastSnapshot;
  }
  lastSnapshot = next;
  return next;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Returns true when ``containerId`` has an outstanding attention flag. */
export function useContainerAttention(containerId: number | null): boolean {
  const map = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return containerId !== null && Boolean(map[containerId]);
}

// Patterns we treat as "obviously waiting for input". Kept deliberately
// narrow — false positives are worse than false negatives here because
// the icon draws the eye.
const ATTENTION_PATTERNS: RegExp[] = [
  /\(y\/n\)\??\s*$/i,
  /\(yes\/no\)\??\s*$/i,
  /\[y\/n\]\??\s*$/i,
  /password\s*:\s*$/i,
  /passphrase\s*:\s*$/i,
  /\bcontinue\?\s*$/i,
  /\bproceed\?\s*$/i,
  // Claude Code's permission prompts end with an unmistakable marker:
  /allow this action\?\s*$/i,
];

/** Scan a chunk of PTY output and mark attention if any known prompt
 * signature appears at the tail of the buffer. The caller is expected
 * to trim ANSI + CR before feeding the text in. */
export function scanForAttention(containerId: number, text: string): void {
  const trimmed = text.trimEnd();
  if (!trimmed) return;
  // Inspect only the last ~240 chars so a massive paste doesn't re-
  // trigger on ancient output.
  const tail = trimmed.slice(-240);
  for (const pattern of ATTENTION_PATTERNS) {
    if (pattern.test(tail)) {
      markAttention(containerId);
      return;
    }
  }
}
