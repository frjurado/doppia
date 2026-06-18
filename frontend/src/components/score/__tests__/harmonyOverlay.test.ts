/**
 * Tests for harmonyOverlay — Component 7 Step 16 (G6.3).
 *
 * Verification targets (harmony-score-overlay.md, Step 16):
 *   - Constructor mounts overlay div with aria-hidden into container; builds initial labels.
 *   - Label x: beat ghost bounds.left; label y: measure bounds.top + height + LANE_OFFSET_PX (6).
 *   - Downbeat events (fractional part < 0.01) use beatIndex.
 *   - Sub-beat events (fractional part ≥ 0.01) probe subBeatIndex for sb=1 and sb=2,
 *     picking the entry whose beatFloat is closest to event.beat.
 *   - Sub-beat fallback: when subBeatIndex has no entry, falls back to beatIndex.
 *   - Beat walk-back: when beat N ghost is absent, walks back to the nearest earlier beat.
 *   - Events with no matching measure ghost are silently skipped.
 *   - Volta-aware key: event.volta=1 resolves against the "m1-e1" ending ghost;
 *     event.volta=2 is skipped when only the volta=1 ghost exists.
 *   - Key suppression: (local_key) shown on the first label and whenever key changes;
 *     suppressed for consecutive labels sharing the same key.
 *   - applied_to: renders chord as "numeral/applied_to".
 *   - Empty numeral + null key renders as "—".
 *   - reproject() swaps the ghost layer and rebuilds all labels at new positions;
 *     stale labels from the previous render are cleared.
 *   - setEvents() replaces the event list and rebuilds labels.
 *   - destroy() removes the overlay element from the container.
 *   - onLabelClick fires with (mn, volta, beat) when a label is clicked.
 *   - Labels without onLabelClick do not throw on click.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { HarmonyOverlay } from '../harmonyOverlay';
import type {
  GhostLayer,
  MeasureGhostEntry,
  BeatGhostEntry,
  SubBeatGhostEntry,
} from '../ghosts';
import { encodeBeat, encodeSubBeat, measureGhostKey } from '../ghosts';
import type { HarmonyEventOut } from '../../../services/analysisApi';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors the private LANE_OFFSET_PX in harmonyOverlay.ts. */
const LANE_OFFSET_PX = 6;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal GhostLayer-shaped object.
 *
 * The `as unknown as GhostLayer` cast is intentional: harmonyOverlay.ts imports
 * GhostLayer as a type only and accesses only measureIndex, beatIndex, and
 * subBeatIndex — exactly what this builder provides.
 */
function makeMockGhostLayer(
  measures: Array<{
    barN: number;
    endingN?: number | null;
    renderOrder: number;
    bounds: { left: number; top: number; width?: number; height?: number };
    beats?: Array<{ beatIdx: number; beatFloat: number; left: number }>;
    subBeats?: Array<{ beatIdx: number; sb: number; beatFloat: number; left: number }>;
  }>,
): GhostLayer {
  const measureIndex = new Map<string, MeasureGhostEntry>();
  const beatIndex = new Map<number, BeatGhostEntry>();
  const subBeatIndex = new Map<number, SubBeatGhostEntry>();

  for (const m of measures) {
    const endingN = m.endingN ?? null;
    const key = measureGhostKey(m.barN, endingN);
    const bounds = {
      left: m.bounds.left,
      top: m.bounds.top,
      width: m.bounds.width ?? 60,
      height: m.bounds.height ?? 40,
    };

    measureIndex.set(key, {
      el: document.createElement('div'),
      barN: m.barN,
      endingN,
      key,
      bounds,
      systemTop: m.bounds.top,
      renderOrder: m.renderOrder,
    });

    for (const b of m.beats ?? []) {
      const encoded = encodeBeat(m.renderOrder, b.beatIdx);
      beatIndex.set(encoded, {
        el: document.createElement('div'),
        barN: m.barN,
        endingN,
        measureKey: key,
        beatIdx: b.beatIdx,
        encodedKey: encoded,
        beatFloat: b.beatFloat,
        bounds: { left: b.left, top: m.bounds.top, width: 20, height: m.bounds.height ?? 40 },
        // Step 21 positions labels on the leftmost notehead center; the mock
        // treats the provided `left` as that center so positioning assertions hold.
        noteheadCenter: b.left,
      });
    }

    for (const sb of m.subBeats ?? []) {
      const encoded = encodeSubBeat(m.renderOrder, sb.beatIdx, sb.sb);
      subBeatIndex.set(encoded, {
        el: document.createElement('div'),
        barN: m.barN,
        endingN,
        measureKey: key,
        beatIdx: sb.beatIdx,
        subBeatIdx: sb.sb,
        encodedKey: encoded,
        beatFloat: sb.beatFloat,
        bounds: { left: sb.left, top: m.bounds.top, width: 10, height: m.bounds.height ?? 40 },
        noteheadCenter: sb.left,
      });
    }
  }

  return { measureIndex, beatIndex, subBeatIndex } as unknown as GhostLayer;
}

