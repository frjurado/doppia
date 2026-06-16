/**
 * Verovio WASM service — single point of interaction with the Verovio toolkit.
 *
 * Components never import from 'verovio' directly. All rendering goes through
 * the functions exported here so that the WASM loading lifecycle is managed in
 * one place.
 *
 * Version: pinned at 6.1.0 in package.json (exact, no range prefix) to match
 * backend/requirements.txt (ADR-013, Decision 4 — WASM and Python bindings
 * must stay at the same major.minor version).
 *
 * Key API facts confirmed by the Component 2 Verovio spike (see
 * docs/architecture/mei-ingest-normalization.md §"Verovio bar-range selection"):
 *   - The correct call sequence is loadData() → select() → redoLayout() → renderToSVG().
 *   - select() without redoLayout() is a no-op from the rendering perspective.
 *   - measureRange operands are 1-based document-order position indices (mc values),
 *     NOT @n attribute values. mc_start/mc_end from the fragment row map directly.
 *   - measureRange "0-x" is invalid; position 0 does not exist.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rendering options accepted by all render functions. */
export interface RenderOptions {
  /** Staff size: 25 = small, 35 = medium (default), 45 = large. */
  scale: number;
  /**
   * Verovio transposition string, e.g. "M2" (up a tone), "-d2" (down a
   * semitone), "" (no transposition). Display-only — the MEI is never modified.
   */
  transpose: string;
  /**
   * Music notation font. One of "Bravura" (default), "Leipzig", "Leland".
   * Changing font triggers a full re-render — same path as a scale change.
   */
  font: string;
  /**
   * Page width in pixels. For full-score renders, measure the score panel
   * container's offsetWidth at render time — do not hardcode. For fragment
   * renders, use a wide fixed value (≥ 2200) so all measures fit on one line.
   */
  pageWidth: number;
}

/**
 * Subset of the Verovio 6.1.0 toolkit API used by this module.
 *
 * Typed locally — the verovio package ships no .d.ts files, so we define only
 * the methods this module calls. Verified against verovio/dist/verovio.mjs.
 *
 * Notable API facts:
 *   - getElementsAtTime takes a single millisecond offset, not (bar, beat).
 *   - redoLayout returns void (not boolean).
 *   - setOptions / select take plain objects (the class JSON-stringifies them
 *     before forwarding to the Emscripten layer).
 */
interface VerovioToolkitInstance {
  setOptions(options: Record<string, unknown>): void;
  loadData(data: string): boolean;
  select(selection: { measureRange: string }): boolean;
  redoLayout(options?: Record<string, unknown>): void;
  getPageCount(): number;
  renderToSVG(page: number): string;
  renderToMIDI(): string;
  /**
   * @param millisec - MIDI time offset in milliseconds.
   * Returns an object directly in Verovio 6.x WASM (not a JSON string as the
   * C++ API docs suggest — the JS binding deserialises before returning).
   */
  getElementsAtTime(millisec: number): string | { notes?: string[]; chords?: string[]; measure?: string; page?: number; rests?: string[] };
  /**
   * Returns a JSON string (array) mapping real-time offsets (ms) to the MEI
   * element IDs that start or end at each offset. Repeat sections are fully
   * expanded: a measure played twice produces two entries with the same element
   * IDs at different tstamp values. This makes it more reliable than
   * getElementsAtTime for building a playback-highlight schedule.
   *
   * Each entry shape: { tstamp: number; on?: string[]; off?: string[]; ... }
   */
  renderToTimemap(options?: Record<string, unknown>): string;
}

// ---------------------------------------------------------------------------
// Singleton loader
// ---------------------------------------------------------------------------

let _verovioPromise: Promise<VerovioToolkitInstance> | null = null;

/**
 * Returns the singleton Verovio toolkit instance, loading the WASM bundle
 * lazily on the first call.
 *
 * The ~7–10 MB WASM bundle is loaded only on first navigation to the score
 * viewer route, not at app startup. Concurrent callers receive the same
 * promise; the WASM module is never loaded twice.
 *
 * The route-level loading boundary should show a "Loading score renderer…"
 * placeholder (Surface layer="container" + label-md label) while this
 * promise is pending.
 */
