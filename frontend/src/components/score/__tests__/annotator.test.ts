/**
 * Unit tests for frontend/src/components/score/annotator.ts.
 *
 * Covers: buildRepeatBarriers, ghostFromTarget, measureKeyRange,
 * numericKeyRange, and AnnotationSession interaction (measure drag,
 * endpoint re-selection, barrier clamping, beat drag, repeat context,
 * resolution toggle, flag management).
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
  buildEndingBarriers,
  buildRepeatBarriers,
  ghostFromTarget,
  measureKeyRange,
  numericKeyRange,
} from '../annotator';
import { GhostLayer, encodeBeat, measureGhostKey } from '../ghosts';
import type { BeatGhostEntry, MeasureGhostEntry } from '../ghosts';

// ---------------------------------------------------------------------------
// buildRepeatBarriers
// ---------------------------------------------------------------------------

describe('buildRepeatBarriers', () => {
  it('returns an empty set when the MEI has no repeat barlines or directions', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1"/><measure n="2"/><measure n="3"/>
    </score></mdiv></body></music></mei>`;
    expect(buildRepeatBarriers(mei).size).toBe(0);
  });

  it('identifies a measure with @right="rptend"', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="4" right="rptend"/>
    </score></mdiv></body></music></mei>`;
    const barriers = buildRepeatBarriers(mei);
    expect(barriers.has(measureGhostKey(4, null))).toBe(true);
  });

  it('identifies a measure with @right="rptboth"', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="8" right="rptboth"/>
    </score></mdiv></body></music></mei>`;
    const barriers = buildRepeatBarriers(mei);
    expect(barriers.has(measureGhostKey(8, null))).toBe(true);
  });

  it('identifies a da capo direction inside a measure', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="16"><dir>D.C. al Fine</dir></measure>
    </score></mdiv></body></music></mei>`;
    const barriers = buildRepeatBarriers(mei);
    expect(barriers.has(measureGhostKey(16, null))).toBe(true);
  });

  it('identifies a dal segno direction inside a measure', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="32"><dir>D.S. al Coda</dir></measure>
    </score></mdiv></body></music></mei>`;
    const barriers = buildRepeatBarriers(mei);
    expect(barriers.has(measureGhostKey(32, null))).toBe(true);
  });

  it('does not mark an open-repeat barline as a barrier', () => {
    const mei = `<mei><music><body><mdiv><score>
      <measure n="1" right="rptstart"/><measure n="2"/>
    </score></mdiv></body></music></mei>`;
    expect(buildRepeatBarriers(mei).size).toBe(0);
  });

  it('includes ending context in the barrier key when measure is inside an ending', () => {
    const mei = `<mei><music><body><mdiv><score>
      <ending n="1"><measure n="12" right="rptend"/></ending>
    </score></mdiv></body></music></mei>`;
    const barriers = buildRepeatBarriers(mei);
    expect(barriers.has(measureGhostKey(12, 1))).toBe(true);
    expect(barriers.has(measureGhostKey(12, null))).toBe(false);
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

  it('returns the ghost ancestor when target is a .ghost-edge child', () => {
    const ghost = document.createElement('div');
    ghost.className = 'ghost ghost-measure';
    const edge = document.createElement('div');
    edge.className = 'ghost-edge ghost-edge-left';
    ghost.appendChild(edge);
    expect(ghostFromTarget(edge)).toBe(ghost);
  });

  it('returns the ghost ancestor when target is a .ghost-gradient child', () => {
    const ghost = document.createElement('div');
    ghost.className = 'ghost ghost-beat';
    const grad = document.createElement('div');
    grad.className = 'ghost-gradient ghost-gradient-right';
    ghost.appendChild(grad);
    expect(ghostFromTarget(grad)).toBe(ghost);
  });

  it('returns null when target has no .ghost ancestor', () => {
    const el = document.createElement('div');
    el.className = 'score-content';
    expect(ghostFromTarget(el)).toBeNull();
  });

  it('returns null for null target', () => {
    expect(ghostFromTarget(null)).toBeNull();
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
  endingNs?: (number | null)[],
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
      bounds: { left: (i * 100), top: 0, width: 100, height: 50 },
      systemTop: 0,
    } satisfies MeasureGhostEntry);
    return el;
  });

  return { container, layer, els };
}

/** Build a GhostLayer with beat ghosts. Beats are in measures barN[], beatIdx 0..numBeats-1. */
function makeLayerWithBeats(
  measures: Array<{ barN: number; numBeats: number; subDiv?: number }>,
): {
  container: HTMLDivElement;
  layer: GhostLayer;
  beatEls: Map<number, HTMLDivElement>;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const layer = new GhostLayer(container);
  const beatEls = new Map<number, HTMLDivElement>();

  for (const { barN, numBeats, subDiv = 2 } of measures) {
    for (let b = 0; b < numBeats; b++) {
      const encKey = encodeBeat(barN, b);
      const beatFloat = b + 1; // 1-indexed
      const el = document.createElement('div');
      el.className = 'ghost ghost-beat';
      el.dataset['key'] = `${encKey}`;
      layer._appendBeatGhost(el);
      layer.beatIndex.set(encKey, {
        el,
        barN,
        endingN: null,
        beatIdx: b,
        encodedKey: encKey,
        beatFloat,
        bounds: { left: 0, top: 0, width: 50, height: 20 },
      } satisfies BeatGhostEntry);
      beatEls.set(encKey, el);
      void subDiv; // used only for sub-beat layer, not needed here
    }
  }

  return { container, layer, beatEls };
}

