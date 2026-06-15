# Tie-loss Investigation — K. 279 mvt 1 (Component 9 · Step 7)

**Date:** 2026-06-16
**Status:** Root-caused and fixed (normalizer cross-barline tie-completion pass, ADR-026)

Sibling of the accidentals and clefs investigations in this folder — same file,
same hand-crossing development section, a different symptom.

## Symptom

A B♭ in the treble staff tied across the barline (mm. 12→13 and 13→14) loses its
tie in the Doppia render, and the continuation note then renders — and plays — as
a B♮. Two similar F♮ ties at mm. 67→68 render correctly.

## Hypothesis tested and disproved

Step 7's brief suspected the heavy ADR-021/022 accidental normalization (73
strips on this file, including `accid.ges` strips on B♭s in mm. 12–14) was
interacting with tie continuation. **It is not.** The normalizer never touches
ties (confirmed in code and in `mei-ingest-normalization.md`), and the retained
original and normalized output are byte-identical across these measures. The
accidental on the continuation is a *consequence* of the lost tie, not the cause.

## Root cause

The defect is upstream, in the MuseScore-to-MEI export. Grepping every `<tie>` in
the movement:

- The two failing ties are encoded `<tie startid="#…"/>` with **no `@endid`**
  (and no `@tstamp2`) — lines 1194 and 1303 of the retained MEI. They are the
  **only** two endpoint-less ties in the file; all 17 others — including the F♮
  at m. 67→68 — carry both `@startid` and `@endid`.
- Verovio cannot render a control event with only one endpoint, so the tie
  silently disappears.
- The continuation note carries an *empty* `<accid/>` (no `@accid`, no
  `accid.ges`) because the engraving relied on the tie to carry the B♭. With the
  tie gone, Verovio applies the default for the pitch class — B♮ in C major — in
  both SVG and MIDI.

### Trace

| Tie (xml:id) | Start note (pname/oct, staff/layer) | Resolved continuation (first match, next bar, same staff/layer) |
|---|---|---|
| `wa0ma2t` (L1194) | `t11bbk9u` — B♭ oct 4, staff 1 / layer 1, `@accid="f"` | `twtc7h8` (m. 13, empty `<accid/>`) |
| `omoukg4` (L1303) | `l1xot75b` — B♭ oct 4, staff 1 / layer 1, `@accid="f"` | `b1sra9lf` (m. 14, empty `<accid/>`) |

Note m. 13 also contains a *later* explicit B♮ (`e14jps2o`); taking the **first**
matching `(pname, oct)` in document order correctly selects the beat-1 tied note,
not that decoy.

## Fix

Normalizer **pass 8 — cross-barline tie completion**
(`_complete_cross_barline_ties`): for each `<tie>` with `@startid` but no
`@endid`/`@tstamp2`, set `@endid` to the first same-`(pname, oct)` note in the
following measure's matching staff/layer, and propagate the start note's
alteration onto the continuation as `accid.ges` (so the pitch/MIDI is B♭ with no
printed accidental). Pass 9 (accidentals) is made tie-aware so it never strips a
tied continuation's `accid.ges`. See ADR-026 and
`mei-ingest-normalization.md` §8.

## Verification (this file)

Running the updated normalizer on `k279-mvt1-original.mei`: exactly the two ties
gain `@endid` (`wa0ma2t`→`#twtc7h8`, `omoukg4`→`#b1sra9lf`), each continuation
gains `accid.ges="f"`, zero tie warnings, and the two continuations' `accid.ges`
survives the accidental pass. Second pass is byte-identical (idempotent). The F♮
ties at mm. 67–68 are untouched. Unit coverage:
`TestCrossBarlineTieCompletion` in `backend/tests/unit/test_mei_normalizer.py`.

Corpus-wide application (re-ingestion of the existing 15 movements) is Step 9.