export function getVerovioToolkit(): Promise<VerovioToolkitInstance> {
  if (!_verovioPromise) {
    // Two-step initialisation required by the verovio 6.x package structure:
    //   verovio/wasm  — default export is createVerovioModule(), an async
    //                   Emscripten factory that resolves to the C++ bindings.
    //   verovio/esm   — named export VerovioToolkit is the JS class; its
    //                   constructor takes the resolved Emscripten module.
    _verovioPromise = Promise.all([
      import('verovio/wasm') as unknown as Promise<{ default: () => Promise<unknown> }>,
      import('verovio/esm') as unknown as Promise<{ VerovioToolkit: new (m: unknown) => VerovioToolkitInstance }>,
    ]).then(async ([wasmMod, esmMod]) => {
      const VerovioModule = await wasmMod.default();
      return new esmMod.VerovioToolkit(VerovioModule);
    });
  }
  return _verovioPromise;
}

// ---------------------------------------------------------------------------
// Rendering functions
// ---------------------------------------------------------------------------

/**
 * Render one page of a score.
 *
 * Sets options, loads the MEI, and renders the requested page in a single
 * call. Use this for the initial render or after an options change (scale,
 * transposition). For the initial display of a multi-page score, prefer
 * renderProgressively() instead — it avoids the blank-screen gap while all
 * pages compile.
 *
 * @param tk      - Toolkit instance from getVerovioToolkit().
 * @param meiText - Normalized MEI content string (not a URL).
 * @param options - Scale, transposition, and page-width settings.
 * @param pageNum - 1-based page number to render.
 * @returns SVG markup string for the requested page.
 */
export async function renderPage(
  tk: VerovioToolkitInstance,
  meiText: string,
  options: RenderOptions,
  pageNum: number,
): Promise<string> {
  tk.setOptions({
    scale: options.scale,
    transpose: options.transpose,
    pageWidth: options.pageWidth,
    font: options.font,
    adjustPageHeight: true,
    breaks: 'smart',
    scaleToPageSize: true,
    pageMarginTop: 0,
    pageMarginBottom: 0,
    header: 'none',
    footer: 'none',
  });
  tk.loadData(meiText);
  return tk.renderToSVG(pageNum);
}

/** Options for renderFragment — RenderOptions plus the layout-break mode. */
export interface FragmentRenderOptions extends RenderOptions {
  /**
   * System-break mode for the fragment render:
   *   - 'none' (default): all selected measures on one long system. pageWidth
   *     should be a wide fixed value (≥ 2200). Incipit-style rendering.
   *   - 'smart': Verovio breaks systems at pageWidth, which should be the
   *     container's measured pixel width (same convention as renderPage:
   *     scaleToPageSize maps pageWidth to output pixels). The whole fragment
   *     still renders as a single SVG page (large pageHeight, trimmed by
   *     adjustPageHeight). Used by the fragment detail view (Component 9
   *     Step 15) — system breaks are preferable to horizontal scrolling.
   */
  breaks?: 'none' | 'smart';
}

/**
 * Render a score fragment identified by mc (document-order position index)
 * coordinates.
 *
 * Uses the confirmed call sequence from the Component 2 spike:
 *   setOptions() → loadData() → select() → redoLayout() → renderToSVG(1)
 *
 * mc_start and mc_end are the 1-based position indices stored on the fragment
 * row. They map directly to measureRange operands — no @n conversion needed.
 * Layout depends on options.breaks: 'none' places the entire fragment on one
 * long system; 'smart' allows system breaks at the given pageWidth while
 * keeping everything on a single SVG page.
 *
 * @param tk      - Toolkit instance from getVerovioToolkit().
 * @param meiText - Normalized MEI content string (not a URL).
 * @param mcStart - Fragment start: 1-based position index (= fragment.mc_start).
 * @param mcEnd   - Fragment end: 1-based position index (= fragment.mc_end).
 * @param options - Scale, transposition, page-width, and break settings.
 * @returns SVG markup string for the fragment.
 */
