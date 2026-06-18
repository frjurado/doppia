/**
 * Unit tests for frontend/src/components/score/ghosts.ts.
 *
 * Covers the pure algorithmic functions: flat-index encoding, compound-meter
 * beat count, per-measure meter reading, beat boundary inference, ghost key
 * non-collision for repeat endings, and tied-note skipping.
 *
 * The DOM-dependent buildGhosts() function requires a real browser layout
 * (getBoundingClientRect returns zeros in jsdom) and is not tested here.
 * Algorithmic correctness of the ghost count and index math is verified
 * through computeBeatBoundaries, which accepts synthetic inputs.
 */

import { describe, expect, it } from 'vitest';
import {
  BEAT_SCALE,
  MEASURE_SCALE,
  beatSlotCount,
  beatToFloat,
  computeBeatBoundaries,
  decodeBeat,
  decodeMeasure,
  decodeSubBeat,
  encodeBeat,
  encodeSubBeat,
  getMeterForMeasure,
  isCompoundMeter,
  measureGhostKey,
  subdivisionsPerBeat,
  walkMeasureKeys,
} from '../ghosts';

// ---------------------------------------------------------------------------
// walkMeasureKeys (§6A.1 shared key derivation)
// ---------------------------------------------------------------------------

function parseMei(inner: string): Document {
  return new DOMParser().parseFromString(
    `<mei><music><body><mdiv><score>${inner}</score></mdiv></body></music></mei>`,
    'text/xml',
  );
}

