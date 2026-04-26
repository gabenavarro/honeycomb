/** useMediaQuery — reactive media-query subscription (M36).
 *
 *  Returns the current `matches` value of the query and re-renders
 *  when the media-query state flips. Cleans up its listener on
 *  unmount.
 *
 *  Named helpers (useIsPhone / useIsTablet / useIsDesktop) wrap the
 *  spec's three breakpoint thresholds (phone < 768, tablet 768–1023,
 *  desktop ≥ 1024). They drive the JS-level layout swaps in App.tsx
 *  while CSS-only Tailwind variants (tablet: / desktop:) handle the
 *  chrome adjustments.
 *
 *  SSR: returns `false` if `window` is undefined; the first client
 *  render reconciles to the real value.
 */
import { useEffect, useState } from "react";

export const BREAKPOINTS = {
  tablet: 768,
  desktop: 1024,
} as const;

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Resync once on mount in case the initial value was stale.
    setMatches(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export function useIsTablet(): boolean {
  // tablet covers 768–1023; the helper returns true only when we are
  // EXACTLY in that band (≥ tablet AND NOT ≥ desktop).
  const tabletOrUp = useMediaQuery(`(min-width: ${BREAKPOINTS.tablet}px)`);
  const desktopOrUp = useMediaQuery(`(min-width: ${BREAKPOINTS.desktop}px)`);
  return tabletOrUp && !desktopOrUp;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS.desktop}px)`);
}

export function useIsPhone(): boolean {
  // Phone is the base — true when neither tablet nor desktop matches.
  const tabletOrUp = useMediaQuery(`(min-width: ${BREAKPOINTS.tablet}px)`);
  return !tabletOrUp;
}
