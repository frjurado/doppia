/**
 * Selection coordinate resolution — Component 5 Step 11, reworked in
 * Component 9 Step 3 (tagging-tool-design.md §6A.1).
 *
 * Resolves the SelectionRange produced by AnnotationSession into the full
 * CommittedSelection coordinate set expected by the fragment write API
 * (Step 6): bar_start, bar_end, mc_start, mc_end, beat_start, beat_end,
 * repeat_context.
 *
 * mc_start / mc_end are 1-based document-order position indices (ADR-015),
 * equivalent to the DCML measure count (mc) field. They map directly to
 * Verovio's measureRange selector without further conversion.
 *
 * Derivation is key-based: the SelectionRange's committed measure-key list is
 * the single source of truth, and the mc index is keyed by the same
 * deduplicated ghost keys buildGhosts() produces (walkMeasureKeys), so the
 * two indexes can never drift apart. Every emitted coordinate is validated
 * finite before any payload is constructed (§6A.1 I2).
 *
 * References: ADR-015, ADR-025, fragment-schema.md §"Dual coordinate system".
 */

import type { SelectionRange } from './annotator';
import { measureGhostKey, walkMeasureKeys } from './ghosts';

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
 * measure's deduplicated ghost key to its 1-based document-order position
 * index (mc / DCML measure count).
 *
 * Keys come from walkMeasureKeys() — the same derivation buildGhosts() uses —
 * so the mc index and GhostLayer.measureIndex always agree, including for
 * section-reset duplicate @n values ('#N' suffixes) and measures whose @n is
 * unparseable (guarded barN fallback).
 *
 * @param meiText Normalised MEI content string (already in memory when the
 *                tagging tool is active — no additional fetch required).
 */
export function buildMcIndex(meiText: string): Map<string, number> {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const index = new Map<string, number>();
  for (const info of walkMeasureKeys(doc)) {
    index.set(info.key, info.mc);
  }
  return index;
}

/**
 * Invert an mc index over a stored fragment's machine interval: return the
 * ordered measure keys whose mc lies in [mcStart, mcEnd], minus the sibling
 * endings excluded by the fragment's repeat_context (§6A.3 — a
 * 'first_ending'/'second_ending' context excludes the other endings; null
 * keeps everything, which is correct for both row 1 and row 3).
 *
 * Used by the edit flow to seed AnnotationSession.initialSelection with the
 * effective key list of a stored fragment, which is more precise than a bar
 * range when @n values repeat (split measures, section resets, endings).
 */
export function measureKeysForMcRange(
  mcIndex: Map<string, number>,
  mcStart: number,
  mcEnd: number,
  repeatContext: SelectionRange['repeatContext'],
): string[] {
  const keys: string[] = [];
  for (const [key, mc] of mcIndex) {
    if (mc < mcStart || mc > mcEnd) continue;
    const endingMatch = /-e(\d+)(?:#\d+)?$/.exec(key);
    if (endingMatch) {
      const endingN = parseInt(endingMatch[1]!, 10);
      if (repeatContext === 'first_ending' && endingN !== 1) continue;
      if (repeatContext === 'second_ending' && endingN === 1) continue;
    }
    keys.push(key);
  }
  // Map iteration follows insertion order = document order; keys are already
  // ordered by mc.
  return keys;
}

// ---------------------------------------------------------------------------
// Coordinate resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a SelectionRange to a CommittedSelection by deriving mc_start and
 * mc_end from the MEI mc index.
 *
 * When the selection carries its committed measure-key list (§6A.1 — every
 * selection committed by AnnotationSession does), mc coordinates come from
 * the first and last key directly. The legacy barN + repeat_context lookup
 * remains as a fallback for ranges restored from stored human coordinates.
 *
 * Returns null when either endpoint cannot be resolved or any coordinate is
 * non-finite. Callers must treat null as "no payload" — a NaN or unresolved
 * value never reaches an API request (§6A.1 I2).
 */
export function commitSelection(
  sel: SelectionRange,
  mcIndex: Map<string, number>,
): CommittedSelection | null {
  let mc_start: number | undefined;
  let mc_end:   number | undefined;

  if (sel.measureKeys && sel.measureKeys.length > 0) {
    mc_start = mcIndex.get(sel.measureKeys[0]!);
    mc_end   = mcIndex.get(sel.measureKeys[sel.measureKeys.length - 1]!);
  } else {
    const endingN = _endingNFromContext(sel.repeatContext);
    mc_start = mcIndex.get(measureGhostKey(sel.barStart, endingN));
    mc_end   = mcIndex.get(measureGhostKey(sel.barEnd,   endingN));
    // Fallback: try without ending context in case the ghost key was stored
    // without it (e.g. beat-level selection spanning an ending boundary).
    if (mc_start === undefined) {
      mc_start = mcIndex.get(measureGhostKey(sel.barStart, null));
    }
    if (mc_end === undefined) {
      mc_end = mcIndex.get(measureGhostKey(sel.barEnd, null));
    }
  }

  if (mc_start === undefined || mc_end === undefined) return null;

  // I2 — total coordinate derivation: no payload with a non-finite value can
  // be constructed. With the guarded barN parsing in walkMeasureKeys these
  // should be unreachable; the guard pins the invariant regardless.
  if (!Number.isFinite(sel.barStart) || !Number.isFinite(sel.barEnd)) return null;
  if (!Number.isFinite(mc_start) || !Number.isFinite(mc_end)) return null;
  if (sel.beatStart !== null && !Number.isFinite(sel.beatStart)) return null;
  if (sel.beatEnd !== null && !Number.isFinite(sel.beatEnd)) return null;

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