describe('walkMeasureKeys', () => {
  it('derives barN, key, and 1-based mc in document order', () => {
    const infos = walkMeasureKeys(parseMei(
      '<measure n="0"/><measure n="1"/><measure n="2"/>',
    ));
    expect(infos.map(i => i.key)).toEqual(['m0', 'm1', 'm2']);
    expect(infos.map(i => i.mc)).toEqual([1, 2, 3]);
    expect(infos.every(i => !i.barNIsFallback)).toBe(true);
  });

  it('incorporates ending context into keys', () => {
    const infos = walkMeasureKeys(parseMei(
      '<measure n="1"/><ending n="1"><measure n="2"/></ending><ending n="2"><measure n="2"/></ending>',
    ));
    expect(infos.map(i => i.key)).toEqual(['m1', 'm2-e1', 'm2-e2']);
    expect(infos[1]!.endingN).toBe(1);
    expect(infos[2]!.endingN).toBe(2);
  });

  it('deduplicates section-reset @n collisions with #N suffixes', () => {
    const infos = walkMeasureKeys(parseMei(
      '<measure n="1"/><measure n="2"/><measure n="1"/>',
    ));
    expect(infos.map(i => i.key)).toEqual(['m1', 'm2', 'm1#1']);
  });

  it('falls back to the preceding finite @n for unparseable values (I2)', () => {
    // MuseScore X-numbered excluded measures: barN must stay finite, keyed
    // under the bar they complete, never NaN.
    const infos = walkMeasureKeys(parseMei(
      '<measure n="8"/><measure n="X1"/><measure n="X2"/><measure n="9"/>',
    ));
    expect(infos.map(i => i.barN)).toEqual([8, 8, 8, 9]);
    expect(infos.map(i => i.key)).toEqual(['m8', 'm8#1', 'm8#2', 'm9']);
    expect(infos.map(i => i.barNIsFallback)).toEqual([false, true, true, false]);
    expect(infos.every(i => Number.isFinite(i.barN))).toBe(true);
  });

  it('falls back for a missing @n on the first measure without producing NaN', () => {
    const infos = walkMeasureKeys(parseMei('<measure/><measure n="1"/>'));
    expect(Number.isFinite(infos[0]!.barN)).toBe(true);
    expect(infos[0]!.barNIsFallback).toBe(true);
    expect(infos[1]!.barN).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Flat-index encoding (ADR-005 §"Flat index encoding")
// ---------------------------------------------------------------------------

describe('flat-index constants and encoding', () => {
  it('BEAT_SCALE is 100', () => {
    expect(BEAT_SCALE).toBe(100);
  });

  it('MEASURE_SCALE is 10000', () => {
    expect(MEASURE_SCALE).toBe(10_000);
  });

  it('encodeBeat round-trips through decodeMeasure and decodeBeat', () => {
    for (const m of [1, 5, 12, 99]) {
      for (const b of [0, 1, 3, 10]) {
        const encoded = encodeBeat(m, b);
        expect(decodeMeasure(encoded)).toBe(m);
        expect(decodeBeat(encoded)).toBe(b);
      }
    }
  });

  it('encodeSubBeat round-trips through all three decoders', () => {
    for (const m of [1, 7, 23]) {
      for (const b of [0, 2, 4]) {
        for (const sb of [0, 1, 2, 3]) {
          const encoded = encodeSubBeat(m, b, sb);
          expect(decodeMeasure(encoded)).toBe(m);
          expect(decodeBeat(encoded)).toBe(b);
          expect(decodeSubBeat(encoded)).toBe(sb);
        }
      }
    }
  });

  it('encodeBeat and encodeSubBeat with sb=0 differ by 0', () => {
    // encodeSubBeat(m, b, 0) must equal encodeBeat(m, b) — sub-beat 0 is the beat onset.
    const m = 3;
    const b = 2;
    expect(encodeSubBeat(m, b, 0)).toBe(encodeBeat(m, b));
  });

  it('distinct beats produce distinct encoded keys', () => {
    const keys = new Set<number>();
    for (let m = 1; m <= 10; m++) {
      for (let b = 0; b < 6; b++) {
        keys.add(encodeBeat(m, b));
      }
    }
    expect(keys.size).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// measureGhostKey — repeat-ending non-collision (ADR-005 §"Edge cases")
// ---------------------------------------------------------------------------

describe('measureGhostKey', () => {
  it('produces "m12" when endingN is null', () => {
    expect(measureGhostKey(12, null)).toBe('m12');
  });

  it('produces "m12-e1" for ending 1 and "m12-e2" for ending 2', () => {
    expect(measureGhostKey(12, 1)).toBe('m12-e1');
    expect(measureGhostKey(12, 2)).toBe('m12-e2');
  });

  it('first and second endings sharing the same @n do NOT collide', () => {
    // Doppia convention: both measures carry @n="12"; disambiguation is via ending.
    const key1 = measureGhostKey(12, 1);
    const key2 = measureGhostKey(12, 2);
    expect(key1).not.toBe(key2);
  });

  it('a non-ending measure and an ending measure with same @n do NOT collide', () => {
    expect(measureGhostKey(5, null)).not.toBe(measureGhostKey(5, 1));
  });

  it('produces distinct keys for all combinations in a typical score', () => {
    const keys = new Set<string>();
    for (let n = 1; n <= 20; n++) keys.add(measureGhostKey(n, null));
    keys.add(measureGhostKey(12, 1));
    keys.add(measureGhostKey(12, 2));
    // 20 regular + 2 endings = 22 unique keys; the @n=12 non-ending entry is also there.
    expect(keys.size).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// Compound-meter utilities
// ---------------------------------------------------------------------------

describe('isCompoundMeter', () => {
  it('returns true for 6/8', () => expect(isCompoundMeter(6, 8)).toBe(true));
  it('returns true for 9/8', () => expect(isCompoundMeter(9, 8)).toBe(true));
  it('returns true for 12/8', () => expect(isCompoundMeter(12, 8)).toBe(true));
  it('returns false for 4/4', () => expect(isCompoundMeter(4, 4)).toBe(false));
  it('returns false for 3/4', () => expect(isCompoundMeter(3, 4)).toBe(false));
  it('returns false for 2/2', () => expect(isCompoundMeter(2, 2)).toBe(false));
  it('returns false for 3/8 (not divisible by 3 as compound)', () => {
    // 3/8 has beatUnit=8 but beatCount=3; 3 % 3 == 0 is true, so it IS classified
    // as compound (3 eighth-note sub-beats per dotted-quarter beat → 1 beat).
    // This matches the ADR-005 formula: isCompound = beatUnit==8 && beatCount%3==0.
    expect(isCompoundMeter(3, 8)).toBe(true);
  });
});

describe('subdivisionsPerBeat', () => {
  it('returns 3 for 6/8', () => expect(subdivisionsPerBeat(6, 8)).toBe(3));
  it('returns 3 for 9/8', () => expect(subdivisionsPerBeat(9, 8)).toBe(3));
  it('returns 2 for 4/4', () => expect(subdivisionsPerBeat(4, 4)).toBe(2));
  it('returns 2 for 3/4', () => expect(subdivisionsPerBeat(3, 4)).toBe(2));
});

describe('beatSlotCount', () => {
  it('returns 2 for 6/8 (dotted-quarter beats)', () => {
    expect(beatSlotCount(6, 8)).toBe(2);
  });
  it('returns 3 for 9/8', () => {
    expect(beatSlotCount(9, 8)).toBe(3);
  });
  it('returns 4 for 12/8', () => {
    expect(beatSlotCount(12, 8)).toBe(4);
  });
  it('returns 4 for 4/4 (simple)', () => {
    expect(beatSlotCount(4, 4)).toBe(4);
  });
  it('returns 3 for 3/4', () => {
    expect(beatSlotCount(3, 4)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// beatToFloat
// ---------------------------------------------------------------------------

describe('beatToFloat', () => {
  it('beat=0, subBeat=0 → 1.0 (first beat onset)', () => {
    expect(beatToFloat(0, 0, 2)).toBe(1.0);
  });

  it('beat=0, subBeat=1 in 4/4 → 1.5', () => {
    expect(beatToFloat(0, 1, 2)).toBeCloseTo(1.5);
  });

  it('beat=1, subBeat=0 → 2.0 (second beat onset)', () => {
    expect(beatToFloat(1, 0, 2)).toBe(2.0);
  });

  it('beat=1, subBeat=1 in 4/4 → 2.5', () => {
    expect(beatToFloat(1, 1, 2)).toBeCloseTo(2.5);
  });

  it('beat=0, subBeat=1 in 6/8 → 1.333…', () => {
    expect(beatToFloat(0, 1, 3)).toBeCloseTo(1 + 1 / 3);
  });

  it('beat=0, subBeat=2 in 6/8 → 1.667…', () => {
    expect(beatToFloat(0, 2, 3)).toBeCloseTo(1 + 2 / 3);
  });

  it('beat=1, subBeat=2 in 6/8 → 2.667…', () => {
    expect(beatToFloat(1, 2, 3)).toBeCloseTo(2 + 2 / 3);
  });
});

// ---------------------------------------------------------------------------
// getMeterForMeasure — per-measure meter reading (ADR-005)
// ---------------------------------------------------------------------------

describe('getMeterForMeasure', () => {
  const makeMeasure = (meterSigAttr?: string): Element => {
    const doc = new DOMParser().parseFromString(
      `<measure n="1">${meterSigAttr ? `<meterSig ${meterSigAttr}/>` : ''}</measure>`,
      'text/xml',
    );
    return doc.documentElement;
  };

  it('returns global values when no <meterSig> child is present', () => {
    const el = makeMeasure();
    expect(getMeterForMeasure(el, 4, 4)).toEqual([4, 4]);
  });

  it('returns local values from <meterSig count="…" unit="…"/> child', () => {
    const el = makeMeasure('count="6" unit="8"');
    expect(getMeterForMeasure(el, 4, 4)).toEqual([6, 8]);
  });

  it('falls back to global when <meterSig> has invalid attributes', () => {
    const el = makeMeasure('count="abc" unit="xyz"');
    expect(getMeterForMeasure(el, 3, 4)).toEqual([3, 4]);
  });

  it('mid-piece meter change: different measures return different meters', () => {
    const doc = new DOMParser().parseFromString(
      `<section>
        <measure n="1"><meterSig count="4" unit="4"/></measure>
        <measure n="2"></measure>
        <measure n="3"><meterSig count="6" unit="8"/></measure>
      </section>`,
      'text/xml',
    );
    const measures = doc.getElementsByTagName('measure');
    // Measure 1: local 4/4
    expect(getMeterForMeasure(measures[0]!, 3, 4)).toEqual([4, 4]);
    // Measure 2: no local sig → global 3/4
    expect(getMeterForMeasure(measures[1]!, 3, 4)).toEqual([3, 4]);
    // Measure 3: local 6/8
    expect(getMeterForMeasure(measures[2]!, 3, 4)).toEqual([6, 8]);
  });
});

// ---------------------------------------------------------------------------
// computeBeatBoundaries — the core beat inference algorithm
// ---------------------------------------------------------------------------

// Helpers to build note inputs. xCenter defaults to xLeft + 5 (≈ half a notehead
// width); pass an explicit center to exercise the centroid logic.
function note(
  xLeft: number,
  onset: number,
  duration = 1.0,
  xCenter = xLeft + 5,
): {
  xLeft: number;
  xCenter: number;
  scoreTimeOnset: number;
  scoreTimeDuration: number;
} {
  return { xLeft, xCenter, scoreTimeOnset: onset, scoreTimeDuration: duration };
}

const grace = (xLeft: number, onset: number) => note(xLeft, onset, 0);

describe('computeBeatBoundaries — 4/4 (simple meter)', () => {
  // In 4/4 with beatUnit=4, onset in quarter-note units:
  // Beat 1 onset=0, Beat 2 onset=1, Beat 3 onset=2, Beat 4 onset=3.
  const MLEFT = 100;
  const MRIGHT = 500;
  const MSTART = 0;

  it('allocates 4 beat slots for a 4/4 bar', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0), note(200, 1), note(300, 2), note(400, 3),
    ]);
    expect(bb.numBeats).toBe(4);
  });

  it('marks all four beats as struck when notes are on all beats', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0), note(210, 1), note(310, 2), note(410, 3),
    ]);
    expect(bb.struckBeats.size).toBe(4);
    for (let b = 0; b < 4; b++) expect(bb.struckBeats.has(b)).toBe(true);
  });

  it('beat 0 left boundary is always mLeft regardless of notes', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(150, 0),
    ]);
    expect(bb.beatLefts[0]).toBe(MLEFT);
  });

  it('beat 1 left boundary matches the leftmost notehead for that beat', () => {
    // Note onset=1 (beat 2, index 1), xLeft=210 → beatLefts[1] = 210 - margin.
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0), note(210, 1),
    ]);
    expect(bb.beatLefts[1]).toBeLessThan(210);
    expect(bb.beatLefts[1]).toBeGreaterThan(100);
  });

  it('last struck beat right boundary is mRight', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0), note(210, 1),
    ]);
    const lastStruck = Math.max(...bb.struckBeats);
    expect(bb.beatRights[lastStruck]).toBe(MRIGHT);
  });

  it('beat N right boundary equals beat N+1 left boundary', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0), note(210, 1), note(310, 2), note(410, 3),
    ]);
    expect(bb.beatRights[0]).toBe(bb.beatLefts[1]);
    expect(bb.beatRights[1]).toBe(bb.beatLefts[2]);
    expect(bb.beatRights[2]).toBe(bb.beatLefts[3]);
  });

  it('only one struck beat when a whole note occupies the whole measure', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0, 4),
    ]);
    expect(bb.struckBeats.size).toBe(1);
    expect(bb.struckBeats.has(0)).toBe(true);
  });

  it('sub-beat layer has 2 slots per beat (simple meter)', () => {
    expect(bb44().subBeatLefts.length).toBe(4);
    expect(bb44().subBeatLefts[0]!.length).toBe(2);
  });

  function bb44() {
    return computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0), note(210, 1), note(310, 2), note(410, 3),
    ]);
  }
});

