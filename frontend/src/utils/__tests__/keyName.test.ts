/**
 * Tests for formatKeyName — display spelling of stored key names.
 *
 * The stored spelling is ASCII ("Bb major") because it doubles as the browse
 * filter's ?key= value; the display spelling uses the Unicode glyphs the rest
 * of the app already emits (transposeKey, meiParsing). The interesting case is
 * the one a naive replace gets wrong: the B of "B major" is a tonic, not a flat.
 */

import { describe, expect, it } from 'vitest';
import { formatKeyName } from '../keyName';

describe('formatKeyName', () => {
  it('renders a lettered flat as a flat glyph', () => {
    expect(formatKeyName('Bb major')).toBe('B♭ major');
    expect(formatKeyName('Eb major')).toBe('E♭ major');
  });

  it('renders a hash as a sharp glyph', () => {
    expect(formatKeyName('F# minor')).toBe('F♯ minor');
  });

  it('leaves a natural tonic alone, including B', () => {
    // The failure mode of a blunt replace: "B major" → "♭ major".
    expect(formatKeyName('B major')).toBe('B major');
    expect(formatKeyName('A minor')).toBe('A minor');
    expect(formatKeyName('C major')).toBe('C major');
  });

  it('is idempotent — input already using glyphs is unchanged', () => {
    expect(formatKeyName('B♭ major')).toBe('B♭ major');
    expect(formatKeyName(formatKeyName('Bb major'))).toBe('B♭ major');
  });

  it('handles double accidentals, longest match first', () => {
    expect(formatKeyName('Bbb major')).toBe('B♭♭ major');
    expect(formatKeyName('F## minor')).toBe('F♯♯ minor');
  });

  it('returns an empty string for null or undefined', () => {
    expect(formatKeyName(null)).toBe('');
    expect(formatKeyName(undefined)).toBe('');
    expect(formatKeyName('')).toBe('');
  });

  it('passes through anything it does not recognise, rather than mangling it', () => {
    expect(formatKeyName('unknown')).toBe('unknown');
    expect(formatKeyName('4f')).toBe('4f');
  });
});
