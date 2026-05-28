/**
 * Unit tests for components/score/stages.ts — Component 5 Step 14.
 *
 * Verification targets (tagging-tool-design.md §4 §7.5, ADR-011 §1 §6):
 *
 *  Pre-population:
 *    - PAC with four stages pre-populates by weight, fills [barStart, barEnd].
 *    - Equal weights distribute evenly; last stage absorbs remainder.
 *    - Single-stage concept fills the whole selection.
 *    - Zero-stage concept returns empty array.
 *
 *  computeStagesComplete:
 *    - True for empty (stageless concept).
 *    - True when all required have bounds + optional confirmed or absent.
 *    - False when required stage lacks bounds.
 *    - False when optional stage is in limbo (not confirmed, not absent).
 *    - False when any stage has error = true.
 *    - Orphaned stages are ignored.
 *
 *  moveSplitHandle:
 *    - Moves shared boundary; no gap between adjacent stages.
 *    - Clamps to minimum 1-bar width on each side.
 *
 *  toggleStageAbsent (absent=true):
 *    - Stage marked absent; left neighbour extends barEnd.
 *    - If no left neighbour, right neighbour extends barStart.
 *
 *  toggleStageAbsent (absent=false):
 *    - Stage restored; neighbour gives back proportional space.
 *
 *  reconcileWithSelection:
 *    - First stage auto-extends left when bracket expands.
 *    - Last stage auto-extends right when bracket expands.
 *    - Middle stage that falls outside gets error = true.
 *
 *  reconcileWithNewConcept:
 *    - Surviving stages kept; non-matching stages orphaned.
 *    - New stages in newStages receive pre-populated defaults.
 */

import { describe, expect, it } from 'vitest';
import type { ContainsStage } from '../../../services/conceptApi';
import type { SelectionRange } from '../annotator';
import type { StageAssignment } from '../stages';
import {
  computeStagesComplete,
  moveSplitHandle,
  prePopulateStages,
  reconcileWithNewConcept,
  reconcileWithSelection,
  toggleStageAbsent,
} from '../stages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
  id: string,
  order: number,
  weight: number,
  required = true,
): ContainsStage {
  return {
    target_id: id,
    target_name: id,
    order,
    required,
    display_mode: 'stage',
    containment_mode: 'contiguous',
    default_weight: weight,
  };
}

function makeSelection(barStart: number, barEnd: number): SelectionRange {
  return { barStart, barEnd, beatStart: null, beatEnd: null, repeatContext: null };
}

// A pre-populated set for four PAC stages over bars 1-8.
function makePacAssignments(): StageAssignment[] {
  const stages = [
    makeStage('Predominant', 1, 2),
    makeStage('Dominant', 2, 3),
    makeStage('PreTonic', 3, 1),
    makeStage('Tonic', 4, 2),
  ];
  return prePopulateStages(stages, makeSelection(1, 8));
}

// ---------------------------------------------------------------------------
// Pre-population
// ---------------------------------------------------------------------------