export async function renderFragment(
  tk: VerovioToolkitInstance,
  meiText: string,
  mcStart: number,
  mcEnd: number,
  options: FragmentRenderOptions,
): Promise<string> {
  const breaks = options.breaks ?? 'none';
  tk.setOptions({
    scale: options.scale,
    transpose: options.transpose,
    pageWidth: options.pageWidth,
    font: options.font,
    adjustPageHeight: true,
    breaks,
    pageMarginTop: 0,
    pageMarginBottom: 0,
    header: 'none',
    footer: 'none',
    // breaks:'none' — no scaleToPageSize: the wide fixed pageWidth ensures all
    //   selected measures appear on one line without scaling.
    // breaks:'smart' — scaleToPageSize so pageWidth is interpreted as output
    //   pixels (renderPage convention); pageHeight is set high so adjustPageHeight
    //   yields one page containing every system.
    ...(breaks === 'smart' ? { scaleToPageSize: true, pageHeight: 60000 } : {}),
  });
  tk.loadData(meiText);
  tk.select({ measureRange: `${mcStart}-${mcEnd}` });
  tk.redoLayout();
  return tk.renderToSVG(1);
}

/**
 * Generate MIDI from the currently loaded score.
 *
 * Must be called after the score has been loaded and rendered (renderPage or
 * renderProgressively), so that the toolkit holds the score with the current
 * transposition applied. If transposition changes, re-render first, then call
 * renderMidi again.
 *
 * Note (ADR-013 §"Breaking-area changes"): as of Verovio 6.0, repetitions
 * (first/second endings, dal segno) are expanded by default in MIDI output.
 * This is the desired behaviour for playback.
 *
 * @param tk - Toolkit instance with a score already loaded.
 * @returns Base64-encoded MIDI string.
 */
export async function renderMidi(tk: VerovioToolkitInstance): Promise<string> {
  return tk.renderToMIDI();
}

// ---------------------------------------------------------------------------
// Progressive rendering
// ---------------------------------------------------------------------------

/**
 * Render all pages of a score progressively, yielding between pages so the
 * browser can paint and respond to input.
 *
 * Page 1 is rendered synchronously before any yield, so the first system
 * appears within ~300ms of MEI load regardless of score length. Remaining
 * pages render one at a time, each after a setTimeout(0) yield.
 *
 * Overlays (playback highlight, selection brackets) are always HTML elements
 * positioned above the SVG container — never injected into Verovio's SVG
 * output — so they survive re-renders without needing to be re-applied after
 * each page arrives (CLAUDE.md SVG overlay rule).
 *
 * @param tk         - Toolkit instance from getVerovioToolkit().
 * @param meiText    - Normalized MEI content string (not a URL).
 * @param options    - Scale, transposition, and page-width settings.
 * @param onPage     - Called for each rendered page with its SVG string and
 *                     1-based page number. Caller appends each SVG to the DOM.
 * @param onComplete - Called once after all pages have been passed to onPage,
 *                     with the total page count.
 */
export async function renderProgressively(
  tk: VerovioToolkitInstance,
  meiText: string,
  options: RenderOptions,
  onPage: (svg: string, pageNum: number) => void,
  onComplete: (totalPages: number) => void,
): Promise<void> {
  tk.setOptions({
    scale: options.scale,
    transpose: options.transpose,
    pageWidth: options.pageWidth,
    font: options.font,
    adjustPageHeight: true,
    breaks: 'smart',
    scaleToPageSize: true,
    pageMarginTop: 0,
    pageMarginBottom: 0,
    header: 'none',
    footer: 'none',
  });
  tk.loadData(meiText);

  const totalPages = tk.getPageCount();

  // Page 1: no yield — renders synchronously so the first system paints immediately.
  onPage(tk.renderToSVG(1), 1);

  // Remaining pages: yield between each render so the browser stays responsive.
  for (let page = 2; page <= totalPages; page++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    onPage(tk.renderToSVG(page), page);
  }

  onComplete(totalPages);
}

// ---------------------------------------------------------------------------
// Note info map (transport bar display)
// ---------------------------------------------------------------------------

/** Display position stored for each MEI element. */
export interface NoteInfo {
  /**
   * MEI @n of the parent measure (display bar number).
   * 0 for pickup (anacrusis) bars; 1 for the first full bar.
   */
  barN: number;
  /**
   * Beat within the bar (1-indexed) in the prevailing time signature's
   * denominator unit. Derived from MEI @tstamp:
   *   - 4/4: @tstamp 1–4 → beat 1–4 (quarter-note beats)
   *   - 6/8: @tstamp 1–6 → beat 1–6 (eighth-note beats)
   *   - 3/2: @tstamp 1–3 → beat 1–3 (half-note beats)
   *
   * For pickup bars (@n="0"), beats are renumbered from 1 (so the first
   * pickup onset is beat 1, not the full-bar @tstamp value like 4 in 4/4).
   *
   * 0 when @tstamp is absent — caller keeps the previous beat value.
   */
  beat: number;
}

