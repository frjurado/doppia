# ADR-032: MusicXML Measure Renumbering for the Verovio Import (Phase B / B2)

**Date:** 2026-06-30 (implemented & verified live 2026-07-01)
**Status:** Accepted — implemented in `scripts/prepare_dcml_corpus.py`
(`renumber_mxl_for_import` + `restore_measure_numbers`); all five gates below
pass on the 2026-07-01 fresh prep + live re-ingest.

---

## Context

K331/movement-2 (Menuetto + Trio) is the epicentre of the Component 9 staging
read-through. Its clef changes are lost or mis-placed in the ingested MEI: the
Trio's measure-start clefs land on the Menuetto bar of the **same number**, and
its mid-measure clefs vanish entirely (Cluster A, items A1-multisection and A3).
The same movement carries the C2 playback symptom (both Trio repeats jump back
to the Menuetto's `|:`) and a new incipit symptom (enormous slurs).

The common factor is **restarting measure numbers**. The Menuetto is numbered
1–48 and the Trio restarts at 1, so the movement carries duplicate `@n` across
the section break (the accepted condition of ADR-015's 2026-06-16 amendment).

### What was proven (offline, 2026-06-30)

Instrumenting the prep on the real `K331-2.mscx`:

- The converted MEI has **14** clefs where the `.mscx` has **22**; the Trio
  clefs (`.mscx` document-order measures 52–98) are missing and two stray clefs
  appear on Menuetto bars (`@n=24`, `@n=42`) that have no clef in the source.
- **Cause:** Verovio's **MusicXML → MEI importer keys clef placement on the
  measure `number`.** With the Trio reusing the Menuetto's numbers, the Trio's
  clef changes are routed onto the Menuetto bars of the same number, and the
  mid-measure ones are dropped.
- **Fix proven:** rewriting the `.mxl` so every `<measure>` carries a **unique**
  `number` before the import restores **all 22** clefs at their correct
  document-order measures — 14 → 23 clefs in the MEI, Trio clefs back at
  idx 52–98, the stray Menuetto clefs gone.

### Why this is safe — the `mc` / `mn` distinction

Per ADR-015:

- **`mc`** (measure count = Verovio position index) is a 1-based **document-order
  rank** over `<measure>` elements. It is **always unique** and is the machine
  join key; fragment coordinates live on `mc_start`/`mc_end`. It does **not**
  depend on `@n` — it is pure document order.
- **`@n` / `mn`** (notated bar number) is the **display-only human coordinate**.
  It legitimately restarts at the Trio (matches the NMA; we keep it), and is
  "established at ingest and not changed by any subsequent pipeline step."

So the duplicate `@n` is **not** a defect in the Doppia data model — it only
confuses Verovio's importer. Removing the duplication *for the import* and then
restoring the true `@n` leaves both `mc` (document order, never touched) and the
displayed numbering exactly as before.

---

## Decision

Add a corpus-prep step, between `convert_mscx_to_mxl` and `convert_mxl_to_mei`,
that:

1. **Renumbers MusicXML measures uniquely** (1..N in document order, per part)
   before Verovio imports the `.mxl`, so the importer never sees a duplicate
   measure number; and
2. **Restores the true (restarting) `@n`** on the resulting MEI immediately
   after import, by mapping each MEI `<measure>` (in document order = `mc`) back
   to the original `.mxl` measure number it came from.

The original `.mxl`'s measure-number sequence is the source of truth for the
restored `@n`; the mapping is a clean 1:1 by document-order position because the
renumbering does not add, remove, or reorder measures.

This supersedes the earlier "trailing-clef recovery must override the
converter's mis-placed clefs" direction for the multi-section case: with the
importer no longer mis-routing clefs, the clefs simply arrive correct and the
recovery/reconciliation passes (ADR-031) handle the rest.

### Scope

Triggered for any movement whose source carries duplicate measure numbers (a
section restart). Single-section movements are a no-op (numbers are already
unique, so the restore is identity).

---

## Consequences

- **K331/ii clefs arrive correct** from the converter (Trio clefs present,
  Menuetto collisions gone), without per-clef repair logic.
- **`mc` is invariant** — document order is never changed, so fragment
  coordinates, harmony alignment, and Verovio `measureRange` selection are
  unaffected. The 15-movement mc-stability check must pass.
- **Displayed numbering is preserved** — the restored `@n` reproduces the NMA's
  restarting sequence, satisfying the ADR-015 duplicate-`@n` (Step 8)
  disposition (`MEASURE_N_MULTI_SECTION_DUPLICATE`).
- **Likely fixes C2-playback and the incipit slurs** — the Verovio repeat
  expansion and `endid` resolution that derail on duplicate numbers are expected
  to recover once the import sees unique numbers; this is verified on the same
  re-ingest, not assumed.

### Gate before this is considered done (verify on a fresh prep + live re-ingest)

1. All 22 K331/ii clefs return at the correct document-order measures.
2. `mc` unchanged; the 15-movement mc-stability check passes.
3. Repeat / volta / `<ending>` handling preserved or improved (the C2 playback
   symptom; check the trio repeat expansion).
4. The restored `@n` still matches the duplicate-`@n` Step-8 disposition, and
   Pass 5/6 (`@n` uniqueness / ending `@n`) behave as before.
5. The incipit slurs on K331/ii are re-checked.

### Verification outcome (2026-07-01 — all gates pass)

1. **PASS** — the stored K331/ii MEI carries all 22 `.mscx` clefs (6 Menuetto +
   16 Trio); a render check finds 0 missing and 0 doubled glyphs, each at its
   correct document-order measure (mc 52, 54, 56, …). The measure-start recovery
   is a clean no-op here — the importer emits the clefs itself once numbering is
   unique. (Only K331/ii triggers the renumber across all 54 sonata movements.)
2. **PASS** — 8 prior-stored movements (incl. K331/ii at 101 measures)
   fingerprint-identical before/after via `measure_content_fingerprints`; no mc
   drift.
3. **PASS (structural)** — repeat marks land correctly: Menuetto
   `|: mc1-18 :| |: mc19-48 :|`, Trio `rptend@mc64 ↔ rptstart@mc65 ↔
   rptend@mc100`, so the Trio repeat closes on the Trio's own start-repeat, not
   the Menuetto's `rptstart@mc19` (the C2 symptom). Warning set unchanged from
   the prior ingest. Rendered MIDI expansion still to be confirmed in-app.
4. **PASS** — the restored `@n` raises `MEASURE_N_MULTI_SECTION_DUPLICATE` with
   runs `[48, 51]`, exactly the Step-8 disposition; the ingest warning set is
   otherwise unchanged.
5. **PASS** — the regenerated K331/ii incipit has 7 slurs, none wider than the
   viewport (max 1828 vs 13190 viewBox units); the runaway slurs are gone.

### Risks

- **Other number-keyed import behaviour.** The importer may key things besides
  clefs on the measure number (endings, repeats). This is the reason for gate
  (3): the change is expected to *help* those, but must be confirmed, not
  assumed.
- **`@n` restore correctness.** A bug in the document-order remap would corrupt
  the display label (never `mc`). Covered by `mc`/`@n` round-trip unit tests on
  K331/ii.

### Alternatives considered

- **Local clef-only repair** — read every `.mscx` clef change (with intra-bar
  onset), align to MEI by document-order index, drop the importer's collisions
  and inject the missing Trio clefs. Rejected as the primary route: it is
  clef-only (does nothing for C2-playback / incipit slurs), and it reimplements,
  downstream, the correct placement the importer would produce on its own once
  it sees unique numbers. Kept as a fallback if gate (3) reveals the renumber
  perturbs other import behaviour unacceptably.
- **Prevent the `@n` restart at the source** (renumber continuously, no
  restore) — rejected: it changes the displayed bar numbers away from the NMA
  and breaks the human coordinate.
