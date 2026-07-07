/**
 * Unit tests for the stage beat-pair normalization in the ScoreViewer submit
 * payload (cross-barline and measure-aligned outer-edge stages).
 *
 * Regression for: a stage crossing a barline (m.14 beat 3 → m.15 beat 2) was
 * stored with both beats nulled because the old guard required
 * beatStart < beatEnd — true only within a single measure. The stage then
 * rendered as whole bars and overlapped its neighbours.
 */

import { describe, expect, it } from 'vitest';
import { measureExclusiveEndBeat, normalizeStageBeats } from '../stageBeats';
import type { BeatGhostEntry, GhostLayer } from '../ghosts';

const MEI_3_4 =
  '<mei><music><body><mdiv><score><scoreDef meter.count="3" meter.unit="4"/></score></mdiv></body></music></mei>';

describe('normalizeStageBeats', () => {
  // measureEnd = 4 (3/4 → numBeats 3 + 1).
  const END = 4;

  it('keeps a cross-bar pair where beatStart > beatEnd (the Predominant case)', () => {
    // m.14 beat 3 → m.15 beat 2: beats are 1-indexed per measure.
    expect(normalizeStageBeats(3.0, 2.0, 14, 15, END)).toEqual({
      beat_start: 3.0,
      beat_end: 2.0,
    });
  });

  it('keeps a valid single-bar pair', () => {
    expect(normalizeStageBeats(1.0, 2.5, 14, 14, END)).toEqual({
      beat_start: 1.0,
      beat_end: 2.5,
    });
  });

  it('leaves a measure-level stage (both null) untouched', () => {
    expect(normalizeStageBeats(null, null, 14, 16, END)).toEqual({
      beat_start: null,
      beat_end: null,
    });
  });

  it('fills a measure-aligned start (null beatStart → 1.0) instead of nulling', () => {
    // First stage of a measure-aligned fragment ending mid-measure.
    expect(normalizeStageBeats(null, 3.0, 14, 14, END)).toEqual({
      beat_start: 1.0,
      beat_end: 3.0,
    });
  });

  it('fills a measure-aligned end (null beatEnd → measure end) instead of nulling', () => {
    // Last stage starting mid-measure and running to the bar end.
    expect(normalizeStageBeats(2.0, null, 16, 16, END)).toEqual({
      beat_start: 2.0,
      beat_end: END,
    });
  });

  it('falls back to measure-level for a degenerate single-bar pair', () => {
    // Empty/inverted within one measure → not representable; store measure-level.
    expect(normalizeStageBeats(3.0, 2.0, 14, 14, END)).toEqual({
      beat_start: null,
      beat_end: null,
    });
  });
});

describe('measureExclusiveEndBeat', () => {
  function layerWithBeats(
    entries: Array<{ measureKey: string; endFloat: number }>,
  ): GhostLayer {
    const beatIndex = new Map<number, BeatGhostEntry>();
    entries.forEach((e, i) => {
      beatIndex.set(i, { measureKey: e.measureKey, endFloat: e.endFloat } as BeatGhostEntry);
    });
    return { measureIndex: new Map(), beatIndex, subBeatIndex: new Map() } as unknown as GhostLayer;
  }

  it('returns the max endFloat among the end measure key (per-measure accurate)', () => {
    const layer = layerWithBeats([
      { measureKey: 'm15', endFloat: 2.0 },
      { measureKey: 'm15', endFloat: 4.0 }, // last beat of a 3/4 bar → exclusive end 4
      { measureKey: 'm16', endFloat: 3.0 },
    ]);
    expect(measureExclusiveEndBeat(layer, 'm15', MEI_3_4)).toBe(4.0);
  });

  it('falls back to the global meter (numBeats + 1) when no layer', () => {
    expect(measureExclusiveEndBeat(null, 'm15', MEI_3_4)).toBe(4); // 3/4 → 3 + 1
  });

  it('falls back to the global meter when the key has no beat entries', () => {
    const layer = layerWithBeats([{ measureKey: 'm99', endFloat: 5.0 }]);
    expect(measureExclusiveEndBeat(layer, 'm15', MEI_3_4)).toBe(4);
  });
});
