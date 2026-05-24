/**
 * Unit tests for frontend/src/services/verovio.ts.
 *
 * The Verovio toolkit is never loaded — all tests use a mock toolkit object
 * constructed locally. The functions under test (renderFragment, renderPage,
 * renderProgressively) accept the toolkit as an argument, so no module mock
 * is needed.
 *
 * For WASM client-side verification of edge cases (mc=1, volta endings), see
 * verovio-fragment.wasm-spike.test.ts (run with VEROVIO_WASM_SPIKE=1).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHighlightSchedule,
  renderFragment,
  renderPage,
  renderProgressively,
  type RenderOptions,
} from '../verovio';

// ---------------------------------------------------------------------------
// Mock toolkit factory
// ---------------------------------------------------------------------------

function makeMockToolkit() {
  return {
    setOptions: vi.fn(),
    loadData: vi.fn().mockReturnValue(true),
    select: vi.fn().mockReturnValue(true),
    redoLayout: vi.fn(),
    getPageCount: vi.fn().mockReturnValue(1),
    renderToSVG: vi.fn().mockReturnValue('<svg/>'),
    renderToMIDI: vi.fn().mockReturnValue('base64midi=='),
    renderToTimemap: vi.fn().mockReturnValue('[]'),
    getElementsAtTime: vi.fn().mockReturnValue('{}'),
  };
}

const BASE_OPTIONS: RenderOptions = {
  scale: 35,
  transpose: '',
  font: 'Bravura',
  pageWidth: 2200,
};

// ---------------------------------------------------------------------------
// renderFragment
// ---------------------------------------------------------------------------

describe('renderFragment', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
  });

  it('calls setOptions with the correct fragment options', async () => {
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(tk.setOptions).toHaveBeenCalledOnce();
    expect(tk.setOptions).toHaveBeenCalledWith({
      scale: 35,
      transpose: '',
      pageWidth: 2200,
      font: 'Bravura',
      adjustPageHeight: true,
      breaks: 'none',
      pageMarginTop: 0,
      pageMarginBottom: 0,
      footer: 'none',
    });
  });

  it('does NOT pass scaleToPageSize to fragment renders', async () => {
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    const opts = tk.setOptions.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('scaleToPageSize');
  });

  it('follows the correct call sequence: setOptions → loadData → select → redoLayout → renderToSVG', async () => {
    const order: string[] = [];
    tk.setOptions.mockImplementation(() => order.push('setOptions'));
    tk.loadData.mockImplementation(() => { order.push('loadData'); return true; });
    tk.select.mockImplementation(() => { order.push('select'); return true; });
    tk.redoLayout.mockImplementation(() => order.push('redoLayout'));
    tk.renderToSVG.mockImplementation(() => { order.push('renderToSVG'); return '<svg/>'; });

    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(order).toEqual(['setOptions', 'loadData', 'select', 'redoLayout', 'renderToSVG']);
  });

  it('does NOT call getPageCount (fragment always renders page 1 directly)', async () => {
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(tk.getPageCount).not.toHaveBeenCalled();
  });

  describe('measureRange string formatting', () => {
    it('formats mcStart=1, mcEnd=4 as "1-4"', async () => {
      await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
      expect(tk.select).toHaveBeenCalledWith({ measureRange: '1-4' });
    });

    it('formats mcStart=3, mcEnd=7 as "3-7"', async () => {
      await renderFragment(tk, '<mei/>', 3, 7, BASE_OPTIONS);
      expect(tk.select).toHaveBeenCalledWith({ measureRange: '3-7' });
    });

    it('formats a single-measure fragment (mcStart=1, mcEnd=1) as "1-1"', async () => {
      await renderFragment(tk, '<mei/>', 1, 1, BASE_OPTIONS);
      expect(tk.select).toHaveBeenCalledWith({ measureRange: '1-1' });
    });
  });

  it('always calls renderToSVG(1), not the page count', async () => {
    // getPageCount returns 3 — renderToSVG must still receive 1, not 3.
    tk.getPageCount.mockReturnValue(3);
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(tk.renderToSVG).toHaveBeenCalledWith(1);
  });

  it('resolves with the SVG string returned by renderToSVG', async () => {
    tk.renderToSVG.mockReturnValue('<svg id="test"/>');
    const result = await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(result).toBe('<svg id="test"/>');
  });
});

// ---------------------------------------------------------------------------
// renderPage — contrast test to document fragment/full-score option differences
// ---------------------------------------------------------------------------

describe('renderPage', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
  });

  it('passes scaleToPageSize: true and breaks: "smart" (unlike renderFragment)', async () => {
    await renderPage(tk, '<mei/>', BASE_OPTIONS, 1);
    const opts = tk.setOptions.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toHaveProperty('scaleToPageSize', true);
    expect(opts).toHaveProperty('breaks', 'smart');
  });

  it('renders the requested page number', async () => {
    await renderPage(tk, '<mei/>', BASE_OPTIONS, 3);
    expect(tk.renderToSVG).toHaveBeenCalledWith(3);
  });

  it('does not call select or redoLayout', async () => {
    await renderPage(tk, '<mei/>', BASE_OPTIONS, 1);
    expect(tk.select).not.toHaveBeenCalled();
    expect(tk.redoLayout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderProgressively
// ---------------------------------------------------------------------------

describe('renderProgressively', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onPage for each page and onComplete with the total', async () => {
    tk.getPageCount.mockReturnValue(3);
    tk.renderToSVG.mockImplementation((page: number) => `<svg page="${page}"/>`);

    const onPage = vi.fn();
    const onComplete = vi.fn();

    const promise = renderProgressively(tk, '<mei/>', BASE_OPTIONS, onPage, onComplete);

    // Page 1 is synchronous — fires before any timer
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenNthCalledWith(1, '<svg page="1"/>', 1);

    // Flush the setTimeout(0) yields for pages 2 and 3
    await vi.runAllTimersAsync();
    await promise;

    expect(onPage).toHaveBeenCalledTimes(3);
    expect(onPage).toHaveBeenNthCalledWith(2, '<svg page="2"/>', 2);
    expect(onPage).toHaveBeenNthCalledWith(3, '<svg page="3"/>', 3);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(3);
  });

  it('fires onPage once and onComplete immediately for a single-page score', async () => {
    tk.getPageCount.mockReturnValue(1);
    const onPage = vi.fn();
    const onComplete = vi.fn();

    await renderProgressively(tk, '<mei/>', BASE_OPTIONS, onPage, onComplete);
    expect(onPage).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// buildHighlightSchedule — Step 17 (note highlight on repeats)
// ---------------------------------------------------------------------------

/**
 * buildHighlightSchedule uses renderToTimemap(), which expands repeats fully.
 *
 * Root cause of the Step 17 bug: Verovio appends a `-rendN` suffix (e.g.
 * `-rend2`, `-rend3`) to every element ID in the timemap for additional passes
 * through a repeated section. These are *virtual* IDs — the SVG DOM only
 * contains the original ID (each repeated measure is drawn once). Calling
 * `getElementById("note-abc-rend2")` returns null, so the highlight disappears
 * on every repeated pass. The fix is to strip the suffix in buildHighlightSchedule
 * before the schedule is stored, so both passes map to the real DOM element.
 *
 * Volta-bracket endings are genuinely separate measures with their own original
 * IDs and are unaffected (no `-rendN` suffix on those elements).
 */
