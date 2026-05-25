/**
 * Key transposition utility for the score viewer transpose dropdown.
 *
 * Tracks keys via their circle-of-fifths position (not pitch class) so that
 * enharmonic spelling is derived from the interval's diatonic direction rather
 * than a fixed PC→name lookup.  Enharmonic normalisation fires only when the
 * result has strictly more than 6 accidentals (> 6, not ≥ 6), so F♯ major
 * (6♯) and G♭ major (6♭) are both preserved as-is.
 *
 * This also fixes the dropdown/score mismatch: Verovio uses the interval's
 * diatonic spelling when rendering (A4 = sharp direction, -A4 = flat
 * direction), so tracking via fifths produces the same enharmonic as the score.
 */

// ---------------------------------------------------------------------------
// Circle-of-fifths offsets per Verovio interval string
// ---------------------------------------------------------------------------

/**
 * Maps each Verovio interval string to its displacement on the circle of
 * fifths.  The sign encodes direction (positive = sharp side, negative = flat
 * side), which is what determines the enharmonic spelling of the result.
 *
 * Derivation from diatonic interval names:
 *   m2 = minor second up   → −5 fifths (C→D♭)
 *   M2 = major second up   → +2 fifths (C→D)
 *   m3 = minor third up    → −3 fifths (C→E♭)
 *   M3 = major third up    → +4 fifths (C→E)
 *   P4 = perfect fourth up → −1 fifth  (C→F)
 *   A4 = augmented fourth  → +6 fifths (C→F♯)
 * Downward intervals negate the offset.
 */
export const INTERVAL_FIFTHS: Record<string, number> = {
  m2:  -5,  '-m2':  5,
  M2:   2,  '-M2': -2,
  m3:  -3,  '-m3':  3,
  M3:   4,  '-M3': -4,
  P4:  -1,  '-P4':  1,
  A4:   6,  '-A4': -6,
};

// ---------------------------------------------------------------------------
// Fifths-position → key-name lookup tables (range −6 … +6)
// ---------------------------------------------------------------------------

/**
 * Major key names indexed by circle-of-fifths position.
 * −6 = G♭ major (6♭), …, 0 = C major, …, +6 = F♯ major (6♯).
 */
const MAJOR_KEY_AT_FIFTHS: Record<number, string> = {
  [-6]: 'G♭', [-5]: 'D♭', [-4]: 'A♭', [-3]: 'E♭', [-2]: 'B♭', [-1]: 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F♯',
};

/**
 * Minor key names indexed by circle-of-fifths position.
 * −6 = E♭ minor (6♭), …, 0 = A minor, …, +6 = D♯ minor (6♯).
 */
const MINOR_KEY_AT_FIFTHS: Record<number, string> = {
  [-6]: 'E♭', [-5]: 'B♭', [-4]: 'F', [-3]: 'C', [-2]: 'G', [-1]: 'D',
  0: 'A', 1: 'E', 2: 'B', 3: 'F♯', 4: 'C♯', 5: 'G♯', 6: 'D♯',
};

// ---------------------------------------------------------------------------
// Natural-note fifths positions for parsing source keys
// ---------------------------------------------------------------------------

/** Fifths positions of the natural notes in the major circle. */
const MAJOR_NATURAL_FIFTHS: Record<string, number> = {
  F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5,
};

/** Fifths positions of the natural notes in the minor circle. */
const MINOR_NATURAL_FIFTHS: Record<string, number> = {
  F: -4, C: -3, G: -2, D: -1, A: 0, E: 1, B: 2,
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a key string ("G major", "A♭ minor", "D# major", …) into a
 * circle-of-fifths position and mode.
 *
 * Returns `null` for unrecognised strings.
 */
function parseKeyFifths(key: string): { fifths: number; mode: string } | null {
  const m = key.match(/^([A-G])(♯♯|##|♯|#|♭♭|bb|♭|b)?\s*(major|minor)$/i);
  if (!m) return null;
  const [, root, acc = '', modeRaw] = m;
  const mode = modeRaw.toLowerCase();
  const naturalTable = mode === 'minor' ? MINOR_NATURAL_FIFTHS : MAJOR_NATURAL_FIFTHS;
  const natural = naturalTable[root.toUpperCase()];
  if (natural === undefined) return null;

  let accOffset = 0;
  if (acc === '♯' || acc === '#')       accOffset =  7;
  else if (acc === '♭' || acc === 'b')  accOffset = -7;
  else if (acc === '♯♯' || acc === '##') accOffset =  14;
  else if (acc === '♭♭' || acc === 'bb') accOffset = -14;

  return { fifths: natural + accOffset, mode };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transpose a key string by a Verovio interval string.
 *
 * Enharmonic spelling follows the interval's diatonic direction (e.g. A4 goes
 * sharp, −A4 goes flat), matching Verovio's own rendering convention.
 * Normalisation to the enharmonic equivalent fires only when the result would
 * have strictly more than 6 accidentals (7+), so 6-accidental keys like
 * F♯ major and G♭ major are preserved.
 *
 * Returns `null` when either argument is empty or unrecognised.
 *
 * @param keyStr      e.g. "G major", "A♭ minor"
 * @param intervalStr Verovio interval string, e.g. "m2", "-P4", "A4"
 * @returns           Transposed key string, e.g. "A♭ major", or null
 */
export function transposeKey(keyStr: string, intervalStr: string): string | null {
  if (!intervalStr || !keyStr) return null;
  const parsed = parseKeyFifths(keyStr);
  if (!parsed) return null;
  const fifthsOffset = INTERVAL_FIFTHS[intervalStr];
  if (fifthsOffset === undefined) return null;

  let newFifths = parsed.fifths + fifthsOffset;

  // Normalise only when strictly beyond 6 accidentals.
  if (newFifths > 6)  newFifths -= 12;
  if (newFifths < -6) newFifths += 12;

  const table = parsed.mode === 'minor' ? MINOR_KEY_AT_FIFTHS : MAJOR_KEY_AT_FIFTHS;
  const root = table[newFifths];
  if (!root) return null;
  return `${root} ${parsed.mode}`;
}