describe('prePopulateStages', () => {
  it('returns empty array for zero stages', () => {
    expect(prePopulateStages([], makeSelection(1, 4))).toEqual([]);
  });

  it('single stage fills the whole selection', () => {
    const result = prePopulateStages([makeStage('A', 1, 1)], makeSelection(3, 7));
    expect(result).toHaveLength(1);
    expect(result[0]!.bounds!.barStart).toBe(3);
    expect(result[0]!.bounds!.barEnd).toBe(7);
  });

  it('four equal-weight stages over 8 bars distribute 2 bars each', () => {
    const stages = [
      makeStage('A', 1, 1),
      makeStage('B', 2, 1),
      makeStage('C', 3, 1),
      makeStage('D', 4, 1),
    ];
    const result = prePopulateStages(stages, makeSelection(1, 8));
    expect(result).toHaveLength(4);
    expect(result[0]!.bounds).toMatchObject({ barStart: 1, barEnd: 2 });
    expect(result[1]!.bounds).toMatchObject({ barStart: 3, barEnd: 4 });
    expect(result[2]!.bounds).toMatchObject({ barStart: 5, barEnd: 6 });
    expect(result[3]!.bounds).toMatchObject({ barStart: 7, barEnd: 8 });
  });

  it('last stage absorbs rounding remainder so barEnd = selection.barEnd', () => {
    // 3 stages over 7 bars: weights 1,1,1 → 2+2+3
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1), makeStage('C', 3, 1)];
    const result = prePopulateStages(stages, makeSelection(1, 7));
    expect(result[result.length - 1]!.bounds!.barEnd).toBe(7);
  });

  it('all stages together cover the full selection without gaps or overlaps', () => {
    const result = makePacAssignments();
    const barStart = result[0]!.bounds!.barStart;
    const barEnd = result[result.length - 1]!.bounds!.barEnd;
    expect(barStart).toBe(1);
    expect(barEnd).toBe(8);

    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]!.bounds!.barEnd + 1).toBe(result[i + 1]!.bounds!.barStart);
    }
  });

  it('initialises confirmed=false, absent=false, orphaned=false, error=false', () => {
    const result = prePopulateStages([makeStage('A', 1, 1)], makeSelection(1, 2));
    const a = result[0]!;
    expect(a.confirmed).toBe(false);
    expect(a.absent).toBe(false);
    expect(a.orphaned).toBe(false);
    expect(a.error).toBe(false);
  });

  it('each stage has null beatStart/beatEnd (measure-level pre-population)', () => {
    const result = makePacAssignments();
    for (const a of result) {
      expect(a.bounds!.beatStart).toBeNull();
      expect(a.bounds!.beatEnd).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// computeStagesComplete
// ---------------------------------------------------------------------------

describe('computeStagesComplete', () => {
  it('true for empty assignments (stageless concept)', () => {
    expect(computeStagesComplete([])).toBe(true);
  });

  it('true when all required stages have bounds (PAC — all required)', () => {
    const assignments = makePacAssignments();
    // All PAC stages are required and pre-populated with bounds → complete.
    expect(assignments.every(a => a.required)).toBe(true);
    expect(computeStagesComplete(assignments)).toBe(true);
  });

  it('false when a required stage lacks bounds', () => {
    const assignments = makePacAssignments();
    const broken = assignments.map(a =>
      a.order === 1 ? { ...a, bounds: null } : a,
    );
    expect(computeStagesComplete(broken)).toBe(false);
  });

  it('false when optional stage is in limbo (not confirmed, not absent)', () => {
    const stage = makeStage('Opt', 1, 1, /* required= */ false);
    const result = prePopulateStages([stage], makeSelection(1, 4));
    // Default: confirmed=false, absent=false → limbo.
    expect(computeStagesComplete(result)).toBe(false);
  });

  it('true when optional stage is confirmed', () => {
    const stage = makeStage('Opt', 1, 1, false);
    const result = prePopulateStages([stage], makeSelection(1, 4));
    const confirmed = result.map(a => ({ ...a, confirmed: true }));
    expect(computeStagesComplete(confirmed)).toBe(true);
  });

  it('true when optional stage is absent', () => {
    const stage = makeStage('Opt', 1, 1, false);
    const result = prePopulateStages([stage], makeSelection(1, 4));
    const absent = result.map(a => ({ ...a, absent: true, bounds: null }));
    expect(computeStagesComplete(absent)).toBe(true);
  });

  it('false when any stage has error=true', () => {
    const assignments = makePacAssignments();
    const errored = assignments.map(a =>
      a.order === 2 ? { ...a, error: true } : a,
    );
    expect(computeStagesComplete(errored)).toBe(false);
  });

  it('orphaned stages are ignored', () => {
    const assignments = makePacAssignments();
    const withOrphan = assignments.map(a =>
      a.order === 3 ? { ...a, orphaned: true, bounds: null } : a,
    );
    // Remaining non-orphaned required stages all have bounds → true.
    expect(computeStagesComplete(withOrphan)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// moveSplitHandle
// ---------------------------------------------------------------------------

describe('moveSplitHandle', () => {
  it('moves shared boundary so left stage ends at newBarN, right starts at newBarN+1', () => {
    const assignments = makePacAssignments();
    // Sorted active: [Predominant(1-2), Dominant(3-4), PreTonic(5-5), Tonic(6-8)]
    // Move boundary at sortedIdx=0 (between Predominant and Dominant) to barN=3
    // → Predominant ends at 3, Dominant starts at 4.
    const updated = moveSplitHandle(assignments, 0, 3);
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    expect(predominant.bounds!.barEnd).toBe(3);
    expect(dominant.bounds!.barStart).toBe(4);
    // No gap: barEnd + 1 === barStart.
    expect(predominant.bounds!.barEnd + 1).toBe(dominant.bounds!.barStart);
  });

  it('both flanking stages are marked confirmed', () => {
    const assignments = makePacAssignments();
    const updated = moveSplitHandle(assignments, 1, 4);
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    const preTonic = updated.find(a => a.stageId === 'PreTonic')!;
    expect(dominant.confirmed).toBe(true);
    expect(preTonic.confirmed).toBe(true);
  });

  it('clamps to minimum 1-bar width on the left stage', () => {
    const assignments = makePacAssignments();
    // Predominant starts at bar 1 — cannot move handle below bar 2.
    const updated = moveSplitHandle(assignments, 0, 0); // newBarN=0 → clamps to 1
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    expect(predominant.bounds!.barEnd).toBeGreaterThanOrEqual(1);
  });

  it('clamps to minimum 1-bar width on the right stage', () => {
    const assignments = makePacAssignments();
    // sortedIdx=0 boundary: Predominant(1-2) and Dominant(3-4).
    // Moving to barN=4 = Dominant's barEnd → Dominant would be 0 bars wide.
    // moveSplitHandle treats newBoundaryBarN as the barEnd for left stage.
    // maxBarN = rightStage.bounds.barEnd = 4; clamp to maxBarN = 4 means
    // right stage [5..4] which is invalid → actual max must be barEnd-1=3.
    const updated = moveSplitHandle(assignments, 0, 4);
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    expect(dominant.bounds!.barStart).toBeLessThanOrEqual(dominant.bounds!.barEnd);
  });

  it('returns unchanged assignments for out-of-range sortedIdx', () => {
    const assignments = makePacAssignments();
    const updated = moveSplitHandle(assignments, 99, 3);
    expect(updated).toEqual(assignments);
  });
});

// ---------------------------------------------------------------------------
// toggleStageAbsent
// ---------------------------------------------------------------------------

describe('toggleStageAbsent', () => {
  function makeOptAssignments() {
    const stages = [
      makeStage('A', 1, 2, true),
      makeStage('B', 2, 1, false),  // optional
      makeStage('C', 3, 2, true),
    ];
    return prePopulateStages(stages, makeSelection(1, 10));
  }

  it('marks stage absent and gives space to left neighbour', () => {
    const assignments = makeOptAssignments();
    const bOriginalEnd = assignments.find(a => a.stageId === 'B')!.bounds!.barEnd;
    const updated = toggleStageAbsent(assignments, 'B', true);
    const b = updated.find(a => a.stageId === 'B')!;
    const a = updated.find(a => a.stageId === 'A')!;
    expect(b.absent).toBe(true);
    expect(b.bounds).toBeNull();
    // A extends to cover B's range.
    expect(a.bounds!.barEnd).toBe(bOriginalEnd);
  });

  it('gives space to right neighbour when there is no left neighbour', () => {
    const stages = [
      makeStage('First', 1, 1, false), // optional, no left neighbour
      makeStage('Second', 2, 2, true),
    ];
    const assignments = prePopulateStages(stages, makeSelection(1, 6));
    const firstBarStart = assignments.find(a => a.stageId === 'First')!.bounds!.barStart;
    const updated = toggleStageAbsent(assignments, 'First', true);
    const second = updated.find(a => a.stageId === 'Second')!;
    expect(second.bounds!.barStart).toBe(firstBarStart);
  });

  it('does not toggle required stages', () => {
    const assignments = makeOptAssignments();
    const updated = toggleStageAbsent(assignments, 'A', true);
    const a = updated.find(a => a.stageId === 'A')!;
    expect(a.absent).toBe(false);
  });

  it('restores stage and gives back proportional space from neighbour', () => {
    const assignments = makeOptAssignments();
    const absent = toggleStageAbsent(assignments, 'B', true);
    const restored = toggleStageAbsent(absent, 'B', false);
    const b = restored.find(a => a.stageId === 'B')!;
    expect(b.absent).toBe(false);
    expect(b.bounds).not.toBeNull();
    expect(b.confirmed).toBe(true);
    // After restore, A and B should not overlap.
    const a = restored.find(a => a.stageId === 'A')!;
    expect(a.bounds!.barEnd).toBeLessThan(b.bounds!.barStart);
  });
});

// ---------------------------------------------------------------------------
// reconcileWithSelection
// ---------------------------------------------------------------------------

describe('reconcileWithSelection', () => {
  it('first stage auto-extends left when bracket expands', () => {
    const assignments = makePacAssignments();
    // Original barStart=1; expand to barStart=0.
    const expanded = reconcileWithSelection(assignments, makeSelection(0, 8));
    const first = expanded.find(a => a.order === 1)!;
    expect(first.bounds!.barStart).toBe(0);
    expect(first.error).toBe(false);
  });

  it('last stage auto-extends right when bracket expands', () => {
    const assignments = makePacAssignments();
    const expanded = reconcileWithSelection(assignments, makeSelection(1, 12));
    const last = expanded.find(a => a.order === 4)!;
    expect(last.bounds!.barEnd).toBe(12);
    expect(last.error).toBe(false);
  });

  it('middle stage outside contracted bracket gets error=true', () => {
    const stages = [
      makeStage('A', 1, 1),
      makeStage('B', 2, 1),
      makeStage('C', 3, 1),
    ];
    const original = prePopulateStages(stages, makeSelection(1, 9));
    // Contract to only bars 1-3; B (4-6) and C (7-9) fall outside.
    const contracted = reconcileWithSelection(original, makeSelection(1, 3));
    // B is a middle stage → error.
    const b = contracted.find(a => a.stageId === 'B')!;
    expect(b.error).toBe(true);
  });

  it('clears error=true when brackets are re-contained', () => {
    const assignments = makePacAssignments().map(a =>
      a.order === 2 ? { ...a, error: true } : a,
    );
    const cleared = reconcileWithSelection(assignments, makeSelection(1, 8));
    const dominant = cleared.find(a => a.order === 2)!;
    expect(dominant.error).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileWithNewConcept
// ---------------------------------------------------------------------------

describe('reconcileWithNewConcept', () => {
  it('keeps stages whose stageId is still in the new concept', () => {
    const assignments = makePacAssignments();
    const newStages = [
      makeStage('Predominant', 1, 2),
      makeStage('Dominant', 2, 3),
      // PreTonic and Tonic removed
    ];
    const reconciled = reconcileWithNewConcept(assignments, newStages, makeSelection(1, 8));
    const predominant = reconciled.find(a => a.stageId === 'Predominant')!;
    expect(predominant.orphaned).toBe(false);
    expect(predominant.bounds).not.toBeNull(); // preserved at original position
  });

  it('marks stages whose stageId is no longer in the concept as orphaned', () => {
    const assignments = makePacAssignments();
    const newStages = [makeStage('Predominant', 1, 2), makeStage('Dominant', 2, 3)];
    const reconciled = reconcileWithNewConcept(assignments, newStages, makeSelection(1, 8));
    const preTonic = reconciled.find(a => a.stageId === 'PreTonic')!;
    const tonic = reconciled.find(a => a.stageId === 'Tonic')!;
    expect(preTonic.orphaned).toBe(true);
    expect(tonic.orphaned).toBe(true);
  });

  it('pre-populates new stages not in existing assignments', () => {
    const assignments = makePacAssignments();
    const newStages = [
      makeStage('Predominant', 1, 2),
      makeStage('Dominant', 2, 3),
      makeStage('PreTonic', 3, 1),
      makeStage('Tonic', 4, 2),
      makeStage('NewStage', 5, 1),  // brand new
    ];
    const reconciled = reconcileWithNewConcept(assignments, newStages, makeSelection(1, 8));
    const newStage = reconciled.find(a => a.stageId === 'NewStage')!;
    expect(newStage).toBeDefined();
    expect(newStage.orphaned).toBe(false);
    expect(newStage.bounds).not.toBeNull();
  });

  it('does not pre-populate when selection is null', () => {
    const assignments = makePacAssignments();
    const newStages = [makeStage('BrandNew', 1, 1)];
    const reconciled = reconcileWithNewConcept(assignments, newStages, null);
    const brandNew = reconciled.find(a => a.stageId === 'BrandNew');
    expect(brandNew).toBeUndefined();
  });
});
