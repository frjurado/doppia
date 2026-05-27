/**
 * Unit tests for frontend/src/components/score/selection.ts.
 *
 * Covers buildMcIndex() (MEI document-order indexing) and commitSelection()
 * (coordinate resolution: bar_start/bar_end pass-through, mc_start/mc_end
 * derivation, beat_start/beat_end pass-through, repeat_context propagation,
 * first/second ending resolution, and fallback behaviour).
 *
 * Verification requirement (component-5-tagging-tool.md Step 11):
 * A selection over a known passage produces the correct mc_start/mc_end values
 * (matching DCML mc, which equals document-order position index, per ADR-015).
 * A selection inside a first ending sets repeat_context = 'first_ending'.
 */

import { describe, expect, it } from 'vitest';
import { buildMcIndex, commitSelection } from '../selection';
import type { CommittedSelection } from '../selection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal well-formed MEI string with sequential measures (no endings). */
function makeMei(bars: number[]): string {
  const measures = bars.map(n => `<measure n="${n}"/>`).join('');
  return `<mei><music><body><mdiv><score>${measures}</score></mdiv></body></music></mei>`;
}

/** MEI with first + second volta endings. Each ending has the measures in bars[]. */
function makeEndingMei(
  beforeBars: number[],
  ending1Bars: number[],
  ending2Bars: number[],
  afterBars: number[] = [],
): string {
  const before  = beforeBars.map(n => `<measure n="${n}"/>`).join('');
  const e1      = ending1Bars.map(n => `<measure n="${n}"/>`).join('');
  const e2      = ending2Bars.map(n => `<measure n="${n}"/>`).join('');
  const after   = afterBars.map(n => `<measure n="${n}"/>`).join('');
  return `<mei><music><body><mdiv><score>
    ${before}
    <ending n="1">${e1}</ending>
    <ending n="2">${e2}</ending>
    ${after}
  </score></mdiv></body></music></mei>`;
}

// ---------------------------------------------------------------------------
// buildMcIndex
// ---------------------------------------------------------------------------

describe('buildMcIndex', () => {
  it('assigns 1-based document-order positions to sequential measures', () => {
    const mei = makeMei([1, 2, 3, 4]);
    const idx = buildMcIndex(mei);

    expect(idx.get('m1')).toBe(1);
    expect(idx.get('m2')).toBe(2);
    expect(idx.get('m3')).toBe(3);
    expect(idx.get('m4')).toBe(4);
    expect(idx.size).toBe(4);
  });

  it('handles a pickup bar with @n="0"', () => {
    const mei = makeMei([0, 1, 2, 3]);
    const idx = buildMcIndex(mei);

    expect(idx.get('m0')).toBe(1);
    expect(idx.get('m1')).toBe(2);
    expect(idx.get('m3')).toBe(4);
  });

  it('incorporates ending context in the key for volta measures', () => {
    // Measures 1–2 before endings, 3 in ending 1, 3 in ending 2, 4 after.
    const mei = makeEndingMei([1, 2], [3], [3], [4]);
    const idx = buildMcIndex(mei);

    // Measures before endings: mc 1, 2.
    expect(idx.get('m1')).toBe(1);
    expect(idx.get('m2')).toBe(2);
    // First ending, bar 3: mc 3.
    expect(idx.get('m3-e1')).toBe(3);
    // Second ending, bar 3: mc 4.
    expect(idx.get('m3-e2')).toBe(4);
    // After endings, bar 4: mc 5.
    expect(idx.get('m4')).toBe(5);
    expect(idx.size).toBe(5);
  });

  it('first occurrence wins for duplicate ghost keys (unusual but safe)', () => {
    // Two measures with the same @n and no endings — should not happen in
    // normalised MEI but the function must not panic or overwrite.
    const mei = `<mei><music><body><mdiv><score>
      <measure n="3"/><measure n="3"/>
    </score></mdiv></body></music></mei>`;
    const idx = buildMcIndex(mei);
    // Only one entry; the first occurrence (mc=1) is kept.
    expect(idx.get('m3')).toBe(1);
    expect(idx.size).toBe(1);
  });

  it('matches DCML mc for a Mozart-style passage', () => {
    // Simulates a short passage: pickup (n=0) + 4 bars. In the DCML TSV the
    // pickup is mc=1, the next bar mc=2, etc.
    const mei = makeMei([0, 1, 2, 3, 4]);
    const idx = buildMcIndex(mei);

    // Cross-check: DCML mc is 1-based document order — these must match.
    expect(idx.get('m0')).toBe(1); // mc=1 in DCML
    expect(idx.get('m4')).toBe(5); // mc=5 in DCML
  });
});

// ---------------------------------------------------------------------------
// commitSelection — bar / beat pass-through
// ---------------------------------------------------------------------------

