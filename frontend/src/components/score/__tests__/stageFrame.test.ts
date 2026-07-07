/**
 * Unit tests for stageFrame.ts — Component 9 Step 4 (tagging-tool-design.md
 * §6A.4/§6A.5). Encodes the spec's collapse/redistribution tables against the
 * Step 1 stage fixtures:
 *
 *  - STG-01/STG-03 (I6): a backward drag that collapses a stage hands the
 *    freed space to the stage on the growing side of the handle — never to a
 *    far-side stage.
 *  - STG-02: forward collapse keeps absorbing into the growing stage
 *    (positive control).
 *  - STG-04 (I9): moveBoundary is total — every drag position yields a legal
 *    clamped boundary vector; there is no "unchanged" sentinel for the UI to
 *    translate into a bounce-back.
 *  - I10: optional stages overtaken by a drag collapse to zero width and
 *    restore when the drag retreats (each tick derives from the gesture's
 *    initial frame); required stages clamp the drag at one grid unit.
 *  - STG-05/06/07/08 (§6A.5, I7): the main-resize response rebuilds the frame
 *    from the committed state — outer stage edges coincide with the new
 *    selection exactly at every resolution, and a resize on one side cannot
 *    move a confirmed stage on the other.
 *  - STG-10 (overlap prohibition, I8): stage runs partition the slot list of
 *    the selection's effective key range — geometry cannot overlap, gap, or
 *    extend past the main bracket, including across duplicate @n values.
 *
 * Uses hand-constructed minimal ghost layers (jsdom cannot lay out SVG).
 */

import { describe, expect, it } from 'vitest';
import type { BeatGhostEntry, GhostLayer, MeasureGhostEntry } from '../ghosts';
import { encodeBeat, measureGhostKey } from '../ghosts';
import type { SelectionRange } from '../annotator';
import type { ContainsStage } from '../../../services/conceptApi';
import type { StageAssignment } from '../stages';
import { prePopulateStages } from '../stages';
import {
  buildStageSlots,
  projectBoundaries,
  projectRun,
  moveBoundary,
  frameToAssignments,
  foldStageSegments,
  respondToMainResize,
} from '../stageFrame';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockMeasure {
  key: string;
  barN: number;
  endingN?: number | null;
  left: number;
  width?: number;
  systemTop?: number;
}

/**
 * Build a mock GhostLayer. Each measure is 100px wide (or `width`); when
 * beatsPerBar > 0, beat ghosts tile the measure evenly with endFloat = next
 * onset (last beat's endFloat = beatsPerBar + 1).
 */
function makeLayer(measures: MockMeasure[], beatsPerBar = 0): GhostLayer {
  const measureIndex = new Map<string, MeasureGhostEntry>();
  const beatIndex = new Map<number, BeatGhostEntry>();

  measures.forEach((m, i) => {
    const width = m.width ?? 100;
    const sysTop = m.systemTop ?? 0;
    measureIndex.set(m.key, {
      el: document.createElement('div'),
      barN: m.barN,
      endingN: m.endingN ?? null,
      key: m.key,
      bounds: { left: m.left, top: sysTop + 4, width, height: 40 },
      systemTop: sysTop,
      renderOrder: i,
    });
    for (let b = 0; b < beatsPerBar; b++) {
      const encKey = encodeBeat(i, b);
      beatIndex.set(encKey, {
        el: document.createElement('div'),
        barN: m.barN,
        endingN: m.endingN ?? null,
        measureKey: m.key,
        beatIdx: b,
        encodedKey: encKey,
        beatFloat: b + 1,
        endFloat: b + 2,
        bounds: {
          left: m.left + (b * width) / beatsPerBar,
          top: sysTop + 4,
          width: width / beatsPerBar,
          height: 40,
        },
      });
    }
  });

  return {
    measureIndex,
    beatIndex,
    subBeatIndex: new Map(),
  } as unknown as GhostLayer;
}

function sel(partial: Partial<SelectionRange>): SelectionRange {
  return {
    barStart: 1,
    barEnd: 1,
    beatStart: null,
    beatEnd: null,
    repeatContext: null,
    ...partial,
  };
}

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

