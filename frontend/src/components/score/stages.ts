/**
 * Stage bracket state — pure logic for Component 5 Step 14.
 *
 * StageAssignment tracks the musical-coordinate bounds and status of one
 * stage bracket in the stage bracket track (Layer 4,
 * tagging-tool-design.md §4).
 *
 * Pre-population, stagesComplete, and reconciliation helpers live here so
 * they can be unit-tested without a DOM or React.
 *
 * References: tagging-tool-design.md §4 §6 §7.3, ADR-011 §1 §3 §6.
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
   * Confirmed = the annotator explicitly dragged this bracket from its
   * pre-populated default position. Unconfirmed optional stages are in "limbo"
   * and block submission (tagging-tool-design.md §4 §"Optional stages").
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
}

/**
 * Return the coarsest resolution at which stageCount stages can each occupy
 * at least one grid slot in the selection.
 *
 * Tries Measure → Beat → Sub-beat in order, falling through to 'subbeat'
 * even when all counts are below stageCount. The caller is responsible for
 * detecting and surfacing the blocking case (stageCount exceeds all tiers).
 *
 * beatSlots and subBeatSlots are counts of available ghost positions in the
 * selection at each finer resolution, computed by the caller from the ghost
 * layer. If omitted, those tiers are treated as having zero capacity.
 */
