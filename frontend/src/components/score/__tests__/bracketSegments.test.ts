/**
 * Unit tests for resolveSegments() — moved to bracketSegments.ts with the
 * removal of the live selection bracket (M5, Component 12 Step 14).
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
import { resolveSegments, serifSides } from '../bracketSegments';
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

// ---------------------------------------------------------------------------
// Independent endpoints (Component 11 triage item 5)
// ---------------------------------------------------------------------------

describe('resolveSegments — the two endpoints constrain independently', () => {
  /**
   * One 4/4 measure with bounds [0, 200] whose eight sub-beat ghosts span only
   * [8, 200]: the 8px indent stands for the barline and clef area, which
   * carries no ghost. The indent is what makes "pin an unconstrained end to the
   * measure" and "start at the first notehead" tell apart — without it both
   * readings land on 0 and the test proves nothing.
   */
  function makeIndentedLayer(): GhostLayer {
    const measureIndex = new Map<string, MeasureGhostEntry>();
    const subBeatIndex = new Map<number, SubBeatGhostEntry>();
    const key = measureGhostKey(1, null);
    measureIndex.set(key, {
      el: document.createElement('div'),
      barN: 1,
      endingN: null,
      key,
      bounds: { left: 0, top: 4, width: 200, height: 40 },
      systemTop: 0,
      renderOrder: 0,
    });
    for (let i = 0; i < 8; i++) {
      const encKey = encodeSubBeat(0, Math.floor(i / 2), i % 2);
      subBeatIndex.set(encKey, {
        el: document.createElement('div'),
        barN: 1,
        endingN: null,
        measureKey: key,
        beatIdx: Math.floor(i / 2),
        subBeatIdx: i % 2,
        encodedKey: encKey,
        beatFloat: 1 + i * 0.5,
        endFloat: 1.5 + i * 0.5,
        bounds: { left: 8 + i * 24, top: 4, width: 24, height: 40 },
      });
    }
    return { measureIndex, beatIndex: new Map(), subBeatIndex } as unknown as GhostLayer;
  }

  it('honours a beat-precise end when the start is unconstrained', () => {
    // The ordinary shape of a last stage: prePopulateStages pins beats on the
    // selection's outer edges only, so an inner endpoint is null. Keying
    // beat-precision off beatStart alone made this whole-measure, which is why
    // a Final Tonic ran to the end of its bar.
    const segments = resolveSegments(
      sel({ barStart: 1, barEnd: 1, beatStart: null, beatEnd: 3.0, measureKeys: ['m1'] }),
      makeIndentedLayer(),
      'subbeat'
    );
    expect(segments).toHaveLength(1);
    // Ghosts 1.0–2.5 (3.0 excluded) end at x=104 — not the measure's 200.
    expect(segments![0]!.right).toBe(104);
  });

  it('pins an unconstrained start to the barline, not to the first notehead', () => {
    // Taking the ghost span would start the bracket at x=8 and leave a visible
    // gap after whatever stage ends on that barline.
    const segments = resolveSegments(
      sel({ barStart: 1, barEnd: 1, beatStart: null, beatEnd: 3.0, measureKeys: ['m1'] }),
      makeIndentedLayer(),
      'subbeat'
    );
    expect(segments![0]!.left).toBe(0);
  });

  it('pins an unconstrained end to the barline, not to the last notehead', () => {
    const segments = resolveSegments(
      sel({ barStart: 1, barEnd: 1, beatStart: 3.0, beatEnd: null, measureKeys: ['m1'] }),
      makeIndentedLayer(),
      'subbeat'
    );
    expect(segments).toHaveLength(1);
    expect(segments![0]).toMatchObject({ left: 104, right: 200 });
  });

  it('lets adjacent stages tile exactly, with no overlap at the shared beat', () => {
    // The reported symptom: two stages meeting at beat 3 drew over each other,
    // because the one with a null start covered its whole measure.
    const layer = makeIndentedLayer();
    const before = resolveSegments(
      sel({ barStart: 1, barEnd: 1, beatStart: null, beatEnd: 3.0, measureKeys: ['m1'] }),
      layer,
      'subbeat'
    );
    const after = resolveSegments(
      sel({ barStart: 1, barEnd: 1, beatStart: 3.0, beatEnd: null, measureKeys: ['m1'] }),
      layer,
      'subbeat'
    );
    expect(before![0]!.right).toBe(after![0]!.left);
  });

  it('still spans whole measures when neither endpoint is constrained', () => {
    const segments = resolveSegments(
      sel({ barStart: 1, barEnd: 1, beatStart: null, beatEnd: null, measureKeys: ['m1'] }),
      makeIndentedLayer(),
      'subbeat'
    );
    expect(segments![0]).toMatchObject({ left: 0, right: 200 });
  });
});

// ---------------------------------------------------------------------------
// serifSides (M5, Component 12 Step 14)
// ---------------------------------------------------------------------------

describe('serifSides', () => {
  const span = (left: number, right: number, lane = 0) => ({ left, right, lane });

  it('gives a lone segment both serifs', () => {
    expect(serifSides([span(0, 100)])).toEqual([{ left: true, right: true }]);
  });

  it('drops the right serif where the next segment begins', () => {
    // Sub-parts tile their parent, so this is the ordinary case: the boundary
    // is marked once, by the following bracket's left serif.
    expect(serifSides([span(0, 100), span(100, 200)])).toEqual([
      { left: true, right: false },
      { left: true, right: true },
    ]);
  });

  it('keeps both serifs when segments are separated by a gap', () => {
    expect(serifSides([span(0, 100), span(140, 200)])).toEqual([
      { left: true, right: true },
      { left: true, right: true },
    ]);
  });

  it('tolerates sub-pixel drift at the boundary', () => {
    // Extents come from measured geometry, so exact equality is not safe.
    expect(serifSides([span(0, 100), span(100.7, 200)])[0]).toEqual({
      left: true,
      right: false,
    });
  });

  it('never lets segments on different system rows suppress each other', () => {
    // A segment ending at x=100 on one row and another starting at x=100 on
    // the next row do not touch on screen.
    expect(serifSides([span(0, 100, 0), span(100, 200, 1)])).toEqual([
      { left: true, right: true },
      { left: true, right: true },
    ]);
  });

  it('does not let a segment suppress its own right serif', () => {
    // A zero-width segment's left equals its right; it must not match itself.
    expect(serifSides([span(50, 50)])).toEqual([{ left: true, right: true }]);
  });

  it('returns sides positionally, whatever order the spans arrive in', () => {
    expect(serifSides([span(100, 200), span(0, 100)])).toEqual([
      { left: true, right: true },
      { left: true, right: false },
    ]);
  });
});
