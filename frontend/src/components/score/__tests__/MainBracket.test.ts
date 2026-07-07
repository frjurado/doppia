/**
 * Unit tests for resolveSegments() in MainBracket.tsx (Component 9 Step 3).
 *
 * Pins the §6A.1 I1 invariant (bracket ≡ committed ghost range) against the
 * Step 1 bracket-geometry fixtures:
 *  - SEL-03/SEL-08: geometry keyed on @n intervals painted unrelated partial
 *    bars sharing a bar number — key-based derivation must not.
 *  - SEL-12/SEL-13: ending measures sharing @n absorbed all sibling endings —
 *    the effective key list excludes them, and the bracket renders
 *    discontiguously (visible gap) over the exclusion.
 *  - SEL-04/SEL-05: a NaN bar number meant no bracket (measure) or a
 *    whole-movement bracket (beat/sub-beat) — non-finite human coords without
 *    a key list now yield no segments at all, never a wrong bracket.
 *  - SEL-09/SEL-10/SEL-14: sub-beat endpoints are exact — no dropped final
 *    measure, no rounding up to complete the beat.
 *
 * Uses a hand-constructed minimal ghost layer (jsdom cannot lay out SVG).
 */

import { describe, expect, it } from 'vitest';
import { resolveSegments } from '../MainBracket';
import type { GhostLayer, MeasureGhostEntry, SubBeatGhostEntry } from '../ghosts';
import { encodeSubBeat, measureGhostKey } from '../ghosts';
import type { SelectionRange } from '../annotator';

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

function makeLayer(measures: MockMeasure[]): GhostLayer {
  const measureIndex = new Map<string, MeasureGhostEntry>();
  measures.forEach((m, i) => {
    measureIndex.set(m.key, {
      el: document.createElement('div'),
      barN: m.barN,
      endingN: m.endingN ?? null,
      key: m.key,
      bounds: { left: m.left, top: (m.systemTop ?? 0) + 4, width: m.width ?? 100, height: 40 },
      systemTop: m.systemTop ?? 0,
      renderOrder: i,
    });
  });
  return {
    measureIndex,
    beatIndex: new Map(),
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

// ---------------------------------------------------------------------------
// Measure resolution — key-based derivation
// ---------------------------------------------------------------------------

describe('resolveSegments — measure resolution, key-based', () => {
  it('covers exactly the committed keys, ignoring unrelated same-@n measures (SEL-03/SEL-08)', () => {
    // Two physical measures share barN 8 (split pair around a repeat); only
    // the first is committed. The bracket must not extend over the second.
    const layer = makeLayer([
      { key: 'm7', barN: 7, left: 0 },
      { key: 'm8', barN: 8, left: 100 },
      { key: 'm8#1', barN: 8, left: 200 },
      { key: 'm9', barN: 9, left: 300 },
    ]);
    const segments = resolveSegments(
      sel({ barStart: 7, barEnd: 8, measureKeys: ['m7', 'm8'] }),
      layer,
      'measure'
    );
    expect(segments).toHaveLength(1);
    expect(segments![0]).toMatchObject({ left: 0, right: 200 });
  });

  it('renders a visible gap over an excluded sibling ending (§6A.3 discontiguous)', () => {
    // Body m1–m2, ending 1 (m3-e1), ending 2 (m3-e2), all on one system.
    // Selection enters ending 2; ending 1 is excluded from the key list.
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2', barN: 2, left: 100 },
      { key: 'm3-e1', barN: 3, endingN: 1, left: 200 },
      { key: 'm3-e2', barN: 3, endingN: 2, left: 300 },
    ]);
    const segments = resolveSegments(
      sel({
        barStart: 1,
        barEnd: 3,
        repeatContext: 'second_ending',
        measureKeys: ['m1', 'm2', 'm3-e2'],
      }),
      layer,
      'measure'
    );
    expect(segments).toHaveLength(2);
    expect(segments![0]).toMatchObject({ left: 0, right: 200, isFirst: true, isLast: false });
    expect(segments![1]).toMatchObject({ left: 300, right: 400, isFirst: false, isLast: true });
  });

  it('splits segments at system breaks as before', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0, systemTop: 0 },
      { key: 'm2', barN: 2, left: 100, systemTop: 0 },
      { key: 'm3', barN: 3, left: 0, systemTop: 300 },
    ]);
    const segments = resolveSegments(
      sel({ barStart: 1, barEnd: 3, measureKeys: ['m1', 'm2', 'm3'] }),
      layer,
      'measure'
    );
    expect(segments).toHaveLength(2);
    expect(segments![0]!.systemTop).toBe(0);
    expect(segments![1]!.systemTop).toBe(300);
    expect(segments![1]!.isLast).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallback reconstruction (no key list — stored fragments)
