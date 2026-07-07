/**
 * Unit tests for the split-handle drag-targeting helpers — Component 9 Part 8
 * item 2 (cross-system drag, tagging-tool-design.md §6A.4 I11;
 * part-8-campaign-triage.md).
 *
 * The bug: `nearestBoundaryTarget` keyed its "on this system" preference to
 * the system frozen at drag start, and since every system always offers at
 * least one candidate, a boundary target on another system could never win —
 * a split handle could not be dragged across a system break. The fix resolves
 * the target system from the cursor's y position per mousemove tick
 * (`nearestSystemBottom`). These tests pin both helpers over hand-built
 * two-system slot fixtures (jsdom cannot lay out SVG; the helpers are pure).
 */

import { describe, expect, it } from 'vitest';
import type { StageSlot } from '../stageFrame';
import { nearestBoundaryTarget, nearestSystemBottom } from '../stageFrame';

// ---------------------------------------------------------------------------
// Fixture: a selection spanning two systems, two slots per system.
// System 1 (bottom at y=100): slots at x [0,100) and [100,200).
// System 2 (bottom at y=400): slots at x [0,100) and [100,200).
// Boundary indices over the 4-slot list:
//   k=0 → s1a.left (x=0,   sys 100)
//   k=1 → s1b.left (x=100, sys 100)
//   k=2 → s2a.left (x=0,   sys 400)
//   k=3 → s2b.left (x=100, sys 400)
//   k=4 → s2b.right (x=200, sys 400)
// ---------------------------------------------------------------------------

function makeSlot(left: number, right: number, systemBottom: number, pos: number): StageSlot {
  return {
    measureKey: `m${pos}`,
    barN: pos,
    beatFloat: null,
    endFloat: null,
    pos,
    left,
    right,
    systemTop: systemBottom - 60,
    systemBottom,
  };
}

const TWO_SYSTEMS: StageSlot[] = [
  makeSlot(0, 100, 100, 1),
  makeSlot(100, 200, 100, 2),
  makeSlot(0, 100, 400, 3),
  makeSlot(100, 200, 400, 4),
];

describe('nearestSystemBottom', () => {
  it('resolves a cursor over the first system to its bottom', () => {
    expect(nearestSystemBottom(TWO_SYSTEMS, 90)).toBe(100);
  });

  it('resolves a cursor over the second system to its bottom', () => {
    expect(nearestSystemBottom(TWO_SYSTEMS, 380)).toBe(400);
  });

  it('switches systems at the vertical midpoint between them', () => {
    expect(nearestSystemBottom(TWO_SYSTEMS, 249)).toBe(100);
    expect(nearestSystemBottom(TWO_SYSTEMS, 251)).toBe(400);
  });

  it('clamps to the nearest system beyond the outer edges', () => {
    expect(nearestSystemBottom(TWO_SYSTEMS, -50)).toBe(100);
    expect(nearestSystemBottom(TWO_SYSTEMS, 900)).toBe(400);
  });
});

describe('nearestBoundaryTarget', () => {
  it('picks the nearest boundary on the cursor system (first system)', () => {
    expect(nearestBoundaryTarget(TWO_SYSTEMS, 100, 100)).toBe(1);
  });

  it('reaches a boundary on the second system when the cursor is there', () => {
    // Same x as the k=1 boundary on system 1 — but with the cursor resolved
    // to system 2, the on-system candidate k=3 wins. Under the pre-fix
    // behaviour (system frozen at drag start on system 1) this returned 1.
    expect(nearestBoundaryTarget(TWO_SYSTEMS, 100, 400)).toBe(3);
  });

  it('reaches the terminal boundary (last slot right edge) across systems', () => {
    expect(nearestBoundaryTarget(TWO_SYSTEMS, 220, 400)).toBe(4);
  });

  it('reaches the first boundary of the second system', () => {
    expect(nearestBoundaryTarget(TWO_SYSTEMS, 10, 400)).toBe(2);
  });

  it('is total: returns a boundary even for x far outside any slot', () => {
    expect(nearestBoundaryTarget(TWO_SYSTEMS, -500, 100)).toBe(0);
    expect(nearestBoundaryTarget(TWO_SYSTEMS, 5000, 400)).toBe(4);
  });

  it('round-trips a drag: leaving a system and coming back retargets it', () => {
    // Simulates mousemove ticks: start near k=1 (system 1), drag down to
    // system 2 (k=3), then back up — the target follows the cursor's system
    // each tick rather than staying frozen.
    const down = nearestBoundaryTarget(TWO_SYSTEMS, 100, nearestSystemBottom(TWO_SYSTEMS, 390));
    const back = nearestBoundaryTarget(TWO_SYSTEMS, 100, nearestSystemBottom(TWO_SYSTEMS, 110));
    expect(down).toBe(3);
    expect(back).toBe(1);
  });
});
