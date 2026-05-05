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
  /** @param millisec - MIDI time offset in milliseconds. */
  getElementsAtTime(millisec: number): string;
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
      import('verovio/wasm') as Promise<{ default: () => Promise<unknown> }>,
      import('verovio/esm') as Promise<{ VerovioToolkit: new (m: unknown) => VerovioToolkitInstance }>,
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
  });
  tk.loadData(meiText);
  return tk.renderToSVG(pageNum);
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
 * A wide pageWidth (≥ 2200) combined with breaks:"none" places the entire
 * fragment on a single SVG page.
 *
 * @param tk      - Toolkit instance from getVerovioToolkit().
 * @param meiText - Normalized MEI content string (not a URL).
 * @param mcStart - Fragment start: 1-based position index (= fragment.mc_start).
 * @param mcEnd   - Fragment end: 1-based position index (= fragment.mc_end).
 * @param options - Scale, transposition, and page-width settings.
 * @returns SVG markup string for the fragment.
 */
export async function renderFragment(
  tk: VerovioToolkitInstance,
  meiText: string,
  mcStart: number,
  mcEnd: number,
  options: RenderOptions,
): Promise<string> {
  tk.setOptions({
    scale: options.scale,
    transpose: options.transpose,
    pageWidth: options.pageWidth,
    font: options.font,
    adjustPageHeight: true,
    breaks: 'none',
    pageMarginTop: 0,
    pageMarginBottom: 0,
    // No scaleToPageSize for fragment renders — the wide fixed pageWidth
    // ensures all selected measures appear on one line without scaling.
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
