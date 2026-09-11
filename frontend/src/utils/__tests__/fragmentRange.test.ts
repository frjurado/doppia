/**
 * formatFragmentRange tests — Component 9 Step 15 measure/beat display rule.
 *
 * Rule: beats render only within their measure's context, and not at all when
 * the fragment spans complete measures.
 *
 * beat_end display semantics (G1, settled 2026-09-10 in ADR-005 § "range-label
 * convention", Component 12 Step 20): a range names the first and last
 * *included onset*, and the unit stepped back by is inferred from the two
 * endpoints' precision — both whole → a beat, otherwise 1/d for d their common
 * denominator. A multi-measure end whose beat_end lands on beat 1 of barEnd
 * covers none of barEnd — the true last measure is the previous one, fully
 * covered. Ranges that reduce to whole measures at both ends collapse to the
 * bare "mm. N–M" form.
 */

import { describe, expect, it } from 'vitest';
import {
  formatBarRange,
  formatBeat,
  formatFragmentRange,
  qualifyRange,
  rangeLabels,
} from '../fragmentRange';
import type { RangeLabels } from '../fragmentRange';

describe('formatBeat', () => {
  it('formats a whole beat with no fraction', () => {
    expect(formatBeat(2)).toBe('2');
  });

  it('formats common fractions as glyphs', () => {
    expect(formatBeat(2 + 2 / 3)).toBe('2⅔');
    expect(formatBeat(1.5)).toBe('1½');
    expect(formatBeat(2.25)).toBe('2¼');
    expect(formatBeat(1 + 1 / 6)).toBe('1⅙');
  });

  it('falls back to a trimmed decimal for a non-matching fraction', () => {
    expect(formatBeat(2.1)).toBe('2.1');
  });
});

describe('formatFragmentRange — complete measures (no beats shown)', () => {
  it('formats a single complete measure', () => {
    expect(formatFragmentRange(3, 3, null, null)).toBe('m. 3');
  });

  it('formats a complete-measure span', () => {
    expect(formatFragmentRange(3, 7, null, null)).toBe('mm. 3–7');
  });
});

describe('formatFragmentRange — single measure with beats', () => {
  it('formats a beat range within one measure (integer end steps back)', () => {
    expect(formatFragmentRange(3, 3, 2, 4)).toBe('m. 3, beats 2–3');
  });

  it('names the last included onset for a fractional end, not the bound', () => {
    // [1, 2½) includes onsets 1, 1½ and 2; the last is beat 2. The old rule
    // showed the bound itself ("beats 1–2½"), naming a point where nothing in
    // the range starts.
    expect(formatFragmentRange(3, 3, 1, 2.5)).toBe('m. 3, beats 1–2');
  });

  it('collapses equal start/end beats to a single beat', () => {
    expect(formatFragmentRange(3, 3, 2, 2)).toBe('m. 3, beat 2');
  });

  it('collapses to a single beat when the stepped-back end equals start', () => {
    expect(formatFragmentRange(3, 3, 2, 3)).toBe('m. 3, beat 2');
  });

  it('shows the only available beat when one endpoint is null', () => {
    expect(formatFragmentRange(3, 3, 2, null)).toBe('m. 3, beat 2');
    expect(formatFragmentRange(3, 3, null, 3)).toBe('m. 3, beat 3');
  });

  it('collapses a whole single measure covered via beat 1 to the bare measure', () => {
    expect(formatFragmentRange(3, 3, 1, null)).toBe('m. 3');
  });
});

describe('formatFragmentRange — multiple measures with beats', () => {
  it('attaches each beat to its own measure (integer end steps back)', () => {
    expect(formatFragmentRange(3, 7, 2, 2)).toBe('m. 3, beat 2 – m. 7, beat 1');
  });

  it('omits the beat qualifier on a complete-measure endpoint', () => {
    expect(formatFragmentRange(3, 7, null, 3)).toBe('m. 3 – m. 7, beat 2');
    expect(formatFragmentRange(3, 7, 2, null)).toBe('m. 3, beat 2 – m. 7');
  });

  it('formats sub-beat (fractional) positions without float noise', () => {
    // Quarter-beat precision on both ends: the unit is a quarter beat, so the
    // exclusive 2¼ steps back to 2.
    expect(formatFragmentRange(3, 4, 1.5, 2.25)).toBe('m. 3, beat 1½ – m. 4, beat 2');
  });

  it('reduces a beat_end of 1 to the fully-covered previous measure', () => {
    // barEnd=7 is not covered at all (exclusive bound at its very first
    // beat) — the true end is the complete previous measure.
    expect(formatFragmentRange(3, 7, 2, 1)).toBe('m. 3, beat 2 – m. 6');
  });

  it('collapses to the bare measure range when both ends reduce to whole measures', () => {
    // beatStart=1 (whole from the start) and beatEnd=1 at barEnd=8 (barEnd
    // itself uncovered, true end is measure 7, fully covered) — the whole
    // span is complete measures 3–7, matching what null/null would produce.
    expect(formatFragmentRange(3, 8, 1, 1)).toBe('mm. 3–7');
  });

  it('does not collapse when only one end is whole', () => {
    expect(formatFragmentRange(3, 8, 2, 1)).toBe('m. 3, beat 2 – m. 7');
  });
});

