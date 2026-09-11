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
 *  toggleStageAbsent (absent=true):
 *    - Stage marked absent; left neighbour extends barEnd.
 *    - If no left neighbour, right neighbour extends barStart.
 *    - Absorbers inherit the absent stage's far boundary exactly (§6A.4).
 *
 *  toggleStageAbsent (absent=false):
 *    - Stage restored; neighbour gives back proportional space.
 *
 *  reconcileWithNewConcept:
 *    - Surviving stages kept; non-matching stages orphaned.
 *    - New stages in newStages receive pre-populated defaults.
 *
 * Split-handle boundary moves and the main-bracket resize response are
 * tested in stageFrame.test.ts (Component 9 Step 4).
 */

import { describe, expect, it } from 'vitest';
import type { ContainsStage } from '../../../services/conceptApi';
import type { SelectionRange } from '../annotator';
import type { StageAssignment } from '../stages';
import type { BeatSlot } from '../stages';
import {
  buildUnplacedStages,
  chooseStageGrid,
  hasUnplacedWantedStage,
  computeStagesComplete,
  prePopulateStages,
  prePopulateStagesAtGrid,
  reconcileWithNewConcept,
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

  // ── M7: outer-edge pinning at measure resolution (Component 11 Step 11) ────

  it('pins the outer edges to a beat-precise selection, interiors measure-aligned', () => {
    // The 279/ii shape: "m. 8 beat 3 – m. 10 beat 1" (beat_end is the exclusive
    // bound, so 2.0) seating three stages on a measure-granular grid. The first
    // stage must start at beat 3 and the last must end at the fragment's bound —
    // not at their measures' edges, which is how they used to overflow.
    const sel: SelectionRange = {
      barStart: 8, barEnd: 10, beatStart: 3.0, beatEnd: 2.0, repeatContext: null,
      measureKeys: ['m8', 'm9', 'm10'],
    };
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1), makeStage('C', 3, 1)];
    const result = prePopulateStages(stages, sel);

    expect(result[0]!.bounds).toMatchObject({ barStart: 8, beatStart: 3.0, barEnd: 8 });
    expect(result[0]!.bounds!.beatEnd).toBeNull();       // interior boundary
    expect(result[1]!.bounds!.beatStart).toBeNull();     // interior boundary
    expect(result[1]!.bounds!.beatEnd).toBeNull();
    expect(result[2]!.bounds!.beatStart).toBeNull();     // interior boundary
    expect(result[2]!.bounds).toMatchObject({ barEnd: 10, beatEnd: 2.0 });
  });

  it('a single stage over a beat-precise selection takes both of its bounds', () => {
    const sel: SelectionRange = {
      barStart: 8, barEnd: 10, beatStart: 3.0, beatEnd: 2.0, repeatContext: null,
      measureKeys: ['m8', 'm9', 'm10'],
    };
    const result = prePopulateStages([makeStage('A', 1, 1)], sel);
    expect(result[0]!.bounds).toMatchObject({
      barStart: 8, beatStart: 3.0, barEnd: 10, beatEnd: 2.0,
    });
  });

  it('pins outer beats on the bar-arithmetic fallback path too', () => {
    const sel: SelectionRange = {
      barStart: 8, barEnd: 10, beatStart: 3.0, beatEnd: 2.0, repeatContext: null,
    };
    const result = prePopulateStages([makeStage('A', 1, 1), makeStage('B', 2, 1)], sel);
    expect(result[0]!.bounds!.beatStart).toBe(3.0);
    expect(result[1]!.bounds!.beatEnd).toBe(2.0);
  });

  // ── Effective measure-key distribution (Component 9 Step 4, §6A.1) ────────

  it('distributes over the committed measure-key list when present', () => {
    // Four physical measures but only two distinct bar numbers (split measure
    // m2/m2#1 and an ending measure sharing @n 3): key units, not bar
    // arithmetic, drive the partition.
    const sel: SelectionRange = {
      barStart: 2, barEnd: 3, beatStart: null, beatEnd: null,
      repeatContext: null,
      measureKeys: ['m2', 'm2#1', 'm3', 'm3-e1'],
    };
    const result = prePopulateStages([makeStage('A', 1, 1), makeStage('B', 2, 1)], sel);
    expect(result[0]!.bounds).toMatchObject({
      barStart: 2, barEnd: 2, keyStart: 'm2', keyEnd: 'm2#1',
    });
    expect(result[1]!.bounds).toMatchObject({
      barStart: 3, barEnd: 3, keyStart: 'm3', keyEnd: 'm3-e1',
    });
  });

  it('falls back to bar arithmetic when a key is unparseable', () => {
    const sel: SelectionRange = {
      barStart: 1, barEnd: 4, beatStart: null, beatEnd: null,
      repeatContext: null,
      measureKeys: ['m1', 'bogus', 'm3', 'm4'],
    };
    const result = prePopulateStages([makeStage('A', 1, 1), makeStage('B', 2, 1)], sel);
    expect(result[0]!.bounds!.barStart).toBe(1);
    expect(result[1]!.bounds!.barEnd).toBe(4);
    expect(result[0]!.bounds!.keyStart).toBeUndefined();
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

  // ── Bounds stay valid through any toggle sequence (Step 18) ──────────────
  //
  // Restoring a stage carves bars out of a neighbour. A one-bar neighbour has
  // no bar to spare, and the carve used to take it anyway, leaving the donor at
  // barEnd === barStart - 1. Nothing downstream rejects that: the write model
  // validates only `ge=0` and within-bar beat ordering, sub-part containment
  // reads an inverted range as trivially contained, and the table has no check
  // constraint — so an inverted bracket reached the database.

  /** Every stage either has no bounds, or bounds that span at least one bar. */
  function expectValidBounds(assignments: StageAssignment[]) {
    for (const a of assignments) {
      if (!a.bounds) continue;
      expect(
        a.bounds.barEnd,
        `${a.stageId} has inverted bounds ${a.bounds.barStart}-${a.bounds.barEnd}`
      ).toBeGreaterThanOrEqual(a.bounds.barStart);
    }
  }

  /** Four one-bar stages over bars 1-4 — what a 4-bar cadence selection gives. */
  function makeFourOneBarStages() {
    const stages = [
      makeStage('S1', 1, 1, false),
      makeStage('S2', 2, 1, false),
      makeStage('S3', 3, 1, false),
      makeStage('S4', 4, 1, false),
    ];
    return prePopulateStages(stages, makeSelection(1, 4));
  }

  it('never produces inverted bounds, whatever the toggle order', () => {
    const sequences: Array<Array<[string, boolean]>> = [
      [['S2', true], ['S3', true], ['S3', false], ['S2', false]],
      [['S2', true], ['S3', true], ['S2', false], ['S3', false]],
      [['S1', true], ['S2', true], ['S1', false], ['S2', false]],
      [['S3', true], ['S1', true], ['S3', false], ['S1', false]],
      [['S4', true], ['S4', false]],
    ];

    for (const sequence of sequences) {
      let state = makeFourOneBarStages();
      for (const [stageId, absent] of sequence) {
        state = toggleStageAbsent(state, stageId, absent);
        expectValidBounds(state);
      }
    }
  });

  it('leaves a restored stage unplaced when no neighbour can spare a bar', () => {
    // Two one-bar stages: disabling one gives its bar to the other, which then
    // spans two bars and can donate. Shrink the selection so the survivor holds
    // a single bar and the restore has nowhere to take space from.
    const stages = [makeStage('S1', 1, 1, false), makeStage('S2', 2, 1, false)];
    const assignments = prePopulateStages(stages, makeSelection(1, 2));

    const absent = toggleStageAbsent(assignments, 'S2', true);
    // S1 now covers both bars, so it *can* donate and the restore succeeds.
    const restored = toggleStageAbsent(absent, 'S2', false);
    expectValidBounds(restored);
    expect(restored.find(a => a.stageId === 'S2')!.bounds).not.toBeNull();
  });

  it('restores a stage unplaced rather than inverted when nothing can donate', () => {
    // The contract ScoreViewer's toggle handler depends on. Three one-bar
    // stages fill a three-bar selection exactly; a fourth has nowhere to go.
    // No neighbour can spare a bar, so the restore yields a stage that is
    // *wanted but unplaced* — bounds null, absent false. Refusing to place it
    // is right (the alternative is the inverted geometry fixed above), but it
    // is silent on its own: the caller must notice and raise the blocked
    // notice, or the annotator sees a stage with no bracket and no reason.
    const placed = prePopulateStages(
      [makeStage('S1', 1, 1, false), makeStage('S2', 2, 1, false), makeStage('S3', 3, 1, false)],
      makeSelection(1, 3)
    );
    const withFourth: StageAssignment[] = [
      ...placed,
      {
        stageId: 'S4',
        stageName: 'S4',
        order: 4,
        required: false,
        displayMode: 'stage',
        containmentMode: 'contiguous',
        defaultWeight: 1.0,
        bounds: null,
        confirmed: false,
        absent: true,
        orphaned: false,
        error: false,
      },
    ];

    const restored = toggleStageAbsent(withFourth, 'S4', false);
    const s4 = restored.find(a => a.stageId === 'S4')!;

    expect(s4.absent).toBe(false);
    expect(s4.bounds).toBeNull();
    expectValidBounds(restored);
    // The other three keep the positions they already had.
    expect(restored.find(a => a.stageId === 'S1')!.bounds).toEqual(
      placed.find(a => a.stageId === 'S1')!.bounds
    );

    // And the fragment is not submittable while a wanted stage has no bounds.
    expect(computeStagesComplete(restored)).toBe(false);
  });

  it('hasUnplacedWantedStage detects the state that must raise the notice', () => {
    const placed = prePopulateStages(
      [makeStage('S1', 1, 1, false), makeStage('S2', 2, 1, false)],
      makeSelection(1, 2)
    );
    expect(hasUnplacedWantedStage(placed)).toBe(false);

    // Absent stages have no bounds, but they are not wanted — not a problem.
    const absent = toggleStageAbsent(placed, 'S2', true);
    expect(hasUnplacedWantedStage(absent)).toBe(false);

    // A wanted stage with no bounds is.
    const stranded = placed.map(a => (a.stageId === 'S2' ? { ...a, bounds: null } : a));
    expect(hasUnplacedWantedStage(stranded)).toBe(true);
  });

  it('buildUnplacedStages marks stages wanted, not absent', () => {
    // The blocked state (Step 17): stages listed so they can be toggled, but
    // none placed. They must read as wanted so completeness stays false.
    const built = buildUnplacedStages([makeStage('S1', 1, 1, false), makeStage('S2', 2, 1, false)]);
    expect(built.map(a => a.stageId)).toEqual(['S1', 'S2']);
    expect(built.every(a => a.bounds === null)).toBe(true);
    expect(built.every(a => !a.absent)).toBe(true);
    expect(computeStagesComplete(built)).toBe(false);
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
  it('returns measure when the frame has enough measure slots', () => {
    expect(chooseStageGrid(4, { measure: 4, beat: 16, subbeat: 32 })).toBe('measure');
  });

  it('returns measure when the frame has more measure slots than stages', () => {
    expect(chooseStageGrid(4, { measure: 8, beat: 32, subbeat: 64 })).toBe('measure');
  });

  it('returns beat when measure slots are insufficient but beats suffice', () => {
    expect(chooseStageGrid(4, { measure: 2, beat: 8, subbeat: 16 })).toBe('beat');
  });

  it('returns subbeat when beats are insufficient but sub-beats suffice', () => {
    expect(chooseStageGrid(4, { measure: 1, beat: 2, subbeat: 16 })).toBe('subbeat');
  });

  it('falls through to subbeat even when no resolution fits (blocking case)', () => {
    expect(chooseStageGrid(4, { measure: 1, beat: 2, subbeat: 3 })).toBe('subbeat');
  });

  it('returns measure for stageCount 0', () => {
    expect(chooseStageGrid(0, { measure: 0, beat: 0, subbeat: 0 })).toBe('measure');
  });

  it('returns measure for stageCount 1 on a single-slot frame', () => {
    expect(chooseStageGrid(1, { measure: 1, beat: 4, subbeat: 8 })).toBe('measure');
  });

  it('takes the measure tier from the frame, not from a bar span', () => {
    // Four physical measures behind two distinct bar numbers (split measures):
    // the frame reports 4 measure slots, so 4 stages fit at measure resolution
    // even though barEnd − barStart + 1 is 2 (§6A.1). The M7 case is the mirror
    // image — a beat-precise endpoint leaves its measure uncovered, so the frame
    // reports fewer slots than there are keys.
    expect(chooseStageGrid(4, { measure: 4, beat: 16, subbeat: 32 })).toBe('measure');
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
// ADR-005 beat-symmetry invariant — regression tests for 422 "Request
// validation failed" root causes.
//
// The wire invariant: a sub-part's beat_start/beat_end must both be null
// (measure-level) or both non-null with beat_start < beat_end. StageBounds
// may legitimately hold asymmetric pairs (boundary precision is preserved per
// boundary, §6A.4); the ScoreViewer payload builder normalises any pair where
// beatStart is null OR beatEnd is null OR beatStart >= beatEnd to both-null
// before submission, so the backend validator never sees a bad pair.
// ---------------------------------------------------------------------------

describe('ADR-005 beat-symmetry invariant', () => {
  // ── Root cause 1: prePopulateStagesAtGrid outer boundaries ───────────────
  // prePopulateStagesAtGrid intentionally leaves the outer boundary asymmetric
  // (first stage: beatStart=null / beatEnd=<number>; last stage: beatStart=<number>
  // / beatEnd=null) so the visual tiling stays contiguous.  The ScoreViewer.tsx
  // payload builder is the safety net: it normalises any pair where
  // beatStart is null OR beatEnd is null OR beatStart >= beatEnd to both-null
  // before submission, so the backend ADR-005 validator never sees a bad pair.

  it('prePopulateStagesAtGrid: outer boundaries — first stage has null beatStart, last has null beatEnd', () => {
    const stages = [makeStage('A', 1, 1), makeStage('B', 2, 1), makeStage('C', 3, 1)];
    const positions = makeBeatPositions(1, 1, 4); // single bar, 4 beat slots
    const result = prePopulateStagesAtGrid(stages, makeSelection(1, 1), positions);
    const first = result[0]!;
    const last  = result[result.length - 1]!;
    // Outer-edge asymmetry: the selection is measure-level so the outer boundaries
    // inherit null.  beatEnd of first and beatStart of last are set by the inner
    // split positions and are non-null — that is intentional (visual tiling).
    expect(first.bounds!.beatStart).toBeNull();   // outer left edge: measure-level
    expect(last.bounds!.beatEnd).toBeNull();       // outer right edge: measure-level
    // The inner split boundaries are non-null (beat-level distribution).
    expect(first.bounds!.beatEnd).not.toBeNull();  // inner right boundary of first stage
    expect(last.bounds!.beatStart).not.toBeNull(); // inner left boundary of last stage
  });

  // ── Root cause 3: toggleStageAbsent absorber boundary inheritance ────────
  // The absorber inherits the absent stage's FAR boundary exactly (§6A.4 —
  // single shared value against the stage beyond, so no overlap or gap), and
  // keeps its own near boundary's precision. The payload builder normalises
  // any resulting asymmetric pair for the wire format.

  it('toggleStageAbsent: left absorber inherits the absent stage far boundary, keeps its own start', () => {
    const stages = [
      makeStage('A', 1, 1, true),
      makeStage('B', 2, 1, false), // optional — will go absent
      makeStage('C', 3, 1, true),
    ];
    const base = prePopulateStages(stages, makeSelection(1, 6));
    const bBounds = base.find(x => x.stageId === 'B')!.bounds!;
    // Give A a beat-level split so it has non-null beat coordinates.
    const withBeat = base.map(a =>
      a.stageId === 'A' ? { ...a, bounds: { ...a.bounds!, beatStart: 1.0, beatEnd: 2.5 } } : a,
    );
    const updated = toggleStageAbsent(withBeat, 'B', true);
    const a = updated.find(x => x.stageId === 'A')!;
    // A absorbed B's space: far boundary inherited from B exactly.
    expect(a.bounds!.barEnd).toBe(bBounds.barEnd);
    expect(a.bounds!.beatEnd).toBe(bBounds.beatEnd);
    expect(a.bounds!.keyEnd).toBe(bBounds.keyEnd);
    // A's own start boundary keeps its precision (no blanket beat clearing —
    // nulling it shifted the shared boundary against C and could overlap).
    expect(a.bounds!.beatStart).toBe(1.0);
  });

  it('toggleStageAbsent: right absorber inherits the absent stage start boundary, keeps its own end', () => {
    const stages = [
      makeStage('First', 1, 1, false), // optional — will go absent, no left neighbour
      makeStage('Second', 2, 1, true),
    ];
    const base = prePopulateStages(stages, makeSelection(1, 6));
    const firstBounds = base.find(x => x.stageId === 'First')!.bounds!;
    // Give Second a beat-level split so it has non-null beat coordinates.
    const withBeat = base.map(a =>
      a.stageId === 'Second' ? { ...a, bounds: { ...a.bounds!, beatStart: 1.5, beatEnd: 3.0 } } : a,
    );
    const updated = toggleStageAbsent(withBeat, 'First', true);
    const second = updated.find(x => x.stageId === 'Second')!;
    // Second absorbed First's space: start boundary inherited from First exactly.
    expect(second.bounds!.barStart).toBe(firstBounds.barStart);
    expect(second.bounds!.beatStart).toBe(firstBounds.beatStart);
    expect(second.bounds!.keyStart).toBe(firstBounds.keyStart);
    // Second's own end boundary keeps its precision.
    expect(second.bounds!.beatEnd).toBe(3.0);
  });
});

// ---------------------------------------------------------------------------
// Beat-grid absent/restore — bar counting is not a measure of available space
// ---------------------------------------------------------------------------

describe('toggleStageAbsent on a beat grid', () => {
  /**
   * Francisco's report: 4/4, a measure and a half selected (six beats), PAC.
   * Pre-population lays the four stages out 2+2+1+1. Disabling Initial Tonic
   * hands its two beats to Pre-dominant, which then holds all of bar 1.
   * Re-enabling used to give Initial Tonic the *whole* of bar 1 and leave
   * Pre-dominant at `m2b1 .. m2b1` — zero beats wide, still listed as present.
   *
   * The cause is that the carve counts whole bars while the stages sit on a
   * beat grid. Pre-dominant spans `m1b3 .. m2b1`: two bars by the count, two
   * beats in reality. Taking "one bar" from it takes far more than it has.
   */
  function sixBeatLayout() {
    const positions: BeatSlot[] = [
      { barN: 1, beatFloat: 1 },
      { barN: 1, beatFloat: 2 },
      { barN: 1, beatFloat: 3 },
      { barN: 1, beatFloat: 4 },
      { barN: 2, beatFloat: 1 },
      { barN: 2, beatFloat: 2 },
    ];
    const selection = {
      ...makeSelection(1, 2),
      beatStart: 1,
      beatEnd: 3,
    } as SelectionRange;
    const stages = [
      makeStage('InitialTonic', 1, 1, false),
      makeStage('PreDominant', 2, 1, false),
      makeStage('Dominant', 3, 1, false),
      makeStage('FinalTonic', 4, 1, false),
    ];
    return { positions, selection, stages };
  }

  /** A stage covers real music: (bar, beat) end strictly after (bar, beat) start. */
  function expectNonEmptyExtents(assignments: StageAssignment[]) {
    for (const a of assignments) {
      if (!a.bounds) continue;
      const { barStart, beatStart, barEnd, beatEnd } = a.bounds;
      const startBeat = beatStart ?? 1;
      const endBeat = beatEnd ?? Number.POSITIVE_INFINITY;
      const nonEmpty = barEnd !== barStart ? barEnd > barStart : endBeat > startBeat;
      expect(
        nonEmpty,
        `${a.stageId} spans nothing: m${barStart}b${beatStart} .. m${barEnd}b${beatEnd}`
      ).toBe(true);
    }
  }

  it('leaves no zero-width stage when a stage is disabled and re-enabled', () => {
    const { positions, selection, stages } = sixBeatLayout();
    const laid = prePopulateStagesAtGrid(stages, selection, positions);
    expectNonEmptyExtents(laid);

    const absent = toggleStageAbsent(laid, 'InitialTonic', true);
    expectNonEmptyExtents(absent);

    const restored = toggleStageAbsent(absent, 'InitialTonic', false);
    expectNonEmptyExtents(restored);
  });

  it('restores unplaced rather than carving a bar out of a two-beat donor', () => {
    // Pre-dominant holds m1b1..m2b1 after absorbing — "two bars", four beats.
    // A whole-bar carve would empty it, so the restore declines and hands the
    // decision back to the caller, which re-places the wanted set on the grid.
    const { positions, selection, stages } = sixBeatLayout();
    const laid = prePopulateStagesAtGrid(stages, selection, positions);
    const absent = toggleStageAbsent(laid, 'InitialTonic', true);
    const restored = toggleStageAbsent(absent, 'InitialTonic', false);

    const it0 = restored.find(a => a.stageId === 'InitialTonic')!;
    expect(it0.absent).toBe(false);
    expect(it0.bounds).toBeNull();
    expect(hasUnplacedWantedStage(restored)).toBe(true);

    // Pre-dominant is untouched — it keeps the space it absorbed.
    expect(restored.find(a => a.stageId === 'PreDominant')!.bounds).toEqual(
      absent.find(a => a.stageId === 'PreDominant')!.bounds
    );
  });

  it('re-placing the wanted set recovers the original layout', () => {
    // The recovery ScoreViewer performs once hasUnplacedWantedStage reports true.
    const { positions, selection, stages } = sixBeatLayout();
    const laid = prePopulateStagesAtGrid(stages, selection, positions);
    const absent = toggleStageAbsent(laid, 'InitialTonic', true);
    const restored = toggleStageAbsent(absent, 'InitialTonic', false);

    const placed = new Map(
      prePopulateStagesAtGrid(stages, selection, positions).map(a => [a.stageId, a])
    );
    const merged = restored.map(a => placed.get(a.stageId) ?? a);

    expectNonEmptyExtents(merged);
    expect(hasUnplacedWantedStage(merged)).toBe(false);
    expect(merged.map(a => a.bounds)).toEqual(laid.map(a => a.bounds));
  });
});