/** Four consecutive measures m1–m4 on one system (K279 mm. 1–4 shape). */
function fourBarLayer(beatsPerBar = 0): GhostLayer {
  return makeLayer(
    [1, 2, 3, 4].map(n => ({ key: measureGhostKey(n, null), barN: n, left: (n - 1) * 100 })),
    beatsPerBar,
  );
}

function fourBarSel(): SelectionRange {
  return sel({ barStart: 1, barEnd: 4, measureKeys: ['m1', 'm2', 'm3', 'm4'] });
}

// ---------------------------------------------------------------------------
// buildStageSlots
// ---------------------------------------------------------------------------

describe('buildStageSlots', () => {
  it('measure grid: one slot per committed key, in document order', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(), 'measure');
    expect(slots.map(s => s.measureKey)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(slots.map(s => s.barN)).toEqual([1, 2, 3, 4]);
    expect(slots.every(s => s.beatFloat === null)).toBe(true);
  });

  it('only committed keys contribute — duplicate @n elsewhere is ignored (STG-10)', () => {
    // m2 and m2#1 share barN 2; only m2 is committed.
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2', barN: 2, left: 100 },
      { key: 'm2#1', barN: 2, left: 200 },
      { key: 'm3', barN: 3, left: 300 },
    ]);
    const slots = buildStageSlots(
      sel({ barStart: 1, barEnd: 2, measureKeys: ['m1', 'm2'] }),
      layer,
      'measure',
    );
    expect(slots.map(s => s.measureKey)).toEqual(['m1', 'm2']);
  });

  it('beat grid: endpoint filters apply to the first/last key only', () => {
    const layer = fourBarLayer(4);
    const slots = buildStageSlots(
      sel({
        barStart: 1, barEnd: 2, beatStart: 2.0, beatEnd: 3.0,
        measureKeys: ['m1', 'm2'],
      }),
      layer,
      'beat',
    );
    // m1: beats 2,3,4 (1.0 < beatStart excluded); m2: beats 1,2 (3.0+ excluded).
    expect(slots.map(s => `${s.measureKey}:${s.beatFloat}`)).toEqual([
      'm1:2', 'm1:3', 'm1:4', 'm2:1', 'm2:2',
    ]);
    // Frame edges are the selection's exact endpoints (I7 base case).
    expect(slots[0]!.beatFloat).toBe(2.0);
    expect(slots[slots.length - 1]!.endFloat).toBe(3.0);
  });

  it('excluded sibling endings leave a document-position gap (§6A.3)', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2-e1', barN: 2, endingN: 1, left: 100 },
      { key: 'm2-e2', barN: 2, endingN: 2, left: 200 },
    ]);
    const slots = buildStageSlots(
      sel({
        barStart: 1, barEnd: 2, repeatContext: 'second_ending',
        measureKeys: ['m1', 'm2-e2'],
      }),
      layer,
      'measure',
    );
    expect(slots.map(s => s.measureKey)).toEqual(['m1', 'm2-e2']);
    expect(slots[1]!.pos - slots[0]!.pos).toBe(2); // gap over m2-e1
  });
});

// ---------------------------------------------------------------------------
// moveBoundary — the I6/I9/I10 collapse table
// ---------------------------------------------------------------------------

