/**
 * MEI text parsing utilities for extracting score metadata.
 *
 * Used at submission time (Step 18) to populate the fragment summary's `key`
 * and `meter` fields from the loaded MEI, which are required by the
 * FragmentSummary schema. Reads the initial <scoreDef> only — per
 * fragment-schema.md, these fields reflect the notated (high-reliability) key
 * and meter of the source movement.
 *
 * Score title (composer, work title, movement) is sourced from the DB via the
 * mei-url API response and lives in services/scoreApi.ts — not parsed here.
 *
 * References: fragment-schema.md §"The summary JSONB schema", ADR-015.
 */

// ---------------------------------------------------------------------------
// Key-signature lookup
// ---------------------------------------------------------------------------

/**
 * Map from MEI key.sig attribute value to major key tonic name.
 * Uses Unicode flat/sharp glyphs to match the transposeKey display convention.
 */
const KEY_SIG_MAJOR: Record<string, string> = {
  '0':  'C',
  '1s': 'G',  '2s': 'D',  '3s': 'A',  '4s': 'E',  '5s': 'B',  '6s': 'F♯', '7s': 'C♯',
  '1f': 'F',  '2f': 'B♭', '3f': 'E♭', '4f': 'A♭', '5f': 'D♭', '6f': 'G♭', '7f': 'C♭',
};

/**
 * Map from MEI key.sig attribute value to minor key tonic name.
 */
const KEY_SIG_MINOR: Record<string, string> = {
  '0':  'A',
  '1s': 'E',  '2s': 'B',  '3s': 'F♯', '4s': 'C♯', '5s': 'G♯', '6s': 'D♯', '7s': 'A♯',
  '1f': 'D',  '2f': 'G',  '3f': 'C',  '4f': 'F',  '5f': 'B♭', '6f': 'E♭', '7f': 'A♭',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the notated key as a human-readable string from MEI text.
 *
 * Reads the first <scoreDef> element's key.sig and key.mode attributes.
 * Falls back to "C major" when the attribute is absent or unrecognised.
 *
 * @example parseMeiKey(meiText) → "G major", "B♭ minor", "C major"
 */
export function parseMeiKey(meiText: string): string {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const scoreDefs = doc.getElementsByTagName('scoreDef');
  const scoreDef = scoreDefs.length > 0 ? scoreDefs[0]! : null;
  if (!scoreDef) return 'C major';

  const sig  = scoreDef.getAttribute('key.sig')  ?? '0';
  const mode = (scoreDef.getAttribute('key.mode') ?? 'major').toLowerCase();

  const table = mode === 'minor' ? KEY_SIG_MINOR : KEY_SIG_MAJOR;
  const root  = table[sig] ?? 'C';

  return `${root} ${mode}`;
}

/**
 * Extract the notated meter as a "count/unit" string from MEI text.
 *
 * Reads meter.count and meter.unit from the first <scoreDef>.
 * Falls back to "4/4" when attributes are absent.
 *
 * @example parseMeiMeter(meiText) → "4/4", "3/4", "6/8"
 */
export function parseMeiMeter(meiText: string): string {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const scoreDefs = doc.getElementsByTagName('scoreDef');
  const scoreDef = scoreDefs.length > 0 ? scoreDefs[0]! : null;
  if (!scoreDef) return '4/4';

  const count = scoreDef.getAttribute('meter.count') ?? '4';
  const unit  = scoreDef.getAttribute('meter.unit')  ?? '4';

  return `${count}/${unit}`;
}

/**
 * Extract the notated meter as a numeric pair [beatCount, beatUnit] from MEI text.
 *
 * Mirrors the probe order used by ghosts.ts parseGlobalMeter:
 *   1. meter.count / meter.unit attributes on <scoreDef> or <staffDef>
 *   2. count / unit attributes on the first <meterSig> child
 * Falls back to [4, 4] when nothing is found.
 *
 * @example parseMeiMeterParts(meiText) → [4, 4], [3, 4], [6, 8]
 */
export function parseMeiMeterParts(meiText: string): [number, number] {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');

  for (const tag of ['scoreDef', 'staffDef']) {
    const els = doc.getElementsByTagName(tag);
    for (let i = 0; i < els.length; i++) {
      const count = parseInt(els[i]!.getAttribute('meter.count') ?? '', 10);
      const unit  = parseInt(els[i]!.getAttribute('meter.unit')  ?? '', 10);
      if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
        return [count, unit];
      }
    }
  }

  const sigs = doc.getElementsByTagName('meterSig');
  for (let i = 0; i < sigs.length; i++) {
    const count = parseInt(sigs[i]!.getAttribute('count') ?? '', 10);
    const unit  = parseInt(sigs[i]!.getAttribute('unit')  ?? '', 10);
    if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
      return [count, unit];
    }
  }

  return [4, 4];
}
