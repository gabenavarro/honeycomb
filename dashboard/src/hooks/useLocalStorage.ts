/** Typed localStorage hook (M9).
 *
 * Replaces the ad-hoc ``readNumberArray`` / ``readBool`` helpers that
 * used to live in ``App.tsx`` and the per-field persistence ``useEffect``
 * chain. One source of truth: a read on mount, a write whenever the
 * value changes, and sensible handling of the two ways persistence can
 * fail — ``QuotaExceededError`` (disk full, large session transcripts)
 * and private-mode throws where ``localStorage`` is a stub.
 *
 * On a write failure the hook emits a one-shot warning *event*, not a
 * toast. Hooks cannot safely depend on context providers (they would
 * introduce rendering-order coupling), so ``useLocalStorageQuotaToast``
 * lives as a small companion component that listens for the event and
 * surfaces the warning. That component is mounted under ``ToastProvider``
 * so the toast pops in the expected place.
 *
 * ``storage`` events (cross-tab sync) are handled — if the user opens
 * Honeycomb in two tabs and toggles the sidebar in one, the other
 * reflects the change.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseLocalStorageOptions<T> {
  /** Validator run on the parsed value. Returns ``true`` to accept,
   * ``false`` to fall back to the default. Handy for enum-like values
   * where an older dashboard build might have written an unknown label. */
  validate?: (value: unknown) => value is T;
}

const QUOTA_EVENT = "hive:localStorage:quota";

interface QuotaDetail {
  key: string;
  error: unknown;
}

function emitQuota(detail: QuotaDetail): void {
  try {
    window.dispatchEvent(new CustomEvent(QUOTA_EVENT, { detail }));
  } catch {
    // ignore — Event constructor missing in very old environments.
  }
}

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  options?: UseLocalStorageOptions<T>,
): [T, (value: T | ((prev: T) => T)) => void] {
  const validateRef = useRef(options?.validate);
  // Keep the ref in sync without writing during render — the effect
  // fires after commit, and the ref is only read from the ``storage``
  // event handler below (also post-commit).
  useEffect(() => {
    validateRef.current = options?.validate;
  }, [options?.validate]);

  // Read once on mount. A thrown validator or JSON-parse failure falls
  // back to the default — treating corrupt storage the same as missing
  // storage is safer than crashing the app.
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      const parsed = JSON.parse(raw) as unknown;
      const initialValidator = options?.validate;
      if (initialValidator && !initialValidator(parsed)) return defaultValue;
      return parsed as T;
    } catch {
      return defaultValue;
    }
  });

  // Persist on change. Separate from initial read so StrictMode's
  // double-mount doesn't double-write.
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (err) {
      // DOMException.name === "QuotaExceededError" (or the legacy
      // NS_ERROR_DOM_QUOTA_REACHED Firefox used to throw).
      emitQuota({ key, error: err });
    }
  }, [key, state]);

  // Cross-tab sync. ``storage`` fires only when *another* window writes,
  // which is exactly what we want.
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== key) return;
      if (ev.newValue === null) {
        setState(defaultValue);
        return;
      }
      try {
        const parsed = JSON.parse(ev.newValue) as unknown;
        if (validateRef.current && !validateRef.current(parsed)) return;
        setState(parsed as T);
      } catch {
        // ignore malformed cross-tab writes
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, defaultValue]);

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    setState(next);
  }, []);

  return [state, setValue];
}

/** Subscribe to quota-exceeded events. Returns an unsubscribe function.
 * Used by the small toast-surfacing component below but exported so
 * tests can assert the signal fired. */
export function onLocalStorageQuota(cb: (detail: QuotaDetail) => void): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<QuotaDetail>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(QUOTA_EVENT, handler);
  return () => window.removeEventListener(QUOTA_EVENT, handler);
}
