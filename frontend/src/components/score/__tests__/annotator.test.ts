/**
 * Unit tests for frontend/src/components/score/annotator.ts.
 *
 * Covers: buildDirectiveBarriers, buildVoltaIndex, computeSelectionKeys,
 * deriveRepeatContext, ghostFromTarget, measureKeyRange, numericKeyRange,
 * and AnnotationSession interaction (measure drag, endpoint re-selection,
 * barrier clamping, volta gates and effective-range exclusion, beat drag,
 * repeat context, resolution toggle, flag management).
 *
 * The AnnotationSession tests use a minimal GhostLayer constructed in
 * jsdom, with ghost elements appended via the public _appendXxxGhost methods
 * and entries added directly to the public index Maps. Mouse events are
 * dispatched synthetically; jsdom ignores CSS pointer-events so bubbling
 * works regardless of the overlay's pointer-events: none style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnnotationSession,
  buildDirectiveBarriers,
  buildVoltaIndex,
  computeSelectionKeys,
  deriveRepeatContext,
  ghostFromTarget,
  handleFromTarget,
  measureKeyRange,
  numericKeyRange,
} from '../annotator';
import type { VoltaIndex } from '../annotator';
import { GhostLayer, encodeBeat, encodeSubBeat, measureGhostKey } from '../ghosts';
import type { BeatGhostEntry, MeasureGhostEntry, SubBeatGhostEntry } from '../ghosts';

// ---------------------------------------------------------------------------
// buildDirectiveBarriers (ADR-025: D.C./D.S. only — repeat barlines are free)
// ---------------------------------------------------------------------------

describe('buildDirectiveBarriers', () => {
  it('returns an empty set when the MEI has no D.C./D.S. directions', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/><measure n="2"/><measure n="3"/>
    </score></mdiv></body></music></mei>`;
    expect(buildDirectiveBarriers(mei).size).toBe(0);
  });

  it('does NOT mark a measure with @right="rptend" (ADR-025)', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="4" right="rptend"/>
    </score></mdiv></body></music></mei>`;
    expect(buildDirectiveBarriers(mei).size).toBe(0);
  });

  it('does NOT mark a measure with @right="rptboth" (ADR-025)', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="8" right="rptboth"/>
    </score></mdiv></body></music></mei>`;
    expect(buildDirectiveBarriers(mei).size).toBe(0);
  });

  it('identifies a da capo direction inside a measure', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="16"><dir>D.C. al Fine</dir></measure>
    </score></mdiv></body></music></mei>`;
    const barriers = buildDirectiveBarriers(mei);
    expect(barriers.has(measureGhostKey(16, null))).toBe(true);
  });

  it('identifies a dal segno direction inside a measure', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="32"><dir>D.S. al Coda</dir></measure>
    </score></mdiv></body></music></mei>`;
    const barriers = buildDirectiveBarriers(mei);
    expect(barriers.has(measureGhostKey(32, null))).toBe(true);
  });

  it('does not mark an open-repeat barline as a barrier', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1" right="rptstart"/><measure n="2"/>
    </score></mdiv></body></music></mei>`;
    expect(buildDirectiveBarriers(mei).size).toBe(0);
  });

  it('includes ending context in the barrier key when measure is inside an ending', () => {
    const mei = `<mei><music><body><mdiv><score>
      <ending n="1"><measure n="12"><dir>D.C.</dir></measure></ending>
    </score></mdiv></body></music></mei>`;
    const barriers = buildDirectiveBarriers(mei);
    expect(barriers.has(measureGhostKey(12, 1))).toBe(true);
    expect(barriers.has(measureGhostKey(12, null))).toBe(false);
  });

  it('uses the deduplicated key for a D.C. measure whose @n was seen before', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/>
      <measure n="1"><dir>D.C. al Fine</dir></measure>
    </score></mdiv></body></music></mei>`;
    const barriers = buildDirectiveBarriers(mei);
    expect(barriers.has('m1#1')).toBe(true);
    expect(barriers.has('m1')).toBe(false);
    expect(barriers.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildVoltaIndex (§6A.3)
// ---------------------------------------------------------------------------

describe('buildVoltaIndex', () => {
  it('returns no groups for ending-free MEI', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/><measure n="2"/>
    </score></mdiv></body></music></mei>`;
    const volta = buildVoltaIndex(mei);
    expect(volta.groups.length).toBe(0);
    expect(volta.byKey.size).toBe(0);
  });

  it('groups contiguous endings and records ending membership and finalN', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/>
      <ending n="1"><measure n="2"/><measure n="3"/></ending>
      <ending n="2"><measure n="2"/><measure n="3"/></ending>
      <measure n="4"/>
    </score></mdiv></body></music></mei>`;
    const volta = buildVoltaIndex(mei);
    expect(volta.groups.length).toBe(1);
    const g = volta.groups[0]!;
    expect(g.finalN).toBe(2);
    expect(g.endings.get(1)).toEqual(['m2-e1', 'm3-e1']);
    expect(g.endings.get(2)).toEqual(['m2-e2', 'm3-e2']);
    expect(g.allKeys).toEqual(['m2-e1', 'm3-e1', 'm2-e2', 'm3-e2']);
    expect(volta.byKey.get('m3-e2')).toEqual({ groupIdx: 0, endingN: 2 });
  });

  it('resolves the jump target from a preceding @left="rptstart"', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/>
      <measure n="2" left="rptstart"/>
      <measure n="3"/>
      <ending n="1"><measure n="4" right="rptend"/></ending>
      <ending n="2"><measure n="4"/></ending>
    </score></mdiv></body></music></mei>`;
    const volta = buildVoltaIndex(mei);
    expect(volta.groups[0]!.jumpTargetKey).toBe('m2');
  });

  it('resolves the jump target after a @right="rptboth" measure', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1" right="rptboth"/>
      <measure n="2"/>
      <ending n="1"><measure n="3" right="rptend"/></ending>
      <ending n="2"><measure n="3"/></ending>
    </score></mdiv></body></music></mei>`;
    const volta = buildVoltaIndex(mei);
    expect(volta.groups[0]!.jumpTargetKey).toBe('m2');
  });

  it('defaults the jump target to the first measure when no repeat-start exists', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/>
      <ending n="1"><measure n="2" right="rptend"/></ending>
      <ending n="2"><measure n="2"/></ending>
    </score></mdiv></body></music></mei>`;
    const volta = buildVoltaIndex(mei);
    expect(volta.groups[0]!.jumpTargetKey).toBe('m1');
  });

  it('separates two volta groups split by body measures', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1" left="rptstart"/>
      <ending n="1"><measure n="2"/></ending>
      <ending n="2"><measure n="2"/></ending>
      <measure n="3" left="rptstart"/>
      <ending n="1"><measure n="4"/></ending>
      <ending n="2"><measure n="4"/></ending>
    </score></mdiv></body></music></mei>`;
    const volta = buildVoltaIndex(mei);
    expect(volta.groups.length).toBe(2);
    expect(volta.groups[0]!.jumpTargetKey).toBe('m1');
    expect(volta.groups[1]!.jumpTargetKey).toBe('m3');
  });
});

// ---------------------------------------------------------------------------
// computeSelectionKeys (§6A.2–6A.3)
// ---------------------------------------------------------------------------

describe('computeSelectionKeys', () => {
  // Layout: m1 m2 | ending1: m3-e1 m4-e1 | ending2: m3-e2 m4-e2 | m5
  const keys = ['m1', 'm2', 'm3-e1', 'm4-e1', 'm3-e2', 'm4-e2', 'm5'];
  const noBarriers = new Set<string>();

  function makeVolta(jumpTargetKey: string | null): VoltaIndex {
    return {
      byKey: new Map([
        ['m3-e1', { groupIdx: 0, endingN: 1 }],
        ['m4-e1', { groupIdx: 0, endingN: 1 }],
        ['m3-e2', { groupIdx: 0, endingN: 2 }],
        ['m4-e2', { groupIdx: 0, endingN: 2 }],
      ]),
      groups: [
        {
          endings: new Map([
            [1, ['m3-e1', 'm4-e1']],
            [2, ['m3-e2', 'm4-e2']],
          ]),
          allKeys: ['m3-e1', 'm4-e1', 'm3-e2', 'm4-e2'],
          finalN: 2,
          jumpTargetKey,
        },
      ],
    };
  }

  it('returns the plain interval when no volta groups exist', () => {
    expect(computeSelectionKeys('m1', 'm5', keys, noBarriers, null)).toEqual(keys);
  });

  it('still clamps at directive barriers', () => {
    const barriers = new Set(['m2']);
    expect(computeSelectionKeys('m1', 'm5', keys, barriers, makeVolta('m1'))).toEqual(['m1', 'm2']);
  });

  it('clamps a forward drag from ending 1 at the sibling-ending gate', () => {
    expect(computeSelectionKeys('m3-e1', 'm3-e2', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm3-e1',
      'm4-e1',
    ]);
  });

  it('clamps a non-final-ending anchor extended past its group', () => {
    expect(computeSelectionKeys('m3-e1', 'm5', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm3-e1',
      'm4-e1',
    ]);
  });

  it('allows a final-ending anchor to extend past the group', () => {
    expect(computeSelectionKeys('m3-e2', 'm5', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm3-e2',
      'm4-e2',
      'm5',
    ]);
  });

  it('entering ending 2 from the body excludes ending 1 (row 2, discontiguous)', () => {
    expect(computeSelectionKeys('m1', 'm4-e2', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm1',
      'm2',
      'm3-e2',
      'm4-e2',
    ]);
  });

  it('entering ending 1 from the body keeps ending 1 only (row 2)', () => {
    expect(computeSelectionKeys('m1', 'm4-e1', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm1',
      'm2',
      'm3-e1',
      'm4-e1',
    ]);
  });

  it('backward drag from ending 2 into the body skips ending 1', () => {
    expect(computeSelectionKeys('m4-e2', 'm1', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm1',
      'm2',
      'm3-e2',
      'm4-e2',
    ]);
  });

  it('backward drag from ending 2 hovering inside ending 1 clamps at the gate', () => {
    expect(computeSelectionKeys('m4-e2', 'm4-e1', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm3-e2',
      'm4-e2',
    ]);
  });

  it('wholly contained group including its repeat-start keeps all endings (row 3)', () => {
    expect(computeSelectionKeys('m1', 'm5', keys, noBarriers, makeVolta('m2'))).toEqual([
      'm1',
      'm2',
      'm3-e1',
      'm4-e1',
      'm3-e2',
      'm4-e2',
      'm5',
    ]);
  });

  it('wholly contained group without its repeat-start excludes non-final endings (row 4)', () => {
    expect(computeSelectionKeys('m2', 'm5', keys, noBarriers, makeVolta('m1'))).toEqual([
      'm2',
      'm3-e2',
      'm4-e2',
      'm5',
    ]);
  });

  it('unknown jump target (null) takes the conservative row-4 path', () => {
    expect(computeSelectionKeys('m1', 'm5', keys, noBarriers, makeVolta(null))).toEqual([
      'm1',
      'm2',
      'm3-e2',
      'm4-e2',
      'm5',
    ]);
  });
});

// ---------------------------------------------------------------------------
// deriveRepeatContext (§6A.3)
// ---------------------------------------------------------------------------

describe('deriveRepeatContext', () => {
  const volta: VoltaIndex = {
    byKey: new Map([
      ['m3-e1', { groupIdx: 0, endingN: 1 }],
      ['m3-e2', { groupIdx: 0, endingN: 2 }],
    ]),
    groups: [
      {
        endings: new Map([
          [1, ['m3-e1']],
          [2, ['m3-e2']],
        ]),
        allKeys: ['m3-e1', 'm3-e2'],
        finalN: 2,
        jumpTargetKey: 'm1',
      },
    ],
  };

  it('returns null for a selection without ending measures', () => {
    expect(deriveRepeatContext(['m1', 'm2'], volta)).toBeNull();
  });

  it('returns first_ending when only ending 1 is represented', () => {
    expect(deriveRepeatContext(['m2', 'm3-e1'], volta)).toBe('first_ending');
  });

  it('returns second_ending when only the final ending is represented', () => {
    expect(deriveRepeatContext(['m2', 'm3-e2'], volta)).toBe('second_ending');
  });

  it('returns null when the full group is represented (row 3)', () => {
    expect(deriveRepeatContext(['m2', 'm3-e1', 'm3-e2', 'm4'], volta)).toBeNull();
  });

  it('returns null without a volta index', () => {
    expect(deriveRepeatContext(['m3-e1'], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ghostFromTarget
// ---------------------------------------------------------------------------

describe('ghostFromTarget', () => {
  it('returns the element itself when it carries .ghost', () => {
    const el = document.createElement('div');
    el.className = 'ghost ghost-measure';
    expect(ghostFromTarget(el)).toBe(el);
  });

  it('returns null when target has no .ghost ancestor', () => {
    const el = document.createElement('div');
    el.className = 'score-content';
    expect(ghostFromTarget(el)).toBeNull();
  });

  it('returns null for null target', () => {
    expect(ghostFromTarget(null)).toBeNull();
  });

  it('returns null for a .ghost-handle element (handles are not ghosts)', () => {
    const el = document.createElement('div');
    el.className = 'ghost-handle ghost-handle-left';
    expect(ghostFromTarget(el)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleFromTarget
// ---------------------------------------------------------------------------

describe('handleFromTarget', () => {
  it('returns the element itself when it carries .ghost-handle', () => {
    const el = document.createElement('div');
    el.className = 'ghost-handle ghost-handle-left';
    expect(handleFromTarget(el)).toBe(el);
  });

  it('returns null for a .ghost element', () => {
    const el = document.createElement('div');
    el.className = 'ghost ghost-measure';
    expect(handleFromTarget(el)).toBeNull();
  });

  it('returns null for null target', () => {
    expect(handleFromTarget(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// measureKeyRange
// ---------------------------------------------------------------------------

describe('measureKeyRange', () => {
  const keys = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const noBarriers = new Set<string>();

  it('returns all keys between anchor and current (forward)', () => {
    expect(measureKeyRange('m1', 'm3', keys, noBarriers)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns all keys between anchor and current (backward drag)', () => {
    expect(measureKeyRange('m4', 'm2', keys, noBarriers)).toEqual(['m2', 'm3', 'm4']);
  });

  it('returns a single key when anchor equals current', () => {
    expect(measureKeyRange('m3', 'm3', keys, noBarriers)).toEqual(['m3']);
  });

  it('clamps the selection at a barrier measure (cannot extend past it)', () => {
    const barriers = new Set(['m3']);
    // Dragging forward past m3 → clamped at m3.
    expect(measureKeyRange('m1', 'm5', keys, barriers)).toEqual(['m1', 'm2', 'm3']);
  });

  it('allows a selection ending exactly at the barrier measure', () => {
    const barriers = new Set(['m3']);
    expect(measureKeyRange('m1', 'm3', keys, barriers)).toEqual(['m1', 'm2', 'm3']);
  });

  it('clamps at the first barrier when multiple barriers exist', () => {
    const barriers = new Set(['m2', 'm4']);
    expect(measureKeyRange('m1', 'm5', keys, barriers)).toEqual(['m1', 'm2']);
  });

  // G2.1 — symmetric backward clamping
  it('clamps a backward drag at the barrier (anchor stays on its side)', () => {
    const barriers = new Set(['m3']);
    // Anchor at m5, drag backward through m1 — barrier at m3 blocks the crossing.
    // Selection is confined to the anchor's side: [m4, m5].
    expect(measureKeyRange('m5', 'm1', keys, barriers)).toEqual(['m4', 'm5']);
  });

  it('backward drag ending exactly at the barrier measure is blocked (anchor side only)', () => {
    const barriers = new Set(['m3']);
    // Anchor at m5, current at m3 — the barrier is at m3, so m3 is excluded.
    expect(measureKeyRange('m5', 'm3', keys, barriers)).toEqual(['m4', 'm5']);
  });

  it('backward drag not crossing any barrier is unaffected', () => {
    const barriers = new Set(['m3']);
    // Anchor at m5, current at m4 — no barrier between them.
    expect(measureKeyRange('m5', 'm4', keys, barriers)).toEqual(['m4', 'm5']);
  });

  it('backward drag clamps at the nearest barrier when multiple barriers exist', () => {
    const barriers = new Set(['m2', 'm4']);
    // Anchor at m5, drag to m1 — nearest barrier going backward from m5 is m4.
    // Selection is confined to [m5] (barrier+1 = m5 = anchor).
    expect(measureKeyRange('m5', 'm1', keys, barriers)).toEqual(['m5']);
  });

  it('returns [anchorKey] when anchorKey is not in orderedKeys', () => {
    expect(measureKeyRange('mX', 'm3', keys, noBarriers)).toEqual([]);
  });

  it('returns empty array when both keys are missing', () => {
    expect(measureKeyRange('mX', 'mY', keys, noBarriers)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// numericKeyRange
// ---------------------------------------------------------------------------

describe('numericKeyRange', () => {
  const keys = [100, 200, 300, 400, 500];

  it('returns keys between lo and hi inclusive (forward)', () => {
    expect(numericKeyRange(200, 400, keys)).toEqual([200, 300, 400]);
  });

  it('returns keys between lo and hi inclusive (backward)', () => {
    expect(numericKeyRange(400, 200, keys)).toEqual([200, 300, 400]);
  });

  it('returns a single key when anchor equals current', () => {
    expect(numericKeyRange(300, 300, keys)).toEqual([300]);
  });

  it('returns empty array when no keys fall in the range', () => {
    expect(numericKeyRange(150, 160, keys)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession helpers
// ---------------------------------------------------------------------------

/** Build a minimal GhostLayer container and populate n measure ghosts. */
function makeLayerWithMeasures(
  barNs: number[],
  endingNs?: (number | null)[]
): {
  container: HTMLDivElement;
  layer: GhostLayer;
  els: HTMLDivElement[];
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const layer = new GhostLayer(container);

  const els: HTMLDivElement[] = barNs.map((barN, i) => {
    const endingN = endingNs?.[i] ?? null;
    const key = measureGhostKey(barN, endingN);
    const el = document.createElement('div');
    el.className = 'ghost ghost-measure';
    el.dataset['key'] = key;
    layer._appendMeasureGhost(el);
    layer.measureIndex.set(key, {
      el,
      barN,
      endingN,
      key,
      bounds: { left: i * 100, top: 0, width: 100, height: 50 },
      systemTop: 0,
      renderOrder: i,
    } satisfies MeasureGhostEntry);
    return el;
  });

  return { container, layer, els };
}

