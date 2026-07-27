/**
 * MEI text parsing utilities for extracting score metadata.
 *
 * These populate the fragment summary's `key` and `meter` fields, which the
 * FragmentSummary schema requires and which per fragment-schema.md reflect the
 * notated key and meter of the source movement.
 *
 * **Since M6 (Component 11 Step 10) the tagging tool prefers the movement
 * record** (`fetchMeiUrl()` returns `key_signature` / `meter`) and uses these
 * only as a fallback. Two reasons, both learned the hard way: the corpus MEI
 * puts key and meter in `<keySig>` / `<meterSig>` children rather than
 * `<scoreDef>` attributes, and reading only the latter stamped every fragment
 * "C major / 4/4"; and the MEI records no *mode* at all, so a minor key cannot
 * be recovered from the notation however carefully it is parsed.
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
  '0': 'C',
  '1s': 'G',
  '2s': 'D',
  '3s': 'A',
  '4s': 'E',
  '5s': 'B',
  '6s': 'F♯',
  '7s': 'C♯',
  '1f': 'F',
  '2f': 'B♭',
  '3f': 'E♭',
  '4f': 'A♭',
  '5f': 'D♭',
  '6f': 'G♭',
  '7f': 'C♭',
};

/**
 * Map from MEI key.sig attribute value to minor key tonic name.
 */
const KEY_SIG_MINOR: Record<string, string> = {
  '0': 'A',
  '1s': 'E',
  '2s': 'B',
  '3s': 'F♯',
  '4s': 'C♯',
  '5s': 'G♯',
  '6s': 'D♯',
  '7s': 'A♯',
  '1f': 'D',
  '2f': 'G',
  '3f': 'C',
  '4f': 'F',
  '5f': 'B♭',
  '6f': 'E♭',
  '7f': 'A♭',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the notated key as a human-readable string from MEI text.
 *
 * **This is a fallback, not the source of truth.** Prefer the movement record's
 * `key_signature`, which `fetchMeiUrl()` returns. The reason is a hard limit of
 * the encoding, not a preference: the corpus MEI writes `<keySig sig="4f"/>`
 * with **no mode attribute anywhere**, and 4 flats is A♭ major and F minor
 * alike. Mode is unrecoverable here, so this always answers "major" and is
 * wrong for every minor movement (M6, Component 11 Step 10).
 *
 * Probe order, mirroring parseMeiMeterParts:
 *   1. key.sig / key.mode attributes on <scoreDef> or <staffDef>
 *   2. sig / mode attributes on the first <keySig> child — what this corpus has
 * Falls back to "C major" when nothing is found.
 *
 * @example parseMeiKey(meiText) → "G major", "B♭ minor", "C major"
 */
export function parseMeiKey(meiText: string): string {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');

  let sig: string | null = null;
  let mode: string | null = null;

  for (const tag of ['scoreDef', 'staffDef']) {
    const els = doc.getElementsByTagName(tag);
    for (let i = 0; i < els.length && sig === null; i++) {
      const s = els[i]!.getAttribute('key.sig');
      if (s) {
        sig = s;
        mode = els[i]!.getAttribute('key.mode');
      }
    }
    if (sig !== null) break;
  }

  if (sig === null) {
    const keySigs = doc.getElementsByTagName('keySig');
    for (let i = 0; i < keySigs.length && sig === null; i++) {
      const s = keySigs[i]!.getAttribute('sig');
      if (s) {
        sig = s;
        mode = keySigs[i]!.getAttribute('mode');
      }
    }
  }

  const resolvedMode = (mode ?? 'major').toLowerCase();
  const table = resolvedMode === 'minor' ? KEY_SIG_MINOR : KEY_SIG_MAJOR;
  const root = table[sig ?? '0'] ?? 'C';

  return `${root} ${resolvedMode}`;
}

/**
 * Extract the notated meter as a "count/unit" string from MEI text.
 *
 * Delegates to parseMeiMeterParts, which already probes both encodings
 * (meter.count/meter.unit attributes, then <meterSig> children). Reading only
 * the first <scoreDef>'s attributes — as this did before M6 — always returned
 * "4/4" for this corpus, whose <scoreDef> carries no attributes at all.
 *
 * @example parseMeiMeter(meiText) → "4/4", "3/4", "6/8"
 */
export function parseMeiMeter(meiText: string): string {
  const [count, unit] = parseMeiMeterParts(meiText);
  return `${count}/${unit}`;
}

/**
 * Extract the meter in force at one measure, as a "count/unit" string.
 *
 * A fragment sits at one place in a movement, so the meter it should record is
 * the one sounding *there* — not the movement's opening signature. They differ
 * only where a movement changes meter mid-piece (two in this corpus: K331/i at
 * mc 111, K284/iii at mc 248), but a fragment tagged after such a change would
 * otherwise be labelled with a meter its own bars are not in (Track M18).
 *
 * `mc` is the ADR-015 1-based document-order measure index. The scan walks
 * measures in that order carrying the meter forward, because the normalizer
 * writes a `<meterSig>` only where the meter *changes*, never restating it in
 * the measures that follow. Mirrors `services.mei_meter.meter_at_mc` on the
 * backend, which is what the repair script and corpus prep use.
 *
 * @example parseMeiMeterAtMc(meiText, 120) → "4/4"
 */
export function parseMeiMeterAtMc(meiText: string, mc: number): string {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const [count, unit] = parseMeiMeterParts(meiText);
  let current: [number, number] = [count, unit];

  const measures = doc.getElementsByTagName('measure');
  const limit = Math.min(mc, measures.length);
  for (let i = 0; i < limit; i++) {
    const sig = measures[i]!.querySelector('meterSig');
    if (!sig) continue;
    const c = parseInt(sig.getAttribute('count') ?? '', 10);
    const u = parseInt(sig.getAttribute('unit') ?? '', 10);
    if (!isNaN(c) && !isNaN(u) && c > 0 && u > 0) current = [c, u];
  }
  return `${current[0]}/${current[1]}`;
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
      const unit = parseInt(els[i]!.getAttribute('meter.unit') ?? '', 10);
      if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
        return [count, unit];
      }
    }
  }

  const sigs = doc.getElementsByTagName('meterSig');
  for (let i = 0; i < sigs.length; i++) {
    const count = parseInt(sigs[i]!.getAttribute('count') ?? '', 10);
    const unit = parseInt(sigs[i]!.getAttribute('unit') ?? '', 10);
    if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
      return [count, unit];
    }
  }

  return [4, 4];
}
