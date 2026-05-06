/**
 * WASM client-side fragment rendering spike.
 *
 * Verifies the two edge cases from component-3-score-viewer.md Step 13 against
 * the actual Verovio 6.1.0 WASM build (not mocked). Findings are documented in
 * docs/architecture/mei-ingest-normalization.md §"Verovio WASM client-side
 * verification".
 *
 * Gate: only runs when VEROVIO_WASM_SPIKE=1 is set.
 *
 *   VEROVIO_WASM_SPIKE=1 npx vitest run \
 *     src/services/__tests__/verovio-fragment.wasm-spike.test.ts
 *
 * Each test has a 30 s timeout — the WASM bundle (~7-10 MB) is large and the
 * singleton loads once per suite run. In CI (no env var), the suite is skipped
 * entirely: zero assertions, no WASM download.
 *
 * The Python bindings spike (docs/architecture/mei-ingest-normalization.md,
 * Findings 6-9, 2026-05-04) already established the expected behaviour.
 * This spike confirms the WASM build produces identical results because both
 * wrap the same Verovio C++ library at version 6.1.0.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getVerovioToolkit, renderFragment, type RenderOptions } from '../verovio';

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const RUN_WASM_SPIKE = process.env['VEROVIO_WASM_SPIKE'] === '1';

// ---------------------------------------------------------------------------
// MEI fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal MEI: 6 measures, 3/4, no pickup bar, no endings.
 * Equivalent to the k331 fixture used in the Python bindings spike.
 * No XML comments before <mei> — Finding 3 confirms these cause loadData failure.
 */
const FIXTURE_LINEAR = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="4.0.1">
  <meiHead><fileDesc><titleStmt><title>WASM Spike — Linear</title></titleStmt>
    <pubStmt/></fileDesc></meiHead>
  <music><body><mdiv><score>
    <scoreDef><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"
      meter.count="3" meter.unit="4" key.sig="0"/></staffGrp></scoreDef>
    <section>
      <measure n="1"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="c"/><note dur="4" oct="4" pname="d"/>
        <note dur="4" oct="4" pname="e"/>
      </layer></staff></measure>
      <measure n="2"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="f"/><note dur="4" oct="4" pname="g"/>
        <note dur="4" oct="4" pname="a"/>
      </layer></staff></measure>
      <measure n="3"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="b"/><note dur="4" oct="5" pname="c"/>
        <note dur="4" oct="4" pname="b"/>
      </layer></staff></measure>
      <measure n="4"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="a"/><note dur="4" oct="4" pname="g"/>
        <note dur="4" oct="4" pname="f"/>
      </layer></staff></measure>
      <measure n="5"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="e"/><note dur="4" oct="4" pname="d"/>
        <note dur="4" oct="4" pname="c"/>
      </layer></staff></measure>
      <measure n="6"><staff n="1"><layer n="1">
        <note dur="2" oct="4" pname="c"/><note dur="4" oct="4" pname="c"/>
      </layer></staff></measure>
    </section>
  </score></mdiv></body></music>
</mei>`;

/**
 * Minimal MEI with a pickup bar: @n="0" anacrusis + 4 full measures, 4/4.
 * Used to verify that mc=1 includes the pickup bar (WASM Finding 2).
 */
const FIXTURE_PICKUP = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="4.0.1">
  <meiHead><fileDesc><titleStmt><title>WASM Spike — Pickup</title></titleStmt>
    <pubStmt/></fileDesc></meiHead>
  <music><body><mdiv><score>
    <scoreDef><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"
      meter.count="4" meter.unit="4" key.sig="0"/></staffGrp></scoreDef>
    <section>
      <measure n="0" metcon="false"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="g"/>
      </layer></staff></measure>
      <measure n="1"><staff n="1"><layer n="1">
        <note dur="4" oct="4" pname="c"/><note dur="4" oct="4" pname="d"/>
        <note dur="4" oct="4" pname="e"/><note dur="4" oct="4" pname="f"/>
      </layer></staff></measure>
      <measure n="2"><staff n="1"><layer n="1">
        <note dur="1" oct="4" pname="g"/>
      </layer></staff></measure>
      <measure n="3"><staff n="1"><layer n="1">
        <note dur="1" oct="4" pname="a"/>
      </layer></staff></measure>
      <measure n="4"><staff n="1"><layer n="1">
        <note dur="1" oct="4" pname="c"/>
      </layer></staff></measure>
    </section>
  </score></mdiv></body></music>
</mei>`;

/**
 * Minimal MEI with volta endings: 4 document-order positions.
 *   Position 1: n=1 (repeated, rptend barline)
 *   Position 2: first ending, n=2 (note: D4)
 *   Position 3: second ending, n=2 (note: E4)
 *   Position 4: n=3
 *
 * Used to verify that mc_start=2, mc_end=2 isolates only one ending's measure
 * (WASM Finding 3). The two ending measures have different pitches (D vs E),
 * so their SVGs must differ.
 */
const FIXTURE_VOLTA = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="4.0.1">
  <meiHead><fileDesc><titleStmt><title>WASM Spike — Volta</title></titleStmt>
    <pubStmt/></fileDesc></meiHead>
  <music><body><mdiv><score>
    <scoreDef><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"
      meter.count="4" meter.unit="4" key.sig="0"/></staffGrp></scoreDef>
    <section>
      <measure n="1" right="rptend"><staff n="1"><layer n="1">
        <note dur="1" oct="4" pname="c"/>
      </layer></staff></measure>
      <ending n="1">
        <measure n="2"><staff n="1"><layer n="1">
          <note dur="1" oct="4" pname="d"/>
        </layer></staff></measure>
      </ending>
      <ending n="2">
        <measure n="2"><staff n="1"><layer n="1">
          <note dur="1" oct="4" pname="e"/>
        </layer></staff></measure>
      </ending>
      <measure n="3"><staff n="1"><layer n="1">
        <note dur="1" oct="4" pname="f"/>
      </layer></staff></measure>
    </section>
  </score></mdiv></body></music>