describe('moveBoundary', () => {
  // Four stages A|B|C|D over 8 slots, boundaries [2, 4, 6].
  const B0 = [2, 4, 6];
  const noneRequired = [false, false, false, false];

  it('moves only the dragged boundary within free space (I6)', () => {
    expect(moveBoundary(B0, 1, 5, noneRequired, 8)).toEqual([2, 5, 6]);
    expect(moveBoundary(B0, 1, 3, noneRequired, 8)).toEqual([2, 3, 6]);
  });

  it('backward collapse: far-side stage does not expand; growing side absorbs (STG-01/STG-03)', () => {
    // Drag boundary 1 (B|C) backward to 2: B collapses to zero width.
    const moved = moveBoundary(B0, 1, 2, noneRequired, 8);
    expect(moved).toEqual([2, 2, 6]);
    // A's run [0,2) unchanged (far side); C's run [2,6) absorbed B's space.
  });

  it('backward drag continues against the next boundary after a collapse (I10)', () => {
    // Past B's zero point: boundary 0 rides along; A shrinks next.
    const moved = moveBoundary(B0, 1, 1, noneRequired, 8);
    expect(moved).toEqual([1, 1, 6]);
  });

  it('forward collapse absorbs into the left (growing) stage (STG-02)', () => {
    const moved = moveBoundary(B0, 1, 6, noneRequired, 8);
    expect(moved).toEqual([2, 6, 6]); // C collapsed; D's run [6,8) untouched
  });

  it('required stage clamps the drag one slot before zero (I10), forward', () => {
    const required = [false, false, true, false]; // C required
    const moved = moveBoundary(B0, 1, 8, required, 8);
    expect(moved).toEqual([2, 5, 6]); // C keeps slot [5,6)
  });

  it('required stage clamps the drag one slot before zero (I10), backward', () => {
    const required = [true, false, false, false]; // A required
    const moved = moveBoundary(B0, 1, 0, required, 8);
    expect(moved).toEqual([1, 1, 6]); // A keeps slot [0,1)
  });

  it('the dragged stage itself clamps at one slot when required, backward', () => {
    const required = [false, true, false, false]; // B required
    const moved = moveBoundary(B0, 1, 0, required, 8);
    expect(moved).toEqual([2, 3, 6]); // B keeps [2,3)
  });

  it('multi-collapse: a long drag eats every optional stage up to the frame edge', () => {
    const moved = moveBoundary(B0, 2, 0, noneRequired, 8);
    expect(moved).toEqual([0, 0, 0]); // A, B, C collapsed; D spans [0,8)
  });

  it('is total: out-of-range targets clamp, never bounce (I9 / STG-04)', () => {
    expect(moveBoundary(B0, 2, 99, noneRequired, 8)).toEqual([2, 4, 8]);
    expect(moveBoundary(B0, 0, -7, noneRequired, 8)).toEqual([0, 4, 6]);
  });

  it('retreating within the same gesture restores collapsed stages (I10)', () => {
    // Each tick derives from the gesture's initial boundaries: a collapse at
    // tick 1 leaves no trace when tick 2 recomputes from B0.
    const tick1 = moveBoundary(B0, 1, 2, noneRequired, 8);
    expect(tick1).toEqual([2, 2, 6]); // B collapsed
    const tick2 = moveBoundary(B0, 1, 3, noneRequired, 8);
    expect(tick2).toEqual([2, 3, 6]); // B back at width 1
  });

  it('runs always partition the frame: non-decreasing, in range', () => {
    for (const target of [-3, 0, 1, 2, 3, 4, 5, 6, 7, 8, 11]) {
      for (let dragged = 0; dragged < 3; dragged++) {
        const moved = moveBoundary(B0, dragged, target, noneRequired, 8);
        expect(moved[0]!).toBeGreaterThanOrEqual(0);
        expect(moved[moved.length - 1]!).toBeLessThanOrEqual(8);
        for (let j = 1; j < moved.length; j++) {
          expect(moved[j]!).toBeGreaterThanOrEqual(moved[j - 1]!);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// frameToAssignments — derivation, outer pinning, overlap prohibition
// ---------------------------------------------------------------------------

describe('frameToAssignments', () => {
  function makeAssignments(specs: Array<[string, boolean]>): StageAssignment[] {
    return specs.map(([id, required], i) => ({
      stageId: id,
      stageName: id,
      order: i + 1,
      required,
      displayMode: 'stage' as const,
      containmentMode: 'contiguous' as const,
      defaultWeight: 1,
      bounds: { barStart: 0, beatStart: null, barEnd: 0, beatEnd: null },
      confirmed: false,
      absent: false,
      orphaned: false,
      error: false,
    }));
  }

  it('derives bar, beat, and key bounds from slot runs (beat grid)', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(4), 'beat'); // 16 slots
    const assignments = makeAssignments([['A', true], ['B', true]]);
    const active = assignments;
    const out = frameToAssignments(assignments, active, slots, [6]);
    const a = out.find(x => x.stageId === 'A')!;
    const b = out.find(x => x.stageId === 'B')!;
    // A: slots 0..5 → m1 beat 1 to m2 beat 2 (endFloat 3).
    expect(a.bounds).toMatchObject({
      barStart: 1, beatStart: 1, barEnd: 2, beatEnd: 3,
      keyStart: 'm1', keyEnd: 'm2',
    });
    // B: slots 6..15 → m2 beat 3 to m4 beat 4 (endFloat 5).
    expect(b.bounds).toMatchObject({
      barStart: 2, beatStart: 3, barEnd: 4, beatEnd: 5,
      keyStart: 'm2', keyEnd: 'm4',
    });
    // Shared boundary: single value on both sides (§6A.4 — no overlap, no gap).
    expect(a.bounds!.barEnd).toBe(b.bounds!.barStart);
    expect(a.bounds!.beatEnd).toBe(b.bounds!.beatStart);
  });

  it('pins outer edges to the frame exactly (I7), including beat-filtered endpoints', () => {
    const layer = fourBarLayer(4);
    const s = sel({
      barStart: 1, barEnd: 4, beatStart: 2.0, beatEnd: 3.0,
      measureKeys: ['m1', 'm2', 'm3', 'm4'],
    });
    const slots = buildStageSlots(s, layer, 'beat');
    const assignments = makeAssignments([['A', true], ['B', true]]);
    const out = frameToAssignments(assignments, assignments, slots, [5]);
    expect(out[0]!.bounds!.beatStart).toBe(2.0); // = selection.beatStart
    expect(out[1]!.bounds!.barEnd).toBe(4);
    expect(out[1]!.bounds!.beatEnd).toBe(3.0);   // = selection.beatEnd, exact
  });

  it('collapses an optional stage with an empty run to absent (I10 commit)', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(), 'measure');
    const assignments = makeAssignments([['A', true], ['B', false], ['C', true]]);
    const out = frameToAssignments(assignments, assignments, slots, [2, 2]);
    const b = out.find(x => x.stageId === 'B')!;
    expect(b.absent).toBe(true);
    expect(b.bounds).toBeNull();
    // Neighbours tile the full frame.
    expect(out.find(x => x.stageId === 'A')!.bounds).toMatchObject({ barStart: 1, barEnd: 2 });
    expect(out.find(x => x.stageId === 'C')!.bounds).toMatchObject({ barStart: 3, barEnd: 4 });
  });

  it('marks the stages in confirmIds confirmed', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(), 'measure');
    const assignments = makeAssignments([['A', true], ['B', true]]);
    const out = frameToAssignments(assignments, assignments, slots, [2], new Set(['A']));
    expect(out.find(x => x.stageId === 'A')!.confirmed).toBe(true);
    expect(out.find(x => x.stageId === 'B')!.confirmed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projectBoundaries — round-trip across duplicate @n values
// ---------------------------------------------------------------------------

describe('projectBoundaries', () => {
  it('round-trips frame-derived bounds exactly, including duplicate barNs', () => {
    // m8 and m8#1 share barN 8 (X-numbered fallback inside the selection).
    const layer = makeLayer([
      { key: 'm7', barN: 7, left: 0 },
      { key: 'm8', barN: 8, left: 100 },
      { key: 'm8#1', barN: 8, left: 200 },
      { key: 'm9', barN: 9, left: 300 },
    ]);
    const s = sel({ barStart: 7, barEnd: 9, measureKeys: ['m7', 'm8', 'm8#1', 'm9'] });
    const slots = buildStageSlots(s, layer, 'measure');
    const assignments: StageAssignment[] = ['A', 'B', 'C'].map((id, i) => ({
      stageId: id, stageName: id, order: i + 1, required: true,
      displayMode: 'stage', containmentMode: 'contiguous', defaultWeight: 1,
      bounds: { barStart: 0, beatStart: null, barEnd: 0, beatEnd: null },
      confirmed: false, absent: false, orphaned: false, error: false,
    }));
    // B starts at m8#1 (slot 2) — barN alone could not say which slot.
    const derived = frameToAssignments(assignments, assignments, slots, [1, 2]);
    const { boundaries } = projectBoundaries(derived, slots);
    expect(boundaries).toEqual([1, 2]);
  });

  it('keeps the boundary vector non-decreasing when a stage cannot be matched', () => {
    const layer = fourBarLayer();
    const slots = buildStageSlots(fourBarSel(), layer, 'measure');
    const assignments: StageAssignment[] = ['A', 'B'].map((id, i) => ({
      stageId: id, stageName: id, order: i + 1, required: true,
      displayMode: 'stage', containmentMode: 'contiguous', defaultWeight: 1,
      // B's bounds reference a bar outside the frame — stale state.
      bounds: { barStart: i === 0 ? 1 : 99, beatStart: null, barEnd: i === 0 ? 2 : 99, beatEnd: null },
      confirmed: false, absent: false, orphaned: false, error: false,
    }));
    const { boundaries } = projectBoundaries(assignments, slots);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!).toBeGreaterThanOrEqual(0);
    expect(boundaries[0]!).toBeLessThanOrEqual(slots.length);
  });
});

// ---------------------------------------------------------------------------
// foldStageSegments — discontiguous rendering (§6A.3) and system breaks
// ---------------------------------------------------------------------------

describe('foldStageSegments', () => {
  it('folds a contiguous run on one system into a single segment', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(), 'measure');
    const segments = foldStageSegments(slots, 0, 4);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ left: 0, right: 400, isFirst: true, isLast: true });
  });

  it('splits at a document-position gap over an excluded ending (§6A.3)', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2-e1', barN: 2, endingN: 1, left: 100 },
      { key: 'm2-e2', barN: 2, endingN: 2, left: 200 },
    ]);
    const s = sel({
      barStart: 1, barEnd: 2, repeatContext: 'second_ending',
      measureKeys: ['m1', 'm2-e2'],
    });
    const slots = buildStageSlots(s, layer, 'measure');
    const segments = foldStageSegments(slots, 0, 2);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ left: 0, right: 100, isFirst: true, isLast: false });
    expect(segments[1]).toMatchObject({ left: 200, right: 300, isFirst: false, isLast: true });
  });

  it('splits at system breaks', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0, systemTop: 0 },
      { key: 'm2', barN: 2, left: 100, systemTop: 0 },
      { key: 'm3', barN: 3, left: 0, systemTop: 300 },
    ]);
    const s = sel({ barStart: 1, barEnd: 3, measureKeys: ['m1', 'm2', 'm3'] });
    const slots = buildStageSlots(s, layer, 'measure');
    const segments = foldStageSegments(slots, 0, 3);
    expect(segments).toHaveLength(2);
    expect(segments[1]!.isLast).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projectRun — orphaned stage rendering
