# ADR-026: MEI Cross-Barline Tie Completion — Pass 8

**Date:** 2026-06-16  
**Status:** Accepted  
**Related:** ADR-022 (accidental pass, now pass 9), ADR-014 (original MEI retention)

---

## Context

In the app render of Mozart Piano Sonata K. 279 mvt 1, a B♭ in the treble staff
tied across the barline (mm. 12→13 and 13→14) loses its tie, and the
continuation note then renders — and plays — as a B♮. The two similar F♮ ties at
mm. 67→68 render correctly. Component 9, Step 7 was opened to diagnose and fix
this.

**Diagnosis (disproves the roadmap's hypothesis).** The roadmap suspected the
heavy ADR-021/022 accidental normalization (73 strips on this file) was
interacting with tie continuation. It is not. The retained original
(`docs/investigations/accidentals-k279-mvt1/`) and the normalized output are
byte-identical across these measures, and the normalizer never touched ties.

The real cause is upstream, in the MuseScore-to-MEI export:

- The two failing ties are encoded `<tie startid="#…"/>` with **no `@endid`**
  (and no `@tstamp2`). They are the *only* two endpoint-less ties in the
  movement; all 17 other ties — including the F♮ at m. 67→68 — carry both
  `@startid` and `@endid`.
- Verovio cannot render a control event (tie/slur) with only one endpoint, so
  the tie silently disappears.
- The continuation note (e.g. `twtc7h8` in m. 13) carries an *empty* `<accid/>`
  — no `@accid`, no `accid.ges` — because the engraving relied on the tie to
  carry the B♭. With the tie gone, Verovio applies the default for the pitch
  class (B♮ in C major) in both SVG and MIDI. The "consequent accidental" is
  therefore a *symptom* of the lost tie, not a separate accidental defect.

This is structurally the same class of problem as the clef `sameas` defect
(pass 10, ADR-fixed via the normalizer): malformed control-event data the
converter emits that Verovio cannot render. It belongs in the normalizer, where
correctness repairs land and where ADR-014 retention allows re-running against
the original.

---

## Decision

Add normalizer **pass 8 — cross-barline tie completion**
(`_complete_cross_barline_ties`), running *before* the accidental pass so the
completed ties inform its legitimacy rule.

### Algorithm

For each `<tie>` carrying `@startid` but **neither `@endid` nor `@tstamp2`**:

1. Resolve the start note by `xml:id`; read its `(pname, oct)`, containing
   `<staff @n>` / `<layer @n>`, and alteration (notated `@accid`, else
   gestural `accid.ges`).
2. **Locate the continuation** as the first note of the same `(pname, oct)` in
   the **immediately following** measure's matching staff/layer, in document
   order. (First-match selection is deliberate: in K. 279 m. 13 a later
   explicit B♮ exists in the same bar; the beat-1 tied note is the correct
   target.)
3. Set `@endid` to the continuation note's id.
4. If the start note carries an alteration and the continuation carries
   *neither* `@accid` nor `accid.ges`, add `accid.ges=<alteration>` to the
   continuation. No notated `@accid` is added — the original engraving printed
   none, and a tied note should not restate the accidental.

| Tie state | Continuation found? | Action |
|---|---|---|
| Has `@endid` or `@tstamp2` | — | **Skip** (already complete; idempotent) |
| `@startid` only | Yes | **Complete**: set `@endid`; propagate alteration as `accid.ges` if absent |
| `@startid` only | No (none in next bar's staff/layer) | **Warn and leave untouched** — never fabricate an endpoint |

### Why propagate `accid.ges` (the "full repair")

A completed tie alone leaves the continuation note's literal pitch as B♮
(no accidental, C major). Relying on Verovio to carry the flat through a tie
between two differently-spelled notes is fragile and semantically incorrect
(tied notes should be the same pitch). Writing `accid.ges` onto the continuation
makes the note genuinely B♭ — correct MIDI and no printed accidental —
independent of Verovio's tie-pitch handling, exactly as well-formed MEI encodes
a tied continuation.

### Interaction with pass 9 (accidentals, ADR-022)

The `accid.ges` this pass adds (and any pre-existing tied-continuation
`accid.ges` in the corpus) would otherwise be stripped by pass 9 as "spurious"
(no key-signature or within-measure carry explains a flat on B in C major).
Pass 9 is therefore made **tie-aware**: a note that is the `@endid` target of a
`<tie>` whose start note carries the same alteration is a third legitimate
source (alongside key signature and within-staff carry) and is never stripped.

---

## Evidence

**K. 279 mvt 1:** exactly two ties completed —
`wa0ma2t` (B♭ oct 4) → `#twtc7h8` in m. 13, and
`omoukg4` (B♭ oct 4) → `#b1sra9lf` in m. 14 — each with `accid.ges="f"` added to
the continuation. Zero tie warnings; the rest of the report (73 accidental
strips, clef resolutions) is unchanged. Second pass is byte-identical
(idempotent), and the two continuations' `accid.ges` survives pass 9.

**Reference fixtures** (`backend/tests/unit/test_mei_normalizer.py`,
`TestCrossBarlineTieCompletion`):

| Fixture | What it tests |
|---|---|
| `normalizer/tie_incomplete_crossbar.mei` | Endid resolution to next-bar note; decoy same-pitch note not chosen; chained second tie; `accid.ges` propagation; complete tie left untouched; pass-9 survival; idempotence |
| `normalizer/tie_incomplete_no_target.mei` | No continuation in the next bar → warning, tie left endid-less |

---

## Consequences

- **Tie + accidental + MIDI corrected** for endpoint-less cross-barline ties
  corpus-wide; the fix is general, not K. 279-specific (Step 10 ingests 39 more
  movements from the same export pipeline).
- **Pass renumbering.** The accidental pass moves from pass 8 to **pass 9** and
  the clef `sameas` pass from pass 9 to **pass 10**; `mei-ingest-normalization.md`
  and the module docstring are updated to match. ADR-022 continues to describe
  the accidental algorithm (now pass 9) unchanged in substance.
- **Applied to the live corpus in Step 9**, when the existing 15 movements are
  re-ingested through the updated normalizer (with the mc-stability check). This
  step delivers the pass, tests, and docs only.
- **Limitation.** Completion only handles `<tie>` *elements* missing `@endid`;
  it does not synthesize ties from `@tie` attributes, nor complete ties whose
  continuation is more than one measure away (none occur in the corpus). Such
  cases warn rather than guess.
