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

## Staging read-through follow-up (2026-06-28 · Component 9 Band 1 · A1–A3)

The original investigation validated only the *missing-clef* direction on a
single-voice reduction. The full staging read-through surfaced three regressions
the fixture set did not cover (issues A1–A3 in
`docs/reports/component-9-reports/staging-readthrough-issues.md`); all three are
fixed in `recover_measure_start_clefs`:

- **A1 — double-clef glyph.** The idempotency guard skipped injection only when a
  clef was the layer's *first child*. A genuine measure-start change can sit
  mid-layer (after a `<beam>`, as at K279/i m. 86), so the guard missed it and a
  second identical `<clef>` was inserted at position 0 → two glyphs. The guard is
  widened to skip when an *equivalent* clef already exists anywhere in the layer
  (descendant axis), in addition to the leading-clef check.
- **A2 — clef affects voice 1 only.** The recovered clef was injected into
  `staff.find("layer")` (the first layer only); the second voice stayed on the
  previous clef. It is now injected into every `<layer>` of the staff, each with a
  distinct `xml:id`.
- **A3 — trio clefs vanish.** Flat `.//measure` document-order indexing mis-placed
  clefs when the `.mscx`↔MEI measure counts diverged across a section boundary
  (K331/ii minuet→trio). Indexing is now section-aware: when `.mscx` section
  breaks and MEI top-level `<section>` counts agree, the index is resolved within
  its section; otherwise it falls back to flat indexing **and logs a diagnostic**
  so a silent trio-clef drop becomes visible.

### Render spot-check list (extend before re-verification — Band 1 Item 6)

The earlier list covered single-voice K279/i. Add these multi-voice and
multi-section measures (from the A-cluster table) to the render check when the 15
are re-verified:

- **Double-clef (A1):** 279/i m. 86 · 279/iii m. 72 · 283/ii m. 19, m. 25 ·
  331/i m. 98 · 331/ii m. 6 · 332/iii m. 210 — confirm a *single* clef glyph.
- **Per-voice scope (A2):** 279/iii m. 110 · 280/i m. 46 · 280/ii m. 24 ·
  331/ii m. 24–25 — confirm *both* voices read on the new clef.
- **Multi-section (A3):** 331/ii Trio (after m. 48) — confirm the second-staff
  clef changes reappear in the trio.

Final on-staging verification against the real K331/ii source is Band 1 Item 6
(re-run the normalizer + `mc`-stability check); the unit fixtures here exercise
the logic synthetically because the DCML source is not checked into the repo.