/**
 * Build a GhostLayer with beat ghosts. Beats are in measures barN[], beatIdx 0..numBeats-1.
 *
 * renderOrder is assigned sequentially (0, 1, 2, …) in the order measures appear in the
 * array; each beat's encodedKey is encodeBeat(renderOrder, beatIdx) to mirror the
 * production buildGhosts behaviour (G2.3: renderOrder avoids barN collisions).
 *
 * measureKey defaults to measureGhostKey(barN, null) but can be overridden per-measure.
 */
function makeLayerWithBeats(
  measures: Array<{ barN: number; numBeats: number; subDiv?: number; measureKey?: string }>
): {
  container: HTMLDivElement;
  layer: GhostLayer;
  beatEls: Map<number, HTMLDivElement>;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const layer = new GhostLayer(container);
  const beatEls = new Map<number, HTMLDivElement>();

  measures.forEach(({ barN, numBeats, subDiv = 2, measureKey }, renderOrder) => {
    const mKey = measureKey ?? measureGhostKey(barN, null);
    for (let b = 0; b < numBeats; b++) {
      const encKey = encodeBeat(renderOrder, b);
      const beatFloat = b + 1; // 1-indexed
      const el = document.createElement('div');
      el.className = 'ghost ghost-beat';
      el.dataset['key'] = `${encKey}`;
      layer._appendBeatGhost(el);
      layer.beatIndex.set(encKey, {
        el,
        barN,
        endingN: null,
        measureKey: mKey,
        beatIdx: b,
        encodedKey: encKey,
        beatFloat,
        endFloat: beatFloat + 1,
        bounds: { left: 0, top: 0, width: 50, height: 20 },
      } satisfies BeatGhostEntry);
      beatEls.set(encKey, el);
      void subDiv; // used only for sub-beat layer, not needed here
    }
  });

  return { container, layer, beatEls };
}

