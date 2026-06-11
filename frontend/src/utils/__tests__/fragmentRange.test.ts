/**
 * formatFragmentRange tests — Component 9 Step 15 measure/beat display rule.
 *
 * Rule: beats render only within their measure's context, and not at all when
 * the fragment spans complete measures.
 */

import { describe, expect, it } from 'vitest';
import { formatFragmentRange } from '../fragmentRange';

describe('formatFragmentRange — complete measures (no beats shown)', () => {
  it('formats a single complete measure', () => {
    expect(formatFragmentRange(3, 3, null, null)).toBe('m. 3');
  });

  it('formats a complete-measure span', () => {
    expect(formatFragmentRange(3, 7, null, null)).toBe('mm. 3–7');
  });
});

describe('formatFragmentRange — single measure with beats', () => {
  it('formats a beat range within one measure', () => {
    expect(formatFragmentRange(3, 3, 2, 4)).toBe('m. 3, beats 2–4');
  });

  it('collapses equal start/end beats to a single beat', () => {
    expect(formatFragmentRange(3, 3, 2, 2)).toBe('m. 3, beat 2');
  });

  it('shows the only available beat when one endpoint is null', () => {
    expect(formatFragmentRange(3, 3, 2, null)).toBe('m. 3, beat 2');
    expect(formatFragmentRange(3, 3, null, 3)).toBe('m. 3, beat 3');
  });
});

describe('formatFragmentRange — multiple measures with beats', () => {
  it('attaches each beat to its own measure', () => {
    expect(formatFragmentRange(3, 7, 2, 1)).toBe('m. 3, beat 2 – m. 7, beat 1');
  });

  it('omits the beat qualifier on a complete-measure endpoint', () => {
    expect(formatFragmentRange(3, 7, null, 3)).toBe('m. 3 – m. 7, beat 3');
    expect(formatFragmentRange(3, 7, 2, null)).toBe('m. 3, beat 2 – m. 7');
  });

  it('formats sub-beat (fractional) positions without float noise', () => {
    expect(formatFragmentRange(3, 4, 1.5, 2.25)).toBe('m. 3, beat 1.5 – m. 4, beat 2.25');
  });
});
