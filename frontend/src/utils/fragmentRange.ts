/**
 * Human-readable measure/beat range formatting — Component 9 Step 15.
 *
 * Display rule (component-9 plan § "Fragment viewer"): beats render only
 * within their measure's context, and not at all when the fragment spans
 * complete measures. "mm. 3–4 · beat 1–3" reads as ambiguous because a beat
 * number is meaningless without its measure; "m. 3, beat 1 – m. 4, beat 3"
 * is not.
 *
 * Semantics note: `beat_end` is stored as the *exclusive* onset bound of the
 * selection (see annotator.ts — "any note whose onset < beatEnd is included").
 * Decided with Francisco (Component 9 G1, 2026-07-01): a *whole-number*
 * beat_end steps back to the last included beat (e.g. exclusive bound 3 → "beat
 * 2", the last beat actually covered), collapsing to a single beat label when
 * that equals beatStart; a *fractional* beat_end (mid-beat) displays the raw
 * bound as-is (e.g. "beats 1–2½") — contradictory-looking at first glance, but
 * it's the phrasing a musician actually reads naturally in each case.
 */

/**
 * Unicode vulgar-fraction glyphs for the subdivision denominators ADR-005's
 * beat encoding actually produces (halves/thirds/quarters/sixths/eighths;
 * fifths included for completeness).
 */
const FRACTION_GLYPHS: Record<string, string> = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/5': '⅕',
  '2/5': '⅖',
  '3/5': '⅗',
  '4/5': '⅘',
  '1/6': '⅙',
  '5/6': '⅚',
  '1/8': '⅛',
  '3/8': '⅜',
  '5/8': '⅝',
  '7/8': '⅞',
};
const FRACTION_DENOMINATORS = [2, 3, 4, 5, 6, 8];
const FRACTION_EPS = 0.01;

/**
 * Format a beat number as a whole number or whole+fraction glyph
 * (2.667 → "2⅔") instead of floating-point noise (2.667) — Component 9 G1.
 * Matches against the subdivision denominators ADR-005's beat_position
 * encoding uses. Falls back to a trimmed decimal for a fraction that doesn't
 * cleanly match one of them (should not occur for compliant beat values, but
 * keeps the display safe if one ever does).
 */
export function formatBeat(beat: number): string {
  const whole = Math.floor(beat + 1e-9);
  const frac = beat - whole;
  if (frac < FRACTION_EPS) return String(whole);
  for (const d of FRACTION_DENOMINATORS) {
    const n = Math.round(frac * d);
    if (n > 0 && n < d && Math.abs(frac - n / d) < FRACTION_EPS) {
      const glyph = FRACTION_GLYPHS[`${n}/${d}`];
      if (glyph) return `${whole}${glyph}`;
    }
  }
  return String(parseFloat(beat.toFixed(3)));
}

/**
 * Convert an exclusive beat_end bound to its human-facing display value
 * (Component 9 G1, decided with Francisco 2026-07-01): a whole-number bound
 * steps back one beat to name the last beat actually covered; a fractional
 * bound (mid-beat) is shown unchanged, since it already names a real onset
 * inside the range rather than the excluded next one.
 */
function displayEndBeat(beatEnd: number): number {
  return Number.isInteger(beatEnd) ? beatEnd - 1 : beatEnd;
}

/**
 * Format a fragment's measure/beat range for display.
 *
 * @param barStart  - First measure (@n) of the fragment.
 * @param barEnd    - Last measure (@n) of the fragment.
 * @param beatStart - Beat within barStart, or null for a complete-measure start.
 * @param beatEnd   - Beat within barEnd (exclusive bound as stored), or null.
 * @returns e.g. "m. 3", "mm. 3–7", "m. 3, beats 2–3" (exclusive bound 4 →
 *   displayed as the last covered beat 3), "m. 3, beats 1–2½" (a fractional
 *   bound displays as-is), "m. 3, beat 2 – m. 7, beat 1".
 */