/**
 * Parse a MEI document to build a note-id → {barN, beat} lookup map.
 *
 * This map drives the transport bar display during playback without relying on
 * Tone.js's BBT counter, which has three known defects:
 *
 * 1. **Pickup bars**: Tone.js treats the pickup as a full bar, shifting every
 *    subsequent bar off by one and making beats permanently out of phase.
 *    This map reads MEI @n directly (pickup = 0), so the cascade never starts.
 *
 * 2. **Repeats**: Tone.js counts bars linearly (bar 9 on the second pass through
 *    bar 1). Because Step 17 strips the -rendN suffix from highlighted IDs, the
 *    DOM element id equals the original MEI xml:id, which this map resolves to
 *    the same barN on both passes.
 *
 * 3. **Non-quarter meters**: Tone.js counts beats in quarter notes (so 6/8
 *    appears to have 3 beats). MEI @tstamp is already in the denominator unit
 *    (eighths for 6/8), so the correct count comes for free.
 *
 * Usage in ScoreViewer: on each animation frame, `handlePositionUpdate` looks
 * up the first highlighted element's id in this map and calls `setDisplayPosition`.
 * No Tone.js BBT reading is involved.
 *
 * Handles:
 *   - `<note>` and `<rest>` with @tstamp
 *   - `<note>` / `<rest>` inside `<chord>` — inherits chord's @tstamp
 *   - Measures without @n — falls back to sequential 1-based index
 *   - Pickup bars (@n="0") — beats renumbered 1, 2, … within the pickup
 *
 * Falls back to empty map if DOMParser is unavailable or MEI is unparseable;
 * the caller falls back to the raw Tone.js position in that case.
 *
 * @param meiText - Normalized MEI content string.
 */
export function buildNoteInfoMap(meiText: string): Map<string, NoteInfo> {
  const map = new Map<string, NoteInfo>();
  try {
    if (typeof DOMParser === 'undefined') return map;
    const doc = new DOMParser().parseFromString(meiText, 'text/xml');
    const measures = doc.getElementsByTagName('measure');

    for (let mi = 0; mi < measures.length; mi++) {
      const measure = measures[mi];
      const nAttr = measure.getAttribute('n');
      // @n = 0 is valid for pickup bars; missing @n → sequential 1-based index.
      const barN = nAttr !== null ? parseInt(nAttr, 10) : mi + 1;
      const isPickup = barN === 0;

      // Helper: read @xml:id from an element (namespace-safe).
      const getId = (el: Element): string | null =>
        el.getAttribute('xml:id') ??
        el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id');

      // Helper: find the nearest @tstamp walking up toward the measure root.
      // Handles notes-inside-chords (chord carries @tstamp, note does not).
      const getTimestamp = (el: Element): number | null => {
        let cursor: Element | null = el;
        while (cursor && cursor !== measure) {
          const ts = cursor.getAttribute('tstamp');
          if (ts !== null) {
            const v = parseFloat(ts);
            return Number.isNaN(v) ? null : v;
          }
          cursor = cursor.parentElement;
        }
        return null;
      };

      // Collect all note and rest elements in this measure.
      const noteEls = Array.from(measure.getElementsByTagName('note'));
      const restEls = Array.from(measure.getElementsByTagName('rest'));
      const elements = [...noteEls, ...restEls];

      // For pickup bars: renumber beats 1, 2, 3 … by onset order,
      // not by the full-bar @tstamp value (which would be e.g. 4 for the
      // last beat of a 4/4 bar). This matches the display rule in the
      // playback-coordinates spec: "0:1 for the first event, not 0:4".
      let pickupBeatMap: Map<number, number> | null = null;
      if (isPickup) {
        const uniqueTs = [...new Set(
          elements.map(el => getTimestamp(el)).filter((v): v is number => v !== null)
        )].sort((a, b) => a - b);
        pickupBeatMap = new Map(uniqueTs.map((ts, idx) => [ts, idx + 1]));
      }

      for (const el of elements) {
        const id = getId(el);
        if (!id) continue;

        const ts = getTimestamp(el);
        let beat = 0;
        if (ts !== null) {
          beat = isPickup
            ? (pickupBeatMap!.get(ts) ?? 1)
            : Math.max(1, Math.floor(ts + 1e-9)); // floor: note on beat 1.5 shows beat 1
        }
        map.set(id, { barN, beat });
      }
    }
  } catch {
    // Ignore parse errors — caller falls back to Tone.js position.
  }
  return map;
}