describe('buildHighlightSchedule', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
  });

  it('returns an empty array when the timemap is empty', () => {
    tk.renderToTimemap.mockReturnValue('[]');
    expect(buildHighlightSchedule(tk)).toEqual([]);
  });

  it('returns an empty array when renderToTimemap throws', () => {
    tk.renderToTimemap.mockImplementation(() => { throw new Error('WASM error'); });
    expect(buildHighlightSchedule(tk)).toEqual([]);
  });

  it('returns an empty array when all entries lack an `on` field', () => {
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0, off: ['note1'] },
      { tstamp: 500 },
    ]));
    expect(buildHighlightSchedule(tk)).toEqual([]);
  });

  it('skips entries with an empty `on` array', () => {
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0, on: [] },
      { tstamp: 500, on: ['note1'] },
    ]));
    expect(buildHighlightSchedule(tk)).toEqual([{ timeMs: 500, ids: ['note1'] }]);
  });

  it('skips entries without a tstamp', () => {
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { on: ['note1'] },
      { tstamp: 500, on: ['note2'] },
    ]));
    expect(buildHighlightSchedule(tk)).toEqual([{ timeMs: 500, ids: ['note2'] }]);
  });

  it('returns a single entry for a single onset', () => {
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0, on: ['note1', 'note2'] },
    ]));
    expect(buildHighlightSchedule(tk)).toEqual([{ timeMs: 0, ids: ['note1', 'note2'] }]);
  });

  it('sorts entries by timeMs even when renderToTimemap returns them out of order', () => {
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 1000, on: ['noteB'] },
      { tstamp: 0, on: ['noteA'] },
      { tstamp: 500, on: ['noteC'] },
    ]));
    const schedule = buildHighlightSchedule(tk);
    expect(schedule.map(e => e.timeMs)).toEqual([0, 500, 1000]);
    expect(schedule[0].ids).toEqual(['noteA']);
  });

  // ── -rendN suffix stripping (the root fix for Step 17) ───────────────────

  it('strips -rendN suffixes so repeated-pass IDs resolve to real DOM elements', () => {
    // Verovio appends -rend2 (2nd pass), -rend3 (3rd pass), etc.
    // None of these IDs exist in the SVG; only the base ID does.
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0,    on: ['note-abc'] },          // first pass — original ID in SVG
      { tstamp: 1000, on: ['note-abc-rend2'] },    // second pass — virtual ID, NOT in SVG
      { tstamp: 2000, on: ['note-abc-rend3'] },    // third pass — virtual ID, NOT in SVG
    ]));
    const schedule = buildHighlightSchedule(tk);
    expect(schedule[0].ids).toEqual(['note-abc']);
    expect(schedule[1].ids).toEqual(['note-abc']); // stripped to base ID
    expect(schedule[2].ids).toEqual(['note-abc']); // stripped to base ID
  });

  it('strips -rendN from multiple IDs in the same entry (e.g. chord in repeated bar)', () => {
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 500, on: ['note-1-rend2', 'note-2-rend2', 'note-3-rend2'] },
    ]));
    expect(buildHighlightSchedule(tk)).toEqual([
      { timeMs: 500, ids: ['note-1', 'note-2', 'note-3'] },
    ]);
  });

  it('does not strip when the suffix is mid-id (only trailing -rendN is removed)', () => {
    // e.g. an id that happens to contain "rend" as part of its meaningful name
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0, on: ['rendering-note1'] },   // contains "rend" but not -rendN at end
    ]));
    expect(buildHighlightSchedule(tk)).toEqual([
      { timeMs: 0, ids: ['rendering-note1'] },
    ]);
  });

  // ── Repeat handling (the core of Step 17) ───────────────────────────────

  it('maps repeated-pass entries to the same DOM IDs as the first pass', () => {
    // Actual Verovio output: first pass uses original IDs; second pass uses
    // -rend2 IDs. After stripping, both passes produce the same canonical IDs
    // so getElementById finds the SVG element on both passes.
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0,    on: ['bar1-note1', 'bar1-note2'] },        // first pass
      { tstamp: 500,  on: ['bar2-note1'] },
      { tstamp: 1000, on: ['bar1-note1-rend2', 'bar1-note2-rend2'] }, // second pass (virtual)
      { tstamp: 1500, on: ['bar2-note1-rend2'] },
    ]));
    const schedule = buildHighlightSchedule(tk);
    expect(schedule).toHaveLength(4);
    // Both passes resolve to the same base IDs:
    expect(schedule[0].ids).toEqual(['bar1-note1', 'bar1-note2']);
    expect(schedule[2].ids).toEqual(['bar1-note1', 'bar1-note2']); // was -rend2, now stripped
    expect(schedule[3].ids).toEqual(['bar2-note1']);                // was -rend2, now stripped
  });

  it('handles volta brackets: shared bars stripped, each ending keeps its own ID', () => {
    // Score: ||: bar1 :||1. first-ending :|2. second-ending ||
    // The timemap for the second pass through bar1 uses -rend2; the second
    // ending is a genuinely separate measure with its own original ID.
    tk.renderToTimemap.mockReturnValue(JSON.stringify([
      { tstamp: 0,    on: ['bar1-note1'] },              // first pass (original)
      { tstamp: 500,  on: ['first-ending-note1'] },      // first volta
      { tstamp: 1000, on: ['bar1-note1-rend2'] },        // second pass (virtual -rend2)
      { tstamp: 1500, on: ['second-ending-note1'] },     // second volta (original, exists in SVG)
    ]));
    const schedule = buildHighlightSchedule(tk);
    // First pass: original bar1 element highlighted
    expect(schedule[0]).toEqual({ timeMs: 0,    ids: ['bar1-note1'] });
    // First ending: its own element highlighted
    expect(schedule[1]).toEqual({ timeMs: 500,  ids: ['first-ending-note1'] });
    // Second pass through bar1: same element as first pass (suffix stripped)
    expect(schedule[2]).toEqual({ timeMs: 1000, ids: ['bar1-note1'] });
    // Second ending: its own distinct element highlighted
    expect(schedule[3]).toEqual({ timeMs: 1500, ids: ['second-ending-note1'] });
  });

  it('handles the timemap returned as an object (non-string) from the WASM binding', () => {
    // Some Verovio JS bindings deserialise the JSON before returning,
    // so the raw value may already be an array rather than a JSON string.
    const parsed = [{ tstamp: 0, on: ['note1'] }];
    tk.renderToTimemap.mockReturnValue(parsed as unknown as string);
    expect(buildHighlightSchedule(tk)).toEqual([{ timeMs: 0, ids: ['note1'] }]);
  });
});
