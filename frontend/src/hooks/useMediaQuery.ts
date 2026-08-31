import { useEffect, useState } from 'react';

/**
 * Viewport breakpoints and the hook that reads them (Component 12 Step 13).
 *
 * The values come from `DESIGN.md` § 7.1, which also explains why they are
 * literals rather than CSS custom properties: custom properties are not valid
 * inside `@media` conditions, so a `--bp-sm` token would be silently useless.
 * These constants are the JS-side half of that rule — the CSS-side half is
 * written out in the media queries themselves. **Keep the two in step.**
 *
 * Extracted from `CorpusBrowser`, which had the only copy of this hook.
 */

/** Below this, layouts go single-column and the topbar collapses to a panel. */
export const BREAKPOINT_SM = 600;
/** Below this, two-pane editorial layouts are not offered. */
export const BREAKPOINT_MD = 900;

/*
 * Range notation (`width < 600px`) rather than `max-width: 599px`: it states
 * the boundary exactly, so the JS and CSS halves cannot disagree by a pixel at
 * fractional zoom levels. Stylelint enforces the same notation in CSS.
 */

/** Matches while the viewport is narrower than the `sm` breakpoint. */
export const BELOW_SM = `(width < ${BREAKPOINT_SM}px)`;
/** Matches while the viewport is narrower than the `md` breakpoint. */
export const BELOW_MD = `(width < ${BREAKPOINT_MD}px)`;

/**
 * Track a media query, re-rendering when it starts or stops matching.
 *
 * @param query A media-query string, e.g. {@link BELOW_SM}.
 * @returns Whether the query currently matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    // Re-read on subscribe: the query may have changed, or the viewport may
    // have moved between the initial render and this effect.
    setMatches(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}