// ---------------------------------------------------------------------------

describe('resolveSegments — fallback without measureKeys', () => {
  it('applies the repeat_context exclusion when reconstructing from bar range (SEL-12/SEL-13)', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2-e1', barN: 2, endingN: 1, left: 100 },
      { key: 'm2-e2', barN: 2, endingN: 2, left: 200 },
    ]);
    const segments = resolveSegments(
      sel({ barStart: 1, barEnd: 2, repeatContext: 'second_ending' }),
      layer,
      'measure'
    );
    // m2-e1 excluded → gap → two segments, none covering [100, 200).
    expect(segments).toHaveLength(2);
    expect(segments![0]).toMatchObject({ left: 0, right: 100 });
    expect(segments![1]).toMatchObject({ left: 200, right: 300 });
  });

  it('returns null for non-finite human coordinates instead of a wrong bracket (SEL-04/SEL-05)', () => {
    const layer = makeLayer([
      { key: 'm1', barN: 1, left: 0 },
      { key: 'm2', barN: 2, left: 100 },
    ]);
    const segments = resolveSegments(sel({ barStart: Number.NaN, barEnd: 2 }), layer, 'measure');
    expect(segments).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sub-beat resolution — endpoint exactness (SEL-09/SEL-10/SEL-14)
// ---------------------------------------------------------------------------

describe('resolveSegments — sub-beat endpoint exactness', () => {
  /** Two 4/4 measures, sub-beat ghosts at 25px each (floats 1.0…4.5). */
  function makeSubBeatLayer(): GhostLayer {
    const measureIndex = new Map<string, MeasureGhostEntry>();
    const subBeatIndex = new Map<number, SubBeatGhostEntry>();

    [1, 2].forEach((barN, renderOrder) => {
      const key = measureGhostKey(barN, null);
      measureIndex.set(key, {
        el: document.createElement('div'),
        barN,
        endingN: null,
        key,
        bounds: { left: renderOrder * 200, top: 4, width: 200, height: 40 },
        systemTop: 0,
        renderOrder,
      });
      for (let b = 0; b < 4; b++) {
        for (let sb = 0; sb < 2; sb++) {
          const encKey = encodeSubBeat(renderOrder, b, sb);
          const beatFloat = b + 1 + sb / 2;
          subBeatIndex.set(encKey, {
            el: document.createElement('div'),
            barN,
            endingN: null,
            measureKey: key,
            beatIdx: b,
            subBeatIdx: sb,
            encodedKey: encKey,
            beatFloat,
            endFloat: beatFloat + 0.5,
            bounds: {
              left: renderOrder * 200 + b * 50 + sb * 25,
              top: 4,
              width: 25,
              height: 40,
            },
          });
        }
      }
    });

    return {
      measureIndex,
      beatIndex: new Map(),
      subBeatIndex,
    } as unknown as GhostLayer;
  }

  it('reaches the final measure when the endpoint is its first sub-beat (SEL-09/SEL-14)', () => {
    const layer = makeSubBeatLayer();
    const segments = resolveSegments(
      sel({
        barStart: 1,
        barEnd: 2,
        beatStart: 3.0,
        beatEnd: 1.5,
        measureKeys: ['m1', 'm2'],
      }),
      layer,
      'subbeat'
    );
    expect(segments).toHaveLength(1);
    // m1 from beat 3 (x=100) through m2's first sub-beat only (x=200..225).
    expect(segments![0]).toMatchObject({ left: 100, right: 225 });
  });

  it('stops exactly at the committed sub-beat — no rounding up to the full beat (SEL-10)', () => {
    const layer = makeSubBeatLayer();
    const segments = resolveSegments(
      sel({
        barStart: 1,
        barEnd: 1,
        beatStart: 1.0,
        beatEnd: 3.5,
        measureKeys: ['m1'],
      }),
      layer,
      'subbeat'
    );
    expect(segments).toHaveLength(1);
    // Beats 1.0–3.0 included (3.5 excluded): x from 0 to 125, not 150.
    expect(segments![0]).toMatchObject({ left: 0, right: 125 });
  });
});
