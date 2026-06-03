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
  buildNoteInfoMap,
  getTimemapTempo,
  parseMeiMeterUnit,
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
      header: 'none',
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

// ---------------------------------------------------------------------------
// buildNoteInfoMap — Step 18 (transport bar measure:beat display)
// ---------------------------------------------------------------------------

/**
 * buildNoteInfoMap parses MEI XML directly — no Verovio toolkit call needed.
 *
 * Each highlighted SVG element's DOM id is the MEI xml:id of the note.
 * The map connects that id to the note's parent measure @n (display bar number)
 * and its @tstamp (beat, in the time signature's denominator unit).
 *
 * This resolves all three transport-bar sub-defects that Tone.js cannot:
 *
 * 1. Pickup bars — MEI @n = 0, beats renumbered from 1 within the pickup.
 *    Tone.js counts the pickup as a full bar, making all subsequent bars wrong.
 *
 * 2. Repeats — the second pass through bar 4 highlights the SAME SVG element
 *    as the first pass (Step 17 strips the -rendN suffix). The map returns
 *    barN = 4 on both passes. Tone.js would return 12 on the second pass.
 *
 * 3. Non-quarter meters — MEI @tstamp is in the denominator unit (eighths for
 *    6/8), so notes in a 6/8 bar correctly show beats 1–6.
 *    Tone.js would show beats 1–3 (quarter notes), regardless of time signature.
 */

// Shared MEI fixtures used across test cases.
// Note: in jsdom DOMParser XML mode, getAttribute('xml:id') returns the value
// correctly (jsdom stores the attribute by qualified name including the prefix).

const makeMei = (meterCount: number, meterUnit: number, measures: string) =>
  `<mei xmlns="http://www.music-encoding.org/ns/mei">
    <music><body><mdiv><score>
      <scoreDef meter.count="${meterCount}" meter.unit="${meterUnit}"/>
      <section>${measures}</section>
    </score></mdiv></body></music>
  </mei>`;

const note = (id: string, tstamp: number | string) =>
  `<note xml:id="${id}" tstamp="${tstamp}" dur="4"/>`;

const rest = (id: string, tstamp: number | string) =>
  `<rest xml:id="${id}" tstamp="${tstamp}" dur="4"/>`;

const chord = (tstamp: number, ...noteIds: string[]) =>
  `<chord tstamp="${tstamp}" dur="4">${noteIds.map(id =>
    `<note xml:id="${id}"/>`
  ).join('')}</chord>`;

const measure = (n: number, ...content: string[]) =>
  `<staff n="1"><layer n="1">${content.join('')}</layer></staff>`;

const bar = (n: number, content: string) =>
  `<measure n="${n}">${content}</measure>`;

