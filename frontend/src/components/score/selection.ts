/**
 * Selection coordinate resolution — Component 5 Step 11.
 *
 * Resolves the raw SelectionRange (barStart/barEnd, beatStart/beatEnd) produced
 * by AnnotationSession into the full CommittedSelection coordinate set expected
 * by the fragment write API (Step 6): bar_start, bar_end, mc_start, mc_end,
 * beat_start, beat_end, repeat_context.
 *
 * mc_start / mc_end are 1-based document-order position indices (ADR-015),
 * equivalent to the DCML measure count (mc) field. They map directly to
 * Verovio's measureRange selector without further conversion.
 *
 * References: ADR-015, fragment-schema.md §"Dual coordinate system".
 */

import type { SelectionRange } from './annotator';
import { measureGhostKey } from './ghosts';

// ---------------------------------------------------------------------------
// CommittedSelection — the stable API contract shape
// ---------------------------------------------------------------------------

/**
 * The full coordinate set written to the fragment row at tag time.
 *
 * Field names are snake_case to match the POST /api/v1/fragments payload
 * (Step 6). Part 4 and Part 5 of Component 5 build against this shape; do
 * not change field names without updating those consumers.
 *
 * bar_start / bar_end  — human coordinates (MEI @n): used for display labels
 *                        ("m. 3–7") and for the annotator's editing UI.
 * mc_start  / mc_end   — machine coordinates (document-order position,
 *                        ADR-015): used for Verovio renderRange calls and for
 *                        cross-system joins with DCML harmonies.
 */
export interface CommittedSelection {
  /** Notated bar number (MEI @n) of the first measure — human display coordinate. */
  bar_start: number;
  /** Notated bar number (MEI @n) of the last measure — human display coordinate (inclusive). */
  bar_end: number;
  /** 1-based document-order position of the first measure (ADR-015 §"Decision"). */
  mc_start: number;
  /** 1-based document-order position of the last measure (ADR-015 §"Decision"). */
  mc_end: number;
  /**
   * Float-encoded beat start (ADR-005 §"Data model"), or null for measure-level
   * selection.  Stored as fragment.beat_start.
   */
  beat_start: number | null;
  /**
   * Float-encoded exclusive upper bound for onset inclusion (ADR-005), or null.
   * Stored as fragment.beat_end.
   */
  beat_end: number | null;
  /** Repeat-ending context when the selection falls inside a written volta bracket. */
  repeat_context: 'first_ending' | 'second_ending' | null;
}

// ---------------------------------------------------------------------------
// MC index construction
// ---------------------------------------------------------------------------

/**
 * Walk MEI <measure> elements in document order and return a Map from each
 * measure's ghost key (measureGhostKey(barN, endingN)) to its 1-based
 * document-order position index (mc / DCML measure count).
 *
 * The ghost key mirrors the key used by GhostLayer.measureIndex, so the two
 * indexes are aligned: the same barN + endingN pair identifies the same
 * physical measure in both. commitSelection() resolves mc_start / mc_end by
 * looking up the SelectionRange's barStart / barEnd in this index without
 * re-parsing the MEI.
 *
 * @param meiText Normalised MEI content string (already in memory when the
 *                tagging tool is active — no additional fetch required).
 */
export function buildMcIndex(meiText: string): Map<string, number> {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const measures = doc.getElementsByTagName('measure');
  const index = new Map<string, number>();

  for (let i = 0; i < measures.length; i++) {
    const measure = measures[i]!;
    // Fall back to position index when @n is absent (should not happen in
    // normalised corpus files, but avoids a NaN key in the map).
    const barN = parseInt(measure.getAttribute('n') ?? `${i + 1}`, 10);
    const endingN = _getEndingN(measure);
    const key = measureGhostKey(barN, endingN);
    // First occurrence wins: duplicate keys should not exist in a normalised
    // MEI file, but this guard prevents a later measure from clobbering an
    // earlier one if they somehow share the same barN + endingN.
    if (!index.has(key)) {
      index.set(key, i + 1);
    }
  }

  return index;
}

/** Walk up the MEI DOM to find the containing <ending @n>, if any. */
function _getEndingN(el: Element): number | null {
  let cursor: Element | null = el.parentElement;
  while (cursor) {
    if (cursor.tagName === 'ending') {
      const n = cursor.getAttribute('n');
      if (n !== null) {
        const v = parseInt(n, 10);
        return isNaN(v) ? null : v;
      }
      return null;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coordinate resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a SelectionRange to a CommittedSelection by deriving mc_start and
 * mc_end from the MEI mc index.
 *
 * Returns null when either endpoint cannot be resolved in the index. This
 * should not occur for a selection committed against a valid ghost layer built
 * from the same MEI, but provides a safe failure mode for callers.
 *
 * Repeat-ending context: 'first_ending' → endingN = 1; 'second_ending' →
 * endingN = 2.  For Phase 1 the Mozart corpus uses endings numbered 1 and 2
 * only.  A fallback lookup without ending context is attempted when the keyed
 * lookup fails (guards against beat-level selections where the barN came from
 * a ghost without a recorded endingN).
 */
export function commitSelection(
  sel: SelectionRange,
  mcIndex: Map<string, number>,
): CommittedSelection | null {
  const endingN = _endingNFromContext(sel.repeatContext);

  const startKey = measureGhostKey(sel.barStart, endingN);
  const endKey   = measureGhostKey(sel.barEnd,   endingN);

  let mc_start = mcIndex.get(startKey);
  let mc_end   = mcIndex.get(endKey);

  // Fallback: try without ending context in case the ghost key was stored
  // without it (e.g. beat-level selection spanning an ending boundary).
  if (mc_start === undefined) {
    mc_start = mcIndex.get(measureGhostKey(sel.barStart, null));
  }
  if (mc_end === undefined) {
    mc_end = mcIndex.get(measureGhostKey(sel.barEnd, null));
  }

  if (mc_start === undefined || mc_end === undefined) return null;

  return {
    bar_start:      sel.barStart,
    bar_end:        sel.barEnd,
    mc_start,
    mc_end,
    beat_start:     sel.beatStart,
    beat_end:       sel.beatEnd,
    repeat_context: sel.repeatContext,
  };
}

function _endingNFromContext(
  ctx: SelectionRange['repeatContext'],
): number | null {
  if (ctx === 'first_ending')  return 1;
  if (ctx === 'second_ending') return 2;
  return null;
}