export function chooseStageGrid(
  selection: SelectionRange,
  stageCount: number,
  beatSlots = 0,
  subBeatSlots = 0,
): ResolutionMode {
  if (stageCount <= 0) return 'measure';
  const measureSlots = selection.barEnd - selection.barStart + 1;
  if (measureSlots >= stageCount) return 'measure';
  if (beatSlots >= stageCount) return 'beat';
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

    // Right boundary: last stage is pinned to the selection's end (outer-edge
    // pinning); others end just before where the next stage starts.
    let barEnd: number;
    let beatEnd: number | null;
    if (isLast) {
      barEnd = selection.barEnd;
      beatEnd = selection.beatEnd ?? null;
    } else {
      barEnd = nextSlot!.barN;
      beatEnd = nextSlot!.beatFloat;
    }

    assignments.push({
      stageId: stage.target_id,
      stageName: stage.target_name,
      order: stage.order,
      required: stage.required,
      displayMode: stage.display_mode,
      containmentMode: stage.containment_mode,
      defaultWeight: stage.default_weight,
      bounds: { barStart, beatStart, barEnd, beatEnd },
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

/**
 * Distribute stage brackets proportionally across the main fragment by
 * default_weight at measure-level resolution.
 *
 * Stages are sorted by order ascending. The last stage absorbs any rounding
 * remainder so the rightmost bracket always reaches selection.barEnd.
 *
 * Beat-level snapping is left to the caller when the active grid is at beat
 * or sub-beat resolution — this function always returns null beat coordinates.
 */
export function prePopulateStages(
  stages: ContainsStage[],
  selection: SelectionRange,
): StageAssignment[] {
  if (stages.length === 0) return [];

  const sorted = [...stages].sort((a, b) => a.order - b.order);
  const totalBars = selection.barEnd - selection.barStart + 1;
  const totalWeight = sorted.reduce((s, st) => s + st.default_weight, 0) || 1;

  const assignments: StageAssignment[] = [];
  let currentBar = selection.barStart;

  for (let i = 0; i < sorted.length; i++) {
    const stage = sorted[i]!;
    const isLast = i === sorted.length - 1;

    let barEnd: number;
    if (isLast) {
      barEnd = selection.barEnd;
    } else {
      // Minimum 1 bar per stage; reserve at least 1 bar for each remaining stage.
      const remaining = sorted.length - 1 - i; // stages after this one
      const maxBarEnd = selection.barEnd - remaining;
      const rawBars = totalBars * stage.default_weight / totalWeight;
      const barCount = Math.max(1, Math.round(rawBars));
      barEnd = Math.min(currentBar + barCount - 1, maxBarEnd);
    }

    assignments.push({
      stageId: stage.target_id,
      stageName: stage.target_name,
      order: stage.order,
      required: stage.required,
      displayMode: stage.display_mode,
      containmentMode: stage.containment_mode,
      defaultWeight: stage.default_weight,
      bounds: {
        barStart: currentBar,
        beatStart: null,
        barEnd,
        beatEnd: null,
      },
      confirmed: false,
      absent: false,
      orphaned: false,
      error: false,
    });

    currentBar = barEnd + 1;
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Split handle move (contiguous mode — tagging-tool-design.md §6)
// ---------------------------------------------------------------------------

/**
 * Boundary coordinates for a stage split handle drag result (G4.1).
 *
 * Measure resolution: `barN` is the barEnd of the left stage; `beatFloat` is
 * null. The right stage's barStart = barN + 1, keeping the two stages on
 * separate bars with no gap.
 *
 * Beat / sub-beat resolution: both stages share `barN`; `beatFloat` is the
 * onset at which the split falls. `beatFloat` is the exclusive upper bound
 * for the left stage (beatEnd) and the inclusive lower bound for the right
 * stage (beatStart). The two stages overlap on the same bar number but are
 * distinguished by their beat coordinates.
 */
export interface StageBeatBoundary {
  /** Bar number for the boundary. At measure level: leftStage.barEnd. At beat
   *  level: the shared bar number that both stages reference. */
  barN: number;
  /** Beat float at the split point, or null for a measure-level boundary. */
  beatFloat: number | null;
}

/**
 * Move the shared boundary between the stage at sortedActiveIdx and the next
 * active stage to newBoundary.
 *
 * sortedActiveIdx is the 0-based index into the sorted (by order), non-absent,
 * non-orphaned list of stage assignments. The boundary sits between
 * sortedActiveIdx and sortedActiveIdx + 1.
 *
 * Measure-level boundary (beatFloat === null):
 *  - leftStage.barEnd  = newBoundary.barN;  leftStage.beatEnd  = null.
 *  - rightStage.barStart = newBoundary.barN + 1; rightStage.beatStart = null.
 *  - Clamped to [leftStage.barStart + 1, rightStage.barEnd] so each side
 *    keeps at least 1 bar.
 *
 * Beat / sub-beat boundary (beatFloat !== null):
 *  - Both stages share barN (the split is within a single measure).
 *  - leftStage.barEnd = barN, leftStage.beatEnd = beatFloat.
 *  - rightStage.barStart = barN, rightStage.beatStart = beatFloat.
 *  - barN is clamped to [leftStage.barStart, rightStage.barEnd].
 *
 * Both flanking stages are marked confirmed (explicitly positioned by the
 * annotator). Only contiguous mode is supported in Phase 1.
 */
export function moveSplitHandle(
  assignments: StageAssignment[],
  sortedActiveIdx: number,
  newBoundary: StageBeatBoundary,
): StageAssignment[] {
  const active = assignments
    .filter(a => !a.absent && !a.orphaned)
    .sort((a, b) => a.order - b.order);

  const leftStage = active[sortedActiveIdx];
  const rightStage = active[sortedActiveIdx + 1];

  if (!leftStage || !rightStage) return assignments;
  if (!leftStage.bounds || !rightStage.bounds) return assignments;

  const { barN, beatFloat } = newBoundary;

  if (beatFloat !== null) {
    // Beat / sub-beat boundary: both stages share barN; beatFloat divides them.
    const clampedBarN = Math.max(
      leftStage.bounds.barStart,
      Math.min(rightStage.bounds.barEnd, barN),
    );

    // beatFloat = 1.0 is the very start of a bar (beatToFloat is 1-indexed:
    // beat 0, sub-beat 0 → 1.0). A boundary there gives the left stage
    // beatEnd = 1.0 and no ghosts satisfy beatFloat < 1.0, so resolveSegments
    // falls back to full-measure rendering — both brackets cover the same bar
    // (visual overlap). Convert to a measure-level boundary instead:
    // leftStage.barEnd = clampedBarN − 1, rightStage.barStart = clampedBarN.
    if (beatFloat <= 1.0) {
      const measureBarN = clampedBarN - 1;
      const minMeasureBarN = leftStage.bounds.barStart;     // 1-bar minimum left
      const maxMeasureBarN = rightStage.bounds.barEnd - 1;  // 1-bar minimum right
      if (measureBarN < minMeasureBarN || measureBarN > maxMeasureBarN) return assignments;

      return assignments.map(a => {
        if (a.stageId === leftStage.stageId) {
          return {
            ...a,
            bounds: { ...a.bounds!, barEnd: measureBarN, beatEnd: null },
            confirmed: true,
          };
        }
        if (a.stageId === rightStage.stageId) {
          return {
            ...a,
            bounds: { ...a.bounds!, barStart: measureBarN + 1, beatStart: null },
            confirmed: true,
          };
        }
        return a;
      });
    }

    // Standard beat / sub-beat boundary (beatFloat > 1.0).
    // 1-beat (or 1-sub-beat) minimum: block if the boundary would land at or
    // before leftStage's own start beat within its starting bar.
    // beatStart = null means the stage starts at the bar beginning (beat 1.0).
    const leftBeatStart = leftStage.bounds.beatStart ?? 1.0;
    if (clampedBarN === leftStage.bounds.barStart && beatFloat <= leftBeatStart) {
      return assignments;
    }
    // Same guard for rightStage: block if boundary lands at or after its beat end.
    // null beatEnd means the stage ends at the bar boundary (always safe — skip).
    if (
      clampedBarN === rightStage.bounds.barEnd &&
      rightStage.bounds.beatEnd !== null &&
      beatFloat >= rightStage.bounds.beatEnd
    ) {
      return assignments;
    }

    return assignments.map(a => {
      if (a.stageId === leftStage.stageId) {
        return {
          ...a,
          bounds: { ...a.bounds!, barEnd: clampedBarN, beatEnd: beatFloat },
          confirmed: true,
        };
      }
      if (a.stageId === rightStage.stageId) {
        return {
          ...a,
          bounds: { ...a.bounds!, barStart: clampedBarN, beatStart: beatFloat },
          confirmed: true,
        };
      }
      return a;
    });
  }

  // Measure-level boundary: enforce 1-bar minimum for all stages (required and optional).
  // Sidebar toggle is the only mechanism for marking stages absent.
  const minBarN = leftStage.bounds.barStart;     // barEnd ≥ barStart always
  const maxBarN = rightStage.bounds.barEnd - 1;  // barStart ≤ barEnd always

  // No valid split position (fewer bars than stages need) — leave unchanged.
  if (minBarN > maxBarN) return assignments;

  const clampedBarN = Math.max(minBarN, Math.min(maxBarN, barN));

  return assignments.map(a => {
    if (a.stageId === leftStage.stageId) {
      return {
        ...a,
        bounds: { ...a.bounds!, barEnd: clampedBarN, beatEnd: null },
        confirmed: true,
      };
    }
    if (a.stageId === rightStage.stageId) {
      return {
        ...a,
        bounds: { ...a.bounds!, barStart: clampedBarN + 1, beatStart: null },
        confirmed: true,
      };
    }
    return a;
  });
}

// ---------------------------------------------------------------------------
// Absent toggle (tagging-tool-design.md §4 §"Optional stages")
// ---------------------------------------------------------------------------

/**
 * Toggle the absent state of an optional stage.
 *
 * When a stage is marked absent:
 *  - Its bounds are set to null (collapsed).
 *  - In contiguous mode, the nearest active neighbour extends to cover the
 *    absent stage's space: left neighbour takes priority, else right neighbour.
 *
 * When a stage is re-enabled:
 *  - The nearest neighbour gives back proportional space based on default_weight.
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
        return { ...a, bounds: { ...a.bounds, barEnd: absentBounds.barEnd, beatEnd: null } };
      }
      if (!prevActive && nextActive && a.stageId === nextActive.stageId && absentBounds && a.bounds) {
        return { ...a, bounds: { ...a.bounds, barStart: absentBounds.barStart, beatStart: null } };
      }
      return a;
    });
  } else {
    // Re-enable: find neighbour that currently owns the absent stage's space.
    const prevActive = sorted.slice(0, idx).reverse().find(a => !a.absent);
    const nextActive = sorted.slice(idx + 1).find(a => !a.absent);

    const donor = prevActive ?? nextActive;
    if (!donor) {
      return assignments.map(a =>
        a.stageId === stageId ? { ...a, absent: false, confirmed: true } : a,
      );
    }

    return assignments.map(a => {
      if (a.stageId === stageId) {
        // Restore from donor based on weight proportion.
        if (!donor.bounds) return { ...a, absent: false, confirmed: true };
        const donorBars = donor.bounds.barEnd - donor.bounds.barStart + 1;
        const totalWeight = stage.defaultWeight + donor.defaultWeight || 1;
        const stageBars = Math.max(1, Math.round(donorBars * stage.defaultWeight / totalWeight));

        const restoredBounds: StageBounds = donor === prevActive
          ? {
              barStart: donor.bounds.barEnd - stageBars + 1,
              beatStart: null,
              barEnd: donor.bounds.barEnd,
              beatEnd: null,
            }
          : {
              barStart: donor.bounds.barStart,
              beatStart: null,
              barEnd: donor.bounds.barStart + stageBars - 1,
              beatEnd: null,
            };

        return { ...a, absent: false, bounds: restoredBounds, confirmed: true };
      }

      if (a.stageId === donor.stageId && donor.bounds) {
        const donorBars = donor.bounds.barEnd - donor.bounds.barStart + 1;
        const totalWeight = stage.defaultWeight + donor.defaultWeight || 1;
        const stageBars = Math.max(1, Math.round(donorBars * stage.defaultWeight / totalWeight));

        const newDonorBounds: StageBounds = donor === prevActive
          ? { ...donor.bounds, barEnd: donor.bounds.barEnd - stageBars, beatEnd: null }
          : { ...donor.bounds, barStart: donor.bounds.barStart + stageBars, beatStart: null };

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
 * Reconcile stage assignments after the main bracket selection changes.
 *
 * - The first non-absent active stage auto-extends its left edge to barStart.
 * - The last non-absent active stage auto-extends its right edge to barEnd.
 * - Any other stage that falls outside the new bounds is marked error.
 *
 * tagging-tool-design.md §6 §"Main bracket change after stages are committed".
 */
export function reconcileWithSelection(
  assignments: StageAssignment[],
  selection: SelectionRange,
): StageAssignment[] {
  if (assignments.length === 0) return assignments;

  const active = assignments
    .filter(a => !a.absent && !a.orphaned && a.bounds !== null)
    .sort((a, b) => a.order - b.order);

  const firstId = active[0]?.stageId ?? null;
  const lastId = active[active.length - 1]?.stageId ?? null;

  return assignments.map(a => {
    if (a.absent || a.orphaned || !a.bounds) return a;

    const b = a.bounds;

    if (a.stageId === firstId && b.barStart !== selection.barStart) {
      return { ...a, bounds: { ...b, barStart: selection.barStart, beatStart: null }, error: false };
    }
    if (a.stageId === lastId && b.barEnd !== selection.barEnd) {
      return { ...a, bounds: { ...b, barEnd: selection.barEnd, beatEnd: null }, error: false };
    }

    const outside = b.barStart < selection.barStart || b.barEnd > selection.barEnd;
    return outside ? { ...a, error: true } : { ...a, error: false };
  });
}

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

