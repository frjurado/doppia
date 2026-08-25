/**
 * formatFragmentRange tests — Component 9 Step 15 measure/beat display rule.
 *
 * Rule: beats render only within their measure's context, and not at all when
 * the fragment spans complete measures.
 *
 * beat_end display semantics (Component 9 G1, decided with Francisco
 * 2026-07-01): a whole-number beat_end steps back to the last included beat
 * (the exclusive bound minus one); a fractional beat_end displays as-is. A
 * multi-measure end whose beat_end lands on beat 1 of barEnd covers none of
 * barEnd — the true last measure is the previous one, fully covered. Ranges
 * that reduce to whole measures at both ends collapse to the bare "mm. N–M"
 * form.
 */

import { describe, expect, it } from 'vitest';
import { formatBarRange, formatBeat, formatFragmentRange, qualifyRange } from '../fragmentRange';

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

  it('formats a fractional end as-is', () => {
    expect(formatFragmentRange(3, 3, 1, 2.5)).toBe('m. 3, beats 1–2½');
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
    expect(formatFragmentRange(3, 4, 1.5, 2.25)).toBe('m. 3, beat 1½ – m. 4, beat 2¼');
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
