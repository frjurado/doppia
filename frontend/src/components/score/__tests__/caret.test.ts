/**
 * Unit tests for resolveCaret() in caret.ts (Component 9 Step 19).
 *
 * Covers the pure caret resolver against the cases the playback caret must
 * handle (see docs/architecture/playback-coordinates.md §"Playback caret"):
 *  - hidden before the first onset; pinned at/after the last onset;
 *  - linear interpolation within a system;
 *  - sweep-to-right-edge then jump at a system break;
 *  - hold (snap, never reverse) across a repeat seam;
 *  - the caret-without-interpolation fallback (discrete steps).
 *
 * buildCaretTrack() is DOM/layout-dependent (jsdom returns zero bounding rects,
 * like buildGhosts) and is exercised via the manual verification path instead.
 */

import { describe, expect, it } from 'vitest';
import { resolveCaret } from '../caret';
import type { CaretSystem, CaretTrack } from '../caret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two systems: row 0 at top 100 (height 60, right edge 500); row 1 at top 200. */
const SYSTEMS: CaretSystem[] = [
  { index: 0, top: 100, height: 60, rightEdge: 500 },
  { index: 1, top: 200, height: 60, rightEdge: 500 },
];

function track(anchors: CaretTrack['anchors']): CaretTrack {
  return { anchors, systems: SYSTEMS };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveCaret — empty / bounds', () => {
  it('returns null for an empty track', () => {
    expect(resolveCaret({ anchors: [], systems: [] }, 0)).toBeNull();
  });

  it('returns null before the first onset (caret hidden)', () => {
    const t = track([{ timeMs: 100, x: 10, system: 0 }]);
    expect(resolveCaret(t, 50)).toBeNull();
  });

  it('pins at the last anchor when t is at or past it', () => {
    const t = track([
      { timeMs: 0, x: 10, system: 0 },
      { timeMs: 100, x: 200, system: 0 },
    ]);
    const p = resolveCaret(t, 999);
    expect(p).toEqual({ x: 200, top: 100, height: 60 });
  });

  it('uses the anchor system top/height in the placement', () => {
    const t = track([{ timeMs: 0, x: 10, system: 1 }]);
    expect(resolveCaret(t, 0)).toEqual({ x: 10, top: 200, height: 60 });
  });
});

describe('resolveCaret — interpolation within a system', () => {
  const t = track([
    { timeMs: 0, x: 100, system: 0 },
    { timeMs: 100, x: 300, system: 0 },
  ]);

  it('returns the left anchor x exactly at the onset', () => {
    expect(resolveCaret(t, 0)!.x).toBe(100);
  });

  it('linearly interpolates x at the midpoint', () => {
    expect(resolveCaret(t, 50)!.x).toBe(200);
  });

  it('interpolates at an arbitrary fraction', () => {
    expect(resolveCaret(t, 25)!.x).toBe(150);
  });

  it('coincident-time anchors do not divide by zero (frac=0)', () => {
    const z = track([
      { timeMs: 0, x: 100, system: 0 },
      { timeMs: 0, x: 300, system: 0 },
    ]);
    // idx resolves to the last anchor with timeMs<=t; t=0 → last one (x=300), pinned.
    expect(resolveCaret(z, 0)!.x).toBe(300);
  });
});

describe('resolveCaret — system break', () => {
  // Last onset of system 0 at x=400; next onset on system 1 at x=120.
  const t = track([
    { timeMs: 0, x: 400, system: 0 },
    { timeMs: 100, x: 120, system: 1 },
  ]);

  it('sweeps toward the current system right edge, not the next anchor', () => {
    // Midway: lerp(400, 500, 0.5) = 450 on system 0 (still top 100).
    const p = resolveCaret(t, 50)!;
    expect(p.x).toBe(450);
    expect(p.top).toBe(100);
  });

  it('jumps to the next system anchor at its onset time', () => {
    const p = resolveCaret(t, 100)!;
    expect(p.x).toBe(120);
    expect(p.top).toBe(200);
  });
});

describe('resolveCaret — repeat seam (backward x)', () => {
  // A repeated section replays: the next onset is to the LEFT, same system.
  const t = track([
    { timeMs: 0, x: 400, system: 0 },
    { timeMs: 100, x: 120, system: 0 },
  ]);

  it('holds at the current anchor instead of sweeping backwards', () => {
    expect(resolveCaret(t, 50)!.x).toBe(400);
  });

  it('appears at the next (earlier) anchor once its onset is reached', () => {
    expect(resolveCaret(t, 100)!.x).toBe(120);
  });
});

describe('resolveCaret — fallback (no interpolation)', () => {
  const t = track([
    { timeMs: 0, x: 100, system: 0 },
    { timeMs: 100, x: 300, system: 0 },
  ]);

  it('snaps to the current anchor (discrete steps)', () => {
    expect(resolveCaret(t, 50, false)!.x).toBe(100);
    expect(resolveCaret(t, 99, false)!.x).toBe(100);
    expect(resolveCaret(t, 100, false)!.x).toBe(300);
  });

  it('still hides before the first onset', () => {
    expect(resolveCaret(t, -1, false)).toBeNull();
  });
});