describe('commitSelection — field pass-through', () => {
  const mei = makeMei([1, 2, 3, 4]);
  const idx = buildMcIndex(mei);

  it('preserves bar_start and bar_end from the SelectionRange', () => {
    const result = commitSelection(
      { barStart: 2, barEnd: 4, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    expect(result?.bar_start).toBe(2);
    expect(result?.bar_end).toBe(4);
  });

  it('preserves beat_start and beat_end', () => {
    const result = commitSelection(
      { barStart: 1, barEnd: 3, beatStart: 1.5, beatEnd: 3.0, repeatContext: null },
      idx,
    );
    expect(result?.beat_start).toBe(1.5);
    expect(result?.beat_end).toBe(3.0);
  });

  it('preserves null beat values for measure-level selections', () => {
    const result = commitSelection(
      { barStart: 1, barEnd: 2, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    expect(result?.beat_start).toBeNull();
    expect(result?.beat_end).toBeNull();
  });

  it('preserves repeat_context', () => {
    const endingMei = makeEndingMei([1], [2], [2]);
    const endingIdx = buildMcIndex(endingMei);

    const result = commitSelection(
      { barStart: 2, barEnd: 2, beatStart: null, beatEnd: null, repeatContext: 'first_ending' },
      endingIdx,
    );
    expect(result?.repeat_context).toBe('first_ending');
  });
});

// ---------------------------------------------------------------------------
// commitSelection — mc derivation
// ---------------------------------------------------------------------------

describe('commitSelection — mc_start / mc_end derivation', () => {
  it('derives mc_start and mc_end for a simple sequential selection', () => {
    const mei = makeMei([1, 2, 3, 4, 5]);
    const idx = buildMcIndex(mei);

    const result = commitSelection(
      { barStart: 2, barEnd: 4, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    expect(result?.mc_start).toBe(2);
    expect(result?.mc_end).toBe(4);
  });

  it('derives mc for a single-measure selection', () => {
    const mei = makeMei([1, 2, 3]);
    const idx = buildMcIndex(mei);

    const result = commitSelection(
      { barStart: 3, barEnd: 3, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    expect(result?.mc_start).toBe(3);
    expect(result?.mc_end).toBe(3);
  });

  it('resolves mc for a first-ending selection (endingN = 1)', () => {
    // Passage: bars 1–2, then ending 1 with bar 3, ending 2 with bar 3, bar 4 after.
    const mei = makeEndingMei([1, 2], [3], [3], [4]);
    const idx = buildMcIndex(mei);

    const result = commitSelection(
      { barStart: 3, barEnd: 3, beatStart: null, beatEnd: null, repeatContext: 'first_ending' },
      idx,
    );
    // bar 3 in ending 1 is document-order position 3.
    expect(result?.mc_start).toBe(3);
    expect(result?.mc_end).toBe(3);
  });

  it('resolves mc for a second-ending selection (endingN = 2)', () => {
    const mei = makeEndingMei([1, 2], [3], [3], [4]);
    const idx = buildMcIndex(mei);

    const result = commitSelection(
      { barStart: 3, barEnd: 3, beatStart: null, beatEnd: null, repeatContext: 'second_ending' },
      idx,
    );
    // bar 3 in ending 2 is document-order position 4.
    expect(result?.mc_start).toBe(4);
    expect(result?.mc_end).toBe(4);
  });

  it('mc values match the DCML mc for the same physical measures', () => {
    // Simulate K.331 movement 1, first 4 bars (simplified).
    // DCML mc=1 → pickup bar (n=0), mc=2 → bar 1, …, mc=5 → bar 4.
    const mei = makeMei([0, 1, 2, 3, 4]);
    const idx = buildMcIndex(mei);

    const result = commitSelection(
      { barStart: 1, barEnd: 3, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    // bar 1 is document position 2 (after pickup at position 1).
    expect(result?.mc_start).toBe(2);
    expect(result?.mc_end).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// commitSelection — failure / fallback
// ---------------------------------------------------------------------------

describe('commitSelection — failure and fallback', () => {
  it('returns null when barStart is not in the index', () => {
    const idx = buildMcIndex(makeMei([1, 2, 3]));
    const result = commitSelection(
      { barStart: 99, barEnd: 1, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    expect(result).toBeNull();
  });

  it('returns null when barEnd is not in the index', () => {
    const idx = buildMcIndex(makeMei([1, 2, 3]));
    const result = commitSelection(
      { barStart: 1, barEnd: 99, beatStart: null, beatEnd: null, repeatContext: null },
      idx,
    );
    expect(result).toBeNull();
  });

  it('falls back to no-ending key when ending key is absent', () => {
    // Index has m3 (no ending); selection claims first_ending context.
    // The fallback should still resolve mc_start.
    const idx = buildMcIndex(makeMei([1, 2, 3]));
    const result = commitSelection(
      { barStart: 3, barEnd: 3, beatStart: null, beatEnd: null, repeatContext: 'first_ending' },
      idx,
    );
    // Falls back to 'm3' (no ending) → mc 3.
    expect(result?.mc_start).toBe(3);
    expect(result?.mc_end).toBe(3);
  });

  it('returns a correctly typed CommittedSelection object', () => {
    const idx = buildMcIndex(makeMei([1, 2, 3, 4]));
    const result = commitSelection(
      { barStart: 2, barEnd: 3, beatStart: 1.0, beatEnd: 2.5, repeatContext: null },
      idx,
    ) as CommittedSelection;

    expect(result).toMatchObject<CommittedSelection>({
      bar_start: 2,
      bar_end: 3,
      mc_start: 2,
      mc_end: 3,
      beat_start: 1.0,
      beat_end: 2.5,
      repeat_context: null,
    });
  });
});
