/**
 * Two-row label packing (M5, Component 12 Step 14).
 *
 * The DOM half of this is three lines (measure, call, write an attribute); the
 * packing is the part worth testing, which is why it is a pure function.
 */

import { describe, expect, it } from 'vitest';
import { assignLabelRows, type LabelBox } from '../staggerLabels';

const box = (left: number, width: number, lane = 0): LabelBox => ({ left, width, lane });

describe('assignLabelRows', () => {
  it('leaves labels that do not collide on the first row', () => {
    // The common case, and the reason the stagger is adaptive: most cadences
    // have names that fit, and spending a second row on them would look
    // irregular for no gain.
    expect(assignLabelRows([box(0, 40), box(60, 40), box(120, 40)])).toEqual([0, 0, 0]);
  });

  it('drops a colliding label to the second row', () => {
    // "Dominant" at 48px wide starting where "Pre-dominant" (70px) is still
    // running — the reported case.
    expect(assignLabelRows([box(0, 70), box(50, 48)])).toEqual([0, 1]);
  });

  it('returns a label to the first row once the first row has cleared', () => {
    // Third label starts past the end of the first: it belongs on row 0 again,
    // not permanently alternating.
    expect(assignLabelRows([box(0, 70), box(50, 30), box(200, 40)])).toEqual([0, 1, 0]);
  });

  it('packs the second row independently rather than dumping everything on it', () => {
    const rows = assignLabelRows([box(0, 100), box(20, 30), box(120, 40), box(160, 30)]);
    expect(rows[0]).toBe(0); // row 0 occupied to 100
    expect(rows[1]).toBe(1); // collides with the first → row 1, occupied to 50
    expect(rows[2]).toBe(0); // 120 clears row 0's 100
    expect(rows[3]).toBe(1); // 160 collides with row 0's 160 → row 1, which is free
  });

  it('never lets labels on different system rows affect each other', () => {
    // Two labels at the same x on different lanes do not collide: they are
    // rows apart on screen.
    expect(assignLabelRows([box(0, 100, 0), box(0, 100, 1)])).toEqual([0, 0]);
  });

  it('honours the minimum gap, not just literal overlap', () => {
    // Abutting labels are as unreadable as overlapping ones.
    expect(assignLabelRows([box(0, 50), box(52, 40)], 6)).toEqual([0, 1]);
    expect(assignLabelRows([box(0, 50), box(58, 40)], 6)).toEqual([0, 0]);
  });

  it('returns rows positionally, whatever order the boxes arrive in', () => {
    // Labels come from a render walk, not sorted by x.
    expect(assignLabelRows([box(50, 48), box(0, 70)])).toEqual([1, 0]);
  });

  it('handles an empty input', () => {
    expect(assignLabelRows([])).toEqual([]);
  });
});