// ---------------------------------------------------------------------------

describe('projectRun', () => {
  it('projects committed bounds onto a slot run by keys', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(), 'measure');
    const run = projectRun(slots, {
      barStart: 2, beatStart: null, barEnd: 3, beatEnd: null,
      keyStart: 'm2', keyEnd: 'm3',
    });
    expect(run).toEqual({ lo: 1, hi: 3 });
  });

  it('returns null when the start lies outside the frame', () => {
    const slots = buildStageSlots(fourBarSel(), fourBarLayer(), 'measure');
    const run = projectRun(slots, {
      barStart: 9, beatStart: null, barEnd: 10, beatEnd: null,
    });
    expect(run).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// respondToMainResize — §6A.5 (STG-05/06/07/08)
// ---------------------------------------------------------------------------

describe('respondToMainResize', () => {
  function prePop(stageSpecs: Array<[string, number, boolean]>, s: SelectionRange) {
    return prePopulateStages(
      stageSpecs.map(([id, w, req], i) => makeStage(id, i + 1, w, req)),
      s,
    );
  }

  it('redistributes unconfirmed stages by weight over the new frame (STG-05)', () => {
    const before = prePop([['A', 1, true], ['B', 1, true]], fourBarSel());
    const grown = makeLayer(
      [1, 2, 3, 4, 5, 6].map(n => ({ key: `m${n}`, barN: n, left: (n - 1) * 100 })),
    );
    const newSel = sel({ barStart: 1, barEnd: 6, measureKeys: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] });
    const { assignments, blocked } = respondToMainResize(before, newSel, 'measure', grown);
    expect(blocked).toBe(false);
    expect(assignments[0]!.bounds).toMatchObject({ barStart: 1, barEnd: 3, keyStart: 'm1', keyEnd: 'm3' });
    expect(assignments[1]!.bounds).toMatchObject({ barStart: 4, barEnd: 6, keyStart: 'm4', keyEnd: 'm6' });
  });

  it('outer stage edge tracks a beat-precision shrink exactly (STG-06, I7)', () => {
    const layer = fourBarLayer(4);
    const initSel = fourBarSel();
    const before = prePop([['A', 1, true], ['B', 1, true]], initSel);
    // Shrink the fragment end to bar 4, beat 3.0 (partial last bar).
    const newSel = sel({
      barStart: 1, barEnd: 4, beatStart: 1.0, beatEnd: 3.0,
      measureKeys: ['m1', 'm2', 'm3', 'm4'],
    });
    const { assignments } = respondToMainResize(before, newSel, 'beat', layer);
    const last = assignments[assignments.length - 1]!;
    expect(last.bounds!.barEnd).toBe(4);
    expect(last.bounds!.beatEnd).toBe(3.0); // exact — no drift past the ghost
    const first = assignments[0]!;
    expect(first.bounds!.barStart).toBe(1);
    expect(first.bounds!.beatStart).toBe(1.0);
  });

  it('shrink past stage starts: first stage starts at the new frame start exactly (STG-07)', () => {
    const layer = fourBarLayer(4);
    const before = prePop(
      [['A', 1, true], ['B', 1, true], ['C', 1, true]],
      fourBarSel(),
    );
    // Shrink from the start to bar 2 beat 2.0 — past A's old start.
    const newSel = sel({
      barStart: 2, barEnd: 4, beatStart: 2.0, beatEnd: 5.0,
      measureKeys: ['m2', 'm3', 'm4'],
    });
    const { assignments, blocked } = respondToMainResize(before, newSel, 'beat', layer);
    expect(blocked).toBe(false);
    const first = assignments[0]!;
    expect(first.bounds!.barStart).toBe(2);
    expect(first.bounds!.beatStart).toBe(2.0); // coincides with the main bracket start
    // Every stage stays inside the new frame (I8).
    for (const a of assignments) {
      expect(a.bounds!.barStart).toBeGreaterThanOrEqual(2);
      expect(a.bounds!.barEnd).toBeLessThanOrEqual(4);
    }
  });

  it('resizing one side leaves a confirmed stage on the other side untouched (STG-08)', () => {
    const layer = makeLayer(
      [1, 2, 3, 4, 5, 6].map(n => ({ key: `m${n}`, barN: n, left: (n - 1) * 100 })),
    );
    const initSel = sel({
      barStart: 1, barEnd: 6,
      measureKeys: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
    });
    let assignments = prePop([['A', 1, true], ['B', 1, true], ['C', 1, true]], initSel);
    // Confirm C (bars 5–6).
    assignments = assignments.map(a => a.stageId === 'C' ? { ...a, confirmed: true } : a);
    const cBefore = assignments.find(a => a.stageId === 'C')!.bounds;

    // Shrink from the START: bars 2–6.
    const newSel = sel({
      barStart: 2, barEnd: 6,
      measureKeys: ['m2', 'm3', 'm4', 'm5', 'm6'],
    });
    const { assignments: result } = respondToMainResize(assignments, newSel, 'measure', layer);
    const c = result.find(a => a.stageId === 'C')!;
    expect(c.bounds).toMatchObject({
      barStart: cBefore!.barStart,
      barEnd:   cBefore!.barEnd,
      keyStart: cBefore!.keyStart,
      keyEnd:   cBefore!.keyEnd,
    });
    // The unconfirmed stages redistribute in the remaining gap.
    const a = result.find(x => x.stageId === 'A')!;
    expect(a.bounds!.barStart).toBe(2);
  });

  it('drops to a finer grid when measure no longer fits (escape valve)', () => {
    const layer = fourBarLayer(4);
    const before = prePop(
      [['A', 1, true], ['B', 1, true], ['C', 1, true], ['D', 1, true]],
      fourBarSel(),
    );
    const newSel = sel({ barStart: 1, barEnd: 2, measureKeys: ['m1', 'm2'] });
    const { droppedGrid, blocked, assignments } = respondToMainResize(before, newSel, 'measure', layer);
    expect(blocked).toBe(false);
    expect(droppedGrid).toBe('beat');
    // All four stages fit within the 8 beat slots, tiling the frame (I7/I8).
    expect(assignments[0]!.bounds!.barStart).toBe(1);
    expect(assignments[3]!.bounds!.barEnd).toBe(2);
  });

  it('returns blocked (assignments untouched) when no grid fits', () => {
    const layer = makeLayer([{ key: 'm1', barN: 1, left: 0 }], 2); // 2 beats, no sub-beats
    const before = prePop(
      [['A', 1, true], ['B', 1, true], ['C', 1, true], ['D', 1, true]],
      fourBarSel(),
    );
    const newSel = sel({ barStart: 1, barEnd: 1, measureKeys: ['m1'] });
    const { blocked, assignments } = respondToMainResize(before, newSel, 'measure', layer);
    expect(blocked).toBe(true);
    expect(assignments).toBe(before);
  });

  it('optional stage left without space collapses to absent', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2', barN: 2, left: 100 },
      { key: 'm3', barN: 3, left: 200 },
    ]);
    const newSel = sel({ barStart: 1, barEnd: 3, measureKeys: ['m1', 'm2', 'm3'] });
    let assignments = prePop(
      [['A', 1, true], ['B', 1, false], ['C', 1, true]],
      newSel,
    );
    // A and C confirmed adjacent (bars 1 and 2–3) — zero-width gap for B.
    assignments = assignments.map(a => {
      if (a.stageId === 'A') return { ...a, confirmed: true, bounds: { barStart: 1, beatStart: null, barEnd: 1, beatEnd: null, keyStart: 'm1', keyEnd: 'm1' } };
      if (a.stageId === 'C') return { ...a, confirmed: true, bounds: { barStart: 2, beatStart: null, barEnd: 3, beatEnd: null, keyStart: 'm2', keyEnd: 'm3' } };
      return a;
    });
    const { assignments: result, blocked } = respondToMainResize(assignments, newSel, 'measure', layer);
    expect(blocked).toBe(false);
    const b = result.find(x => x.stageId === 'B')!;
    expect(b.absent).toBe(true);
    expect(b.bounds).toBeNull();
    // The confirmed neighbours are untouched.
    expect(result.find(x => x.stageId === 'A')!.bounds).toMatchObject({ barStart: 1, barEnd: 1 });
    expect(result.find(x => x.stageId === 'C')!.bounds).toMatchObject({ barStart: 2, barEnd: 3 });
  });

  it('repeated identical resizes are idempotent (no error accumulation, §6A.5)', () => {
    const layer = fourBarLayer(4);
    const before = prePop([['A', 2, true], ['B', 1, true]], fourBarSel());
    const newSel = sel({
      barStart: 1, barEnd: 3, beatStart: 1.0, beatEnd: 4.0,
      measureKeys: ['m1', 'm2', 'm3'],
    });
    const once = respondToMainResize(before, newSel, 'beat', layer).assignments;
    const twice = respondToMainResize(once, newSel, 'beat', layer).assignments;
    expect(twice.map(a => a.bounds)).toEqual(once.map(a => a.bounds));
  });
});