export function formatFragmentRange(
  barStart: number,
  barEnd: number,
  beatStart: number | null,
  beatEnd: number | null
): string {
  // Complete measures: no beats at all.
  if (beatStart === null && beatEnd === null) {
    return barStart === barEnd ? `m. ${barStart}` : `mm. ${barStart}–${barEnd}`;
  }

  // A multi-measure end whose exclusive beat_end sits at beat 1 of barEnd
  // covers none of barEnd at all — barEnd is merely "the onset of the cut",
  // not an included measure. The true last included measure is the previous
  // one, covered completely (Component 9 G1, decided with Francisco
  // 2026-07-01). Reduce to that measure, fully covered, before anything else
  // below reasons about barEnd/beatEnd.
  let effBarEnd = barEnd;
  let effBeatEnd = beatEnd;
  if (barStart !== barEnd && effBeatEnd === 1) {
    effBarEnd = barEnd - 1;
    effBeatEnd = null;
  }

  // Once reduced, a start and end that both cover their measure completely
  // (beatStart null/1; effBeatEnd null) collapse to the plain measure-range
  // form — no beat qualifiers, exactly as if the whole span had been passed
  // in as complete measures. This is the general form of "if whole measures,
  // simplify": e.g. "m. 3, beat 1 – m. 8, beat 1" (barEnd 8 uncovered) becomes
  // "mm. 3–7", not "m. 3, beat 1 – m. 7".
  const startIsWhole = beatStart === null || beatStart === 1;
  const endIsWhole = effBeatEnd === null;
  if (startIsWhole && endIsWhole) {
    return barStart === effBarEnd ? `m. ${barStart}` : `mm. ${barStart}–${effBarEnd}`;
  }

  // Single measure: both beats share the measure's context.
  if (barStart === effBarEnd) {
    if (beatStart !== null && effBeatEnd !== null && beatStart !== effBeatEnd) {
      const displayEnd = displayEndBeat(effBeatEnd);
      if (displayEnd === beatStart) {
        return `m. ${barStart}, beat ${formatBeat(beatStart)}`;
      }
      return `m. ${barStart}, beats ${formatBeat(beatStart)}–${formatBeat(displayEnd)}`;
    }
    const beat = beatStart ?? effBeatEnd;
    return beat !== null ? `m. ${barStart}, beat ${formatBeat(beat)}` : `m. ${barStart}`;
  }

  // Multiple measures: each beat qualifies only its own measure.
  const startLabel =
    beatStart !== null ? `m. ${barStart}, beat ${formatBeat(beatStart)}` : `m. ${barStart}`;
  const endLabel =
    effBeatEnd !== null
      ? `m. ${effBarEnd}, beat ${formatBeat(displayEndBeat(effBeatEnd))}`
      : `m. ${effBarEnd}`;
  return `${startLabel} – ${endLabel}`;
}

/**
 * Format a plain measure range — "m. 3" / "mm. 3–7" — with no beat detail.
 *
 * The listing surfaces (browse cards, glossary example captions) deliberately
 * stay at measure precision: a card is a glance, not a reading. This exists so
 * they share one implementation with the detail formatter above rather than
 * three near-identical i18n templates, which is how the bar label drifted in the
 * first place.
 */
export function formatBarRange(barStart: number, barEnd: number): string {
  return barStart === barEnd ? `m. ${barStart}` : `mm. ${barStart}–${barEnd}`;
}

/**
 * Qualifiers that disambiguate a bar range — ADR-036.
 *
 * `sectionLabel` is set by the API only for movements whose bar numbers restart
 * (K331/ii: the Trio renumbers from 1), where "mm. 12–15" names two different
 * places in the score. `repeatContext` marks a volta ending; it disambiguates
 * nothing in the present corpus — no two endings share a bar number — but it is
 * real musical information, and it reached the UI as the raw enum
 * `"first_ending"` before this.
 */
export interface RangeQualifiers {
  sectionLabel?: string | null;
  repeatContext?: string | null;
  /**
   * Renders a `repeat_context` value as prose ("first_ending" → "1st ending").
   * Supplied by the caller so the utility stays free of i18n wiring; when
   * omitted the qualifier is dropped rather than leaking the enum.
   */
  formatRepeatContext?: (context: string) => string | null;
}

/**
 * Apply section and volta qualifiers to an already-formatted range — ADR-036.
 *
 * "mm. 12–15" → "Trio, mm. 12–15" → "Trio, mm. 12–15 (1st ending)".
 *
 * **Both sections are qualified, not only the second.** In a sectioned movement
 * an unqualified label is itself ambiguous: the reader cannot tell whether its
 * absence means "the first section" or "not applicable". Unsectioned movements —
 * all but one in the corpus — get no `sectionLabel` from the API and so pass
 * through unchanged.
 *
 * This is the single place the convention lives. Every surface that shows a bar
 * reference to a reader routes through it.
 */
export function qualifyRange(range: string, qualifiers: RangeQualifiers = {}): string {
  const { sectionLabel, repeatContext, formatRepeatContext } = qualifiers;
  let out = sectionLabel ? `${sectionLabel}, ${range}` : range;
  if (repeatContext) {
    const prose = formatRepeatContext?.(repeatContext);
    if (prose) out = `${out} (${prose})`;
  }
  return out;
}

/**
 * Build a `formatRepeatContext` from a translation function.
 *
 * Renders `repeat_context` as prose via `common:repeatContext.*`. An
 * unrecognised value yields `null` so the qualifier is dropped: showing nothing
 * beats showing a raw enum, which is what this replaces.
 */
export function makeRepeatContextFormatter(
  t: (key: string, options?: Record<string, unknown>) => string
): (context: string) => string | null {
  return (context: string) => t(`common:repeatContext.${context}`, { defaultValue: '' }) || null;
}