/** A minimal HarmonyEventOut with sensible defaults. */
function makeEvent(overrides: Partial<HarmonyEventOut> = {}): HarmonyEventOut {
  return {
    mn: 1,
    beat: 1.0,
    volta: null,
    mc: null,
    numeral: 'V',
    local_key: 'C',
    root: null,
    quality: null,
    inversion: null,
    root_accidental: null,
    applied_to: null,
    extensions: [],
    bass_pitch: null,
    soprano_pitch: null,
    source: 'dcml',
    auto: true,
    reviewed: false,
    ...overrides,
  };
}

/**
 * A single-measure ghost layer used as the default across tests that do not
 * need special ghost geometry. Measure 1, renderOrder 0, beats 0 and 1.
 *
 *   measure bounds : left=10, top=100, width=80, height=40
 *   beat 0 (beat 1 in score): left=10
 *   beat 1 (beat 2 in score): left=50
 */
function defaultGhostLayer(): GhostLayer {
  return makeMockGhostLayer([
    {
      barN: 1,
      renderOrder: 0,
      bounds: { left: 10, top: 100, width: 80, height: 40 },
      beats: [
        { beatIdx: 0, beatFloat: 1.0, left: 10 },
        { beatIdx: 1, beatFloat: 2.0, left: 50 },
      ],
    },
  ]);
}

/**
 * Create a HarmonyOverlay wired to a fresh container appended to document.body.
 * The container is cleaned up in the `afterEach` that each describe block provides.
 */
function createOverlay(
  overrides: {
    ghostLayer?: GhostLayer;
    events?: HarmonyEventOut[];
    scale?: number;
    onLabelClick?: (mn: number, volta: number | null, beat: number) => void;
  } = {},
): { overlay: HarmonyOverlay; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const overlay = new HarmonyOverlay({
    container,
    ghostLayer: overrides.ghostLayer ?? defaultGhostLayer(),
    mcIndex: new Map(),
    events: overrides.events ?? [],
    scale: overrides.scale,
    onLabelClick: overrides.onLabelClick,
  });
  return { overlay, container };
}