/**
 * Return the initial tempo (BPM) from the Verovio timemap.
 *
 * The timemap emits a `tempo` field at the first entry and again at each
 * tempo change. Reading only the first event is sufficient for Phase 1
 * (single-tempo pieces); multi-tempo pieces will have slightly imprecise beat
 * display after tempo changes, which is an acceptable limitation.
 *
 * Returns 120 if no tempo event is found or if an error occurs.
 */
export function getTimemapTempo(tk: VerovioToolkitInstance): number {
  try {
    const raw = tk.renderToTimemap();
    const entries = (
      typeof raw === 'string'
        ? (JSON.parse(raw) as Array<{ tempo?: unknown }>)
        : (raw as Array<{ tempo?: unknown }>)
    );
    for (const entry of entries) {
      if (typeof entry.tempo === 'number' && entry.tempo > 0) return entry.tempo;
    }
  } catch {
    // Fall through to default.
  }
  return 120;
}

/**
 * Parse the first time signature's denominator from an MEI document.
 *
 * MEI uses `@meter.unit` for the denominator: 4 = quarter note, 8 = eighth
 * note, 2 = half note. This value is used to compute the beat duration:
 * `beatDurationMs = (60 000 / bpm) × (4 / meterUnit)`.
 *
 * Returns 4 (quarter note) as the default when not found or on parse failure.
 *
 * @param meiText - Normalized MEI content string.
 */
export function parseMeiMeterUnit(meiText: string): number {
  try {
    if (typeof DOMParser === 'undefined') return 4;
    const doc = new DOMParser().parseFromString(meiText, 'text/xml');

    // Strategy 1: @meter.unit attribute on scoreDef or staffDef (MEI inline style,
    // used by hand-crafted MEI and some MuseScore versions).
    for (const tag of ['scoreDef', 'staffDef']) {
      const els = doc.getElementsByTagName(tag);
      for (let i = 0; i < els.length; i++) {
        const unit = els[i].getAttribute('meter.unit');
        if (unit) {
          const v = parseInt(unit, 10);
          if (!Number.isNaN(v) && v > 0) return v;
        }
      }
    }

    // Strategy 2: <meterSig unit="..."> child elements (MuseScore/OpenScore MEI style,
    // also inserted by the MEI normalizer's _propagate_meter_changes step).
    // These appear inside <staffDef>, <scoreDef>, or <measure> elements.
    const meterSigs = doc.getElementsByTagName('meterSig');
    for (let i = 0; i < meterSigs.length; i++) {
      const unit = meterSigs[i].getAttribute('unit');
      if (unit) {
        const v = parseInt(unit, 10);
        if (!Number.isNaN(v) && v > 0) return v;
      }
    }
  } catch {
    // Fall through to default.
  }
  return 4;
}

// ---------------------------------------------------------------------------
// Highlight schedule
// ---------------------------------------------------------------------------

/**
 * Strip Verovio's repeat-expansion suffix from a timemap element ID.
 *
 * When Verovio expands repeats in the timemap, it appends `-rendN` (e.g.
 * `-rend2`, `-rend3`) to the xml:id of every element played in an additional
 * pass through a repeated section. These are virtual IDs: the SVG DOM only
 * ever contains the **original** ID (the score renders each repeated measure
 * once with its repeat sign intact). Stripping the suffix maps every repeat
 * pass back to the real DOM element.
 *
 * Volta-bracket endings are genuinely separate measures with their own
 * original IDs (`first-ending-note`, `second-ending-note`) and are therefore
 * unaffected — their IDs carry no `-rendN` suffix.
 *
 * @param id - Raw element ID from the timemap `on` array.
 * @returns The canonical DOM ID (suffix removed if present).
 */