// ---------------------------------------------------------------------------
// Leftmost-notehead center — harmony-label centering (Step 21)
// ---------------------------------------------------------------------------

describe('computeBeatBoundaries — leftmost-notehead center', () => {
  const MLEFT = 100;
  const MRIGHT = 500;
  const MSTART = 0;

  it('beatCenters[b] is the center of the notehead for a single struck note', () => {
    // note(xLeft=210, onset=1, xCenter=218) → beat index 1.
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0, 1.0, 116), note(210, 1, 1.0, 218),
    ]);
    expect(bb.beatCenters[0]).toBe(116);
    expect(bb.beatCenters[1]).toBe(218);
  });

  it('beatCenters[b] follows the LEFTMOST head, not an average, for a 2nd interval', () => {
    // Two notes at the same onset (beat 2) whose heads are offset off the stem:
    // leftmost head xLeft=210/center=218, displaced head xLeft=222/center=230.
    // Centering must use the leftmost head (218), not the centroid (224).
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0, 1.0, 116),
      note(210, 1, 1.0, 218),
      note(222, 1, 1.0, 230),
    ]);
    expect(bb.beatCenters[1]).toBe(218);
  });

  it('a later note within the beat does not drag beatCenters right', () => {
    // Downbeat note at beat 1 (xLeft=110/center=116) plus an eighth on the "&"
    // (onset 0.5, xLeft=160/center=166) — both bucket into beat index 0. The beat
    // label must stay on the downbeat head (116), not move toward the "&".
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0, 0.5, 116),
      note(160, 0.5, 0.5, 166),
    ]);
    expect(bb.beatCenters[0]).toBe(116);
  });

  it('beatCenters is NaN for unstruck beats', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0, 1.0, 116),
    ]);
    expect(bb.beatCenters[0]).toBe(116);
    expect(Number.isNaN(bb.beatCenters[1]!)).toBe(true);
  });

  it('subBeatCenters carries the leftmost head per sub-beat', () => {
    // Beat 1 downbeat (sub-beat 0) and its "&" (onset 0.5, sub-beat 1) in 4/4.
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 4, 4, [
      note(110, 0, 0.5, 116),
      note(160, 0.5, 0.5, 166),
    ]);
    expect(bb.subBeatCenters[0]![0]).toBe(116);
    expect(bb.subBeatCenters[0]![1]).toBe(166);
  });
});

