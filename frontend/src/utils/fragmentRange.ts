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
 * The stored bound and the label are different objects, and the label is prose.
 *
 * **Range-label convention** (ADR-005 § "range-label convention", decided with
 * Francisco 2026-09-10, Component 12 Step 20 / G1): a range names the onset of
 * the *first and last included unit*. That is the musician's rule at every
 * granularity — "mm. 5–8" names the first and last included measure, "beats 1–4"
 * the first and last included beat — and the unit is inferred from the
 * endpoints' own precision: both whole → a beat, otherwise `1/d` for `d` the
 * common denominator of their fractions. The displayed end is the stored
 * exclusive bound stepped back by one unit; landing on the start collapses to a
 * single-beat label. Because both endpoints are multiples of `1/d`, the stepped
 * end can never fall below the start — the invariant is a property of the rule,
 * not a clamp bolted on after it.
 *
 * This replaces the two-rule scheme of 2026-07-01 (whole bound → step back a
 * beat; fractional bound → show as-is), which mixed an inclusive reading of the
 * end with an exclusive one and so could render "beats 1⅔–1". Its fractional
 * branch also named points where nothing starts ("beats 1–2½" for a range whose
 * last onset is beat 2).
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
 * The denominator implied by one beat value: 1 for a whole beat, else the
 * subdivision it sits on (2½ → 2, 1⅔ → 3).
 *
 * Returns null for a fraction outside the recognised vocabulary. Compliant
 * ADR-005 coordinates never produce one; when it happens the caller shows the
 * raw bound rather than stepping back by a unit it cannot name.
 */
function beatDenominator(beat: number): number | null {
  const frac = beat - Math.floor(beat + 1e-9);
  if (frac < FRACTION_EPS) return 1;
  for (const d of FRACTION_DENOMINATORS) {
    const n = Math.round(frac * d);
    if (n > 0 && n < d && Math.abs(frac - n / d) < FRACTION_EPS) return d;
  }
  return null;
}

/** Least common multiple of two small positive integers. */
function lcm(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return (a * b) / x;
}

/**
 * Convert an exclusive beat_end bound to the onset it should display — the last
 * onset the range includes (ADR-005 § "range-label convention"; see the module
 * docstring).
 *
 * Both endpoints are read, because the unit to step back by is a property of the
 * *range*, not of its end: [1⅓, 2) is stepped by a third to "1⅔", while [1, 2)
 * — same bound, whole start — is stepped by a beat to "1". Where the endpoints
 * live in different measures (a cross-bar range) that inference still holds: the
 * two numbers together are what says how finely the range was tagged.
 *
 * @param beatStart - The range's start beat, or null for a whole-measure start.
 * @param beatEnd   - The stored exclusive end bound.
 */
function displayEndBeat(beatStart: number | null, beatEnd: number): number {
  const dEnd = beatDenominator(beatEnd);
  const dStart = beatStart === null ? 1 : beatDenominator(beatStart);
  if (dEnd === null || dStart === null) return beatEnd; // outside the vocabulary
  return beatEnd - 1 / lcm(dStart, dEnd);
}

/**
 * The four words a range is built from, injected rather than imported.
 *
 * This module is a pure formatter with no hook access, and its output is read
 * by every fragment card, detail panel and stage row — which is how "m." and
 * "beat" stayed English through Step 19b while everything around them was
 * translated (Component 12 Step 19c). Injection matches what this file already
 * does for volta prose in `makeRepeatContextFormatter`; the English default
 * keeps existing call sites working unchanged.
 */
export interface RangeLabels {
  /** Singular measure abbreviation: "m." (en), "c." (es). */
  measure: string;
  /** Plural measure abbreviation: "mm." (en), "cc." (es). */
  measures: string;
  /** Singular beat word. */
  beat: string;
  /** Plural beat word. */
  beats: string;
}

/** English labels — the default, so an unconverted call site is unchanged. */
export const EN_RANGE_LABELS: RangeLabels = {
  measure: 'm.',
  measures: 'mm.',
  beat: 'beat',
  beats: 'beats',
};

