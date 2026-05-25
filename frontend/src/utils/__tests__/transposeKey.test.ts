import { describe, expect, it } from 'vitest';
import { transposeKey } from '../transposeKey';

describe('transposeKey', () => {
  // ── Basic interval correctness against "G major" ──────────────────────────
  // Expected results from the playback-coordinates.md reference table.

  it('returns null for no transposition (empty interval)', () => {
    expect(transposeKey('G major', '')).toBeNull();
  });

  it('m2 up: G major → A♭ major', () => {
    expect(transposeKey('G major', 'm2')).toBe('A♭ major');
  });

  it('m2 down: G major → F♯ major', () => {
    expect(transposeKey('G major', '-m2')).toBe('F♯ major');
  });

  it('M2 up: G major → A major', () => {
    expect(transposeKey('G major', 'M2')).toBe('A major');
  });

  it('M2 down: G major → F major', () => {
    expect(transposeKey('G major', '-M2')).toBe('F major');
  });

  it('m3 up: G major → B♭ major', () => {
    expect(transposeKey('G major', 'm3')).toBe('B♭ major');
  });

  it('m3 down: G major → E major', () => {
    expect(transposeKey('G major', '-m3')).toBe('E major');
  });

  it('M3 up: G major → B major', () => {
    expect(transposeKey('G major', 'M3')).toBe('B major');
  });

  it('M3 down: G major → E♭ major', () => {
    expect(transposeKey('G major', '-M3')).toBe('E♭ major');
  });

  it('P4 up: G major → C major', () => {
    expect(transposeKey('G major', 'P4')).toBe('C major');
  });

  it('P4 down: G major → D major', () => {
    expect(transposeKey('G major', '-P4')).toBe('D major');
  });

  it('A4 up: G major → D♭ major', () => {
    // G(+1) + A4(+6) = +7 → normalise → −5 = D♭ major
    expect(transposeKey('G major', 'A4')).toBe('D♭ major');
  });

  it('A4 down: G major → D♭ major', () => {
    // G(+1) − A4(+6) = −5 = D♭ major
    expect(transposeKey('G major', '-A4')).toBe('D♭ major');
  });

  // ── Tritone direction determines enharmonic (issue fix) ───────────────────
  // A4 (augmented 4th up) moves sharp; −A4 (diminished 5th down) moves flat.
  // This matches Verovio's own rendering convention, so the dropdown hint and
  // the rendered score always agree.

  it('A4 up from C major → F♯ major (sharp direction, 6 sharps, no normalisation)', () => {
    // C(0) + A4(+6) = +6 = F♯ major
    expect(transposeKey('C major', 'A4')).toBe('F♯ major');
  });

  it('A4 down from C major → G♭ major (flat direction, 6 flats, no normalisation)', () => {
    // C(0) − A4(+6) = −6 = G♭ major
    expect(transposeKey('C major', '-A4')).toBe('G♭ major');
  });

  // ── 6-accidental keys preserved (issue 1) ─────────────────────────────────
  // Keys with exactly 6 accidentals must not be enharmonised — only 7+ triggers
  // normalisation.

  it('F♯ major source + M2 → A♭ major (7♯ normalised to 4♭)', () => {
    // F♯(+6) + M2(+2) = +8 → normalise → −4 = A♭ major
    expect(transposeKey('F♯ major', 'M2')).toBe('A♭ major');
  });

  it('G♭ major source + M2 → A♭ major', () => {
    // G♭(−6) + M2(+2) = −4 = A♭ major
    expect(transposeKey('G♭ major', 'M2')).toBe('A♭ major');
  });

  it('F♯ major source + m2 → G major (not treated as G♭ en route)', () => {
    // F♯(+6) + m2(−5) = +1 = G major
    expect(transposeKey('F♯ major', 'm2')).toBe('G major');
  });

  it('G♭ major source + P4 → C♭ major not normalised (would be 7♭ — normalise to B major)', () => {
    // G♭(−6) + P4(−1) = −7 → normalise → +5 = B major
    expect(transposeKey('G♭ major', 'P4')).toBe('B major');
  });

  it('D♯ minor source preserved at 6 sharps (not normalised to E♭ minor)', () => {
    // D♯ minor: D natural minor(−1) + sharp(+7) = +6.  No interval — check
    // that a neutral transposition from an adjacent key reaches D♯ minor.
    // E minor(+1) − m2(−5 → +5) = +6 = D♯ minor
    expect(transposeKey('E minor', '-m2')).toBe('D♯ minor');
  });

  it('E♭ minor source preserved at 6 flats (not normalised to D♯ minor)', () => {
    // E minor(+1) + m2(−5) = −4.  Approach E♭ minor differently:
    // D minor(−1) + m3(−3) = −4 ≠ E♭.  Direct: E♭ minor → P4 up.
    // E♭ minor(−6) + M2(+2) = −4 = F minor
    expect(transposeKey('E♭ minor', 'M2')).toBe('F minor');
  });

  // ── Enharmonic normalisation at 7+ accidentals ────────────────────────────

  it('normalises C♯ major (7 sharps) to D♭ major: D major − m2', () => {
    // D(+2) − m2(+5) = +7 → normalise → −5 = D♭ major
    expect(transposeKey('D major', '-m2')).toBe('D♭ major');
  });

  it('B major + M2 → D♭ major (not C♯ major)', () => {
    // B(+5) + M2(+2) = +7 → normalise → −5 = D♭ major
    expect(transposeKey('B major', 'M2')).toBe('D♭ major');
  });

  // ── Minor keys ────────────────────────────────────────────────────────────

  it('A minor + P4 → D minor', () => {
    expect(transposeKey('A minor', 'P4')).toBe('D minor');
  });

  it('A minor + m2 → B♭ minor (not A♯ minor)', () => {
    expect(transposeKey('A minor', 'm2')).toBe('B♭ minor');
  });

  it('E minor + P4 → A minor', () => {
    expect(transposeKey('E minor', 'P4')).toBe('A minor');
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns null for an unrecognised key string', () => {
    expect(transposeKey('X major', 'm2')).toBeNull();
  });

  it('returns null for an unrecognised interval string', () => {
    expect(transposeKey('G major', 'd2')).toBeNull();
  });

  it('returns null for an empty key string', () => {
    expect(transposeKey('', 'm2')).toBeNull();
  });

  it('handles flat notation with b: "Ab major" → A♭ major base', () => {
    // A♭ major: A natural major(+3) + flat(−7) = −4.  −4 + M2(+2) = −2 = B♭ major
    expect(transposeKey('Ab major', 'M2')).toBe('B♭ major');
  });

  it('handles Unicode flat in key string: "A♭ major"', () => {
    expect(transposeKey('A♭ major', 'M2')).toBe('B♭ major');
  });
});
