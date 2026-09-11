/**
 * Stage bracket state — pure logic for Component 5 Step 14.
 *
 * StageAssignment tracks the musical-coordinate bounds and status of one
 * stage bracket in the stage bracket track (Layer 4,
 * tagging-tool-design.md §4).
 *
 * Pre-population, stagesComplete, the absent toggle, and concept-change
 * reconciliation live here so they can be unit-tested without a DOM or React.
 * The interaction core — split-handle boundary moves and the main-bracket
 * resize response — lives in stageFrame.ts (Component 9 Step 4), built on
 * slot lists over the selection's effective measure keys (§6A.4/§6A.5).
 *
 * References: tagging-tool-design.md §4 §6 §6A.4 §7.3, ADR-011 §1 §3 §6.
 */

import type { ContainsStage, ConceptSchemaTree } from '../../services/conceptApi';
import type { SelectionRange } from './annotator';
import type { PropertyFormValues } from './PropertyForm';
import type { ResolutionMode } from './ghosts';

// ---------------------------------------------------------------------------
// Sub-part tagging (Component 5 Step 15)
// ---------------------------------------------------------------------------

/**
 * Property state for a single stage's inline form.
 *
 * The concept is implicit from the stage bracket's graph metadata (stageId =
 * target_id from the CONTAINS edge). At submission time this becomes a child
 * Fragment row linked by parent_fragment_id, with concept_id = stageId and
 * bounds from StageAssignment (tagging-tool-design.md §5.4, ADR-011 §1).
 *
 * Phase 1 renders one visible level of nesting only (two-level display limit,
 * ADR-011 §3).
 */
export interface SubPartTag {
  /** Full schema tree for the stage concept; null while loading. */
  schemaTree: ConceptSchemaTree | null;
  /** Form values keyed by PropertySchema.id, matching PropertyFormValues. */
  propertyValues: PropertyFormValues;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Musical-coordinate bounds for a stage bracket (ADR-005 §"Data model"). */
export interface StageBounds {
  barStart: number;
  /** Float-encoded beat (ADR-005), or null = measure-level. */
  beatStart: number | null;
  barEnd: number;
  /** Float-encoded exclusive beat upper bound, or null = measure-level. */
  beatEnd: number | null;
  /**
   * Deduplicated physical-measure ghost key of the start boundary (§6A.1).
   * Preferred over barStart for geometry projection and mc resolution —
   * bar numbers repeat across endings, split measures, and X-numbered
   * fallbacks. Optional: bounds restored from stored human coordinates may
   * lack keys, in which case derivations fall back to barN matching.
   */
  keyStart?: string;
  /** Physical-measure ghost key of the end boundary (see keyStart). */
  keyEnd?: string;
}

/** State for one stage bracket. Immutable — produce new instances on change. */
export interface StageAssignment {
  stageId: string;
  stageName: string;
  order: number;
  required: boolean;
  displayMode: 'stage' | 'segment';
  containmentMode: 'contiguous' | 'free';
  defaultWeight: number;

  /** Current bounds; null when the stage is absent (collapsed to zero width). */
  bounds: StageBounds | null;

  /**
   * Confirmed = this bracket's position is settled, not a default awaiting
   * review. Unconfirmed optional stages are in "limbo" and block submission
   * (tagging-tool-design.md §4 §"Optional stages"). Set by an explicit drag and
   * by restoring a stored fragment, whose bounds an annotator already settled in
   * an earlier session.
   */
  confirmed: boolean;

  /**
   * User explicitly toggled this optional stage absent via the absent toggle
   * (tagging-tool-design.md §7.3). Required stages cannot be absent.
   */
  absent: boolean;

  /**
   * Stage concept ID has no counterpart in the current concept's CONTAINS
   * structure after a concept/refinement change. Orphaned stages are shown
   * greyed with a warning icon; they are not submitted
   * (tagging-tool-design.md §6 §"Concept change after stages are committed").
   */
  orphaned: boolean;