/**
 * Build labels from a translation function.
 *
 * Takes `t` as an argument rather than calling a hook, so this stays usable
 * from non-component code and from tests with no i18n provider.
 */
export function rangeLabels(t: (key: string) => string): RangeLabels {
  return {
    measure: t('fragments:range.measure'),
    measures: t('fragments:range.measures'),
    beat: t('fragments:range.beat'),
    beats: t('fragments:range.beats'),
  };
}

/**
 * Format a fragment's measure/beat range for display.
 *
 * @param barStart  - First measure (@n) of the fragment.
 * @param barEnd    - Last measure (@n) of the fragment.
 * @param beatStart - Beat within barStart, or null for a complete-measure start.
 * @param beatEnd   - Beat within barEnd (exclusive bound as stored), or null.
 * @returns e.g. "m. 3", "mm. 3–7", "m. 3, beats 2–3" (exclusive bound 4 →
 *   the last included onset, beat 3), "m. 3, beats 1–2" (exclusive bound 2½ →
 *   beat 2, the last onset inside it), "m. 3, beats 1⅓–1⅔" (a range tagged in
 *   thirds steps back by a third), "m. 3, beat 2 – m. 7, beat 1".
 */
export function formatFragmentRange(
  barStart: number,
  barEnd: number,
  beatStart: number | null,
  beatEnd: number | null,
  labels: RangeLabels = EN_RANGE_LABELS
): string {
  // Complete measures: no beats at all.
  if (beatStart === null && beatEnd === null) {
    return barStart === barEnd
      ? `${labels.measure} ${barStart}`
      : `${labels.measures} ${barStart}–${barEnd}`;
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
    return barStart === effBarEnd
      ? `${labels.measure} ${barStart}`
      : `${labels.measures} ${barStart}–${effBarEnd}`;
  }

  // Single measure: both beats share the measure's context.
  if (barStart === effBarEnd) {
    if (beatStart !== null && effBeatEnd !== null && beatStart !== effBeatEnd) {
      const displayEnd = displayEndBeat(beatStart, effBeatEnd);
      // Landing on the start collapses to a single beat. The comparison is
      // tolerant because the two sides are reached by different arithmetic —
      // 1 + 2/3 is 1.6666666666666665, 2 - 1/3 is 1.6666666666666667 — and an
      // exact test renders "beats 1⅔–1⅔" for the very range G1 was about.
      // FRACTION_EPS is far below the finest gap the beat grid produces (⅛).
      // `<` rather than `===` also catches a bound whose fraction fell outside
      // the recognised vocabulary, where no unit could be inferred.
      if (displayEnd <= beatStart + FRACTION_EPS) {
        return `${labels.measure} ${barStart}, ${labels.beat} ${formatBeat(beatStart)}`;
      }
      return (
        `${labels.measure} ${barStart}, ${labels.beats} ` +
        `${formatBeat(beatStart)}–${formatBeat(displayEnd)}`
      );
    }
    const beat = beatStart ?? effBeatEnd;
    return beat !== null
      ? `${labels.measure} ${barStart}, ${labels.beat} ${formatBeat(beat)}`
      : `${labels.measure} ${barStart}`;
  }

  // Multiple measures: each beat qualifies only its own measure.
  const startLabel =
    beatStart !== null
      ? `${labels.measure} ${barStart}, ${labels.beat} ${formatBeat(beatStart)}`
      : `${labels.measure} ${barStart}`;
  const endLabel =
    effBeatEnd !== null
      ? `${labels.measure} ${effBarEnd}, ${labels.beat} ${formatBeat(displayEndBeat(beatStart, effBeatEnd))}`
      : `${labels.measure} ${effBarEnd}`;
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
export function formatBarRange(
  barStart: number,
  barEnd: number,
  labels: RangeLabels = EN_RANGE_LABELS
): string {
  return barStart === barEnd
    ? `${labels.measure} ${barStart}`
    : `${labels.measures} ${barStart}–${barEnd}`;
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
