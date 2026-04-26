/** Theme system (M31).
 *
 * One React Context provides the current theme preference and a setter.
 * Preference can be:
 *   - "system" — follow OS via prefers-color-scheme media query
 *   - "light"  — explicit light override
 *   - "dark"   — explicit dark override
 *
 * Resolution rules:
 *   - When preference is "system": data-theme attribute is REMOVED from
 *     <html>, letting the prefers-color-scheme CSS media query take effect.
 *   - When preference is "light" or "dark": data-theme attribute is SET on
 *     <html>, overriding the media query.
 *
 * Persistence: localStorage key `hive:theme`. Setting back to "system"
 * removes the storage key (so a fresh device follows OS until told
 * otherwise).
 *
 * Listens for media-query change events so a user on "system" who
 * flips their OS theme sees the dashboard update without reload.
 */

import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const THEME_STORAGE_KEY = "hive:theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function readSystemPreference(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyDataTheme(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemPreference());

  // Apply data-theme on mount + whenever preference changes
  useEffect(() => {
    applyDataTheme(preference);
  }, [preference]);

  // Listen for OS preference changes so "system" stays live
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = (ev: { matches: boolean }) => {
      setSystemTheme(ev.matches ? "light" : "dark");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (next === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? systemTheme : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