// ---------------------------------------------------------------------------
// Constructor and DOM structure
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — constructor', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('appends exactly one overlay child to the container', () => {
    const { container } = createOverlay();
    expect(container.children).toHaveLength(1);
  });

  it('overlay element has aria-hidden="true"', () => {
    const { container } = createOverlay();
    const overlayEl = container.firstElementChild as HTMLElement;
    expect(overlayEl.getAttribute('aria-hidden')).toBe('true');
  });

  it('produces no label spans when events is empty', () => {
    const { container } = createOverlay({ events: [] });
    expect(container.firstElementChild!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Label text content
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — label text', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders numeral with key on the first label', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V65', local_key: 'C' })],
    });
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V65 (C)');
  });

  it('renders applied_to as "numeral/applied_to"', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V65', applied_to: 'IV', local_key: 'C' })],
    });
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V65/IV (C)');
  });

  it('renders "—" when numeral and applied_to are null and key is null', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: null, applied_to: null, local_key: null })],
    });
    expect(container.firstElementChild!.children[0]!.textContent).toBe('—');
  });

  it('suppresses key on consecutive labels sharing the same local_key', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [
          { beatIdx: 0, beatFloat: 1.0, left: 0 },
          { beatIdx: 1, beatFloat: 2.0, left: 40 },
        ],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [
        makeEvent({ beat: 1.0, numeral: 'I', local_key: 'C' }),
        makeEvent({ beat: 2.0, numeral: 'V', local_key: 'C' }),
      ],
    });
    const labels = container.firstElementChild!.children;
    expect(labels).toHaveLength(2);
    expect(labels[0]!.textContent).toBe('I (C)');  // first label: key shown
    expect(labels[1]!.textContent).toBe('V');       // same key: suppressed
  });

  it('re-shows key when it changes between consecutive labels', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [
          { beatIdx: 0, beatFloat: 1.0, left: 0 },
          { beatIdx: 1, beatFloat: 2.0, left: 40 },
        ],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [
        makeEvent({ beat: 1.0, numeral: 'I', local_key: 'C' }),
        makeEvent({ beat: 2.0, numeral: 'V', local_key: 'G' }),
      ],
    });
    const labels = container.firstElementChild!.children;
    expect(labels[0]!.textContent).toBe('I (C)');
    expect(labels[1]!.textContent).toBe('V (G)');
  });
});

// ---------------------------------------------------------------------------
// Stacked figures (Step 22)
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — stacked figures', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** Return the stacked-figure rows (digit strings) of the first label, or null. */
  function figureRows(container: HTMLElement): string[] | null {
    const label = container.firstElementChild!.children[0] as HTMLElement | undefined;
    if (!label) return null;
    const figure = label.querySelector('[data-figure]');
    if (!figure) return null;
    return Array.from(figure.children).map(c => c.textContent ?? '');
  }

  it('stacks a figbass figure: V65 → rows 6,5; textContent unchanged', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V65', local_key: 'C' })],
    });
    expect(figureRows(container)).toEqual(['6', '5']);
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V65 (C)');
  });

  it('stacks V43 → rows 4,3', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V43' })],
    });
    expect(figureRows(container)).toEqual(['4', '3']);
  });

  it('stacks I64 → rows 6,4', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'I64' })],
    });
    expect(figureRows(container)).toEqual(['6', '4']);
  });

  it('stacks a single-digit figbass figure: V7 → row 7', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V7' })],
    });
    expect(figureRows(container)).toEqual(['7']);
  });

  it('cadential six-four: V + extensions ["64"] → rows 6,4; textContent "V64 (C)"', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V', extensions: ['64'], local_key: 'C' })],
    });
    expect(figureRows(container)).toEqual(['6', '4']);
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V64 (C)');
  });

  it('plain root-position numeral with no extensions has no figure', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V', extensions: [], local_key: 'C' })],
    });
    expect(figureRows(container)).toBeNull();
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V (C)');
  });

  it('figbass wins over a "64" extension: V7 + ["64"] → rows 7 only', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V7', extensions: ['64'] })],
    });
    expect(figureRows(container)).toEqual(['7']);
  });

  it('non-cadential extension is ignored (renders as today)', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V', extensions: ['b3'], local_key: 'C' })],
    });
    expect(figureRows(container)).toBeNull();
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V (C)');
  });

  it('applied chord keeps slash after the stacked figure', () => {
    const { container } = createOverlay({
      events: [makeEvent({ numeral: 'V65', applied_to: 'V', local_key: 'C' })],
    });
    expect(figureRows(container)).toEqual(['6', '5']);
    expect(container.firstElementChild!.children[0]!.textContent).toBe('V65/V (C)');
  });
});