  /**
   * Stage bounds fall (partially or fully) outside the main fragment bracket
   * after the annotator contracted the main bracket. Blocks submission until
   * resolved (tagging-tool-design.md §6 §"Main bracket change after stages
   * are committed").
   */
  error: boolean;
}

// ---------------------------------------------------------------------------
// Stage palette (one colour per stage order, cycling)
// ---------------------------------------------------------------------------

/**
 * Fixed palette of scholarly muted colours for stage brackets.
 * Assigned by stage order (0-indexed mod palette length) so that the same
 * stage concept always gets the same colour in a given concept's stage list.
 */
export const STAGE_PALETTE = [
  '#7a9e7e', // sage green     (typically: Predominant)
  '#b5838d', // dusty rose     (typically: Dominant)
  '#d4956a', // amber ochre    (typically: Pre-Tonic)
  '#6b7fa3', // steel blue     (typically: Tonic)
  '#9b8ea0', // mauve
  '#7a9e9e', // teal
  '#a09b7a', // khaki
] as const;

/** Return the bracket colour for the stage at the given 0-indexed order. */
export function stageColor(orderIndex: number): string {
  return STAGE_PALETTE[orderIndex % STAGE_PALETTE.length]!;
}

// ---------------------------------------------------------------------------
// Auto-grid selection (tagging-tool-design.md §4, Component 7 Step 2)
// ---------------------------------------------------------------------------

/**
 * A logical beat or sub-beat position extracted from the ghost layer index.
 * Used when the selection is too short for measure-level stage distribution
 * and pre-population auto-drops to beat or sub-beat resolution.
 */
export interface BeatSlot {
  barN: number;
  beatFloat: number;
  /** Deduplicated measure ghost key of the slot's parent measure, when the
   *  caller derives slots from the ghost layer (preferred — see StageBounds). */
  measureKey?: string;
}

/** Slot capacity of the stage layout frame at each resolution (§6A.1). */
export interface StageSlotCounts {
  measure: number;
  beat: number;
  subbeat: number;
}

/**
 * Return the coarsest resolution at which stageCount stages can each occupy
 * at least one grid slot of the stage layout frame.
 *
 * Tries Measure → Beat → Sub-beat in order, falling through to 'subbeat'
 * even when all counts are below stageCount. The caller is responsible for
 * detecting and surfacing the blocking case (stageCount exceeds all tiers).
 *
 * Counts are the frame's own slot counts at each resolution — `buildStageSlots`
 * lengths, the same lists the brackets render from. They are not derived from
 * the selection's bar range: bar arithmetic over-counts when `@n` repeats and
 * miscounts discontiguous ranges (§6A.3), and the measure tier is not simply
 * the key count either, since a beat-precise endpoint can leave its measure
 * uncovered (M7).
 */
export function chooseStageGrid(
  stageCount: number,
  counts: StageSlotCounts,
): ResolutionMode {
  if (stageCount <= 0) return 'measure';
  if (counts.measure >= stageCount) return 'measure';
  if (counts.beat >= stageCount) return 'beat';
  return 'subbeat';
}

/**
 * Distribute stage brackets over beat or sub-beat grid positions by
 * default_weight. Called when chooseStageGrid returns 'beat' or 'subbeat' —
 * i.e. when the selection is too short for measure-level placement.
 *
 * positions must be ordered (barN ASC, beatFloat ASC) and cover only the
 * slots inside the committed selection (respecting its beat precision if any).
 *
 * Outer-edge pinning (tagging-tool-design.md §4): the first stage's left edge
 * is pinned to the selection boundary (selection.barStart / selection.beatStart),
 * and the last stage's right edge is pinned to the selection end (selection.barEnd
 * / selection.beatEnd). Only the internal split-handle boundaries are distributed
 * across the supplied grid slots.
 *
 * Falls back to measure-level prePopulateStages when positions.length <
 * stages.length (caller is responsible for blocking detection before calling).
 */
export function prePopulateStagesAtGrid(
  stages: ContainsStage[],
  selection: SelectionRange,
  positions: BeatSlot[],
): StageAssignment[] {
  if (stages.length === 0) return [];
  if (positions.length < stages.length) {
    // Not enough beat/sub-beat slots; fall back to measure-level so output is
    // at least consistent — the caller handles the blocked indicator separately.
    return prePopulateStages(stages, selection);
  }

  const sorted = [...stages].sort((a, b) => a.order - b.order);
  const totalWeight = sorted.reduce((s, st) => s + st.default_weight, 0) || 1;
  const N = positions.length;

  const assignments: StageAssignment[] = [];
  let slotIdx = 0;

  for (let i = 0; i < sorted.length; i++) {
    const stage = sorted[i]!;
    const isFirst = i === 0;
    const isLast = i === sorted.length - 1;

    // Distribute slots proportionally; last stage absorbs the remainder.
    let endSlotIdx: number;
    if (isLast) {
      endSlotIdx = N - 1;
    } else {
      const remaining = sorted.length - 1 - i;
      const maxEndSlot = N - remaining - 1;
      const rawSlots = N * stage.default_weight / totalWeight;
      const slotCount = Math.max(1, Math.round(rawSlots));
      endSlotIdx = Math.min(slotIdx + slotCount - 1, maxEndSlot);
    }

    // The stage that starts immediately after this one marks the right boundary.
    const nextSlot: BeatSlot | undefined = isLast ? undefined : positions[endSlotIdx + 1];

    // Left boundary: first stage is pinned to the selection's start (outer-edge
    // pinning); others start at their first slot position.
    const barStart = isFirst ? selection.barStart : positions[slotIdx]!.barN;
    const beatStart: number | null = isFirst
      ? (selection.beatStart ?? null)
      : positions[slotIdx]!.beatFloat;
    const keyStart = isFirst
      ? selection.measureKeys?.[0]
      : positions[slotIdx]!.measureKey;

    // Right boundary: last stage is pinned to the selection's end (outer-edge
    // pinning); others end just before where the next stage starts.
    let barEnd: number;
    let beatEnd: number | null;
    let keyEnd: string | undefined;
    if (isLast) {
      barEnd = selection.barEnd;
      beatEnd = selection.beatEnd ?? null;
      keyEnd = selection.measureKeys?.[selection.measureKeys.length - 1];
    } else {
      barEnd = nextSlot!.barN;
      beatEnd = nextSlot!.beatFloat;
      keyEnd = nextSlot!.measureKey;
    }

    // Outer-boundary asymmetry (null beatStart on first stage, null beatEnd on
    // last stage) is left as-is so the visual tiling stays contiguous.  The
    // ScoreViewer.tsx payload builder normalises both to null before submission
    // so the backend's ADR-005 validator never sees an asymmetric pair.

    assignments.push({
      stageId: stage.target_id,
      stageName: stage.target_name,
      order: stage.order,
      required: stage.required,
      displayMode: stage.display_mode,
      containmentMode: stage.containment_mode,
      defaultWeight: stage.default_weight,
      bounds: { barStart, beatStart, barEnd, beatEnd, keyStart, keyEnd },
      confirmed: false,
      absent: false,
      orphaned: false,
      error: false,
    });

    slotIdx = endSlotIdx + 1;
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Pre-population (tagging-tool-design.md §4)
// ---------------------------------------------------------------------------

/** Parse the human bar number out of a measure ghost key (m{barN}[-e{n}][#N]). */
function _barNFromKey(key: string): number | null {
  const m = /^m(\d+)/.exec(key);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Return the selection's committed measure-key list when present and fully
 * parseable, else null (callers fall back to bar-number arithmetic).
 */
function _usableKeys(selection: SelectionRange): string[] | null {
  const keys = selection.measureKeys;
  if (!keys || keys.length === 0) return null;
  return keys.every(k => _barNFromKey(k) !== null) ? keys : null;
}

/**
 * Distribute stage brackets proportionally across the main fragment by
 * default_weight at measure-level resolution.
 *
 * Stages are sorted by order ascending. The last stage absorbs any rounding
 * remainder so the rightmost bracket always reaches the selection's end.
 *
 * Distribution units are the selection's effective measure keys when the
 * committed key list is present (§6A.1) — bar-number arithmetic over-counts
 * when @n values repeat inside the range and cannot express the discontiguous
 * effective range across excluded sibling endings (§6A.3). Selections without
 * a key list (restored from stored human coordinates) use the legacy bar
 * arithmetic.
 *
 * Interior boundaries are measure-aligned (null beats), but the two outer edges
 * are pinned to the selection's own endpoints — beats included (I7 outer-edge
 * pinning, as at beat resolution). A measure-granular grid over a beat-precise
 * fragment is normal: the grid only has to be fine enough to seat the stages.
 * Inheriting the measure's edges instead of the fragment's is what made the
 * first and last stage of "m. 8 beat 3 – m. 10 beat 1" cover whole measures and
 * overflow their parent (M7, Component 11 Step 11).
 *
 * Beat-level snapping of the *interior* boundaries is left to the caller when
 * the active grid is at beat or sub-beat resolution.
 */
export function prePopulateStages(
  stages: ContainsStage[],
  selection: SelectionRange,
): StageAssignment[] {
  if (stages.length === 0) return [];

  const sorted = [...stages].sort((a, b) => a.order - b.order);
  const keys = _usableKeys(selection);
  const totalUnits = keys ? keys.length : selection.barEnd - selection.barStart + 1;
  const totalWeight = sorted.reduce((s, st) => s + st.default_weight, 0) || 1;

  const assignments: StageAssignment[] = [];
  let startUnit = 0;

  for (let i = 0; i < sorted.length; i++) {
    const stage = sorted[i]!;
    const isLast = i === sorted.length - 1;

    let endUnit: number; // inclusive unit index of the stage's last measure
    if (isLast) {
      endUnit = totalUnits - 1;
    } else {
      // Minimum 1 unit per stage; reserve at least 1 unit for each remaining stage.
      const remaining = sorted.length - 1 - i; // stages after this one
      const maxEndUnit = totalUnits - 1 - remaining;
      const rawUnits = totalUnits * stage.default_weight / totalWeight;
      const unitCount = Math.max(1, Math.round(rawUnits));
      endUnit = Math.min(startUnit + unitCount - 1, maxEndUnit);
    }

    // I7: the frame's outer edges are the selection's exact endpoints.
    const beatStart = i === 0 ? (selection.beatStart ?? null) : null;
    const beatEnd = isLast ? (selection.beatEnd ?? null) : null;

    const bounds: StageBounds = keys
      ? {
          barStart: _barNFromKey(keys[startUnit]!)!,
          beatStart,
          barEnd: _barNFromKey(keys[endUnit]!)!,
          beatEnd,
          keyStart: keys[startUnit]!,
          keyEnd: keys[endUnit]!,
        }
      : {
          barStart: selection.barStart + startUnit,
          beatStart,
          barEnd: selection.barStart + endUnit,
          beatEnd,
        };

    assignments.push({
      stageId: stage.target_id,
      stageName: stage.target_name,
      order: stage.order,
      required: stage.required,
      displayMode: stage.display_mode,
      containmentMode: stage.containment_mode,
      defaultWeight: stage.default_weight,
      bounds,
      confirmed: false,
      absent: false,
      orphaned: false,
      error: false,
    });

    startUnit = endUnit + 1;
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Absent toggle (tagging-tool-design.md §4 §"Optional stages")
// ---------------------------------------------------------------------------

/**
 * True when a stage's bounds cover a non-empty span of music.
 *
 * Stage bounds are half-open — a stage runs from its start up to, but not
 * including, the next stage's start — and a null beat means the bar's own edge:
 * `beatStart: null` is the bar's first beat, `beatEnd: null` its end. Comparing
 * `(bar, beat)` pairs under that reading is the only way to see an empty span,
 * because bar numbers alone cannot: `m2b(null) .. m2b1` counts as one bar and
 * holds zero beats.
 *
 * Also catches inverted bounds (`barEnd < barStart`), which is the whole-bar
 * form of the same defect.
 */
function stageBoundsHaveExtent(b: StageBounds): boolean {
  const startBar = b.barStart;
  const startBeat = b.beatStart ?? 1; // null start = the bar's first beat
  const endBar = b.barEnd;
  const endBeat = b.beatEnd ?? Number.POSITIVE_INFINITY; // null end = the bar's end

  if (endBar !== startBar) return endBar > startBar;
  return endBeat > startBeat;
}

/**
 * Bars to carve out of a donor of `donorBars` for a stage of `stageWeight`.
 *
 * Clamped so the donor keeps at least one bar. `canDonate` already refuses a
 * donor narrower than two bars, so this is the second line of defence rather
 * than the first — it holds the invariant if a future caller forgets that
 * check. Removing either one lets a one-bar donor give away its only bar and
 * end up inverted (`barEnd === barStart - 1`).
 */
function carveBars(donorBars: number, stageWeight: number, totalWeight: number): number {
  const proportional = Math.max(1, Math.round((donorBars * stageWeight) / totalWeight));
  return Math.min(proportional, donorBars - 1);
}

/**
 * Toggle the absent state of an optional stage.
 *
 * When a stage is marked absent:
 *  - Its bounds are set to null (collapsed).
 *  - In contiguous mode, the nearest active neighbour extends to cover the
 *    absent stage's space: left neighbour takes priority, else right neighbour.
 *    The absorber inherits the vanishing stage's far boundary exactly — bar,
 *    beat float, and measure key — so the shared boundary against the stage
 *    beyond stays a single value and no overlap or gap can appear (§6A.4).
 *
 * When a stage is re-enabled:
 *  - The nearest neighbour gives back proportional space based on default_weight.
 *    The restored stage takes the donor's old outer boundary exactly; only the
 *    newly created boundary between donor and restored stage is measure-aligned.
 *  - The re-enabled stage is marked confirmed so it doesn't immediately limbo.
 *
 * Required stages cannot be toggled absent (guard: returns unchanged).
 */
export function toggleStageAbsent(
  assignments: StageAssignment[],
  stageId: string,
  newAbsent: boolean,
): StageAssignment[] {
  const sorted = [...assignments]
    .filter(a => !a.orphaned)
    .sort((a, b) => a.order - b.order);

  const idx = sorted.findIndex(a => a.stageId === stageId);
  if (idx === -1) return assignments;

  const stage = sorted[idx]!;
  if (stage.required) return assignments;

  if (newAbsent) {
    // Prevent removing the last active stage — no neighbour would absorb the space.
    const activeCount = sorted.filter(a => !a.absent).length;
    if (activeCount <= 1) return assignments;

    // Find nearest active neighbour (left first, then right).
    const prevActive = sorted.slice(0, idx).reverse().find(a => !a.absent);
    const nextActive = sorted.slice(idx + 1).find(a => !a.absent);
    const absentBounds = stage.bounds;

    return assignments.map(a => {
      if (a.stageId === stageId) {
        return { ...a, absent: true, bounds: null };
      }
      if (prevActive && a.stageId === prevActive.stageId && absentBounds && a.bounds) {
        return {
          ...a,
          bounds: {
            ...a.bounds,
            barEnd:  absentBounds.barEnd,
            beatEnd: absentBounds.beatEnd,
            keyEnd:  absentBounds.keyEnd,
          },
        };
      }
      if (!prevActive && nextActive && a.stageId === nextActive.stageId && absentBounds && a.bounds) {
        return {
          ...a,
          bounds: {
            ...a.bounds,
            barStart:  absentBounds.barStart,
            beatStart: absentBounds.beatStart,
            keyStart:  absentBounds.keyStart,
          },
        };
      }
      return a;
    });
  } else {
    // Re-enable: find neighbour that currently owns the absent stage's space.
    const prevActive = sorted.slice(0, idx).reverse().find(a => !a.absent);
    const nextActive = sorted.slice(idx + 1).find(a => !a.absent);

    // A donor can only give space it has: carving one bar out of a one-bar
    // neighbour used to leave that neighbour at barEnd = barStart - 1, an
    // inverted bracket that nothing downstream rejects — not the Pydantic
    // write model, not the sub-part containment check, not a DB constraint.
    // Prefer the nearest neighbour, but fall through to the other side when
    // the nearest is too narrow to split.
    const canDonate = (a: StageAssignment | undefined): boolean =>
      !!a?.bounds && a.bounds.barEnd - a.bounds.barStart + 1 >= 2;

    const donor = canDonate(prevActive)
      ? prevActive
      : canDonate(nextActive)
        ? nextActive
        : undefined;

    /** Restore the stage with no bounds — the caller re-places it (see below). */
    const restoreUnplaced = () =>
      assignments.map(a =>
        a.stageId === stageId
          ? { ...a, absent: false, confirmed: true }
          : a,
      );

    if (!donor || !donor.bounds) return restoreUnplaced();

    const donorBars = donor.bounds.barEnd - donor.bounds.barStart + 1;
    const totalWeight = stage.defaultWeight + donor.defaultWeight || 1;
    const stageBars = carveBars(donorBars, stage.defaultWeight, totalWeight);

    // The restored stage inherits the donor's old outer boundary exactly
    // (bar, beat, key); the newly created shared boundary between donor
    // and restored stage is measure-aligned (§6A.4).
    const restoredBounds: StageBounds = donor === prevActive
      ? {
          barStart: donor.bounds.barEnd - stageBars + 1,
          beatStart: null,
          barEnd: donor.bounds.barEnd,
          beatEnd: donor.bounds.beatEnd,
          keyEnd: donor.bounds.keyEnd,
        }
      : {
          barStart: donor.bounds.barStart,
          beatStart: donor.bounds.beatStart,
          keyStart: donor.bounds.keyStart,
          barEnd: donor.bounds.barStart + stageBars - 1,
          beatEnd: null,
        };

    const newDonorBounds: StageBounds = donor === prevActive
      ? { ...donor.bounds, barEnd: donor.bounds.barEnd - stageBars, beatEnd: null, keyEnd: undefined }
      : { ...donor.bounds, barStart: donor.bounds.barStart + stageBars, beatStart: null, keyStart: undefined };

    // This carve counts whole bars, but stages are laid out on whatever grid
    // the selection needed — often beats. A donor spanning "two bars" may hold
    // only two beats across a barline (m1b3 .. m2b1), and taking a bar from it
    // then hands the restored stage a whole measure and leaves the donor with
    // nothing: m2b1 .. m2b1, zero beats wide, still listed as present. Bar
    // counting cannot see that, so check the actual extents and bail out if
    // either is empty. Restoring unplaced is the honest fallback — the toggle
    // handler re-places the whole wanted set on the correct grid, which is what
    // this situation calls for anyway.
    if (!stageBoundsHaveExtent(restoredBounds) || !stageBoundsHaveExtent(newDonorBounds)) {
      return restoreUnplaced();
    }

    return assignments.map(a => {
      if (a.stageId === stageId) {
        return { ...a, absent: false, bounds: restoredBounds, confirmed: true };
      }
      if (a.stageId === donor.stageId) {
        return { ...a, bounds: newDonorBounds };
      }
      return a;
    });
  }
}

// ---------------------------------------------------------------------------
// stagesComplete check (tagging-tool-design.md §7.5)
// ---------------------------------------------------------------------------

/**
 * True when all stage submission conditions are satisfied:
 *  - All non-absent, non-orphaned stages have bounds set.
 *  - No stage has an error flag set.
 *  - Trivially true when there are no non-orphaned stages (stageless concepts).
 *
 * Pre-populated positions are valid data; the `confirmed` flag (whether the
 * annotator dragged the bracket) is NOT required. See tagging-tool-design.md §7.5.
 */
export function computeStagesComplete(assignments: StageAssignment[]): boolean {
  const active = assignments.filter(a => !a.orphaned);
  if (active.length === 0) return true;

  for (const a of active) {
    if (a.absent) continue;
    if (a.error) return false;
    if (!a.bounds) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Reconciliation helpers
// ---------------------------------------------------------------------------

/**
 * Reconcile assignments when the concept or Type Refinement changes.
 *
 * - Stages whose stageId appears in newStages are kept with their current
 *   spatial positions (metadata updated to reflect new edge properties).
 * - Stages no longer present are marked orphaned.
 * - New stages in newStages with no existing bracket receive proportional
 *   pre-populated defaults (when selection is available).
 *
 * tagging-tool-design.md §6 §"Concept change after stages are committed".
 */
export function reconcileWithNewConcept(
  existing: StageAssignment[],
  newStages: ContainsStage[],
  selection: SelectionRange | null,
): StageAssignment[] {
  const newStageMap = new Map(newStages.map(s => [s.target_id, s]));
  const existingIds = new Set(existing.map(a => a.stageId));

  const updated: StageAssignment[] = existing.map(a => {
    const ns = newStageMap.get(a.stageId);
    if (!ns) return { ...a, orphaned: true };
    return {
      ...a,
      orphaned: false,
      required: ns.required,
      displayMode: ns.display_mode,
      containmentMode: ns.containment_mode,
      order: ns.order,
      defaultWeight: ns.default_weight,
    };
  });

  const brandNew = newStages.filter(s => !existingIds.has(s.target_id));
  if (brandNew.length > 0 && selection) {
    const freshAssignments = prePopulateStages(brandNew, selection);
    return [...updated, ...freshAssignments];
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Stage-card display order (Component 12 Step 18, M9)
// ---------------------------------------------------------------------------

/**
 * Order stage cards for the sidebar list.
 *
 * Placed stages sort by physical position in the score — bar, then beat, then
 * schema order as the tiebreak — which is the rule
 * `tagging-tool-design.md` §"Stage list" fixed in Component 9 G2: the list
 * should read top-to-bottom the way the stages lie in the music.
 *
 * What changed in Step 18 is where an *unplaced* stage goes. Absent stages have
 * no bounds to sort by and used to be grouped after every positioned one, so
 * disabling the second of four stages threw its card to the bottom of the list
 * (M9). Each unplaced stage now keeps its slot in the sequence instead: it is
 * inserted ahead of the first card whose schema order follows its own. For
 * contiguous stages — every stage the corpus defines — position order and
 * schema order coincide, so this only moves the absent cards.
 *
 * Pure and total: every input assignment appears exactly once in the output.
 */
export function orderStageCards(assignments: StageAssignment[]): StageAssignment[] {
  const placed = assignments
    .filter(a => a.bounds)
    .sort((a, b) => {
      const ab = a.bounds!;
      const bb = b.bounds!;
      if (ab.barStart !== bb.barStart) return ab.barStart - bb.barStart;
      const aBeat = ab.beatStart ?? 0;
      const bBeat = bb.beatStart ?? 0;
      if (aBeat !== bBeat) return aBeat - bBeat;
      return a.order - b.order;
    });

  const unplaced = assignments.filter(a => !a.bounds).sort((a, b) => a.order - b.order);

  const out = [...placed];
  for (const stage of unplaced) {
    const at = out.findIndex(a => a.order > stage.order);
    if (at === -1) out.push(stage);
    else out.splice(at, 0, stage);
  }
  return out;
}

/**
 * Build unplaced assignments — one per stage, with no bounds.
 *
 * Used when the committed selection is too short to place the concept's stages
 * even at sub-beat resolution. Returning the stages unplaced rather than
 * returning nothing is what lets the sidebar list them, which is the only place
 * the annotator can mark a stage absent; a notice telling someone to "mark
 * stages absent" over an empty list would be advice they cannot take
 * (Component 12 Step 17).
 *
 * `absent: false` — these stages are wanted, just unplaceable so far.
 * `computeStagesComplete` therefore reports false while any remain, which is
 * correct: the fragment is not ready to submit.
 */
export function buildUnplacedStages(stages: ContainsStage[]): StageAssignment[] {
  return [...stages]
    .sort((a, b) => a.order - b.order)
    .map(stage => ({
      stageId: stage.target_id,
      stageName: stage.target_name,
      order: stage.order,
      required: stage.required,
      displayMode: stage.display_mode,
      containmentMode: stage.containment_mode,
      defaultWeight: stage.default_weight,
      bounds: null,
      confirmed: false,
      absent: false,
      orphaned: false,
      error: false,
    }));
}

/**
 * True when some stage is wanted but has nowhere to sit.
 *
 * "Wanted" means neither absent nor orphaned: the annotator expects a bracket
 * for it. A wanted stage with no bounds is the state `toggleStageAbsent`
 * produces when it restores a stage and no neighbour can spare a bar — correct,
 * since the alternative is inverted geometry, but invisible on its own. The
 * toggle handler tests this to decide whether to re-attempt placement across
 * the whole wanted set and, failing that, to raise the blocked notice
 * (Component 12 Step 17/18).
 */
export function hasUnplacedWantedStage(assignments: StageAssignment[]): boolean {
  return assignments.some(a => !a.absent && !a.orphaned && !a.bounds);
}
