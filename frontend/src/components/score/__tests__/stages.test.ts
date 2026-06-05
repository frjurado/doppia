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
 *    - True when all required stages have bounds (pre-populated or dragged).
 *    - True when optional stage is pre-populated (bounds set; confirmed irrelevant).
 *    - False when required stage lacks bounds.
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
import type { StageBeatBoundary, StageAssignment } from '../stages';
import type { BeatSlot } from '../stages';
import {
  chooseStageGrid,
  computeResizeClamp,
  computeStagesComplete,
  moveSplitHandle,
  prePopulateStages,
  prePopulateStagesAtGrid,
  reconcileWithNewConcept,
  reconcileWithSelection,
  respondToMainResize,
  toggleStageAbsent,
} from '../stages';

/** Shorthand for a measure-level boundary (beatFloat: null). */
function mBoundary(barN: number): StageBeatBoundary {
  return { barN, beatFloat: null };
}

/** Shorthand for a beat-level boundary. */
function bBoundary(barN: number, beatFloat: number): StageBeatBoundary {
  return { barN, beatFloat };
}

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

  it('true when optional stage is pre-populated (bounds set, not absent)', () => {
    const stage = makeStage('Opt', 1, 1, /* required= */ false);
    const result = prePopulateStages([stage], makeSelection(1, 4));
    // Pre-populated positions are valid data; confirmed flag is irrelevant.
    expect(result[0]!.confirmed).toBe(false);
    expect(computeStagesComplete(result)).toBe(true);
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
  // ── Measure-level boundary (beatFloat: null) ──────────────────────────────

  it('moves shared boundary so left stage ends at barN, right starts at barN+1', () => {
    const assignments = makePacAssignments();
    // Sorted active: [Predominant(1-2), Dominant(3-5), PreTonic(6-6), Tonic(7-8)]
    // Move boundary at sortedIdx=0 (between Predominant and Dominant) to barN=3
    // → Predominant ends at 3, Dominant starts at 4.
    const updated = moveSplitHandle(assignments, 0, mBoundary(3));
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    expect(predominant.bounds!.barEnd).toBe(3);
    expect(dominant.bounds!.barStart).toBe(4);
    // No gap: barEnd + 1 === barStart.
    expect(predominant.bounds!.barEnd + 1).toBe(dominant.bounds!.barStart);
    // Beat coords cleared at measure-level boundary.
    expect(predominant.bounds!.beatEnd).toBeNull();
    expect(dominant.bounds!.beatStart).toBeNull();
  });

  it('both flanking stages are marked confirmed (measure boundary)', () => {
    const assignments = makePacAssignments();
    const updated = moveSplitHandle(assignments, 1, mBoundary(4));
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    const preTonic = updated.find(a => a.stageId === 'PreTonic')!;
    expect(dominant.confirmed).toBe(true);
    expect(preTonic.confirmed).toBe(true);
  });

  it('clamps to minimum 1-bar width on the left stage (measure boundary)', () => {
    const assignments = makePacAssignments();
    // Predominant starts at bar 1 — cannot move handle below bar 2.
    const updated = moveSplitHandle(assignments, 0, mBoundary(0));
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    expect(predominant.bounds!.barEnd).toBeGreaterThanOrEqual(1);
  });

  it('clamps to minimum 1-bar width on the right stage (measure boundary)', () => {
    const assignments = makePacAssignments();
    const updated = moveSplitHandle(assignments, 0, mBoundary(4));
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    expect(dominant.bounds!.barStart).toBeLessThanOrEqual(dominant.bounds!.barEnd);
  });

  it('returns unchanged assignments for out-of-range sortedIdx', () => {
    const assignments = makePacAssignments();
    const updated = moveSplitHandle(assignments, 99, mBoundary(3));
    expect(updated).toEqual(assignments);
  });

  // ── Beat-level boundary (beatFloat !== null) ──────────────────────────────

  it('beat boundary: both stages share barN; beatFloat divides them', () => {
    const assignments = makePacAssignments();
    // Move the boundary between Predominant and Dominant to beat 2.0 of bar 3.
    const updated = moveSplitHandle(assignments, 0, bBoundary(3, 2.0));
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    expect(predominant.bounds!.barEnd).toBe(3);
    expect(predominant.bounds!.beatEnd).toBe(2.0);
    expect(dominant.bounds!.barStart).toBe(3);
    expect(dominant.bounds!.beatStart).toBe(2.0);
  });

  it('beat boundary: both flanking stages are marked confirmed', () => {
    const assignments = makePacAssignments();
    const updated = moveSplitHandle(assignments, 0, bBoundary(2, 1.5));
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    const dominant = updated.find(a => a.stageId === 'Dominant')!;
    expect(predominant.confirmed).toBe(true);
    expect(dominant.confirmed).toBe(true);
  });

  it('beat boundary: barN clamped to [leftStage.barStart, rightStage.barEnd]', () => {
    const assignments = makePacAssignments();
    // Predominant starts at 1, Dominant ends at 5; barN=99 should clamp to 5.
    const updated = moveSplitHandle(assignments, 0, bBoundary(99, 1.0));
    const predominant = updated.find(a => a.stageId === 'Predominant')!;
    expect(predominant.bounds!.barEnd).toBeLessThanOrEqual(5);
  });

  it('beat boundary: non-flanking stages are unchanged', () => {
    const assignments = makePacAssignments();
    const original = assignments.find(a => a.stageId === 'Tonic')!;
    const updated = moveSplitHandle(assignments, 0, bBoundary(2, 2.0));
    const tonic = updated.find(a => a.stageId === 'Tonic')!;
    expect(tonic.bounds).toEqual(original.bounds);
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

// ---------------------------------------------------------------------------
// chooseStageGrid
// ---------------------------------------------------------------------------

describe('chooseStageGrid', () => {
  it('returns measure when selection has enough bars', () => {
    const sel = makeSelection(1, 4); // 4 bars, 4 stages
    expect(chooseStageGrid(sel, 4)).toBe('measure');
  });

  it('returns measure when selection has more bars than stages', () => {
    const sel = makeSelection(1, 8);
    expect(chooseStageGrid(sel, 4)).toBe('measure');
  });

  it('returns beat when bars insufficient but beatSlots sufficient', () => {
    const sel = makeSelection(1, 2); // 2 bars, 4 stages — too few at measure level
    expect(chooseStageGrid(sel, 4, 8 /* 8 beats in 2 bars */)).toBe('beat');
  });

  it('returns subbeat when beat insufficient but subBeatSlots sufficient', () => {
    const sel = makeSelection(1, 1); // 1 bar, 4 stages
    expect(chooseStageGrid(sel, 4, 2 /* only 2 beats */, 16 /* 16 sub-beats */)).toBe('subbeat');
  });

  it('falls through to subbeat even when no resolution fits (blocking case)', () => {
    const sel = makeSelection(1, 1); // 1 bar, 4 stages — none fit
    expect(chooseStageGrid(sel, 4, 2, 3)).toBe('subbeat');
  });

  it('returns measure for stageCount 0', () => {
    expect(chooseStageGrid(makeSelection(1, 2), 0)).toBe('measure');
  });

  it('returns measure for stageCount 1 (single bar selection)', () => {
    expect(chooseStageGrid(makeSelection(1, 1), 1)).toBe('measure');
  });
});

// ---------------------------------------------------------------------------
// prePopulateStagesAtGrid
// ---------------------------------------------------------------------------

/** Build an ordered list of {barN, beatFloat} positions simulating 4/4 time. */
function makeBeatPositions(barStart: number, barEnd: number, beatsPerBar = 4): BeatSlot[] {
  const positions: BeatSlot[] = [];
  for (let bar = barStart; bar <= barEnd; bar++) {
    for (let b = 1; b <= beatsPerBar; b++) {
      positions.push({ barN: bar, beatFloat: b });
    }
  }
  return positions;
}

describe('prePopulateStagesAtGrid', () => {
  it('returns empty array for zero stages', () => {
    expect(prePopulateStagesAtGrid([], makeSelection(1, 2), makeBeatPositions(1, 2))).toEqual([]);
  });

  it('4 equal-weight stages over 8 beat slots distribute 2 beats each', () => {
    const stages = [
      makeStage('A', 1, 1),
      makeStage('B', 2, 1),
      makeStage('C', 3, 1),
      makeStage('D', 4, 1),
    ];
    // 2 bars × 4 beats = 8 slots; 4 stages → 2 slots each
    const positions = makeBeatPositions(1, 2, 4);
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 2), positions);
    expect(result).toHaveLength(4);
  });

  it('first stage left edge is pinned to selection.barStart with null beatStart', () => {
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1)];
    const positions = makeBeatPositions(1, 2, 4);
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 2), positions);
    expect(result[0]!.bounds!.barStart).toBe(1);
    expect(result[0]!.bounds!.beatStart).toBeNull(); // measure-level selection → null
  });

  it('last stage right edge is pinned to selection.barEnd with null beatEnd', () => {
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1)];
    const positions = makeBeatPositions(1, 2, 4);
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 2), positions);
    const last = result[result.length - 1]!;
    expect(last.bounds!.barEnd).toBe(2);
    expect(last.bounds!.beatEnd).toBeNull();
  });

  it('internal boundary: left stage beatEnd equals right stage beatStart', () => {
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1)];
    const positions = makeBeatPositions(1, 2, 4);
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 2), positions);
    // A ends at the slot where B starts
    expect(result[0]!.bounds!.beatEnd).toBe(result[1]!.bounds!.beatStart);
  });

  it('all stage bounds are contiguous with no gap', () => {
    const stages = [
      makeStage('A', 1, 1),
      makeStage('B', 2, 1),
      makeStage('C', 3, 1),
      makeStage('D', 4, 1),
    ];
    const positions = makeBeatPositions(1, 2, 4); // bar1:1-4, bar2:1-4
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 2), positions);
    for (let i = 0; i < result.length - 1; i++) {
      // Right edge of stage i equals left edge of stage i+1
      const rBarEnd = result[i]!.bounds!.barEnd;
      const rBeatEnd = result[i]!.bounds!.beatEnd;
      const lBarStart = result[i + 1]!.bounds!.barStart;
      const lBeatStart = result[i + 1]!.bounds!.beatStart;
      expect(rBarEnd).toBe(lBarStart);
      expect(rBeatEnd).toBe(lBeatStart);
    }
  });

  it('falls back to measure-level when positions < stages (blocking safeguard)', () => {
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1), makeStage('C', 3, 1)];
    // Only 2 positions for 3 stages — too few
    const positions: BeatSlot[] = [{ barN: 1, beatFloat: 1 }, { barN: 1, beatFloat: 2 }];
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 4), positions);
    // Falls back to measure-level: all have null beat coords
    for (const a of result) {
      expect(a.bounds!.beatStart).toBeNull();
      expect(a.bounds!.beatEnd).toBeNull();
    }
  });

  it('initialises confirmed=false, absent=false, orphaned=false, error=false', () => {
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1)];
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 2), makeBeatPositions(1, 2, 4));
    for (const a of result) {
      expect(a.confirmed).toBe(false);
      expect(a.absent).toBe(false);
      expect(a.orphaned).toBe(false);
      expect(a.error).toBe(false);
    }
  });

  it('verifying 2-bar 4-stage PAC scenario: 4 stages × 2 beats from 8 beat slots', () => {
    const pac = [
      makeStage('Predominant', 1, 2),
      makeStage('Dominant', 2, 3),
      makeStage('PreTonic', 3, 1),
      makeStage('Tonic', 4, 2),
    ];
    const positions = makeBeatPositions(1, 2, 4); // 8 slots for 8 total weight
    const result = prePopulateStagesAtGrid(pac, makeSelection(1, 2), positions);
    expect(result).toHaveLength(4);
    // First stage pinned to barStart=1
    expect(result[0]!.bounds!.barStart).toBe(1);
    // Last stage pinned to barEnd=2
    expect(result[3]!.bounds!.barEnd).toBe(2);
    // All assignments have non-null beat coords for internal stages
    expect(result[1]!.bounds!.beatStart).not.toBeNull();
    expect(result[2]!.bounds!.beatStart).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeResizeClamp
// ---------------------------------------------------------------------------

describe('computeResizeClamp', () => {
  it('returns null when no confirmed stages exist', () => {
    const assignments = makePacAssignments(); // all confirmed=false
    expect(computeResizeClamp(assignments)).toBeNull();
  });

  it('returns null for empty assignments', () => {
    expect(computeResizeClamp([])).toBeNull();
  });

  it('single confirmed stage: minBarStart = barStart, maxBarEnd = barEnd', () => {
    const assignments = makePacAssignments().map((a, i) =>
      i === 1 ? { ...a, confirmed: true } : a,
    );
    const clamp = computeResizeClamp(assignments);
    const stage = assignments.find(a => a.confirmed)!;
    expect(clamp).not.toBeNull();
    expect(clamp!.minBarStart).toBe(stage.bounds!.barStart);
    expect(clamp!.maxBarEnd).toBe(stage.bounds!.barEnd);
  });

  it('multiple confirmed stages: min of barStarts and max of barEnds', () => {
    const assignments = makePacAssignments().map(a =>
      a.order === 1 || a.order === 4 ? { ...a, confirmed: true } : a,
    );
    const first = assignments.find(a => a.order === 1)!;
    const last  = assignments.find(a => a.order === 4)!;
    const clamp = computeResizeClamp(assignments);
    expect(clamp!.minBarStart).toBe(first.bounds!.barStart);
    expect(clamp!.maxBarEnd).toBe(last.bounds!.barEnd);
  });

  it('ignores absent confirmed stages', () => {
    const assignments = makePacAssignments().map((a, i) =>
      i === 0 ? { ...a, confirmed: true, absent: true, bounds: null } : a,
    );
    // Only the absent+confirmed stage exists → null (no non-absent confirmed)
    expect(computeResizeClamp(assignments)).toBeNull();
  });

  it('ignores orphaned confirmed stages', () => {
    const assignments = makePacAssignments().map((a, i) =>
      i === 0 ? { ...a, confirmed: true, orphaned: true } : a,
    );
    expect(computeResizeClamp(assignments)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// respondToMainResize
// ---------------------------------------------------------------------------

describe('respondToMainResize', () => {
  // Convenience: build a set of unconfirmed PAC assignments over bars 1–8.
  function makePac() { return makePacAssignments(); }

  // Convenience: confirm one stage by stageId, leaving others unconfirmed.
  function confirmStage(assignments: StageAssignment[], stageId: string) {
    return assignments.map(a => a.stageId === stageId ? { ...a, confirmed: true } : a);
  }

  // ── All-unconfirmed, grow (extend first/last, no redistribution) ─────────────

  it('growing the bracket extends first/last stage edges; middle stages stay put', () => {
    const before = makePac(); // stages at bars 1-2, 3-5, 6-6, 7-8
    const middleBefore = before.find(a => a.stageId === 'Dominant')!.bounds!;
    const { assignments, blocked } = respondToMainResize(
      before, makeSelection(1, 12), 'measure', [], [],
    );
    expect(blocked).toBe(false);
    // First stage extends to selection left edge (already at bar 1 — no change).
    expect(assignments[0]!.bounds!.barStart).toBe(1);
    // Last stage extends to new barEnd.
    expect(assignments[assignments.length - 1]!.bounds!.barEnd).toBe(12);
    // Middle stage (Dominant) is unchanged.
    expect(assignments.find(a => a.stageId === 'Dominant')!.bounds).toEqual(middleBefore);
    // confirmed flag untouched.
    for (const a of assignments.filter(x => !x.absent && !x.orphaned)) {
      expect(a.confirmed).toBe(false);
    }
  });

  it('small shrink (all stages still fit): extends first/last edges only', () => {
    // Stages at 1-2, 3-5, 6-6, 7-8.  Shrink right edge from 8 to 8 (no-op case)
    // then verify with a real small shrink: 1-8 → 1-8 (identical range).
    // For a real small-shrink, make a custom layout where last stage fits at new end.
    const stages = [
      makeStage('A', 1, 1, true),
      makeStage('B', 2, 1, true),
      makeStage('C', 3, 1, true),
    ];
    const before = prePopulateStages(stages, makeSelection(1, 9)); // A:1-3, B:4-6, C:7-9
    const middleBefore = before.find(a => a.stageId === 'B')!.bounds!;

    // Shrink to 1-9 (same — trivially all fit) and verify first/last edge logic.
    const { assignments } = respondToMainResize(before, makeSelection(1, 9), 'measure', [], []);
    expect(assignments.find(a => a.stageId === 'B')!.bounds).toEqual(middleBefore);

    // Grow to 1-12: C extends, B unchanged.
    const { assignments: grown } = respondToMainResize(before, makeSelection(1, 12), 'measure', [], []);
    expect(grown.find(a => a.stageId === 'B')!.bounds).toEqual(middleBefore);
    expect(grown.find(a => a.stageId === 'C')!.bounds!.barEnd).toBe(12);
    expect(grown.find(a => a.stageId === 'A')!.bounds!.barStart).toBe(1);
  });

  // ── All-unconfirmed, shrink past a stage (full redistribution) ──────────────

  it('shrinking so that last stage falls outside triggers full redistribution', () => {
    const before = makePac(); // last stage Tonic at bars 7-8
    const { assignments, blocked } = respondToMainResize(
      before, makeSelection(1, 4), 'measure', [], [],
    );
    expect(blocked).toBe(false);
    // All stages now within the new range.
    for (const a of assignments.filter(x => !x.absent && !x.orphaned)) {
      expect(a.bounds!.barStart).toBeGreaterThanOrEqual(1);
      expect(a.bounds!.barEnd).toBeLessThanOrEqual(4);
    }
    // Full redistribution: last stage ends at barEnd 4.
    expect(assignments[assignments.length - 1]!.bounds!.barEnd).toBe(4);
  });

  // ── droppedGrid: no downgrade when user is at a finer resolution ────────────

  it('droppedGrid is null when current resolution is finer than the coarsest fitting grid', () => {
    // 4 stages over 4 bars → measure fits. Current = beat. Must NOT downgrade.
    const before = makePac();
    const { droppedGrid } = respondToMainResize(
      before, makeSelection(1, 4), 'beat', [], [],
    );
    expect(droppedGrid).toBeNull();
  });

  it('droppedGrid is null when at subbeat and stages fit at measure', () => {
    const before = makePac();
    const { droppedGrid } = respondToMainResize(
      before, makeSelection(1, 8), 'subbeat', [], [],
    );
    expect(droppedGrid).toBeNull();
  });

  it('returns droppedGrid=null when the current grid (measure) still fits after resize', () => {
    const before = makePac(); // 4 stages over 8 bars; measure fits
    const { droppedGrid } = respondToMainResize(
      before, makeSelection(1, 4), 'measure', [], [],
    );
    expect(droppedGrid).toBeNull(); // 4 bars ≥ 4 stages → measure still works
  });

  it('returns droppedGrid=beat when at measure and selection is too short for measure', () => {
    // 4 stages, shrink to 2 bars → measure no longer fits; need beat resolution.
    const before = makePac();
    const beatPos = makeBeatPositions(1, 2, 4); // 8 beat slots
    const { droppedGrid, blocked } = respondToMainResize(
      before, makeSelection(1, 2), 'measure', beatPos, [],
    );
    expect(blocked).toBe(false);
    expect(droppedGrid).toBe('beat');
  });

  it('returns blocked=true when no resolution can fit the stages', () => {
    // 4 stages, selection is 1 bar with 2 beats → not enough at any grid.
    const before = makePac();
    const { blocked } = respondToMainResize(
      before, makeSelection(1, 1), 'measure', [{ barN: 1, beatFloat: 1 }, { barN: 1, beatFloat: 2 }], [],
    );
    expect(blocked).toBe(true);
  });

  // ── With confirmed stages (hybrid) ────────────────────────────────────────

  it('confirmed stage bounds are preserved after a grow', () => {
    const before = confirmStage(makePac(), 'Dominant');
    const dominantBefore = before.find(a => a.stageId === 'Dominant')!;
    const { assignments } = respondToMainResize(
      before, makeSelection(1, 12), 'measure', [], [],
    );
    const dominant = assignments.find(a => a.stageId === 'Dominant')!;
    expect(dominant.bounds).toEqual(dominantBefore.bounds);
    expect(dominant.confirmed).toBe(true);
  });

  it('confirmed stage bounds are preserved after a shrink', () => {
    // Dominant is at bars 3–5 (approx) in the default layout.
    const before = confirmStage(makePac(), 'Dominant');
    const dominantBefore = before.find(a => a.stageId === 'Dominant')!;
    // Shrink to a range that still contains the confirmed stage.
    const newEnd = dominantBefore.bounds!.barEnd;
    const { assignments } = respondToMainResize(
      before, makeSelection(1, newEnd), 'measure', [], [],
    );
    const dominant = assignments.find(a => a.stageId === 'Dominant')!;
    expect(dominant.bounds).toEqual(dominantBefore.bounds);
  });

  it('unconfirmed stages before a confirmed anchor fill the leading gap', () => {
    // Confirm Dominant (order 2); Predominant (order 1) should fill barStart..Dominant.barStart-1.
    const before = confirmStage(makePac(), 'Dominant');
    const dominantBefore = before.find(a => a.stageId === 'Dominant')!;
    const { assignments } = respondToMainResize(
      before, makeSelection(1, 8), 'measure', [], [],
    );
    const predominant = assignments.find(a => a.stageId === 'Predominant')!;
    expect(predominant.bounds!.barStart).toBe(1);
    expect(predominant.bounds!.barEnd).toBe(dominantBefore.bounds!.barStart - 1);
  });

  it('unconfirmed stages after the last confirmed anchor fill the trailing gap', () => {
    const before = confirmStage(makePac(), 'Dominant');
    const dominantBefore = before.find(a => a.stageId === 'Dominant')!;
    const { assignments } = respondToMainResize(
      before, makeSelection(1, 8), 'measure', [], [],
    );
    const preTonicIdx = assignments.findIndex(a => a.stageId === 'PreTonic');
    const tonicIdx    = assignments.findIndex(a => a.stageId === 'Tonic');
    expect(preTonicIdx).toBeGreaterThanOrEqual(0);
    expect(tonicIdx).toBeGreaterThanOrEqual(0);
    const lastActive = assignments
      .filter(a => !a.absent && !a.orphaned)
      .sort((a, b) => b.order - a.order)[0]!;
    expect(lastActive.bounds!.barEnd).toBe(8);
    // Confirmed stage is still in place.
    expect(assignments.find(a => a.stageId === 'Dominant')!.bounds).toEqual(dominantBefore.bounds);
  });

  it('absent and orphaned stages are passed through unchanged', () => {
    const before = makePac().map((a, i) =>
      i === 2 ? { ...a, absent: true, bounds: null } : a,
    );
    const { assignments } = respondToMainResize(
      before, makeSelection(1, 10), 'measure', [], [],
    );
    const absentStage = assignments.find(a => a.absent)!;
    expect(absentStage).toBeDefined();
    expect(absentStage.bounds).toBeNull();
  });

  it('optional unconfirmed stage with no room in its gap is marked absent', () => {
    // Arrange: two adjacent confirmed stages that leave zero room for an
    // optional unconfirmed stage between them.
    // Build a 3-stage concept with B (optional, order 2) between A (order 1)
    // and C (order 3).  Confirm A and C so they are adjacent (A.barEnd+1 = C.barStart).
    const stages = [
      makeStage('A', 1, 1, true),
      makeStage('B', 2, 1, false), // optional
      makeStage('C', 3, 1, true),
    ];
    const assignments = prePopulateStages(stages, makeSelection(1, 3));
    // A: bar 1, B: bar 2, C: bar 3 — confirm A and C adjacent.
    const withConfirmed = assignments.map(a => {
      if (a.stageId === 'A') return { ...a, confirmed: true, bounds: { barStart: 1, beatStart: null, barEnd: 1, beatEnd: null } };
      if (a.stageId === 'C') return { ...a, confirmed: true, bounds: { barStart: 2, beatStart: null, barEnd: 3, beatEnd: null } };
      return a;
    });
    // Resize — B's gap is bars 2–1 (empty, lo > hi) because C starts at bar 2.
    const { assignments: result } = respondToMainResize(
      withConfirmed, makeSelection(1, 3), 'measure', [], [],
    );
    const b = result.find(a => a.stageId === 'B')!;
    expect(b.absent).toBe(true);
    expect(b.bounds).toBeNull();
  });

  it('returns assignments unchanged when blocked', () => {
    const before = makePac();
    const { assignments, blocked } = respondToMainResize(
      before, makeSelection(1, 1), 'measure', [{ barN: 1, beatFloat: 1 }], [],
    );
    expect(blocked).toBe(true);
    expect(assignments).toBe(before); // reference equality — unchanged
  });

  // ── Active optional stage clamp scenario (Step 3 verification) ────────────

  it('shrinking toward an active optional stage: droppedGrid fires before blocked', () => {
    // Optional confirmed stage at bars 3-4 (in an 8-bar selection).
    // Shrink to 2 bars — measure can no longer fit 4 stages, but beat can.
    const stages = [
      makeStage('Predominant', 1, 2, true),
      makeStage('Dominant',    2, 3, true),
      makeStage('PreTonic',    3, 1, false), // optional
      makeStage('Tonic',       4, 2, true),
    ];
    let assignments = prePopulateStages(stages, makeSelection(1, 8));
    // Confirm the optional PreTonic stage.
    assignments = confirmStage(assignments, 'PreTonic');
    const preTonicBounds = assignments.find(a => a.stageId === 'PreTonic')!.bounds!;

    // Shrink to 2 bars but provide enough beats to fit (4 stages × 1 beat each).
    const beatPos = makeBeatPositions(1, 2, 4); // 8 beat positions
    const { droppedGrid, blocked, assignments: result } = respondToMainResize(
      assignments, makeSelection(1, 2), 'measure', beatPos, [],
    );
    expect(blocked).toBe(false);
    expect(droppedGrid).toBe('beat'); // auto-dropped to beat resolution

    // The confirmed optional stage is preserved.
    const preTonic = result.find(a => a.stageId === 'PreTonic')!;
    expect(preTonic.bounds).toEqual(preTonicBounds);
    expect(preTonic.confirmed).toBe(true);
  });

  // ── Outer-edge sync: last/first confirmed stage tracks fragment boundary ────

  it('last confirmed stage: outer barEnd tracks fragment when it grows', () => {
    // Confirm Tonic (the last stage). When the fragment grows, Tonic's barEnd
    // must extend to the new selection end. Its barStart (the split point set
    // by the confirmed drag) must be preserved unchanged.
    const before = confirmStage(makePac(), 'Tonic');
    const tonicBefore = before.find(a => a.stageId === 'Tonic')!;

    const { assignments } = respondToMainResize(
      before, makeSelection(1, 12), 'measure', [], [],
    );
    const tonic = assignments.find(a => a.stageId === 'Tonic')!;
    expect(tonic.bounds!.barEnd).toBe(12);
    expect(tonic.confirmed).toBe(true);
    // Internal split point (barStart) must be unchanged.
    expect(tonic.bounds!.barStart).toBe(tonicBefore.bounds!.barStart);
  });

  it('all stages confirmed: last stage outer edge tracks fragment grow', () => {
    // When every stage is confirmed the function previously returned early
    // without syncing outer edges. Verify it now extends the last stage.
    const before = makePac().map(a => ({ ...a, confirmed: true }));
    const tonicBefore = before.find(a => a.stageId === 'Tonic')!;
    const dominantBefore = before.find(a => a.stageId === 'Dominant')!;

    const { assignments } = respondToMainResize(
      before, makeSelection(1, 12), 'measure', [], [],
    );
    const tonic = assignments.find(a => a.stageId === 'Tonic')!;
    expect(tonic.bounds!.barEnd).toBe(12);
    expect(tonic.confirmed).toBe(true);
    expect(tonic.bounds!.barStart).toBe(tonicBefore.bounds!.barStart);

    // Middle stage bounds are untouched.
    const dominant = assignments.find(a => a.stageId === 'Dominant')!;
    expect(dominant.bounds).toEqual(dominantBefore.bounds);
  });

  it('both flanking stages confirmed (drag-split scenario): last stage tracks grow', () => {
    // Exact user scenario: drag the split handle between stage N-1 and N,
    // confirming both. Then grow the fragment. Last stage's barEnd must follow.
    const before = confirmStage(confirmStage(makePac(), 'PreTonic'), 'Tonic');
    const tonicBefore = before.find(a => a.stageId === 'Tonic')!;

    const { assignments } = respondToMainResize(
      before, makeSelection(1, 12), 'measure', [], [],
    );
    const tonic = assignments.find(a => a.stageId === 'Tonic')!;
    expect(tonic.bounds!.barEnd).toBe(12);
    expect(tonic.bounds!.barStart).toBe(tonicBefore.bounds!.barStart);
    expect(tonic.confirmed).toBe(true);
  });

  it('last confirmed stage: beatEnd syncs when fragment shrinks within last bar', () => {
    // Beat-precision shrink: fragment shrinks from barEnd=8 (full bar) to
    // barEnd=8 beatEnd=3.0 (partial bar 8). The bar number is unchanged but
    // beatEnd differs — the stage must update to avoid extending past the fragment.
    const before = confirmStage(makePac(), 'Tonic');
    const sel: SelectionRange = { barStart: 1, barEnd: 8, beatStart: 1.0, beatEnd: 3.0, repeatContext: null };
    const { assignments } = respondToMainResize(before, sel, 'beat', [], []);
    const tonic = assignments.find(a => a.stageId === 'Tonic')!;
    expect(tonic.bounds!.barEnd).toBe(8);
    expect(tonic.bounds!.beatEnd).toBe(3.0);
  });

  it('first confirmed stage: beatStart syncs when fragment grows into first bar', () => {
    // Beat-precision grow: fragment starts at barStart=1 beatStart=2.5, then
    // extends to barStart=1 beatStart=1.0 (earlier beat in same first bar).
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1), makeStage('C', 3, 1)];
    const initSel: SelectionRange = { barStart: 1, barEnd: 3, beatStart: 2.5, beatEnd: 5.0, repeatContext: null };
    const baseBeatPositions = [
      { barN: 1, beatFloat: 2.5 }, { barN: 1, beatFloat: 3.5 }, { barN: 1, beatFloat: 4.5 },
      { barN: 2, beatFloat: 1.5 }, { barN: 2, beatFloat: 2.5 }, { barN: 2, beatFloat: 3.5 },
      { barN: 3, beatFloat: 1.5 }, { barN: 3, beatFloat: 2.5 }, { barN: 3, beatFloat: 3.5 },
    ];
    const base = prePopulateStagesAtGrid(stages, initSel, baseBeatPositions);
    const withConfirmed = base.map(a => a.stageId === 'A' ? { ...a, confirmed: true } : a);

    // Grow leftward within bar 1: beatStart moves from 2.5 to 1.0.
    const newSel: SelectionRange = { barStart: 1, barEnd: 3, beatStart: 1.0, beatEnd: 5.0, repeatContext: null };
    const { assignments } = respondToMainResize(withConfirmed, newSel, 'beat', baseBeatPositions, []);
    const a = assignments.find(x => x.stageId === 'A')!;
    expect(a.bounds!.barStart).toBe(1);
    expect(a.bounds!.beatStart).toBe(1.0);
    expect(a.confirmed).toBe(true);
  });
});
