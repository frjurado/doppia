/**
 * parseMeiKey / parseMeiMeter — the notated key and meter written into
 * `summary.key` / `summary.meter` on every fragment.
 *
 * Regression origin (M6, Component 11 Step 10): both functions read only the
 * first `<scoreDef>`'s `key.sig` / `meter.count` attributes. The corpus MEI
 * (Verovio 6.x output) puts neither there — `<scoreDef>` carries no attributes
 * at all, and key and meter live in `<keySig>` / `<meterSig>` children of
 * `<staffDef>`. Every parse therefore fell through to its default and stamped
 * every fragment "C major" / "4/4", which was wrong for six of the eight
 * movements carrying fragments.
 *
 * Note the standing limitation these tests pin: the corpus MEI records **no
 * mode**, so a minor key is not recoverable from the notation at all. That is
 * why the tagging tool prefers the movement record and treats this as fallback.
 */

import { describe, expect, it } from 'vitest';
import { parseMeiKey, parseMeiMeter, parseMeiMeterParts } from '../meiParsing';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

/** MEI in the shape the corpus actually has: bare scoreDef, keySig/meterSig children. */
function corpusStyleMei(sig: string, count: number, unit: number): string {
  return `<mei xmlns="${MEI_NS}"><music><body><mdiv><score>
    <scoreDef xml:id="a1">
      <staffGrp>
        <staffDef xml:id="s1" n="1" lines="5">
          <keySig xml:id="k1" sig="${sig}"/>
          <meterSig xml:id="m1" count="${count}" unit="${unit}"/>
        </staffDef>
      </staffGrp>
    </scoreDef>
  </score></mdiv></body></music></mei>`;
}

/** MEI in the older attribute style, which the parsers also have to support. */
function attributeStyleMei(sig: string, mode: string, count: number, unit: number): string {
  return `<mei xmlns="${MEI_NS}"><music><body><mdiv><score>
    <scoreDef xml:id="a1" key.sig="${sig}" key.mode="${mode}"
              meter.count="${count}" meter.unit="${unit}"/>
  </score></mdiv></body></music></mei>`;
}

describe('parseMeiKey', () => {
  it('reads a keySig child — the corpus encoding', () => {
    // 1 flat, no mode → F major. Before the fix this returned "C major".
    expect(parseMeiKey(corpusStyleMei('1f', 3, 4))).toBe('F major');
  });

  it('reads sharp signatures from a keySig child', () => {
    expect(parseMeiKey(corpusStyleMei('3s', 6, 8))).toBe('A major');
  });

  it('still reads the attribute style, mode included', () => {
    expect(parseMeiKey(attributeStyleMei('4f', 'minor', 6, 8))).toBe('F minor');
  });

  it('prefers the attribute style when both are present', () => {
    const mei = `<mei xmlns="${MEI_NS}"><music><body><mdiv><score>
      <scoreDef xml:id="a1" key.sig="2s" key.mode="minor">
        <staffDef xml:id="s1"><keySig xml:id="k1" sig="1f"/></staffDef>
      </scoreDef>
    </score></mdiv></body></music></mei>`;
    expect(parseMeiKey(mei)).toBe('B minor');
  });

  it('cannot recover mode from a keySig child, and says major', () => {
    // The documented limitation, pinned so it is not mistaken for a bug: 4 flats
    // is A♭ major and F minor alike, and the corpus records no mode. K280/ii is
    // really F minor — which is why summary.key comes from the movement record.
    expect(parseMeiKey(corpusStyleMei('4f', 6, 8))).toBe('A♭ major');
  });

  it('falls back to C major when there is no key information at all', () => {
    const mei = `<mei xmlns="${MEI_NS}"><music><body><mdiv><score>
      <scoreDef xml:id="a1"/></score></mdiv></body></music></mei>`;
    expect(parseMeiKey(mei)).toBe('C major');
  });
});

describe('parseMeiMeter', () => {
  it('reads a meterSig child — the corpus encoding', () => {
    // Before the fix this returned "4/4" for every movement in the corpus.
    expect(parseMeiMeter(corpusStyleMei('1f', 3, 4))).toBe('3/4');
    expect(parseMeiMeter(corpusStyleMei('3s', 6, 8))).toBe('6/8');
  });

  it('still reads the attribute style', () => {
    expect(parseMeiMeter(attributeStyleMei('0', 'major', 2, 2))).toBe('2/2');
  });

  it('agrees with parseMeiMeterParts, which was always correct', () => {
    // The two had drifted: parts probed both encodings, parseMeiMeter did not.
    const mei = corpusStyleMei('2f', 12, 8);
    const [count, unit] = parseMeiMeterParts(mei);
    expect(parseMeiMeter(mei)).toBe(`${count}/${unit}`);
  });

  it('falls back to 4/4 when there is no meter information', () => {
    const mei = `<mei xmlns="${MEI_NS}"><music><body><mdiv><score>
      <scoreDef xml:id="a1"/></score></mdiv></body></music></mei>`;
    expect(parseMeiMeter(mei)).toBe('4/4');
  });
});
