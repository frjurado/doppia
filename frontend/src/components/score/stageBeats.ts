/**
 * Stage beat-pair normalization for the submit payload (ADR-005).
 *
 * A stage's bounds may be measure-aligned on one side (null) and beat-precise on
 * the other, or cross a barline (beats are 1-indexed within each measure, so the
 * start beat may numerically exceed the end beat). The wire format requires both
 * beats null (measure-level) or both non-null. These helpers produce that pair
 * without losing beat precision — the old `beatStart < beatEnd` guard nulled
 * cross-bar and asymmetric pairs, collapsing those stages to whole measures.
 */

import { beatSlotCount } from './ghosts';
import type { GhostLayer } from './ghosts';
import { parseMeiMeterParts } from '../../utils/meiParsing';

/**
 * Exclusive beat upper bound of a measure (ADR-005): `numBeats + 1` — the value
 * `beat_end` takes for a stage that runs to the end of its last measure.
 *
 * Prefers the ghost layer's per-measure `endFloat` (exact, honours mid-piece
 * meter changes) for the given physical-measure key; falls back to the global
 * meter (`beatSlotCount(...) + 1`) when no ghost layer or matching entry exists.
 */
export function measureExclusiveEndBeat(
  layer: GhostLayer | null,
  keyEnd: string | undefined,
  meiText: string,
): number {
  if (layer && keyEnd !== undefined) {
    let maxEnd = 0;
    for (const e of layer.beatIndex.values()) {
      if (e.measureKey === keyEnd && e.endFloat > maxEnd) maxEnd = e.endFloat;
    }
    if (maxEnd > 0) return maxEnd;
  }
  const [count, unit] = parseMeiMeterParts(meiText);
  return beatSlotCount(count, unit) + 1;
}

/**
 * Normalize a stage's `(beatStart, beatEnd)` bounds into the ADR-005 wire pair.
 *
 * - Both raw values null → measure-level stage → `(null, null)`.
 * - At least one non-null → a beat-precise stage: fill the measure-aligned side
 *   with its measure boundary (start → 1.0; end → the measure's exclusive end)
 *   so both are non-null and the stored extent matches what was tagged. A
 *   cross-bar pair is preserved; only a degenerate *single-bar* pair
 *   (`beatStart >= beatEnd` within one measure) falls back to measure-level.
 *
 * Mirrors the backend validator, which only enforces ordering when
 * `bar_start === bar_end` (backend/models/fragment.py).
 */
export function normalizeStageBeats(
  beatStart: number | null,
  beatEnd: number | null,
  barStart: number,
  barEnd: number,
  measureEnd: number,
): { beat_start: number | null; beat_end: number | null } {
  if (beatStart === null && beatEnd === null) {
    return { beat_start: null, beat_end: null };
  }
  const bs = beatStart ?? 1.0;
  const be = beatEnd ?? measureEnd;
  if (barStart === barEnd && bs >= be) {
    return { beat_start: null, beat_end: null };
  }
  return { beat_start: bs, beat_end: be };
}
