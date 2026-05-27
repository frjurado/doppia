/**
 * Layer 3 — Main bracket track (tagging-tool-design.md §3).
 *
 * Renders a single coloured bracket above the staff once fragmentSet is true.
 * The bracket spans the pixel extent of the committed selection, from the left
 * edge of the first selected measure to the right edge of the last selected
 * measure, positioned at the top of the measure region.
 *
 * Gradient-zone handles at both endpoints reinforce the visual affordance that
 * the endpoints are draggable (tagging-tool-design.md §3 §"drag handles").
 * The actual drag interaction is owned by the ghost layer (AnnotationSession);
 * the bracket and its handles carry pointer-events: none so clicks pass
 * through to the ghost elements below.
 *
 * Architecture note: this component is rendered inside FragmentOverlay, which
 * has z-index: 30. The ghost overlay has z-index: 20. The bracket therefore
 * visually stacks above ghost highlights while remaining non-interactive.
 *
 * Multi-system selections (where barStart and barEnd are on different SVG
 * rows) render as a single horizontal bar from the first measure's left to the
 * last measure's right — visually spanning across rows. Proper per-system
 * bracket segments are deferred to Component 7.
 */

import type { GhostLayer, MeasureGhostEntry } from './ghosts';
import { measureGhostKey } from './ghosts';
import type { SelectionRange } from './annotator';
import styles from './MainBracket.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Height of the bracket bar in pixels. */
const BRACKET_H = 5;
/** Width of each gradient handle zone. Clamped to one-third of bracket width. */
const HANDLE_W = 28;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MainBracketProps {
  /** Committed selection range from AnnotationSession, or null. */
  selection: SelectionRange | null;
  /** Ghost layer providing pixel bounds via measureIndex. */
  layer: GhostLayer | null;
  /** Bracket is only rendered when the fragmentSet flag is true. */
  fragmentSet: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function endingNFromContext(ctx: SelectionRange['repeatContext']): number | null {
  if (ctx === 'first_ending')  return 1;
  if (ctx === 'second_ending') return 2;
  return null;
}

/**
 * Resolve the first and last selected measure ghost entries from the
 * SelectionRange and the ghost layer's measureIndex.
 *
 * When the repeatContext is set, the lookup uses the matching endingN so that
 * first-ending and second-ending measures are correctly distinguished (the
 * ghost keys already incorporate endingN, mirroring the pattern used by
 * buildMcIndex). Falls back to the no-ending key when the keyed lookup fails.
 */
function resolveEntries(
  sel: SelectionRange,
  layer: GhostLayer,
): { first: MeasureGhostEntry; last: MeasureGhostEntry } | null {
  const endingN = endingNFromContext(sel.repeatContext);

  let first = layer.measureIndex.get(measureGhostKey(sel.barStart, endingN));
  let last  = layer.measureIndex.get(measureGhostKey(sel.barEnd,   endingN));

  if (!first) first = layer.measureIndex.get(measureGhostKey(sel.barStart, null));
  if (!last)  last  = layer.measureIndex.get(measureGhostKey(sel.barEnd,   null));

  if (!first || !last) return null;
  return { first, last };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MainBracket({ selection, layer, fragmentSet }: MainBracketProps) {
  if (!fragmentSet || !selection || !layer) return null;

  const resolved = resolveEntries(selection, layer);
  if (!resolved) return null;

  const { first, last } = resolved;

  const left  = first.bounds.left;
  const right = last.bounds.left + last.bounds.width;
  const top   = first.systemTop;
  const width = right - left;

  if (width <= 0) return null;

  const handleW = Math.min(HANDLE_W, Math.floor(width / 3));

  return (
    <div
      className={styles.bracket}
      style={{ left, top, width, height: BRACKET_H }}
      aria-hidden="true"
      data-testid="main-bracket"
    >
      <div
        className={styles.handleLeft}
        style={{ width: handleW }}
      />
      <div
        className={styles.handleRight}
        style={{ width: handleW }}
      />
    </div>
  );
}
