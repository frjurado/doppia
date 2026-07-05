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

### Spot-check tool and first real-data run (2026-06-28)

`scripts/clef_audit.py` runs the real prep clef path (`.mscx → .mxl → .mei →
recover_measure_start_clefs`, then the ingest normalizer) on a single movement
and reports the A1/A2/A3 symptoms directly — no DB ingest, no SVG render:

```
backend/.venv/Scripts/python.exe scripts/clef_audit.py \
  --mscx ~/src/mozart_piano_sonatas/MS3/K331-2.mscx
```

First run on the cloned DCML **K331/ii** (the minuet+trio): **PASS** — 14 clefs
(12 measure + 2 initial `staffDef`), **0 recovered**, no double-clef, both voices
clef-consistent at the one multi-voice bar (m. 18). Two things this established:

- The current DCML Verovio output for K331/ii is a **single** MEI `<section>`
  with continuous numbering and **no** MuseScore section breaks, and recovery
  injected nothing (the export already carried every real measure-start change).
  So the **A3 section-aware branch was not exercised by this file** — its
  trio-vanish path is covered only by the synthetic unit test. A source that
  produces multiple MEI sections + matching `.mscx` section breaks is needed to
  exercise it on real data; flag this for the Item 6 re-verification.
- The pre-normalization prep output shows the m. 18 second voice as a `<clef
  sameas>` with no shape/line (it reads `?/?` under `--no-normalize`); Pass 10
  resolves it to `F/4`, which is why the audit defaults to running the
  normalizer.

## Double-clef root-cause investigation (2026-07-05 · full corpus)

Preparing the remaining 39 movements surfaced 10 more A1b (cross-layer
double-clef) occurrences; instead of per-case fixes, all 15 known occurrences
(the 5 fixed above + the 10 new) were traced through every pipeline stage.
Three synthetic Verovio 6.1.0 probes overturned two assumptions this
investigation had baked into Pass 10 and the recovery:

1. An **unresolved `<clef sameas>` positions its voice's notes** while drawing
   no glyph. The "secondary issue" above called it an empty clef group and
   "fixed it for robustness" by resolving to explicit shape/line — but the
   positioning was never tested, and wholesale resolution is exactly what
   turned silent restatements into drawn doubles (the entire A1b cluster).
2. **Cross-measure clef state is staff-scoped** — one end-of-measure courtesy
   in any layer re-clefs every voice of the next measure. The A2 "inject into
   every layer" fix above is correct only for *leading* (within-measure)
   placement; for the D3 trailing courtesy it over-encoded, and at unequal
   layer-end ticks our own injections drew the K570/ii + K570/iii doubles.
3. A `_ppq_per_quarter` inference bug (a dotted first note poisoned the
   ticks-per-quarter estimate) had silently disabled space-split clef
   alignment in K333/iii.

Resolution (ADR-031 amendment, 2026-07-05; `mei-ingest-normalization.md` §10):
Pass 10 keeps restatements silent with exactly one drawn bearer per change
event, bar-end courtesy groups keep only their latest copy, the recovery
injects a single trailing courtesy (leading, per-voice, after repeat
barlines), and a safety invariant (`CLEF_SAMEAS_DANGLING`) guarantees the
original missing-clef symptom can never return silently. `clef_audit.py`
counts only *drawn* clefs for A1/A1b and adds A4 (dangling restatement).
The K279/i m. 5/9/91 measure-start recoveries this file documents are
single-voice trailing injections and are unaffected.
