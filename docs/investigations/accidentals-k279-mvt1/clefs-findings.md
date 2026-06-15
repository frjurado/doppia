# Clef-rendering Investigation — K. 279 mvt 1 (Component 9 · Step 6)

**Date:** 2026-06-15
**Status:** Root-caused and fixed (corpus-prep recovery + normalizer `sameas` pass)

Sibling of the accidentals investigation in this folder — same file, same
hand-crossing development section (mm. 5–99), a different symptom.

## Symptom

Many bass-staff clef changes visible in MuseScore do not appear in the Doppia
app; others render fine. Francisco's `.mscx`-vs-app comparison established the
rule: **clef changes render if they are mid-measure, but not if they sit at the
start of a measure.**

## Root cause

The corpus pipeline is `.mscx → MusicXML (MuseScore CLI) → MEI (Verovio)`.
Tracing K279-1 through each stage:

- `.mscx` source: all real clef changes present (staff-2 starts: mm. 5, 9, 20,
  30, 48, 52, 54, 56, 62, 91, 92; staff-2 mid: 65, 74, 78, 86, 93; staff-1 mid:
  96, 98).
- **MuseScore MusicXML export (3.6.2 *and* 4, identical): only the mid-measure
  clefs survive.** Every measure-initial clef change is dropped.
- Verovio faithfully converts what MusicXML gives it; the stored MEI lacks the
  ~11 measure-start clefs.

So the loss is in **MuseScore's MusicXML exporter**, not Verovio or the
normalizer. Because MEI `pname`/`oct` are absolute, the affected notes still
render at correct pitch but on the previous clef (ledger-lined, no glyph).

The "weird m90/91" case is explained: a genuine bass-clef change at m91 is
start-of-measure → dropped.

### Secondary issue

One mid-measure clef (m86, voice 6) is exported as `<clef sameas="#…"/>` with no
own shape/line. Verovio 6.1.0 does not resolve `@sameas` and emits an empty clef
group. Cosmetically harmless here (voice 5 shows the same m86 change) but fixed
for robustness.

## Fix

- **Measure-start clef recovery** — `recover_measure_start_clefs` in
  `scripts/prepare_dcml_corpus.py` re-extracts genuine measure-start clef
  changes from the `.mscx` (running-state filtered to drop courtesy-clef
  repeats) and injects them into the MEI. See
  `docs/architecture/corpus-and-analysis-sources.md`.
- **`sameas` resolution** — normalizer Pass 10 rewrites `<clef sameas>` to
  explicit shape/line. See `docs/architecture/mei-ingest-normalization.md` §10.

## Verification (this file)

Running the real pipeline on K279-1: extraction yields exactly the staff-2 list
above; recovery raises the MEI clef count 10 → 21; after recovery + normalize,
**0 empty clef groups** remain and every clef change renders a glyph. Injecting
clefs leaves measure count and document order unchanged → no `mc` drift.
