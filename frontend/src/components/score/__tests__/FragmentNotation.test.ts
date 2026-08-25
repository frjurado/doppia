/**
 * Unit tests for computeBracketSegments() in FragmentNotation.tsx — the
 * bracket geometry of the *read-only* views (fragment viewer, glossary
 * examples). The tagging tool has its own implementation in MainBracket; the
 * two must agree, and this suite pins the case where they did not.
 *
 * Fixture is the real stage layout of the K279/i m. 61–62 PAC, whose four
 * stages tile the fragment end to end:
 *
 *   Initial Tonic  m.61 beat 3.5 → 4.0
 *   Pre-dominant   m.61 beat 4.0 → 4.5
 *   Dominant       m.61 beat 4.5 → m.62 beat 1.0
 *   Final Tonic    m.62 beat 1.0 → 1.5
 *
 * `beat_end` is exclusive (ADR-005), so the Dominant holds nothing *of* m. 62
 * — it stops on the barline.
 */

import { describe, expect, it, vi } from 'vitest';

// FragmentNotation owns the MIDI transport as well as the geometry, so importing
// it pulls in Tone.js, which does not resolve under vitest. Only the pure
// projection function is under test here; the same stubs the FragmentDetail and
// ScoreViewer suites use keep the import chain loadable.
vi.mock('tone', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  getTransport: vi.fn(() => ({})),
  Sampler: vi.fn(),
}));
vi.mock('@tonejs/midi', () => ({ Midi: vi.fn() }));

import { computeBracketSegments } from '../FragmentNotation';

// Two 4/4 bars on one system: m.61 spans x 0–200, m.62 spans x 200–400.
// Onsets every half beat, 25px wide, indented 4px from the barline the way a
// real engraving indents its first notehead.
function geometry() {
  const measures = new Map<number, { left: number; right: number; systemTop: number; systemBottom: number }>();
  const notes: Array<{ barN: number; beatFloat: number; left: number; right: number }> = [];
  [61, 62].forEach((barN, i) => {
    measures.set(barN, { left: i * 200, right: i * 200 + 200, systemTop: 10, systemBottom: 90 });
    for (let k = 0; k < 8; k++) {
      notes.push({
        barN,
        beatFloat: 1 + k * 0.5,
        left: i * 200 + k * 25 + 4,
        right: i * 200 + k * 25 + 25,
      });
    }
  });
  return { measures, notes };
}

const BARLINE_62 = 200;

describe('computeBracketSegments — a range ending on a barline', () => {
  it('stops the Dominant at the barline, not at the end of the bar it names', () => {
    // The reported bug: no onset in m. 62 satisfies beatFloat < 1.0, the
    // refinement was skipped, and the "keep the measure edge" fallback left the
    // bracket stretched across the whole of m. 62.
    const [seg] = computeBracketSegments(geometry(), 61, 62, 4.5, 1.0);
    expect(seg).toBeDefined();
    expect(seg!.right).toBe(BARLINE_62);
  });

  it('does not overlap the stage that begins on that barline', () => {
    const geo = geometry();
    const [dominant] = computeBracketSegments(geo, 61, 62, 4.5, 1.0);
    const [finalTonic] = computeBracketSegments(geo, 62, 62, 1.0, 1.5);
    expect(dominant!.right).toBeLessThanOrEqual(finalTonic!.left);
  });

  it('keeps every stage inside the parent fragment', () => {
    const geo = geometry();
    const [parent] = computeBracketSegments(geo, 61, 62, 3.5, 1.5);
    const stages = [
      computeBracketSegments(geo, 61, 61, 3.5, 4.0)[0]!,
      computeBracketSegments(geo, 61, 61, 4.0, 4.5)[0]!,
      computeBracketSegments(geo, 61, 62, 4.5, 1.0)[0]!,
      computeBracketSegments(geo, 62, 62, 1.0, 1.5)[0]!,
    ];
    for (const s of stages) {
      expect(s.left).toBeGreaterThanOrEqual(parent!.left);
      expect(s.right).toBeLessThanOrEqual(parent!.right);
    }
  });

  it('leaves the stages in order, none overlapping its neighbour', () => {
    const geo = geometry();
    const stages = [
      computeBracketSegments(geo, 61, 61, 3.5, 4.0)[0]!,
      computeBracketSegments(geo, 61, 61, 4.0, 4.5)[0]!,
      computeBracketSegments(geo, 61, 62, 4.5, 1.0)[0]!,
      computeBracketSegments(geo, 62, 62, 1.0, 1.5)[0]!,
    ];
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i - 1]!.right).toBeLessThanOrEqual(stages[i]!.left);
    }
  });
});

describe('computeBracketSegments — refinement fallbacks', () => {
  it('still refines normally when onsets are in range', () => {
    // Initial Tonic: m.61 beats 3.5–4.0 → the single onset at 3.5.
    const [seg] = computeBracketSegments(geometry(), 61, 61, 3.5, 4.0);
    expect(seg!.left).toBe(0 + 5 * 25 + 4); // onset at beat 3.5
    expect(seg!.right).toBe(0 + 5 * 25 + 25);
  });

  it('keeps the measure edges when there is no onset geometry at all', () => {
    // The case the old fallback was written for, and the only one it fits:
    // rects unavailable, so there is nothing to refine from.
    const geo = { measures: geometry().measures, notes: [] };
    const [seg] = computeBracketSegments(geo, 61, 62, 4.5, 1.0);
    expect(seg!.left).toBe(0);
    expect(seg!.right).toBe(400);
  });

  it('drops a bar that contributes nothing rather than drawing it empty', () => {
    // beat_end on the opening barline of a bar that is alone on its system
    // would leave a zero-width segment; it should not be emitted.
    const geo = geometry();
    geo.measures.set(62, { left: 200, right: 400, systemTop: 120, systemBottom: 200 });
    const segs = computeBracketSegments(geo, 62, 62, 1.0, 1.0);
    expect(segs.every((s) => s.right - s.left > 0)).toBe(true);
  });
});
