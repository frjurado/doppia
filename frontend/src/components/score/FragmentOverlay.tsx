import styles from './FragmentOverlay.module.css';

/**
 * Transparent overlay container positioned over the score SVG content area.
 *
 * This component establishes the fragment overlay architecture used by
 * Components 7 and 8 (fragment database display, fragment browsing). It is
 * empty in Step 13 — the overlay slot exists so downstream components inherit
 * the correct pattern without modifying ScoreViewer.
 *
 * Architecture rules (see CLAUDE.md §"Verovio SVG overlay rule"):
 * - Overlays are always absolutely-positioned HTML elements above the SVG.
 * - Never inject overlay content inside Verovio's SVG output — re-renders
 *   discard SVG modifications at any time.
 * - The overlay container has pointer-events: none. Children that need
 *   interaction (e.g. bracket resize handles) set pointer-events: auto on
 *   themselves.
 *
 * Positioning: the containing block is the nearest ancestor with
 * position: relative — which must be the .scoreContent div in ScoreViewer.
 * This ensures overlay coordinates align with the SVG measure geometry.
 */
interface FragmentOverlayProps {
  /**
   * Overlay content — selection brackets, labels, playback caret.
   * Empty in Component 3 (Step 13). Components 7/8 populate this slot.
   */
  children?: React.ReactNode;
  /** Test hook. Defaults to 'fragment-overlay'. */
  'data-testid'?: string;
}

export default function FragmentOverlay({
  children,
  'data-testid': testId,
}: FragmentOverlayProps) {
  return (
    <div
      className={styles.overlay}
      aria-hidden="true"
      data-testid={testId ?? 'fragment-overlay'}
    >
      {children}
    </div>
  );
}