/**
 * The range-label convention, case for case — ADR-005 § "range-label
 * convention" (2026-09-10). This is the table in the ADR; if one of these
 * changes, the ADR is what has to change with it.
 */
describe('formatFragmentRange — the ADR-005 range-label table', () => {
  it('[1, 5) in 4/4 → beats 1–4', () => {
    expect(formatFragmentRange(3, 3, 1, 5)).toBe('m. 3, beats 1–4');
  });

  it('[1⅔, 2) → beat 1⅔ (a single third, not "beats 1⅔–1")', () => {
    // The G1 defect itself. Under the withdrawn rule the whole-number bound
    // stepped back a full beat while the start stayed fractional, so the label
    // ran backwards. Stepping back by the range's own unit — a third — lands
    // exactly on the start, which collapses to one beat.
    expect(formatFragmentRange(3, 3, 1 + 2 / 3, 2)).toBe('m. 3, beat 1⅔');
  });

  it('[1⅓, 2) → beats 1⅓–1⅔', () => {
    expect(formatFragmentRange(3, 3, 1 + 1 / 3, 2)).toBe('m. 3, beats 1⅓–1⅔');
  });

  it('[1, 2½) → beats 1–2', () => {
    expect(formatFragmentRange(3, 3, 1, 2.5)).toBe('m. 3, beats 1–2');
  });

  it('[3, 4½) → beats 3–4', () => {
    // Deliberately imprecise: only the first half of beat 4 is covered, and
    // "beats 3 to 4" is what a musician says there. The bracket on the score
    // carries the exact extent; the label is the caption.
    expect(formatFragmentRange(3, 3, 3, 4.5)).toBe('m. 3, beats 3–4');
  });

  it('m. 5 beat 3 – m. 9 beat 1 → m. 5, beat 3 – m. 8', () => {
    expect(formatFragmentRange(5, 9, 3, 1)).toBe('m. 5, beat 3 – m. 8');
  });

  it('never renders an end below its start, across the whole beat grid', () => {
    // The invariant the convention buys, checked exhaustively over the
    // subdivisions ADR-005 produces rather than asserted once.
    const grid: number[] = [];
    for (const d of [1, 2, 3, 4, 6, 8]) {
      for (let n = 0; n < 4 * d; n++) grid.push(1 + n / d);
    }
    for (const start of grid) {
      for (const end of grid) {
        if (end <= start) continue;
        const label = formatFragmentRange(3, 3, start, end);
        const span = label.match(/beats (\S+)–(\S+)$/);
        if (!span) continue; // collapsed to a single beat: nothing to order
        expect(parseBeatGlyph(span[2]!)).toBeGreaterThan(parseBeatGlyph(span[1]!));
      }
    }
  });
});

/** Read a formatted beat ("1⅔") back to a number, for the ordering check. */
function parseBeatGlyph(text: string): number {
  const glyphs: Record<string, number> = {
    '½': 1 / 2,
    '⅓': 1 / 3,
    '⅔': 2 / 3,
    '¼': 1 / 4,
    '¾': 3 / 4,
    '⅕': 1 / 5,
    '⅖': 2 / 5,
    '⅗': 3 / 5,
    '⅘': 4 / 5,
    '⅙': 1 / 6,
    '⅚': 5 / 6,
    '⅛': 1 / 8,
    '⅜': 3 / 8,
    '⅝': 5 / 8,
    '⅞': 7 / 8,
  };
  const last = text.slice(-1);
  const frac = glyphs[last];
  return frac === undefined ? parseFloat(text) : parseInt(text.slice(0, -1), 10) + frac;
}

/**
 * formatBarRange / qualifyRange — the ADR-036 bar-label disambiguation.
 *
 * A movement whose bar numbers restart (K331/ii: the Trio renumbers from 1)
 * has two bars called "m. 12". The API resolves which section a fragment sits
 * in; these render it. Both sections are qualified, never only the second —
 * an unqualified label in a sectioned movement is itself ambiguous.
 */