</mei>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the SVG width attribute value in pixels. Returns 0 if absent. */
function extractSvgWidth(svg: string): number {
  const m = svg.match(/width="([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/** Fragment render options: wide fixed pageWidth, scale=35, Bravura, no transpose. */
const SPIKE_OPTIONS: RenderOptions = {
  scale: 35,
  transpose: '',
  font: 'Bravura',
  pageWidth: 2200,
};

// ---------------------------------------------------------------------------
// Spike suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_WASM_SPIKE)('verovio WASM fragment spike', () => {
  // The toolkit singleton loads once per suite. Keeping it in a module-level
  // variable avoids re-initialising WASM between tests.
  let tk: Awaited<ReturnType<typeof getVerovioToolkit>>;

  beforeAll(async () => {
    tk = await getVerovioToolkit();
  }, 60_000);

  afterAll(() => {
    // Nothing to tear down — the singleton persists for the process lifetime.
    // Log the findings header so the runner output is easy to copy into
    // mei-ingest-normalization.md.
    console.log('\n--- WASM spike findings (copy into mei-ingest-normalization.md) ---');
  });

  /**
   * WASM Finding 1 — `"1-N"` and `"start-N"` produce SVGs of identical width.
   *
   * renderFragment formats the measureRange as "${mcStart}-${mcEnd}", so
   * mcStart=1 produces "1-4". We test "start-4" equivalence by calling the
   * toolkit select API directly and comparing SVG widths.
   *
   * Expected: both widths are equal and > 0. (The Python bindings spike
   * measured 504px for 4 measures at scale=35 on an equivalent fixture.)
   */
  it('"1-4" and "start-4" produce SVGs of the same pixel width', async () => {
    // renderFragment path: measureRange "1-4"
    const svg1 = await renderFragment(tk, FIXTURE_LINEAR, 1, 4, SPIKE_OPTIONS);

    // Direct API path: measureRange "start-4"
    tk.setOptions({
      scale: SPIKE_OPTIONS.scale,
      transpose: SPIKE_OPTIONS.transpose,
      pageWidth: SPIKE_OPTIONS.pageWidth,
      font: SPIKE_OPTIONS.font,
      adjustPageHeight: true,
      breaks: 'none',
      pageMarginTop: 0,
      pageMarginBottom: 0,
    });
    tk.loadData(FIXTURE_LINEAR);
    tk.select({ measureRange: 'start-4' });
    tk.redoLayout();
    const svgStart = tk.renderToSVG(1);

    const width1 = extractSvgWidth(svg1);
    const widthStart = extractSvgWidth(svgStart);

    console.log(`  WASM Finding 1: "1-4" width=${width1}px, "start-4" width=${widthStart}px`);
    expect(width1).toBeGreaterThan(0);
    expect(widthStart).toBeGreaterThan(0);
    expect(width1).toBe(widthStart);
  }, 30_000);

  /**
   * WASM Finding 2 — Pickup bar at position 1 is included by mc_start=1.
   *
   * On a movement with a pickup bar (@n="0" at position 1), renderFragment
   * with mcStart=1 formats as "1-2" (pickup + first full measure). The
   * resulting SVG should be non-empty and non-trivially sized (> 200px wide),
   * confirming the selection resolved correctly rather than falling back to
   * a full render or an error.
   */
  it('mc_start=1 on a pickup-bar movement renders a non-trivially sized SVG', async () => {
    const svg = await renderFragment(tk, FIXTURE_PICKUP, 1, 2, SPIKE_OPTIONS);
    const width = extractSvgWidth(svg);

    console.log(`  WASM Finding 2: pickup fixture, mc 1-2, width=${width}px`);
    expect(svg).toContain('<svg');
    expect(width).toBeGreaterThan(200);
  }, 30_000);

  /**
   * WASM Finding 3 — Volta ending isolation: mc_start=2, mc_end=2 renders
   * position 2 only (first ending, D4), not both @n="2" elements.
   *
   * We also render position 3 (second ending, E4) and confirm the two SVGs
   * differ — if the selection were not isolated by document order, both would
   * render the same content.
   */
  it('mc_start=2, mc_end=2 isolates the first ending; position 3 isolates the second', async () => {
    const svgPos2 = await renderFragment(tk, FIXTURE_VOLTA, 2, 2, SPIKE_OPTIONS);
    const svgPos3 = await renderFragment(tk, FIXTURE_VOLTA, 3, 3, SPIKE_OPTIONS);

    const width2 = extractSvgWidth(svgPos2);
    const width3 = extractSvgWidth(svgPos3);

    console.log(`  WASM Finding 3: volta pos2 width=${width2}px, pos3 width=${width3}px`);
    console.log(`  SVGs differ: ${svgPos2 !== svgPos3}`);

    expect(svgPos2).toContain('<svg');
    expect(svgPos3).toContain('<svg');
    // The two ending measures have different pitches (D4 vs E4), so the SVGs
    // must not be identical.
    expect(svgPos2).not.toBe(svgPos3);
  }, 30_000);
});