/** Synthesise and dispatch mouse events to simulate a measure drag. */
function measureDrag(els: HTMLDivElement[], anchorIdx: number, throughIdxs: number[]): void {
  els[anchorIdx]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  for (const idx of throughIdxs) {
    els[idx]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  }
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// AnnotationSession — measure drag
// ---------------------------------------------------------------------------

describe('AnnotationSession — measure drag', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let els: HTMLDivElement[];
  let session: AnnotationSession;

  beforeEach(() => {
    ({ container, layer, els } = makeLayerWithMeasures([1, 2, 3, 4, 5]));
    session = new AnnotationSession(layer, { resolution: 'measure' });
  });

  afterEach(() => {
    session.destroy();
    container.remove();
  });

  it('drag across three measures commits barStart and barEnd', () => {
    measureDrag(els, 0, [1, 2]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(3);
  });

  it('sets fragmentSet=true after the first commit', () => {
    expect(session.flags.fragmentSet).toBe(false);
    measureDrag(els, 0, []);
    expect(session.flags.fragmentSet).toBe(true);
  });

  it('beatStart and beatEnd are null for measure-level selection', () => {
    measureDrag(els, 0, [2]);
    expect(session.selection?.beatStart).toBeNull();
    expect(session.selection?.beatEnd).toBeNull();
  });

  it('single-measure click-without-drag commits a one-measure selection', () => {
    measureDrag(els, 2, []);
    expect(session.selection?.barStart).toBe(3);
    expect(session.selection?.barEnd).toBe(3);
  });

  it('darks ghosts during drag', () => {
    els[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    els[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    expect(els[0]!.classList.contains('dark')).toBe(true);
    expect(els[1]!.classList.contains('dark')).toBe(true);
    expect(els[2]!.classList.contains('dark')).toBe(false);
    // Release without committing to any ghost.
    document.dispatchEvent(new MouseEvent('mouseup'));
  });

  it('promotes lit ghosts to dark on commit', () => {
    measureDrag(els, 0, [1]);
    expect(els[0]!.classList.contains('dark')).toBe(true);
    expect(els[1]!.classList.contains('dark')).toBe(true);
    expect(els[0]!.classList.contains('light')).toBe(false);
  });

  it('invoking onSelectionChange fires with the committed range', () => {
    const cb = vi.fn();
    session.onSelectionChange(cb);
    measureDrag(els, 1, [3]);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]![0]).toMatchObject({ barStart: 2, barEnd: 4 });
  });

  it('backward drag (anchor right, extend left) commits correct barStart/barEnd', () => {
    measureDrag(els, 3, [1]);
    expect(session.selection?.barStart).toBe(2);
    expect(session.selection?.barEnd).toBe(4);
  });

  it('dragging the left (first) endpoint re-anchors from the right end', () => {
    // First commit a 3-measure selection [m2, m3, m4].
    measureDrag(els, 1, [3]);
    expect(session.selection?.barStart).toBe(2);
    expect(session.selection?.barEnd).toBe(4);

    // Now mousedown on the leftmost dark ghost (m2, index 1) — should anchor from m4.
    // Then drag to m1 → new selection [m1, m2, m3, m4].
    els[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(4);
  });

  it('dragging the right (last) endpoint re-anchors from the left end', () => {
    measureDrag(els, 1, [3]);
    // Mousedown on rightmost dark ghost (m4, index 3) — anchor from m2 (index 1).
    // Drag to m5 → new selection [m2, m3, m4, m5].
    els[3]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    els[4]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(2);
    expect(session.selection?.barEnd).toBe(5);
  });

  // G3.1 — handle ghost drag
  it('handle ghosts are positioned after commit and appear on hover over dark ghost', () => {
    measureDrag(els, 1, [3]); // commit [m2, m3, m4]
    const leftHandle = layer.overlay.querySelector('.ghost-handle-left') as HTMLElement | null;
    const rightHandle = layer.overlay.querySelector('.ghost-handle-right') as HTMLElement | null;
    expect(leftHandle).not.toBeNull();
    expect(rightHandle).not.toBeNull();
    // Handles are positioned at opacity 0 (interactive but invisible) until hover.
    expect(leftHandle?.style.opacity).toBe('0');
    expect(rightHandle?.style.opacity).toBe('0');
    // Hover over a dark ghost → handles appear.
    els[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(leftHandle?.style.opacity).not.toBe('0');
    expect(rightHandle?.style.opacity).not.toBe('0');
  });

  it('mousedown on the left handle re-anchors from the right end (extends left)', () => {
    // Commit a selection [m2, m3, m4].
    measureDrag(els, 1, [3]);
    expect(session.selection?.barStart).toBe(2);
    expect(session.selection?.barEnd).toBe(4);

    // The left handle re-anchors from m4 (last). Dragging to m1 → [m1,m2,m3,m4].
    const leftHandle = layer.overlay.querySelector('.ghost-handle-left') as HTMLElement;
    leftHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(4);
  });

  it('mousedown on the right handle re-anchors from the left end (extends right)', () => {
    // Commit a selection [m2, m3, m4].
    measureDrag(els, 1, [3]);
    expect(session.selection?.barStart).toBe(2);
    expect(session.selection?.barEnd).toBe(4);

    // The right handle re-anchors from m2 (first). Dragging to m5 → [m2,m3,m4,m5].
    const rightHandle = layer.overlay.querySelector('.ghost-handle-right') as HTMLElement;
    rightHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    els[4]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(2);
    expect(session.selection?.barEnd).toBe(5);
  });

  it('handle ghosts are hidden during a handle drag and reappear on hover after commit', () => {
    measureDrag(els, 1, [3]); // commit [m2, m3, m4]

    const leftHandle = layer.overlay.querySelector('.ghost-handle-left') as HTMLElement;
    const rightHandle = layer.overlay.querySelector('.ghost-handle-right') as HTMLElement;

    // Hover to show handles.
    els[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(leftHandle.style.opacity).not.toBe('0');

    // Begin handle drag — handles should go invisible immediately (opacity 0).
    leftHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(leftHandle.style.opacity).toBe('0');
    expect(rightHandle.style.opacity).toBe('0');

    // Drag to el[0] and commit.
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    // After commit, handles are invisible (opacity 0) until next hover.
    expect(leftHandle.style.opacity).toBe('0');
    expect(rightHandle.style.opacity).toBe('0');
    // Hover over a dark ghost → handles reappear.
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(leftHandle.style.opacity).not.toBe('0');
    expect(rightHandle.style.opacity).not.toBe('0');
  });

  it('handles are deactivated (display:none) after reset()', () => {
    measureDrag(els, 0, [2]); // commit
    const leftHandle = layer.overlay.querySelector('.ghost-handle-left') as HTMLElement;
    // Hover to show handles (opacity > 0).
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(leftHandle.style.opacity).not.toBe('0');
    // reset() fully deactivates — display:none, not just opacity:0.
    session.reset();
    expect(leftHandle.style.display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — directive barrier clamping (D.C./D.S., §6A.2)
// ---------------------------------------------------------------------------

describe('AnnotationSession — directive barrier clamping', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let els: HTMLDivElement[];
  let session: AnnotationSession;

  beforeEach(() => {
    ({ container, layer, els } = makeLayerWithMeasures([1, 2, 3, 4, 5]));
    // Measure m3 carries a D.C./D.S. directive.
    const barriers = new Set([measureGhostKey(3, null)]);
    session = new AnnotationSession(layer, {
      resolution: 'measure',
      barrierMeasures: barriers,
    });
  });

  afterEach(() => {
    session.destroy();
    container.remove();
  });

  it('clamps a forward drag at the barrier measure', () => {
    // Drag from m1 through m5 — should clamp at m3.
    measureDrag(els, 0, [1, 2, 3, 4]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(3);
  });

  it('allows a selection that ends exactly at the barrier measure', () => {
    measureDrag(els, 0, [1, 2]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(3);
  });

  it('a selection that does not reach the barrier is unaffected', () => {
    measureDrag(els, 0, [1]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(2);
  });

  it('a selection starting after the barrier is also unaffected', () => {
    measureDrag(els, 3, [4]);
    expect(session.selection?.barStart).toBe(4);
    expect(session.selection?.barEnd).toBe(5);
  });

  // G2.1 — symmetric backward clamping via AnnotationSession
  it('clamps a backward drag at the barrier — anchor stays on its side', () => {
    // Anchor at m5 (index 4), drag backward past the barrier at m3 to m1.
    // Expected: selection [m4, m5] (barrier blocks backward crossing).
    measureDrag(els, 4, [3, 2, 1, 0]);
    expect(session.selection?.barStart).toBe(4);
    expect(session.selection?.barEnd).toBe(5);
  });

  it('backward drag that stops before the barrier is unaffected', () => {
    // Anchor at m5, drag backward only to m4 — no barrier crossed.
    measureDrag(els, 4, [3]);
    expect(session.selection?.barStart).toBe(4);
    expect(session.selection?.barEnd).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — repeat context capture
// ---------------------------------------------------------------------------

describe('AnnotationSession — repeat context', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('captures first_ending context when selection spans an ending-1 measure', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2, 12, 12], [null, null, 1, 2]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });
    // Drag from m1 through m12-e1 (index 2).
    measureDrag(els, 0, [1, 2]);
    expect(session.selection?.repeatContext).toBe('first_ending');
    session.destroy();
    container.remove();
  });

  it('captures second_ending context when selection is inside ending 2', () => {
    const { container, layer, els } = makeLayerWithMeasures([12], [2]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });
    measureDrag(els, 0, []);
    expect(session.selection?.repeatContext).toBe('second_ending');
    session.destroy();
    container.remove();
  });

  it('repeatContext is null when selection has no ending-bearing ghosts', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2, 3]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });
    measureDrag(els, 0, [2]);
    expect(session.selection?.repeatContext).toBeNull();
    session.destroy();
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — resolution toggle
// ---------------------------------------------------------------------------

describe('AnnotationSession — resolution toggle', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let session: AnnotationSession;

  beforeEach(() => {
    ({ container, layer } = makeLayerWithMeasures([1, 2, 3]));
    session = new AnnotationSession(layer, { resolution: 'measure' });
  });

  afterEach(() => {
    session.destroy();
    container.remove();
  });

  it('setResolution switches the active layer pointer-events without rebuilding ghosts', () => {
    const initialGhostCount = layer.measureIndex.size;

    const measureLayer = layer.overlay.querySelector('.ghost-layer-measure') as HTMLElement;
    const beatLayer = layer.overlay.querySelector('.ghost-layer-beat') as HTMLElement;

    // Before toggle: measure layer should be active (auto).
    expect(measureLayer?.style.pointerEvents).toBe('auto');
    expect(beatLayer?.style.pointerEvents).toBe('none');

    session.setResolution('beat');

    // After toggle: beat layer active, measure layer inactive.
    expect(beatLayer?.style.pointerEvents).toBe('auto');
    expect(measureLayer?.style.pointerEvents).toBe('none');

    // Ghost counts unchanged — no rebuild.
    expect(layer.measureIndex.size).toBe(initialGhostCount);
  });

  it('calling setResolution with the same mode is a no-op', () => {
    const measureLayer = layer.overlay.querySelector('.ghost-layer-measure') as HTMLElement;
    session.setResolution('measure'); // same as current
    expect(measureLayer?.style.pointerEvents).toBe('auto');
  });

  it('resolution toggle preserves committed selection and cancels any in-progress drag', () => {
    // Commit a selection first.
    const { els: testEls, layer: testLayer, container: tc } = makeLayerWithMeasures([1, 2, 3]);
    const sess = new AnnotationSession(testLayer, { resolution: 'measure' });

    measureDrag(testEls, 0, [2]);
    expect(sess.selection?.barStart).toBe(1);
    expect(sess.flags.fragmentSet).toBe(true);

    // Start an in-progress endpoint re-anchor drag then toggle resolution mid-drag.
    testEls[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    testEls[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    sess.setResolution('beat'); // cancels drag; keeps committed selection

    // Selection is preserved; fragmentSet remains true.
    expect(sess.selection?.barStart).toBe(1);
    expect(sess.flags.fragmentSet).toBe(true);

    // mouseup after toggle should not commit a new selection (dragging = false).
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(sess.selection?.barStart).toBe(1); // unchanged

    sess.destroy();
    tc.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — beat drag
// ---------------------------------------------------------------------------

describe('AnnotationSession — beat drag', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let beatEls: Map<number, HTMLDivElement>;
  let session: AnnotationSession;

  beforeEach(() => {
    // Two measures of 4/4 (4 beats each).
    ({ container, layer, beatEls } = makeLayerWithBeats([
      { barN: 1, numBeats: 4 },
      { barN: 2, numBeats: 4 },
    ]));
    session = new AnnotationSession(layer, { resolution: 'beat' });
  });

  afterEach(() => {
    session.destroy();
    container.remove();
  });

  it('beat drag within one measure commits barStart, barEnd, and beatStart', () => {
    // makeLayerWithBeats uses encodeBeat(renderOrder, beatIdx).
    // renderOrder 0 = first measure in the array (barN=1).
    const r0b0 = encodeBeat(0, 0); // renderOrder=0, beat 0 (float 1.0)
    const r0b2 = encodeBeat(0, 2); // renderOrder=0, beat 2 (float 3.0)
    beatEls
      .get(r0b0)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    beatEls
      .get(r0b2)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(1);
    expect(session.selection?.beatStart).toBe(1.0); // beat index 0 → float 1.0
    // beatEnd should be last.beatFloat + 1.0 = 3.0 + 1.0 = 4.0
    expect(session.selection?.beatEnd).toBe(4.0);
  });

  it('beat drag spanning two measures sets correct barStart and barEnd', () => {
    const r0b0 = encodeBeat(0, 0); // renderOrder=0 (barN=1), beat 0
    const r1b1 = encodeBeat(1, 1); // renderOrder=1 (barN=2), beat 1
    beatEls
      .get(r0b0)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    beatEls
      .get(r1b1)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(2);
  });

  it('dragging the left endpoint in beat mode re-anchors from the right', () => {
    // Commit beats r0b0..r0b2 (beatFloats 1.0, 2.0, 3.0).
    const r0b0 = encodeBeat(0, 0); // renderOrder=0, beat 0
    const r0b2 = encodeBeat(0, 2); // renderOrder=0, beat 2
    beatEls.get(r0b0)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    beatEls.get(r0b2)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    // Click on the leftmost dark beat (r0b0) — anchor should re-set to r0b2
    // (the rightmost dark beat). Then drag to r1b0 → range is [r0b2, r0b3, r1b0].
    const r1b0 = encodeBeat(1, 0); // renderOrder=1, beat 0
    beatEls.get(r0b0)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    beatEls.get(r1b0)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    // The anchor is now r0b2 (float 3.0); range runs r0b2→r1b0.
    expect(session.selection?.beatStart).toBe(3.0); // r0b2's beatFloat
    expect(session.selection?.barEnd).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — concurrent flags
// ---------------------------------------------------------------------------

describe('AnnotationSession — concurrent flags', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let session: AnnotationSession;

  beforeEach(() => {
    ({ container, layer } = makeLayerWithMeasures([1, 2]));
    session = new AnnotationSession(layer);
  });

  afterEach(() => {
    session.destroy();
    container.remove();
  });

  it('initial flags are all false', () => {
    expect(session.flags).toEqual({
      fragmentSet: false,
      conceptSet: false,
      stagesComplete: false,
      propertiesComplete: false,
    });
  });

  it('setConceptSet fires onFlagsChange', () => {
    const cb = vi.fn();
    session.onFlagsChange(cb);
    session.setConceptSet(true);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]![0].conceptSet).toBe(true);
  });

  it('setting the same value twice does not fire onFlagsChange a second time', () => {
    const cb = vi.fn();
    session.onFlagsChange(cb);
    session.setConceptSet(true);
    session.setConceptSet(true);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('flags.get returns a snapshot — mutation does not affect session state', () => {
    const snap = session.flags as Record<string, boolean>;
    snap['conceptSet'] = true;
    expect(session.flags.conceptSet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — volta ending gates and effective range (§6A.2–6A.3)
// ---------------------------------------------------------------------------

describe('AnnotationSession — volta ending gates', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let els: HTMLDivElement[];
  let session: AnnotationSession;

  // Volta fixture: m1–m5 main body, m6-e1/m7-e1 first ending,
  // m6-e2/m7-e2 second ending, m8 continuation. No directive barriers —
  // the :| closing ending 1 is NOT a gate (ADR-025); the volta index is
  // auto-derived from the layer (jump target unknown → row-4 default).
  // Index:  0   1   2   3   4    5      6      7      8     9
  // Key:    m1  m2  m3  m4  m5  m6-e1  m7-e1  m6-e2  m7-e2  m8
  beforeEach(() => {
    ({ container, layer, els } = makeLayerWithMeasures(
      [1, 2, 3, 4, 5, 6, 7, 6, 7, 8],
      [null, null, null, null, null, 1, 1, 2, 2, null]
    ));
    session = new AnnotationSession(layer, { resolution: 'measure' });
  });

  afterEach(() => {
    session.destroy();
    container.remove();
  });

  it('same-barN measures in different endings have distinct ghost keys', () => {
    expect(measureGhostKey(6, 1)).toBe('m6-e1');
    expect(measureGhostKey(6, 2)).toBe('m6-e2');
    expect(layer.measureIndex.has(measureGhostKey(6, 1))).toBe(true);
    expect(layer.measureIndex.has(measureGhostKey(6, 2))).toBe(true);
  });

  it('forward drag across the whole group excludes the non-final ending (row 4)', () => {
    // Anchor at m1 (idx 0), drag to m8 (idx 9). The repeat-end of ending 1 no
    // longer clamps (ADR-025); the group is wholly contained with an unknown
    // jump target, so ending 1 is excluded from the effective range.
    measureDrag(els, 0, [9]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(8);
    expect(session.selection?.measureKeys).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6-e2',
      'm7-e2',
      'm8',
    ]);
    expect(session.selection?.repeatContext).toBe('second_ending');
    // Ending-1 ghosts must not be highlighted.
    expect(els[5]!.classList.contains('dark')).toBe(false);
    expect(els[6]!.classList.contains('dark')).toBe(false);
    expect(els[9]!.classList.contains('dark')).toBe(true);
  });

  it('drag within ending 1 works and captures first_ending context', () => {
    measureDrag(els, 5, [6]); // m6-e1 → m7-e1
    expect(session.selection?.barStart).toBe(6);
    expect(session.selection?.barEnd).toBe(7);
    expect(session.selection?.repeatContext).toBe('first_ending');
  });

  it('drag within ending 2 works and captures second_ending context', () => {
    measureDrag(els, 7, [8]); // m6-e2 → m7-e2
    expect(session.selection?.barStart).toBe(6);
    expect(session.selection?.barEnd).toBe(7);
    expect(session.selection?.repeatContext).toBe('second_ending');
  });

  it('forward drag from ending 1 clamps at the sibling-ending gate', () => {
    // Anchor at m6-e1 (idx 5), drag to m6-e2 (idx 7) — clamped at end of e1.
    measureDrag(els, 5, [7]);
    expect(session.selection?.barEnd).toBe(7); // m7-e1.barN = 7
    expect(session.selection?.repeatContext).toBe('first_ending');
  });

  it('forward drag from ending 1 cannot extend past its group', () => {
    // Anchor at m6-e1 (idx 5), drag to m8 (idx 9) — a first ending closes
    // into the repeat jump, never the continuation.
    measureDrag(els, 5, [9]);
    expect(session.selection?.measureKeys).toEqual(['m6-e1', 'm7-e1']);
    expect(session.selection?.repeatContext).toBe('first_ending');
  });

  it('backward drag from ending 2 into the body skips ending 1 (row 2)', () => {
    // Anchor at m6-e2 (idx 7), drag backward to m1 (idx 0). Ending 1 is
    // excluded from the effective range; the selection is discontiguous.
    measureDrag(els, 7, [6, 5, 4, 3, 2, 1, 0]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(6); // m6-e2.barN = 6
    expect(session.selection?.measureKeys).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6-e2']);
    expect(session.selection?.repeatContext).toBe('second_ending');
    expect(els[5]!.classList.contains('dark')).toBe(false); // m6-e1
    expect(els[6]!.classList.contains('dark')).toBe(false); // m7-e1
    expect(els[0]!.classList.contains('dark')).toBe(true); // m1
  });

  it('backward drag from ending 2 hovering inside ending 1 clamps at the gate', () => {
    // Anchor at m6-e2 (idx 7), current inside ending 1 (idx 6) — illegal
    // interval, clamped to the anchor side of the gate.
    measureDrag(els, 7, [6]);
    expect(session.selection?.measureKeys).toEqual(['m6-e2']);
    expect(session.selection?.repeatContext).toBe('second_ending');
  });

  it('repeat_context is first_ending when selection is inside ending 1', () => {
    measureDrag(els, 5, []); // single-measure click on m6-e1
    expect(session.selection?.repeatContext).toBe('first_ending');
  });

  it('repeat_context is second_ending when selection is inside ending 2', () => {
    measureDrag(els, 7, []); // single-measure click on m6-e2
    expect(session.selection?.repeatContext).toBe('second_ending');
  });

  it('volta gates apply without any explicit volta index (layer-derived)', () => {
    const { container: c2, layer: l2, els: e2 } = makeLayerWithMeasures([1, 2, 1, 2], [1, 1, 2, 2]);
    const s2 = new AnnotationSession(l2, { resolution: 'measure' });

    // Drag from m1-e1 (idx 0) to m1-e2 (idx 2) — sibling crossing, clamped
    // at the end of ending 1.
    e2[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    e2[2]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(s2.selection?.barEnd).toBe(2); // m2-e1.barN = 2
    expect(s2.selection?.repeatContext).toBe('first_ending');
    s2.destroy();
    c2.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — sub-beat endpoint exactness (§6A.7, SEL-09/SEL-14)
// ---------------------------------------------------------------------------

describe('AnnotationSession — sub-beat endpoint exactness', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** Two 4/4 measures with sub-beat ghosts (subDiv=2 → floats 1.0…4.5). */
  function makeSubBeatLayer(): {
    container: HTMLDivElement;
    layer: GhostLayer;
    subBeatEls: Map<number, HTMLDivElement>;
  } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const layer = new GhostLayer(container);
    const subBeatEls = new Map<number, HTMLDivElement>();

    [1, 2].forEach((barN, renderOrder) => {
      const mKey = measureGhostKey(barN, null);
      const el = document.createElement('div');
      el.className = 'ghost ghost-measure';
      el.dataset['key'] = mKey;
      layer._appendMeasureGhost(el);
      layer.measureIndex.set(mKey, {
        el,
        barN,
        endingN: null,
        key: mKey,
        bounds: { left: renderOrder * 200, top: 0, width: 200, height: 50 },
        systemTop: 0,
        renderOrder,
      } satisfies MeasureGhostEntry);

      for (let b = 0; b < 4; b++) {
        for (let sb = 0; sb < 2; sb++) {
          const encKey = encodeSubBeat(renderOrder, b, sb);
          const beatFloat = b + 1 + sb / 2;
          const sbEl = document.createElement('div');
          sbEl.className = 'ghost ghost-subbeat';
          sbEl.dataset['key'] = `${encKey}`;
          layer._appendSubBeatGhost(sbEl);
          layer.subBeatIndex.set(encKey, {
            el: sbEl,
            barN,
            endingN: null,
            measureKey: mKey,
            beatIdx: b,
            subBeatIdx: sb,
            encodedKey: encKey,
            beatFloat,
            endFloat: beatFloat + 0.5,
            bounds: { left: renderOrder * 200 + b * 50 + sb * 25, top: 0, width: 25, height: 50 },
          } satisfies SubBeatGhostEntry);
          subBeatEls.set(encKey, sbEl);
        }
      }
    });

    return { container, layer, subBeatEls };
  }

  it('a selection ending on the first sub-beat of a measure commits beatEnd = 1.5', () => {
    // Regression for SEL-09/SEL-14: the old neighbour-difference estimate
    // produced a negative step when the last two entries straddled a barline
    // (1.0 − 4.5 = −3.5 → beatEnd = −2.5), dropping the final measure from
    // every derived surface.
    const { container, layer, subBeatEls } = makeSubBeatLayer();
    const session = new AnnotationSession(layer, { resolution: 'subbeat' });

    const start = encodeSubBeat(0, 2, 0); // m1, beat 3 (float 3.0)
    const end = encodeSubBeat(1, 0, 0); // m2, beat 1, first sub-beat (float 1.0)
    subBeatEls
      .get(start)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    subBeatEls
      .get(end)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(2);
    expect(session.selection?.beatStart).toBe(3.0);
    expect(session.selection?.beatEnd).toBe(1.5); // exactly one sub-beat into m2
    expect(session.selection?.measureKeys).toEqual(['m1', 'm2']);

    session.destroy();
    container.remove();
  });

  it('a selection ending mid-beat commits beatEnd at the exact sub-beat boundary', () => {
    // Regression for SEL-10: no rounding up to complete the beat.
    const { container, layer, subBeatEls } = makeSubBeatLayer();
    const session = new AnnotationSession(layer, { resolution: 'subbeat' });

    const start = encodeSubBeat(0, 0, 0); // m1 float 1.0
    const end = encodeSubBeat(0, 2, 1); // m1, beat 3, second sub-beat (float 3.5)
    subBeatEls
      .get(start)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    subBeatEls
      .get(end)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.beatEnd).toBe(4.0); // 3.5 + 0.5, not 4.5
    session.destroy();
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — directive barrier enforcement at beat resolution (G2.3)
// ---------------------------------------------------------------------------

describe('AnnotationSession — beat barrier enforcement', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Helper: build a minimal GhostLayer that has BOTH a measure index (for
   * measureKeyRange to walk) and a beat index (for the beat drag handlers).
   * barNs/endingNs define the measure layer; beatsPerMeasure defines how many
   * beat ghosts each measure gets.
   *
   * The beat entries carry measureKey = measureGhostKey(barN, endingN) (plain,
   * no suffix) since the test fixtures do not have @n collisions.
   */
  function makeLayerWithMeasuresAndBeats(
    barNs: number[],
    beatsPerMeasure: number[],
    endingNs?: (number | null)[]
  ): {
    container: HTMLDivElement;
    layer: GhostLayer;
    measureEls: HTMLDivElement[];
    beatEls: Map<number, HTMLDivElement>; // encodedKey → element
  } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const layer = new GhostLayer(container);

    const measureEls: HTMLDivElement[] = barNs.map((barN, i) => {
      const endingN = endingNs?.[i] ?? null;
      const key = measureGhostKey(barN, endingN);
      const el = document.createElement('div');
      el.className = 'ghost ghost-measure';
      el.dataset['key'] = key;
      layer._appendMeasureGhost(el);
      layer.measureIndex.set(key, {
        el,
        barN,
        endingN,
        key,
        bounds: { left: i * 100, top: 0, width: 100, height: 50 },
        systemTop: 0,
        renderOrder: i,
      } satisfies MeasureGhostEntry);
      return el;
    });

    const beatEls = new Map<number, HTMLDivElement>();
    barNs.forEach((barN, renderOrder) => {
      const endingN = endingNs?.[renderOrder] ?? null;
      const mKey = measureGhostKey(barN, endingN);
      const numBeats = beatsPerMeasure[renderOrder] ?? 0;
      for (let b = 0; b < numBeats; b++) {
        const encKey = encodeBeat(renderOrder, b);
        const el = document.createElement('div');
        el.className = 'ghost ghost-beat';
        el.dataset['key'] = `${encKey}`;
        layer._appendBeatGhost(el);
        layer.beatIndex.set(encKey, {
          el,
          barN,
          endingN,
          measureKey: mKey,
          beatIdx: b,
          encodedKey: encKey,
          beatFloat: b + 1,
          endFloat: b + 2,
          bounds: { left: renderOrder * 100 + b * 20, top: 0, width: 20, height: 30 },
        } satisfies BeatGhostEntry);
        beatEls.set(encKey, el);
      }
    });

    return { container, layer, measureEls, beatEls };
  }

  it('forward beat drag clamps at the barrier measure', () => {
    // 3 measures: m1 (2 beats), m2 (2 beats, barrier), m3 (2 beats).
    const { container, layer, beatEls } = makeLayerWithMeasuresAndBeats([1, 2, 3], [2, 2, 2]);
    const barrier = new Set([measureGhostKey(2, null)]);
    const session = new AnnotationSession(layer, {
      resolution: 'beat',
      barrierMeasures: barrier,
    });

    // Anchor at m1 beat 0 (renderOrder=0, b=0), drag to m3 beat 0 (renderOrder=2, b=0).
    const r0b0 = encodeBeat(0, 0);
    const r2b0 = encodeBeat(2, 0);
    beatEls
      .get(r0b0)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    beatEls
      .get(r2b0)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    // Should clamp at m2 (barrier): barStart=1, barEnd=2.
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(2);

    session.destroy();
    container.remove();
  });

  it('backward beat drag clamps at the barrier — anchor stays on its side', () => {
    // Same 3-measure setup: barrier at m2.
    const { container, layer, beatEls } = makeLayerWithMeasuresAndBeats([1, 2, 3], [2, 2, 2]);
    const barrier = new Set([measureGhostKey(2, null)]);
    const session = new AnnotationSession(layer, {
      resolution: 'beat',
      barrierMeasures: barrier,
    });

    // Anchor at m3 beat 0 (renderOrder=2), drag backward through barrier to m1 beat 0.
    const r2b0 = encodeBeat(2, 0);
    const r0b0 = encodeBeat(0, 0);
    beatEls
      .get(r2b0)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    beatEls
      .get(r0b0)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    // Barrier at m2 blocks backward crossing — selection stays on m3 side.
    expect(session.selection?.barStart).toBe(3);
    expect(session.selection?.barEnd).toBe(3);

    session.destroy();
    container.remove();
  });

  it('beat drag within one measure is unaffected by a barrier in another measure', () => {
    const { container, layer, beatEls } = makeLayerWithMeasuresAndBeats([1, 2, 3], [4, 4, 4]);
    const barrier = new Set([measureGhostKey(2, null)]);
    const session = new AnnotationSession(layer, {
      resolution: 'beat',
      barrierMeasures: barrier,
    });

    // Drag entirely within m3 (renderOrder=2).
    const r2b0 = encodeBeat(2, 0);
    const r2b3 = encodeBeat(2, 3);
    beatEls
      .get(r2b0)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    beatEls
      .get(r2b3)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(3);
    expect(session.selection?.barEnd).toBe(3);

    session.destroy();
    container.remove();
  });

  it('a beat drag that does not reach the barrier is unaffected', () => {
    const { container, layer, beatEls } = makeLayerWithMeasuresAndBeats([1, 2, 3], [2, 2, 2]);
    const barrier = new Set([measureGhostKey(2, null)]);
    const session = new AnnotationSession(layer, {
      resolution: 'beat',
      barrierMeasures: barrier,
    });

    // Drag from m1 beat 0 to m1 beat 1 — does not cross m2 barrier.
    const r0b0 = encodeBeat(0, 0);
    const r0b1 = encodeBeat(0, 1);
    beatEls
      .get(r0b0)!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    beatEls
      .get(r0b1)!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(1);

    session.destroy();
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — destroy
// ---------------------------------------------------------------------------

describe('AnnotationSession — destroy', () => {
  it('removes event listeners so further mouse events have no effect', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2, 3]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });

    session.destroy();

    // After destroy, mousedown should not start a drag.
    els[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    els[2]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection).toBeNull();
    container.remove();
  });

  it('clears visual highlights on destroy', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });

    // Commit a selection so dark ghosts exist.
    measureDrag(els, 0, [1]);
    expect(els[0]!.classList.contains('dark')).toBe(true);

    session.destroy();

    // Dark class should be removed.
    expect(els[0]!.classList.contains('dark')).toBe(false);
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — stage-drag affordance lock (Component 7 Step 5)
// ---------------------------------------------------------------------------

describe('AnnotationSession — setStageDragActive', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('showHandles is not called during an active stage drag', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2, 3]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });

    // Commit a selection so _handlesReady becomes true.
    measureDrag(els, 0, [2]);

    const showSpy = vi.spyOn(layer, 'showHandles');

    // Lock: stage drag active — mouseover a dark ghost should NOT call showHandles.
    session.setStageDragActive(true);
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(showSpy).not.toHaveBeenCalled();

    // Unlock: mouseover a dark ghost now shows handles again.
    session.setStageDragActive(false);
    els[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(showSpy).toHaveBeenCalledOnce();

    session.destroy();
    container.remove();
  });

  it('setStageDragActive(false) calls hideHandles to clear any visible handles', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });
    measureDrag(els, 0, [1]);

    const hideSpy = vi.spyOn(layer, 'hideHandles');

    session.setStageDragActive(true);
    session.setStageDragActive(false);

    expect(hideSpy).toHaveBeenCalled();

    session.destroy();
    container.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — play-from-position Alt-click (Step 20)
// ---------------------------------------------------------------------------

describe('AnnotationSession — play-from-position (Step 20)', () => {
  it('Alt-click a measure calls onPlayFromMeasure with its key and starts no selection', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2, 3]);
    const onPlay = vi.fn();
    const session = new AnnotationSession(layer, {
      resolution: 'measure',
      onPlayFromMeasure: onPlay,
    });

    els[1]!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true })
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(measureGhostKey(2, null));
    // No selection is started or committed by the Alt gesture.
    expect(session.selection).toBeNull();
    expect(session.flags.fragmentSet).toBe(false);

    session.destroy();
    container.remove();
  });

  it('plain click still starts a selection (Alt-gesture does not regress selection)', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2, 3]);
    const onPlay = vi.fn();
    const session = new AnnotationSession(layer, {
      resolution: 'measure',
      onPlayFromMeasure: onPlay,
    });

    measureDrag(els, 0, [1]); // plain (no altKey) drag m1..m2

    expect(onPlay).not.toHaveBeenCalled();
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(2);

    session.destroy();
    container.remove();
  });

  it('Alt-click a beat ghost resolves up to its enclosing measure key', () => {
    const { container, layer, beatEls } = makeLayerWithBeats([
      { barN: 1, numBeats: 2 },
      { barN: 2, numBeats: 2 },
    ]);
    const onPlay = vi.fn();
    const session = new AnnotationSession(layer, { resolution: 'beat', onPlayFromMeasure: onPlay });

    // A beat ghost in the second measure (renderOrder 1, beatIdx 0).
    const beatEl = beatEls.get(encodeBeat(1, 0))!;
    beatEl.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true })
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(measureGhostKey(2, null));
    expect(session.selection).toBeNull();

    session.destroy();
    container.remove();
  });

  it('does nothing when no onPlayFromMeasure handler is supplied', () => {
    const { container, layer, els } = makeLayerWithMeasures([1, 2]);
    const session = new AnnotationSession(layer, { resolution: 'measure' });

    els[0]!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true })
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(session.selection).toBeNull();
    expect(session.flags.fragmentSet).toBe(false);

    session.destroy();
    container.remove();
  });
});