describe('formatBarRange', () => {
  it('renders a single measure and a span', () => {
    expect(formatBarRange(3, 3)).toBe('m. 3');
    expect(formatBarRange(3, 7)).toBe('mm. 3–7');
  });
});

describe('qualifyRange', () => {
  const prose = (c: string) =>
    ({ first_ending: '1st ending', second_ending: '2nd ending' })[c] ?? null;

  it('passes an unsectioned range through untouched', () => {
    // The ~52 corpus movements with no restart: nothing changes for them.
    expect(qualifyRange('mm. 12–15')).toBe('mm. 12–15');
    expect(qualifyRange('mm. 12–15', { sectionLabel: null, repeatContext: null })).toBe(
      'mm. 12–15'
    );
  });

  it('prefixes the section name', () => {
    expect(qualifyRange('mm. 12–15', { sectionLabel: 'Trio' })).toBe('Trio, mm. 12–15');
  });

  it('qualifies the first section too, not only the second', () => {
    // Otherwise the reader cannot tell "first section" from "not applicable".
    expect(qualifyRange('mm. 12–15', { sectionLabel: 'Menuetto' })).toBe('Menuetto, mm. 12–15');
  });

  it('suffixes a volta as prose, never as the stored enum', () => {
    expect(
      qualifyRange('mm. 12–15', { repeatContext: 'first_ending', formatRepeatContext: prose })
    ).toBe('mm. 12–15 (1st ending)');
  });

  it('combines section and volta', () => {
    expect(
      qualifyRange('mm. 12–15', {
        sectionLabel: 'Trio',
        repeatContext: 'second_ending',
        formatRepeatContext: prose,
      })
    ).toBe('Trio, mm. 12–15 (2nd ending)');
  });

  it('drops an unrecognised repeat context rather than leaking it', () => {
    expect(
      qualifyRange('mm. 12–15', { repeatContext: 'fourth_ending', formatRepeatContext: prose })
    ).toBe('mm. 12–15');
    // No formatter supplied at all: same outcome, no enum on screen.
    expect(qualifyRange('mm. 12–15', { repeatContext: 'first_ending' })).toBe('mm. 12–15');
  });

  it('qualifies a beat-precise range the same way', () => {
    expect(qualifyRange(formatFragmentRange(12, 15, 3, 2), { sectionLabel: 'Trio' })).toBe(
      'Trio, m. 12, beat 3 – m. 15, beat 1'
    );
  });
});

// ---------------------------------------------------------------------------
// Localised labels (Component 12 Step 19c)
// ---------------------------------------------------------------------------

describe('formatFragmentRange — injected labels', () => {
  const ES: RangeLabels = {
    measure: 'c.',
    measures: 'cc.',
    beat: 'tiempo',
    beats: 'tiempos',
  };

  it('defaults to English when no labels are given', () => {
    // Every pre-existing call site relies on this, which is why the parameter
    // is optional rather than required.
    expect(formatFragmentRange(3, 7, null, null)).toBe('mm. 3–7');
  });

  it('uses the injected labels for a plain measure range', () => {
    expect(formatFragmentRange(3, 3, null, null, ES)).toBe('c. 3');
    expect(formatFragmentRange(3, 7, null, null, ES)).toBe('cc. 3–7');
  });

  it('uses the singular beat word for one beat', () => {
    expect(formatFragmentRange(3, 3, 2, 3, ES)).toBe('c. 3, tiempo 2');
  });

  it('uses the plural beat word for a beat span', () => {
    expect(formatFragmentRange(3, 3, 2, 4, ES)).toBe('c. 3, tiempos 2–3');
  });

  it('uses the labels on both sides of a cross-measure range', () => {
    expect(formatFragmentRange(3, 7, 2, 3, ES)).toBe('c. 3, tiempo 2 – c. 7, tiempo 2');
  });

  it('applies to formatBarRange too', () => {
    // The listing surfaces use this one; it was hardcoded separately and is
    // easy to miss when converting the detail formatter.
    expect(formatBarRange(3, 7, ES)).toBe('cc. 3–7');
    expect(formatBarRange(3, 3)).toBe('m. 3');
  });
});

describe('rangeLabels', () => {
  it('reads the four keys from the fragments namespace', () => {
    const seen: string[] = [];
    const labels = rangeLabels((key: string) => {
      seen.push(key);
      return key.split('.').pop() ?? key;
    });
    expect(seen).toEqual([
      'fragments:range.measure',
      'fragments:range.measures',
      'fragments:range.beat',
      'fragments:range.beats',
    ]);
    expect(labels.measures).toBe('measures');
  });
});