function stripRendSuffix(id: string): string {
  return id.replace(/-rend\d+$/, '');
}

/**
 * Build a sorted schedule of { timeMs, ids } from Verovio's timemap.
 *
 * Using renderToTimemap() instead of repeated getElementsAtTime() calls is
 * more reliable because:
 *   - The timemap expands all repeats: a measure played twice appears as two
 *     entries at different tstamp values. On the second pass Verovio appends a
 *     `-rendN` suffix to element IDs; stripRendSuffix() maps them back to the
 *     real DOM element so getElementById() succeeds on every repeat pass.
 *   - getElementsAtTime() can return structural element IDs (rend, barline)
 *     between note onsets and at repeat boundaries, causing stale highlights.
 *
 * Must be called after the score has been loaded and rendered so that the
 * toolkit's internal timing model is up to date (i.e. call after
 * renderProgressively completes).
 *
 * @param tk - Toolkit instance with a score already loaded and rendered.
 * @returns Sorted schedule for use with binary search in onPositionUpdate.
 */
export function buildHighlightSchedule(
  tk: VerovioToolkitInstance,
): Array<{ timeMs: number; ids: string[] }> {
  try {
    const raw = tk.renderToTimemap();
    const entries = (
      typeof raw === 'string'
        ? (JSON.parse(raw) as Array<{ tstamp?: number; on?: string[] }>)
        : (raw as Array<{ tstamp?: number; on?: string[] }>)
    );

    const schedule: Array<{ timeMs: number; ids: string[] }> = [];
    for (const entry of entries) {
      if (!entry.on || entry.on.length === 0 || entry.tstamp === undefined) continue;
      // Strip -rendN suffixes so repeated-pass IDs resolve to real DOM elements.
      schedule.push({ timeMs: entry.tstamp, ids: entry.on.map(stripRendSuffix) });
    }

    // Should already be sorted by Verovio, but sort defensively.
    schedule.sort((a, b) => a.timeMs - b.timeMs);
    return schedule;
  } catch {
    // If renderToTimemap is unavailable or returns unexpected data, fall back
    // to an empty schedule (playback highlight disabled).
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fragment-scoped playback (Component 9 Step 18)
// ---------------------------------------------------------------------------

/**
 * A fragment's playback time window, expressed in the **whole movement's** MIDI
 * time (milliseconds).
 *
 * `startMs` is the onset of the first rendered measure; `endMs` is the onset of
 * the measure immediately after the fragment (its exclusive upper bound), or
 * `Number.POSITIVE_INFINITY` when the fragment runs to the end of the movement.
 */
export interface FragmentTimeWindow {
  startMs: number;
  endMs: number;
}

/**
 * Fragment playback bundle: the time window into the whole-movement MIDI plus a
 * highlight schedule already clipped to that window and shifted so the fragment
 * starts at 0 ms.
 */
export interface FragmentPlayback {
  window: FragmentTimeWindow;
  /** Windowed, fragment-relative highlight schedule (timeMs measured from the
   *  fragment's first onset). */
  schedule: Array<{ timeMs: number; ids: string[] }>;
}

/** Tolerance for ms comparisons against measure-onset boundaries. */
const WINDOW_EPS_MS = 0.5;

/** Read every `<measure>` xml:id in document order (= 1-based mc position). */
function readMeasureIdsInOrder(meiText: string): string[] {
  const ids: string[] = [];
  try {
    if (typeof DOMParser === 'undefined') {
      // Node / non-DOM environments (some test runners): regex fallback.
      for (const m of meiText.matchAll(/<measure\b[^>]*?\bxml:id="([^"]+)"/g)) {
        ids.push(m[1]!);
      }
      return ids;
    }
    const doc = new DOMParser().parseFromString(meiText, 'text/xml');
    const measures = doc.getElementsByTagName('measure');
    for (let i = 0; i < measures.length; i++) {
      const el = measures[i]!;
      const id =
        el.getAttribute('xml:id') ??
        el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id');
      ids.push(id ?? '');
    }
  } catch {
    // Return whatever was collected before the failure.
  }
  return ids;
}

/**
 * Build a fragment-scoped playback bundle from the whole-movement timemap.
 *
 * **Why windowing rather than `select()`.** `renderFragment()` constrains the
 * *rendered SVG* via `select()` + `redoLayout()`, but Verovio's
 * `renderToMIDI()` and `renderToTimemap()` ignore the selection — they always
 * emit the whole movement (empirically confirmed in 6.1.0: identical byte-for-
 * byte MIDI and identical timemap with or without an active selection). So
 * fragment playback windows the whole-movement output to the fragment's measure
 * span instead. This also preserves Verovio's running clef/key/meter/tempo
 * context at `mc_start`, which an MEI slice would lose.
 *
 * The window is keyed on the rendered measure range (`mc_start`/`mc_end`), not
 * on the beat-precise tagged range: playback follows the *rendered* fragment
 * (whole measures), matching what the viewer shows.
 *
 * Boundaries come from the timemap's `measureOn` field (present when
 * `includeMeasures: true`), which carries each `<measure>`'s xml:id at its onset.
 * `mc` is the 1-based document-order index of `<measure>` elements, so
 * `measureIds[mc - 1]` is the fragment's first measure and `measureIds[mcEnd]`
 * the measure after it.
 *
 * Repeats (Verovio expands them in the timemap) fall out naturally: a repeat
 * wholly inside the fragment spans both passes within the window; a fragment
 * inside a larger repeat keeps only the first pass (its `endMs` is the next
 * measure's first onset after `startMs`) — i.e. it plays once, straight
 * through, matching the final-pass policy in `playback-coordinates.md`.
 *
 * Falls back to a whole-movement window + `buildHighlightSchedule` on any
 * failure (missing measureOn, unparseable MEI), so playback degrades to the
 * previous behaviour rather than breaking.
 *
 * @param tk      - Toolkit with the fragment's movement already loaded/rendered.
 * @param meiText - Normalized MEI for the loaded movement.
 * @param mcStart - 1-based position index of the fragment's first measure.
 * @param mcEnd   - 1-based position index of the fragment's last measure.
 */
export function buildFragmentPlayback(
  tk: VerovioToolkitInstance,
  meiText: string,
  mcStart: number,
  mcEnd: number,
): FragmentPlayback {
  const fallback = (): FragmentPlayback => ({
    window: { startMs: 0, endMs: Number.POSITIVE_INFINITY },
    schedule: buildHighlightSchedule(tk),
  });

  try {
    const raw = tk.renderToTimemap({ includeMeasures: true });
    const entries = (
      typeof raw === 'string'
        ? (JSON.parse(raw) as Array<{ tstamp?: number; on?: string[]; measureOn?: string }>)
        : (raw as Array<{ tstamp?: number; on?: string[]; measureOn?: string }>)
    );

    const measureIds = readMeasureIdsInOrder(meiText);
    const startId = measureIds[mcStart - 1];
    if (!startId) return fallback();

    // startMs: first onset of the fragment's first measure.
    let startMs: number | null = null;
    for (const e of entries) {
      if (e.measureOn === startId && e.tstamp !== undefined) { startMs = e.tstamp; break; }
    }
    if (startMs === null) return fallback();

    // endMs: first onset of the measure after the fragment that falls after
    // startMs (so a repeated "next" measure resolves to the correct pass).
    // Absent (fragment ends the movement) → play to the end.
    let endMs = Number.POSITIVE_INFINITY;
    const afterId = measureIds[mcEnd]; // (mcEnd + 1)-th measure, 0-based index mcEnd
    if (afterId) {
      for (const e of entries) {
        if (e.measureOn === afterId && e.tstamp !== undefined && e.tstamp > startMs) {
          endMs = e.tstamp;
          break;
        }
      }
    }

    const schedule: Array<{ timeMs: number; ids: string[] }> = [];
    for (const e of entries) {
      if (!e.on || e.on.length === 0 || e.tstamp === undefined) continue;
      if (e.tstamp < startMs - WINDOW_EPS_MS || e.tstamp >= endMs - WINDOW_EPS_MS) continue;
      schedule.push({ timeMs: e.tstamp - startMs, ids: e.on.map(stripRendSuffix) });
    }
    schedule.sort((a, b) => a.timeMs - b.timeMs);

    return { window: { startMs, endMs }, schedule };
  } catch {
    return fallback();
  }
}