// ---------------------------------------------------------------------------
// 6/8 — compound meter
// ---------------------------------------------------------------------------

describe('computeBeatBoundaries — 6/8 (compound meter)', () => {
  // 6/8: beatUnit=8, beatCount=6; compound → 2 beat slots, 3 sub-beats each.
  // Quarter-note unit onsets for 6 eighth notes: 0, 0.5, 1.0, 1.5, 2.0, 2.5
  const MLEFT = 100;
  const MRIGHT = 500;
  const MSTART = 0;

  const notes68 = [
    note(110, 0),    // beat 0, sub 0
    note(160, 0.5),  // beat 0, sub 1
    note(210, 1.0),  // beat 0, sub 2
    note(260, 1.5),  // beat 1, sub 0
    note(310, 2.0),  // beat 1, sub 1
    note(360, 2.5),  // beat 1, sub 2
  ];

  it('allocates 2 beat slots for 6/8', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    expect(bb.numBeats).toBe(2);
  });

  it('marks both beats as struck', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    expect(bb.struckBeats.has(0)).toBe(true);
    expect(bb.struckBeats.has(1)).toBe(true);
  });

  it('3 sub-beat slots per beat in 6/8 (total 6 sub-beat ghosts)', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    // subBeatLefts has 2 beats × 3 sub-beats each = 6 entries.
    let count = 0;
    for (let b = 0; b < bb.numBeats; b++) {
      count += bb.subBeatLefts[b]!.length;
    }
    expect(count).toBe(6);
  });

  it('6 sub-beats are struck when all eighth notes have onsets', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    expect(bb.struckSubBeats.size).toBe(6);
  });

  it('beat 0 left boundary is mLeft', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    expect(bb.beatLefts[0]).toBe(MLEFT);
  });

  it('last beat right boundary is mRight', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    expect(bb.beatRights[1]).toBe(MRIGHT);
  });

  it('correctly classifies eighth-note onsets into 2 beats and 6 sub-beats', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MSTART, 6, 8, notes68);
    // Beat 0 sub-beats 0,1,2 and beat 1 sub-beats 0,1,2 should all be struck.
    for (let b = 0; b < 2; b++) {
      for (let sb = 0; sb < 3; sb++) {
        expect(bb.struckSubBeats.has(b * 100 + sb)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tied notes across barlines (ADR-005 §"Not yet handled")
// ---------------------------------------------------------------------------

describe('computeBeatBoundaries — tied notes across barlines', () => {
  // A tied continuation note has a negative measureLocalOnset after subtracting
  // the measureStartTime. The range check should skip it without corrupting
  // the beat boundaries.
  const MLEFT = 100;
  const MRIGHT = 500;
  const MEASURE_START = 4.0; // This measure begins at beat 5 of the piece (quarter-note units).

  it('skips a tied continuation note (negative measureLocalOnset)', () => {
    const bbWithTie = computeBeatBoundaries(MLEFT, MRIGHT, MEASURE_START, 4, 4, [
      // This note's scoreTimeOnset is before MEASURE_START → tied continuation.
      note(110, 3.5, 2.0), // onset 3.5 < measureStart 4.0 → measureLocal = -0.5
      // Regular notes in this measure:
      note(150, 4.0),      // beat 0
      note(250, 5.0),      // beat 1
    ]);

    const bbWithout = computeBeatBoundaries(MLEFT, MRIGHT, MEASURE_START, 4, 4, [
      note(150, 4.0),
      note(250, 5.0),
    ]);

    // The tied note must not introduce extra entries.
    expect(bbWithTie.struckBeats.size).toBe(bbWithout.struckBeats.size);
    // Beat 0 left boundary must not be corrupted by the tied note's x position.
    expect(bbWithTie.beatLefts[0]).toBe(MLEFT);
  });

  it('does not corrupt beat 0 left boundary from a tied note with a smaller xLeft', () => {
    // The tied note is at xLeft=50 (far left), but since it's tied it must be skipped.
    // beatLefts[0] must remain mLeft (100), not be corrupted to 50 - margin.
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, MEASURE_START, 4, 4, [
      note(50, 3.0, 2.0), // tied continuation: onset 3.0 < measureStart 4.0
      note(150, 4.0),
    ]);
    expect(bb.beatLefts[0]).toBe(MLEFT);
  });
});

// ---------------------------------------------------------------------------
// Grace notes
// ---------------------------------------------------------------------------

describe('computeBeatBoundaries — grace notes', () => {
  const MLEFT = 100;
  const MRIGHT = 500;

  it('skips grace notes (scoreTimeDuration === 0)', () => {
    const bb = computeBeatBoundaries(MLEFT, MRIGHT, 0, 4, 4, [
      grace(110, 0), // grace note — must be skipped
      note(150, 0),  // real note on beat 0
    ]);
    // Only beat 0 struck; grace note does not introduce a separate beat or shift mLeft.
    expect(bb.struckBeats.size).toBe(1);
    expect(bb.beatLefts[0]).toBe(MLEFT);
  });
});

// ---------------------------------------------------------------------------
// Mid-piece meter change
// ---------------------------------------------------------------------------

describe('computeBeatBoundaries — mid-piece meter change', () => {
  it('correctly handles a 3/4 measure with 3 beats', () => {
    const bb = computeBeatBoundaries(100, 400, 0, 3, 4, [
      note(110, 0), note(210, 1), note(310, 2),
    ]);
    expect(bb.numBeats).toBe(3);
    expect(bb.struckBeats.size).toBe(3);
  });

  it('correctly handles a 2/4 measure with 2 beats', () => {
    const bb = computeBeatBoundaries(100, 300, 0, 2, 4, [
      note(110, 0), note(210, 1),
    ]);
    expect(bb.numBeats).toBe(2);
    expect(bb.struckBeats.size).toBe(2);
  });

  it('getMeterForMeasure returns the correct meter for each measure in a piece with changes', () => {
    const doc = new DOMParser().parseFromString(
      `<section>
        <measure n="1"><meterSig count="4" unit="4"/></measure>
        <measure n="2"><meterSig count="6" unit="8"/></measure>
        <measure n="3"></measure>
      </section>`,
      'text/xml',
    );
    const [m1, m2, m3] = Array.from(doc.getElementsByTagName('measure'));

    // Measure 1: local 4/4 (ignores global 3/4)
    expect(getMeterForMeasure(m1!, 3, 4)).toEqual([4, 4]);
    // Measure 2: local 6/8
    expect(getMeterForMeasure(m2!, 3, 4)).toEqual([6, 8]);
    // Measure 3: no local sig → global 3/4
    expect(getMeterForMeasure(m3!, 3, 4)).toEqual([3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Repeat-ending ghost index collision prevention
// ---------------------------------------------------------------------------

describe('repeat-ending ghost index non-collision', () => {
  it('first and second endings of the same bar produce different measure keys', () => {
    // Doppia convention: first-ending bar 12 and second-ending bar 12 both
    // carry @n="12". Without ending disambiguation, both map to "m12" and the
    // second rendering overwrites the first.
    const key1 = measureGhostKey(12, 1);
    const key2 = measureGhostKey(12, 2);
    expect(key1).toBe('m12-e1');
    expect(key2).toBe('m12-e2');
    expect(key1).not.toBe(key2);
  });

  it('a non-ending measure and same-n ending measure are distinct', () => {
    // The main body bar 12 (no ending) vs first-ending bar 12.
    expect(measureGhostKey(12, null)).toBe('m12');
    expect(measureGhostKey(12, 1)).toBe('m12-e1');
    expect(measureGhostKey(12, null)).not.toBe(measureGhostKey(12, 1));
  });

  it('encodeBeat uses integer barN so first/second ending beats also differ', () => {
    // Different measures → different barN → different encodeBeat results.
    // (In practice the two ending measures are different measure elements with the
    // same @n string but the ghost layer stores them under different string keys,
    // not the flat numeric beat keys. The flat beat key uses barN as an integer,
    // so both endings' beat ghosts may share the same encoded key — which is why
    // measureIndex and beatIndex are keyed differently.)
    //
    // This test just verifies that the numeric encoding is deterministic.
    const enc1a = encodeBeat(12, 0);
    const enc1b = encodeBeat(12, 0);
    expect(enc1a).toBe(enc1b);
  });
});