describe('buildNoteInfoMap', () => {
  // buildNoteInfoMap is a pure MEI-parsing function — no toolkit mock needed.

  // ── Basic cases ──────────────────────────────────────────────────────────

  it('returns an empty map for empty MEI', () => {
    const emptyMei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score><section/></score></mdiv></body></music>
    </mei>`;
    expect(buildNoteInfoMap(emptyMei).size).toBe(0);
  });

  it('returns an empty map for MEI with measures but no notes', () => {
    const mei = makeMei(4, 4, bar(1, ''));
    expect(buildNoteInfoMap(mei).size).toBe(0);
  });

  it('returns an empty map when MEI is not valid XML', () => {
    expect(buildNoteInfoMap('not xml at all').size).toBe(0);
  });

  // ── Bar number (sub-defect 2: repeat policy) ────────────────────────────

  it('maps a note in measure @n=1 to barN=1', () => {
    const mei = makeMei(4, 4, bar(1, measure(1, note('n1', 1))));
    const map = buildNoteInfoMap(mei);
    expect(map.get('n1')?.barN).toBe(1);
  });

  it('maps notes to their respective measure @n values', () => {
    const mei = makeMei(4, 4,
      bar(1, measure(1, note('n1', 1), note('n2', 2))) +
      bar(2, measure(1, note('n3', 1))) +
      bar(3, measure(1, note('n4', 1))),
    );
    const map = buildNoteInfoMap(mei);
    expect(map.get('n1')?.barN).toBe(1);
    expect(map.get('n2')?.barN).toBe(1);
    expect(map.get('n3')?.barN).toBe(2);
    expect(map.get('n4')?.barN).toBe(3);
  });

  it('uses sequential index when a measure lacks @n', () => {
    // No @n attribute → falls back to 1-based sequential position.
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score><section>
        <measure>
          <staff n="1"><layer n="1"><note xml:id="n1" tstamp="1" dur="4"/></layer></staff>
        </measure>
      </section></score></mdiv></body></music>
    </mei>`;
    const map = buildNoteInfoMap(mei);
    expect(map.get('n1')?.barN).toBe(1);
  });

  // ── Beat (sub-defect 3: non-quarter beat normalisation) ──────────────────

  it('reads beat directly from @tstamp for 4/4 notes (1–4)', () => {
    const mei = makeMei(4, 4,
      bar(1, measure(1, note('n1', 1), note('n2', 2), note('n3', 3), note('n4', 4))),
    );
    const map = buildNoteInfoMap(mei);
    expect(map.get('n1')?.beat).toBe(1);
    expect(map.get('n2')?.beat).toBe(2);
    expect(map.get('n3')?.beat).toBe(3);
    expect(map.get('n4')?.beat).toBe(4);
  });

  it('reads eighth-note beats 1–6 from @tstamp for 6/8 notes', () => {
    // In 6/8, MEI @tstamp uses eighth-note units: 1, 2, 3, 4, 5, 6.
    // The note-info map should reflect these directly, giving the correct
    // 6-beat display instead of Tone.js's 3-quarter-beat counter.
    const mei = makeMei(6, 8,
      bar(1, measure(1,
        note('n1', 1), note('n2', 2), note('n3', 3),
        note('n4', 4), note('n5', 5), note('n6', 6),
      )),
    );
    const map = buildNoteInfoMap(mei);
    for (let b = 1; b <= 6; b++) {
      expect(map.get(`n${b}`)?.beat).toBe(b);
    }
  });

  it('floors fractional @tstamp to the beat number (note on off-beat → current beat)', () => {
    // A note with @tstamp="1.5" is on the "and" of beat 1 in 4/4.
    // The transport displays beat 1, not beat 2.
    const mei = makeMei(4, 4, bar(1, measure(1, note('n1', '1.5'))));
    expect(buildNoteInfoMap(mei).get('n1')?.beat).toBe(1);
  });

  it('returns beat=0 for a note without @tstamp', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score><section>
        <measure n="1">
          <staff n="1"><layer n="1">
            <note xml:id="n1" dur="4"/>
          </layer></staff>
        </measure>
      </section></score></mdiv></body></music>
    </mei>`;
    expect(buildNoteInfoMap(mei).get('n1')?.beat).toBe(0);
  });

  // ── Chord handling ────────────────────────────────────────────────────────

  it('inherits @tstamp from parent <chord> for notes inside chords', () => {
    // In MEI, chords carry @tstamp; individual notes inside do not.
    const mei = makeMei(4, 4,
      bar(1, `<staff n="1"><layer n="1">${chord(3, 'n1', 'n2', 'n3')}</layer></staff>`),
    );
    const map = buildNoteInfoMap(mei);
    expect(map.get('n1')?.beat).toBe(3);
    expect(map.get('n2')?.beat).toBe(3);
    expect(map.get('n3')?.beat).toBe(3);
    // All chord notes belong to the same measure.
    expect(map.get('n1')?.barN).toBe(1);
  });

  // ── Rest handling ─────────────────────────────────────────────────────────

  it('includes rests with their bar and beat', () => {
    const mei = makeMei(4, 4, bar(2, measure(1, rest('r1', 1), rest('r2', 3))));
    const map = buildNoteInfoMap(mei);
    expect(map.get('r1')).toEqual({ barN: 2, beat: 1 });
    expect(map.get('r2')).toEqual({ barN: 2, beat: 3 });
  });

  // ── Pickup bar handling (sub-defect 1) ───────────────────────────────────

  it('sets barN=0 for notes in a pickup bar (@n="0")', () => {
    // A pickup bar has MEI @n = "0". After normalisation every piece with an
    // anacrusis has this convention. Tone.js would call it bar 1.
    const mei = makeMei(4, 4,
      bar(0, measure(1, note('pickup', 4))) +  // pickup: one note on beat 4
      bar(1, measure(1, note('b1n1', 1))),     // first full bar
    );
    const map = buildNoteInfoMap(mei);
    expect(map.get('pickup')?.barN).toBe(0);
    expect(map.get('b1n1')?.barN).toBe(1);
  });

  it('renumbers pickup beats from 1 (not the full-bar @tstamp value)', () => {
    // A one-beat pickup in 4/4: the note has @tstamp=4 (last beat of a 4/4 bar).
    // The display rule: show "0:1", not "0:4". The map renumbers within the pickup.
    const mei = makeMei(4, 4,
      bar(0, measure(1, note('pickup', 4))),
    );
    expect(buildNoteInfoMap(mei).get('pickup')?.beat).toBe(1);
  });

  it('renumbers multiple pickup notes starting from 1 in onset order', () => {
    // Three-note pickup in 4/4 with notes on beats 2, 3, 4.
    // Expected: beat 1, 2, 3 (not 2, 3, 4).
    const mei = makeMei(4, 4,
      bar(0, measure(1, note('p1', 2), note('p2', 3), note('p3', 4))),
    );
    const map = buildNoteInfoMap(mei);
    expect(map.get('p1')?.beat).toBe(1);
    expect(map.get('p2')?.beat).toBe(2);
    expect(map.get('p3')?.beat).toBe(3);
  });

  it('non-pickup bars are unaffected by the pickup renumbering', () => {
    // Pickup: one note at @tstamp=4 → beat 1. Bar 1: notes at 1, 2, 3, 4 → 1, 2, 3, 4.
    const mei = makeMei(4, 4,
      bar(0, measure(1, note('pickup', 4))) +
      bar(1, measure(1, note('b1', 1), note('b2', 2), note('b3', 3), note('b4', 4))),
    );
    const map = buildNoteInfoMap(mei);
    expect(map.get('pickup')?.beat).toBe(1);  // renumbered
    expect(map.get('b1')?.beat).toBe(1);      // @tstamp=1 → beat 1 (unchanged)
    expect(map.get('b4')?.beat).toBe(4);      // @tstamp=4 → beat 4 (unchanged)
  });

  // ── Multi-staff / multi-voice ────────────────────────────────────────────

  it('maps notes from different staves/voices to the same barN', () => {
    // Two staves, same measure.
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score><section>
        <measure n="5">
          <staff n="1"><layer n="1"><note xml:id="s1n1" tstamp="1" dur="4"/></layer></staff>
          <staff n="2"><layer n="1"><note xml:id="s2n1" tstamp="1" dur="4"/></layer></staff>
        </measure>
      </section></score></mdiv></body></music>
    </mei>`;
    const map = buildNoteInfoMap(mei);
    expect(map.get('s1n1')?.barN).toBe(5);
    expect(map.get('s2n1')?.barN).toBe(5);
    expect(map.get('s1n1')?.beat).toBe(1);
    expect(map.get('s2n1')?.beat).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getTimemapTempo
// ---------------------------------------------------------------------------

describe('getTimemapTempo', () => {
  it('returns 120 when renderToTimemap returns an empty array', () => {
    const tk = { renderToTimemap: vi.fn().mockReturnValue('[]') };
    expect(getTimemapTempo(tk as never)).toBe(120);
  });

  it('returns 120 when no entry has a tempo field', () => {
    const tk = {
      renderToTimemap: vi.fn().mockReturnValue(
        JSON.stringify([{ tstamp: 0, on: ['n1'] }, { tstamp: 500, on: ['n2'] }]),
      ),
    };
    expect(getTimemapTempo(tk as never)).toBe(120);
  });

  it('returns the first tempo value from a string timemap', () => {
    const tk = {
      renderToTimemap: vi.fn().mockReturnValue(
        JSON.stringify([{ tstamp: 0, tempo: 96 }, { tstamp: 2000, tempo: 108 }]),
      ),
    };
    expect(getTimemapTempo(tk as never)).toBe(96);
  });

  it('returns the first tempo value when renderToTimemap returns a parsed array', () => {
    const tk = {
      renderToTimemap: vi.fn().mockReturnValue(
        [{ tstamp: 0, tempo: 72 }],
      ),
    };
    expect(getTimemapTempo(tk as never)).toBe(72);
  });

  it('returns 120 when renderToTimemap throws', () => {
    const tk = { renderToTimemap: vi.fn().mockImplementation(() => { throw new Error('fail'); }) };
    expect(getTimemapTempo(tk as never)).toBe(120);
  });

  it('skips non-numeric tempo fields and returns the first numeric one', () => {
    const tk = {
      renderToTimemap: vi.fn().mockReturnValue(
        JSON.stringify([
          { tstamp: 0, on: ['n1'] },
          { tstamp: 100, tempo: 'allegro' },
          { tstamp: 200, tempo: 140 },
        ]),
      ),
    };
    expect(getTimemapTempo(tk as never)).toBe(140);
  });
});

// ---------------------------------------------------------------------------
// parseMeiMeterUnit
// ---------------------------------------------------------------------------

describe('parseMeiMeterUnit', () => {
  it('returns 4 for empty MEI', () => {
    expect(parseMeiMeterUnit('<mei/>')).toBe(4);
  });

  it('returns 4 on invalid XML', () => {
    expect(parseMeiMeterUnit('not xml <<<<')).toBe(4);
  });

  it('reads meter.unit from scoreDef', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef meter.count="6" meter.unit="8"/>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(8);
  });

  it('returns 4 for 4/4 time signature', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef meter.count="4" meter.unit="4"/>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(4);
  });

  it('reads meter.unit from staffDef when scoreDef is absent', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <staffDef n="1" meter.count="3" meter.unit="4"/>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(4);
  });

  it('returns 2 for cut time (meter.unit=2)', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef meter.count="2" meter.unit="2"/>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(2);
  });

  it('prefers scoreDef over staffDef when both present', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef meter.count="6" meter.unit="8"/>
        <staffDef n="1" meter.count="3" meter.unit="4"/>
      </score></mdiv></body></music>
    </mei>`;
    // scoreDef comes first in document order → returned first
    expect(parseMeiMeterUnit(mei)).toBe(8);
  });

  // ── <meterSig> child element style (MuseScore/OpenScore MEI) ────────────

  it('reads unit from <meterSig> child of staffDef (MuseScore style)', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef>
          <staffGrp>
            <staffDef n="1" lines="5">
              <meterSig count="6" unit="8"/>
            </staffDef>
          </staffGrp>
        </scoreDef>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(8);
  });

  it('reads unit from <meterSig> child of scoreDef', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef>
          <meterSig count="2" unit="2"/>
        </scoreDef>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(2);
  });

  it('reads unit from <meterSig> inside a measure (normalizer-inserted)', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef><staffGrp><staffDef n="1"/></staffGrp></scoreDef>
        <section>
          <measure n="1">
            <meterSig count="6" unit="8"/>
            <staff n="1"><layer n="1"><note dur="8"/></layer></staff>
          </measure>
        </section>
      </score></mdiv></body></music>
    </mei>`;
    expect(parseMeiMeterUnit(mei)).toBe(8);
  });

  it('@meter.unit attribute takes precedence over <meterSig> when both present', () => {
    const mei = `<mei xmlns="http://www.music-encoding.org/ns/mei">
      <music><body><mdiv><score>
        <scoreDef meter.count="3" meter.unit="4">
          <meterSig count="6" unit="8"/>
        </scoreDef>
      </score></mdiv></body></music>
    </mei>`;
    // Attribute style checked first → returns 4
    expect(parseMeiMeterUnit(mei)).toBe(4);
  });
});