// ---------------------------------------------------------------------------
// Font size scales with staff size (Step 22)
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — label font size', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the 12px base at the Small staff preset (scale 35)', () => {
    const { container } = createOverlay({ scale: 35, events: [makeEvent()] });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.fontSize).toBe('12px');
  });

  it('scales the font up proportionally for larger staff presets', () => {
    const med = createOverlay({ scale: 45, events: [makeEvent()] });
    const lbl45 = med.container.firstElementChild!.children[0] as HTMLElement;
    expect(lbl45.style.fontSize).toBe('15.4px'); // 12 * 45/35, rounded to 0.1
    document.body.innerHTML = '';

    const lg = createOverlay({ scale: 55, events: [makeEvent()] });
    const lbl55 = lg.container.firstElementChild!.children[0] as HTMLElement;
    expect(lbl55.style.fontSize).toBe('18.9px'); // 12 * 55/35, rounded to 0.1
  });

  it('falls back to the base size when no scale is provided', () => {
    const { container } = createOverlay({ events: [makeEvent()] });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.fontSize).toBe('12px');
  });
});

// ---------------------------------------------------------------------------
// Label positioning
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — label positioning', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('x-position is the beat ghost bounds.left', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 10, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 30 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ beat: 1.0 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.left).toBe('30px');
  });

  it('y-position is measure bounds.top + height + LANE_OFFSET_PX', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 10, top: 100, height: 40 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 10 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ beat: 1.0 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.top).toBe(`${100 + 40 + LANE_OFFSET_PX}px`);
  });
});

