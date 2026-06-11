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
 * The display shows the stored endpoint values unchanged; refining the
 * human-facing end-beat label is a Part 1 interaction-model-spec concern.
 */

/** Format a beat number, trimming floating-point noise (1.5 → "1.5", 2 → "2"). */
function formatBeat(beat: number): string {
  return String(parseFloat(beat.toFixed(3)));
}

/**
 * Format a fragment's measure/beat range for display.
 *
 * @param barStart  - First measure (@n) of the fragment.
 * @param barEnd    - Last measure (@n) of the fragment.
 * @param beatStart - Beat within barStart, or null for a complete-measure start.
 * @param beatEnd   - Beat within barEnd (exclusive bound as stored), or null.
 * @returns e.g. "m. 3", "mm. 3–7", "m. 3, beats 2–4", "m. 3, beat 2 – m. 7, beat 1".
 */
export function formatFragmentRange(
  barStart: number,
  barEnd: number,
  beatStart: number | null,
  beatEnd: number | null,
): string {
  // Complete measures: no beats at all.
  if (beatStart === null && beatEnd === null) {
    return barStart === barEnd ? `m. ${barStart}` : `mm. ${barStart}–${barEnd}`;
  }

  // Single measure: both beats share the measure's context.
  if (barStart === barEnd) {
    if (beatStart !== null && beatEnd !== null && beatStart !== beatEnd) {
      return `m. ${barStart}, beats ${formatBeat(beatStart)}–${formatBeat(beatEnd)}`;
    }
    const beat = beatStart ?? beatEnd;
    return beat !== null
      ? `m. ${barStart}, beat ${formatBeat(beat)}`
      : `m. ${barStart}`;
  }

  // Multiple measures: each beat qualifies only its own measure.
  const startLabel =
    beatStart !== null ? `m. ${barStart}, beat ${formatBeat(beatStart)}` : `m. ${barStart}`;
  const endLabel =
    beatEnd !== null ? `m. ${barEnd}, beat ${formatBeat(beatEnd)}` : `m. ${barEnd}`;
  return `${startLabel} – ${endLabel}`;
}