/** Synthesise and dispatch mouse events to simulate a measure drag. */
function measureDrag(
  els: HTMLDivElement[],
  anchorIdx: number,
  throughIdxs: number[],
): void {
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
});

// ---------------------------------------------------------------------------
// AnnotationSession — repeat barrier clamping
// ---------------------------------------------------------------------------

describe('AnnotationSession — close-repeat barrier clamping', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let els: HTMLDivElement[];
  let session: AnnotationSession;

  beforeEach(() => {
    ({ container, layer, els } = makeLayerWithMeasures([1, 2, 3, 4, 5]));
    // Measure m3 has a close-repeat barline.
    const barriers = new Set([measureGhostKey(3, null)]);
    session = new AnnotationSession(layer, {
      resolution: 'measure',
      closeRepeatMeasures: barriers,
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
    const { container, layer, els } = makeLayerWithMeasures(
      [1, 2, 12, 12],
      [null, null, 1, 2],
    );
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

  it('resolution toggle cancels any in-progress drag without clearing committed selection', () => {
    // Commit a selection first.
    const { els } = makeLayerWithMeasures([1, 2, 3]);
    // Use the layer from beforeEach (has its own els); re-create selection.
    const { els: testEls, layer: testLayer, container: tc } = makeLayerWithMeasures([1, 2, 3]);
    const sess = new AnnotationSession(testLayer, { resolution: 'measure' });

    measureDrag(testEls, 0, [2]);
    expect(sess.selection?.barStart).toBe(1);

    // Start a new drag then toggle resolution mid-drag.
    testEls[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    testEls[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    sess.setResolution('beat'); // cancels drag

    // mouseup after toggle should not commit anything (dragging = false).
    document.dispatchEvent(new MouseEvent('mouseup'));
    // Selection is unchanged (still the previously committed one).
    expect(sess.selection?.barStart).toBe(1);

    sess.destroy();
    tc.remove();
    void els; // suppress unused warning
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
    const beat1Key = encodeBeat(1, 0); // m1 beat 0 (float 1.0)
    const beat3Key = encodeBeat(1, 2); // m1 beat 2 (float 3.0)
    beatEls.get(beat1Key)!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    beatEls.get(beat3Key)!.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(1);
    expect(session.selection?.beatStart).toBe(1.0); // beat index 0 → float 1.0
    // beatEnd should be last.beatFloat + 1.0 = 3.0 + 1.0 = 4.0
    expect(session.selection?.beatEnd).toBe(4.0);
  });

  it('beat drag spanning two measures sets correct barStart and barEnd', () => {
    const m1b1 = encodeBeat(1, 0);
    const m2b2 = encodeBeat(2, 1);
    beatEls.get(m1b1)!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    beatEls.get(m2b2)!.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(2);
  });

  it('dragging the left endpoint in beat mode re-anchors from the right', () => {
    // Commit beats m1b0..m1b2 (beatFloats 1.0, 2.0, 3.0).
    const m1b0 = encodeBeat(1, 0);
    const m1b2 = encodeBeat(1, 2);
    beatEls.get(m1b0)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    beatEls.get(m1b2)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    // Click on the leftmost dark beat (m1b0) — anchor should re-set to m1b2
    // (the rightmost dark beat). Then drag to m2b0 → range is [m1b2, m1b3, m2b0].
    const m2b0 = encodeBeat(2, 0);
    beatEls.get(m1b0)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    beatEls.get(m2b0)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    // The anchor is now m1b2 (float 3.0); range runs m1b2→m2b0.
    expect(session.selection?.beatStart).toBe(3.0); // m1b2's beatFloat
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
// buildEndingBarriers (G2.2)
// ---------------------------------------------------------------------------

describe('buildEndingBarriers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns an empty set when no measures have endings', () => {
    const { layer, container } = makeLayerWithMeasures([1, 2, 3]);
    expect(buildEndingBarriers(layer.measureIndex).size).toBe(0);
    layer.destroy(); container.remove();
  });

  it('returns an empty set when all measures are in the same ending', () => {
    const { layer, container } = makeLayerWithMeasures([1, 2, 3], [1, 1, 1]);
    expect(buildEndingBarriers(layer.measureIndex).size).toBe(0);
    layer.destroy(); container.remove();
  });

  it('marks the last measure of ending 1 as a barrier when followed by ending 2', () => {
    // m1(null), m2-e1, m3-e1, m2-e2, m3-e2 — transition at m3-e1 → m2-e2.
    const { layer, container } = makeLayerWithMeasures([1, 2, 3, 2, 3], [null, 1, 1, 2, 2]);
    const barriers = buildEndingBarriers(layer.measureIndex);
    expect(barriers.has(measureGhostKey(3, 1))).toBe(true);   // last of ending 1
    expect(barriers.has(measureGhostKey(2, 1))).toBe(false);  // not last of ending 1
    expect(barriers.has(measureGhostKey(3, 2))).toBe(false);  // ending 2 — not a barrier
    expect(barriers.size).toBe(1);
    layer.destroy(); container.remove();
  });

  it('does not block null → non-null (entering an ending from the main body)', () => {
    // m1(null) → m2-e1: entering ending 1 is permitted.
    const { layer, container } = makeLayerWithMeasures([1, 2, 3], [null, 1, 1]);
    expect(buildEndingBarriers(layer.measureIndex).size).toBe(0);
    layer.destroy(); container.remove();
  });

  it('does not block non-null → null (exiting an ending back to the main body)', () => {
    // m2-e1, m3(null): leaving ending 1 is permitted.
    const { layer, container } = makeLayerWithMeasures([1, 2, 3], [1, 1, null]);
    expect(buildEndingBarriers(layer.measureIndex).size).toBe(0);
    layer.destroy(); container.remove();
  });
});

// ---------------------------------------------------------------------------
// AnnotationSession — ending-boundary barrier (G2.2)
// ---------------------------------------------------------------------------

describe('AnnotationSession — ending-boundary barrier', () => {
  let container: HTMLDivElement;
  let layer: GhostLayer;
  let els: HTMLDivElement[];
  let session: AnnotationSession;

  // Alla Turca fixture: m1–m5 main body, m6-e1/m7-e1 first ending,
  // m6-e2/m7-e2 second ending, m8 continuation.
  // Close-repeat on m7-e1; ending barrier is also auto-derived at m7-e1.
  // Index:  0   1   2   3   4    5      6      7      8     9
  // Key:    m1  m2  m3  m4  m5  m6-e1  m7-e1  m6-e2  m7-e2  m8
  beforeEach(() => {
    ({ container, layer, els } = makeLayerWithMeasures(
      [1, 2, 3, 4, 5, 6, 7, 6, 7, 8],
      [null, null, null, null, null, 1, 1, 2, 2, null],
    ));
    session = new AnnotationSession(layer, {
      resolution: 'measure',
      closeRepeatMeasures: new Set([measureGhostKey(7, 1)]),
    });
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

  it('forward drag from main body is clamped at the close-repeat of ending 1', () => {
    // Anchor at m1 (idx 0), drag to m8 (idx 9) — barrier at m7-e1 (idx 6).
    measureDrag(els, 0, [9]);
    expect(session.selection?.barStart).toBe(1);
    expect(session.selection?.barEnd).toBe(7); // m7-e1.barN = 7
  });

  it('drag within ending 1 is unaffected by barriers', () => {
    measureDrag(els, 5, [6]); // m6-e1 → m7-e1
    expect(session.selection?.barStart).toBe(6);
    expect(session.selection?.barEnd).toBe(7);
    expect(session.selection?.repeatContext).toBe('first_ending');
  });

  it('drag within ending 2 is unaffected by barriers', () => {
    measureDrag(els, 7, [8]); // m6-e2 → m7-e2
    expect(session.selection?.barStart).toBe(6);
    expect(session.selection?.barEnd).toBe(7);
    expect(session.selection?.repeatContext).toBe('second_ending');
  });

  it('forward drag from ending 1 cannot cross the boundary into ending 2', () => {
    // Anchor at m6-e1 (idx 5), drag to m6-e2 (idx 7).
    // Ending barrier at m7-e1 clamps the selection.
    measureDrag(els, 5, [7]);
    expect(session.selection?.barEnd).toBe(7); // m7-e1.barN = 7
    expect(session.selection?.repeatContext).toBe('first_ending');
  });

  it('backward drag from ending 2 cannot cross the boundary into ending 1', () => {
    // Anchor at m6-e2 (idx 7), drag backward past barrier to m1 (idx 0).
    // Barrier at m7-e1 prevents the crossing — selection collapses to [m6-e2].
    measureDrag(els, 7, [6, 5, 4, 3, 2, 1, 0]);
    expect(session.selection?.barStart).toBe(6);
    expect(session.selection?.barEnd).toBe(6);
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

  it('ending-boundary barrier is auto-derived even without a close-repeat barline', () => {
    // Layer with two endings and NO close-repeat; relying solely on auto-derived barrier.
    const { container: c2, layer: l2, els: e2 } = makeLayerWithMeasures(
      [1, 2, 1, 2],
      [1, 1, 2, 2],
    );
    const s2 = new AnnotationSession(l2, { resolution: 'measure' /* no closeRepeatMeasures */ });

    // Drag from m1-e1 (idx 0) to m1-e2 (idx 2) — crosses ending boundary.
    // Auto-derived barrier at m2-e1 (idx 1) must clamp the selection.
    e2[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    e2[2]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(s2.selection?.barEnd).toBe(2); // m2-e1.barN = 2 (clamped at ending barrier)
    expect(s2.selection?.repeatContext).toBe('first_ending');
    s2.destroy(); c2.remove();
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
