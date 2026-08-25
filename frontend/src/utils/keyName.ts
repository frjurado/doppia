/**
 * Display formatting for key names.
 *
 * The corpus stores key signatures in an ASCII spelling — `"Bb major"`,
 * `"Eb major"` — which is the right thing for a stored value: it is the join
 * key behind the browse filter's `?key=` parameter, and it round-trips through
 * URLs and the database without encoding surprises.
 *
 * It is the wrong thing to *show*. Rendered in a label style with
 * `text-transform: uppercase` it reads "BB MAJOR", and even in lower case a
 * lettered flat is not how a key is written. `transposeKey` already emits the
 * Unicode glyphs (`B♭`, `F♯`) and `meiParsing`'s tables follow the same
 * convention; this is that convention applied on the way to the screen.
 *
 * **Format at the point of display only.** Never store the result, put it in a
 * query string, or compare against it — `ScoreViewer` writes the raw
 * `key_signature` into `summary.key`, and the browse filter matches on the raw
 * value. Both must keep the ASCII spelling.
 */

/** ASCII accidental → Unicode glyph, longest first so `bb` beats `b`. */
const ACCIDENTAL_GLYPH: Record<string, string> = {
  '##': '♯♯',
  '#': '♯',
  bb: '♭♭',
  b: '♭',
};

/**
 * Render a stored key name for display, converting a leading accidental to its
 * Unicode glyph.
 *
 * Only an accidental directly after the tonic letter is touched, so the `b` of
 * `"B major"` is never mistaken for a flat. Input already using glyphs, or in
 * any shape this does not recognise, is returned unchanged — this formats, it
 * never validates.
 *
 * @param key Stored key name, e.g. `"Bb major"`, `"A minor"`, or null.
 * @returns   Display form, e.g. `"B♭ major"`. Empty string for null/undefined.
 *
 * @example
 * formatKeyName('Bb major')  // 'B♭ major'
 * formatKeyName('F# minor')  // 'F♯ minor'
 * formatKeyName('B major')   // 'B major'  — the b is the tonic, not a flat
 */
export function formatKeyName(key: string | null | undefined): string {
  if (!key) return '';
  return key.replace(
    /^([A-G])(bb|b|##|#)/,
    (_match, tonic: string, accidental: string) =>
      tonic + (ACCIDENTAL_GLYPH[accidental] ?? accidental)
  );
}