// ---------------------------------------------------------------------------
// Beat resolution
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — beat resolution', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('downbeat event (fractional part < 0.01) uses beatIndex', () => {
    // beat=2.0 → beatIdx=1 (1-indexed → 0-indexed); ghost at beatIdx=1 has left=50
    const { container } = createOverlay({
      events: [makeEvent({ beat: 2.0 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.left).toBe('50px');
  });

  it('sub-beat event probes subBeatIndex and picks the closest beatFloat', () => {
    // beat=1.5 → beatIdx=0, subBeatFrac=0.5
    // sb=1 has beatFloat=1.5 (exact), sb=2 has beatFloat=1.75 (farther)
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 0 }],
        subBeats: [
          { beatIdx: 0, sb: 1, beatFloat: 1.5, left: 25 },
          { beatIdx: 0, sb: 2, beatFloat: 1.75, left: 35 },
        ],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ beat: 1.5 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.left).toBe('25px');
  });

  it('sub-beat event falls back to beatIndex when subBeatIndex has no entry', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 10 }],
        // no subBeats provided
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ beat: 1.5 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.left).toBe('10px');
  });

  it('beat walk-back: when beat N is absent, uses the nearest earlier beat ghost', () => {
    // Only beatIdx=0 present; event requests beat 3 (beatIdx=2, absent).
    // Walk-back tries beatIdx=1 (absent), then beatIdx=0 (found) → left=10.
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 10 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ beat: 3.0 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.left).toBe('10px');
  });

  it('event is silently skipped when its measure ghost is absent', () => {
    // defaultGhostLayer has measure 1; event requests measure 99 (not present).
    const { container } = createOverlay({
      events: [makeEvent({ mn: 99, beat: 1.0 })],
    });
    expect(container.firstElementChild!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Volta / repeat-ending handling
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — volta filtering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('event with volta=null resolves against the plain "m1" ghost', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        endingN: null,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 10 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ mn: 1, beat: 1.0, volta: null })],
    });
    expect(container.firstElementChild!.children).toHaveLength(1);
  });

  it('event with volta=1 resolves against the "m1-e1" ending ghost', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        endingN: 1,   // generates key "m1-e1"
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 77 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ mn: 1, beat: 1.0, volta: 1 })],
    });
    const label = container.firstElementChild!.children[0] as HTMLElement;
    expect(label.style.left).toBe('77px');
  });

  it('event with volta=2 is skipped when only the volta=1 ghost exists', () => {
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        endingN: 1,   // only ending 1 present
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 10 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ mn: 1, beat: 1.0, volta: 2 })],
    });
    expect(container.firstElementChild!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reproject()
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — reproject()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('rebuilds labels at new x-positions after receiving a fresh ghost layer', () => {
    const { overlay, container } = createOverlay({
      events: [makeEvent({ beat: 1.0 })],
    });
    // defaultGhostLayer: beat 0 at left=10
    expect((container.firstElementChild!.children[0] as HTMLElement).style.left).toBe('10px');

    // New ghost layer: same measure but beat 0 shifted to left=200
    const newGhostLayer = makeMockGhostLayer([
      {
        barN: 1,
        renderOrder: 0,
        bounds: { left: 200, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 200 }],
      },
    ]);
    overlay.reproject(newGhostLayer, new Map());

    expect((container.firstElementChild!.children[0] as HTMLElement).style.left).toBe('200px');
  });

  it('clears stale labels when the new ghost layer has no matching measure', () => {
    const { overlay, container } = createOverlay({
      events: [makeEvent({ beat: 1.0 })],
    });
    expect(container.firstElementChild!.children).toHaveLength(1);

    overlay.reproject(makeMockGhostLayer([]), new Map());

    expect(container.firstElementChild!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setEvents()
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — setEvents()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds labels when events are set on an initially empty overlay', () => {
    const { overlay, container } = createOverlay({ events: [] });
    expect(container.firstElementChild!.children).toHaveLength(0);

    overlay.setEvents([makeEvent({ numeral: 'I', local_key: 'D' })]);

    expect(container.firstElementChild!.children).toHaveLength(1);
    expect(container.firstElementChild!.children[0]!.textContent).toBe('I (D)');
  });

  it('clears previous labels and replaces them with the new event list', () => {
    const { overlay, container } = createOverlay({
      events: [makeEvent({ numeral: 'V' })],
    });
    expect(container.firstElementChild!.children).toHaveLength(1);

    overlay.setEvents([]);
    expect(container.firstElementChild!.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// destroy()
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — destroy()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('removes the overlay element from the container', () => {
    const { overlay, container } = createOverlay();
    expect(container.children).toHaveLength(1);

    overlay.destroy();

    expect(container.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onLabelClick callback
// ---------------------------------------------------------------------------

describe('HarmonyOverlay — onLabelClick', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('fires onLabelClick with (mn, volta, beat) when a label is clicked', () => {
    const onLabelClick = vi.fn();
    const { container } = createOverlay({
      events: [makeEvent({ mn: 1, beat: 2.0, volta: null })],
      onLabelClick,
    });
    (container.firstElementChild!.children[0] as HTMLElement).click();
    expect(onLabelClick).toHaveBeenCalledOnce();
    expect(onLabelClick).toHaveBeenCalledWith(1, null, 2.0);
  });

  it('passes the volta number to onLabelClick for repeat-ending events', () => {
    const onLabelClick = vi.fn();
    const ghostLayer = makeMockGhostLayer([
      {
        barN: 1,
        endingN: 1,
        renderOrder: 0,
        bounds: { left: 0, top: 100 },
        beats: [{ beatIdx: 0, beatFloat: 1.0, left: 10 }],
      },
    ]);
    const { container } = createOverlay({
      ghostLayer,
      events: [makeEvent({ mn: 1, beat: 1.0, volta: 1 })],
      onLabelClick,
    });
    (container.firstElementChild!.children[0] as HTMLElement).click();
    expect(onLabelClick).toHaveBeenCalledWith(1, 1, 1.0);
  });

  it('labels without onLabelClick do not throw on click', () => {
    const { container } = createOverlay({
      events: [makeEvent({ mn: 1, beat: 1.0 })],
      // no onLabelClick
    });
    expect(() =>
      (container.firstElementChild!.children[0] as HTMLElement).click()
    ).not.toThrow();
  });
});
