# ADR-033: Pre-import repair of omitted strain-opening repeats

**Date:** 2026-07-01 (gate removed 2026-07-04)
**Status:** Accepted — implemented in `scripts/prepare_dcml_corpus.py`
(`repair_section_opening_repeats`); verified live on the 2026-07-01 re-ingest.
The section-restart gate was dropped 2026-07-04 after a render review of the
remaining 7 matched movements; the rule now applies unconditionally.
Supersedes the C2 overlay erratum in `backend/seed/corrections/mozart__piano-sonatas.yaml`.

---

## Context

K331/ii (Menuetto + Trio) is a rounded-binary movement: the Menuetto has two
repeated strains and the Trio has two more (the second with 1st/2nd endings).
In playback, **both Trio repeats jump back to the Menuetto's bar 19** instead of
repeating the Trio's own strains.

### Root cause (confirmed 2026-07-01)

Verovio builds the MIDI playback order as an MEI `<expansion>` element **at
MusicXML-import time**, by pairing each backward-repeat (`:|`) with the most
recent forward-repeat (`|:`). The DCML/MuseScore source encodes the Trio's two
strain **closings** (`:|` at mc64 and, via the 1st ending, mc100) but **omits
their openings** (`|:` at mc49 and mc65) — the common convention that a new
section's opening repeat is "implicit". With no `|:` at the Trio strains,
Verovio pairs their `:|` with the Menuetto's `|:` at **mc19**, so the generated
expansion is:

```
A A  B B  C [B C] D end1  [B C] D end2  A B      (A=mc1-18 B=mc19-48 C=mc49-64 D=mc65-99)
```

— the Trio "repeat" replays Menuetto strain B. The correct expansion is
`A A B B C C D(1) D(2) A B`.

### Why the earlier erratum could not fix it

The C2 overlay erratum (ADR-027) added `rptstart` at mc65 as a **post-import**
MEI edit. That corrected the rendered `|:` glyph but **not** the playback: the
`<expansion>` was already frozen at import from the pre-erratum marks, so the
wrong order survived. **Any repeat fix that must change the expansion has to run
before the Verovio import.**

### What was proven

Injecting `<repeat direction="forward"/>` at the Trio strain openings (mc49 and
mc65) in the `.mxl` **before** import makes Verovio generate the correct
expansion (`A A B B C C D(1) D(2) A B`), verified by reading the emitted
`<expansion>` `@plist`.

---

## Decision

Add a corpus-prep step, after `renumber_mxl_for_import` and before
`convert_mxl_to_mei`, that supplies the omitted **strain-opening repeats** in the
MusicXML: `repair_section_opening_repeats`.

The rule is structural, not a per-movement lookup. Walking a part's measures in
document order, a *strain* is a run ending at a backward-repeat (`:|`). A strain
that closes with `:|` but carries no forward-repeat (`|:`) anywhere within it is
missing its opening repeat, and one is injected at the strain's first measure —
**except the very first strain**, which opens at the movement start where the
opening repeat is genuinely implicit (`:|` repeats to bar 1). This is exactly why
the Menuetto's first strain keeps no `|:` while both Trio strains gain one. The
injected `<barline>` is cloned from an existing forward-repeat so its bar-style
matches; the step is idempotent and a no-op unless a strain needs repair.

The rendered `|:` at the Trio's first strain (mc49) is a **minor, accepted
engraving deviation**: the NMA leaves that opening repeat implicit, but Francisco
chose the explicit glyph (2026-07-01) as the simplest, most replicable fix — it
makes both the notation and the playback self-consistent and generalises to any
future section-restart movement without per-movement data.

### Scope

The rule is structural — any movement with a non-first strain that closes with
`:|` but no `|:`. A corpus scan (2026-07-01) showed it also matches **7
single-section movements** whose sonata/variation second strains have the same
omitted opening `|:`: k282/ii (mc35), k330/i (mc59), k333/i (mc65), k545/ii
(mc17), k570/i (mc80), k570/iii (mc51), and k284/iii (ten strains). Each produces
a clean, standard-form expansion (consecutive strain repeats), so the rule is
almost certainly correct there too.

**Gate removed (Francisco 2026-07-04):** the interim `if renumbered` restriction
described below has been dropped. A 2026-07-04 before/after render review of all
7 previously-deferred single-section movements (k282/ii, k284/iii's ten
variation strains, k330/i, k333/i, k545/ii, k570/i, k570/iii) confirmed each
"before" was an unambiguous bug (a strain replaying the previous one instead of
itself) and each "after" the correct form. `repair_section_opening_repeats` now
runs unconditionally in both the prep pipeline and `clef_audit`, for every
movement whose structure matches, not just section-restart ones.

<details>
<summary>Original interim gating (2026-07-01 – 2026-07-04, superseded above)</summary>

the repair was applied **only to
section-restart movements** — those `renumber_mxl_for_import` renumbered — which
reached exactly **K331/ii** (the render-verified case). The 7 single-section
movements were **deferred**: the rule adds a visible `|:` to each and they had not
been render-reviewed against the edition, so they waited for a reviewed batch. The
gate lived in the prep pipeline (and `clef_audit`), not in the function, which
stayed general; un-scoping later was deleting the `if renumbered` guard.

</details>

### Relationship to ADR-032

ADR-032 (renumber for import) and this ADR fix two independent Verovio-importer
behaviours keyed on the same movement: ADR-032 stops clefs mis-routing on
duplicate measure numbers; ADR-033 stops the repeat expansion mis-pairing on
omitted strain openings. Both are pre-import `.mxl` rewrites and both leave `mc`
(document order) untouched.

---

## Consequences

- **K331/ii playback is correct** — the Trio repeats stay within the Trio; the
  D.C. plays the Menuetto once to the Fine.
- **The C2 overlay erratum is retired** — `repair_section_opening_repeats`
  supplies mc65 (and mc49) pre-import, so the post-import `repeat-start`
  correction is removed from `mozart__piano-sonatas.yaml`. The `repeat-start`
  overlay field op remains (still valid for a purely-visual repeat erratum), only
  the K331/ii data entry is gone.
- **`mc` is invariant** — injecting a barline adds no measure and reorders none,
  so fragment coordinates and the 15-movement mc-stability check are unaffected.
- **A visible `|:` appears at K331/ii mc49** — the accepted engraving deviation
  above.
- **The 7 single-section movements now get the fix too** — render-reviewed
  2026-07-04 (see below) and included once the section-restart gate was dropped;
  their trio/variation/second-half repeats play correctly.

### Verification (2026-07-01 — live re-ingest)

- The prep logs `injected opening repeat(s) at measure(s) [49, 65]` for K331/ii
  and for no other movement.
- The emitted `<expansion>` reads `A A B B C C D(1) D(2) A B`.
- `mc` unchanged; the mc-stability fingerprints are identical to the prior
  ingest; clefs, `@n` disposition, and incipit slurs (ADR-032 gates) still pass.
- Francisco confirmed in-app that the Trio repeats no longer jump to the
  Menuetto.

### Verification (2026-07-04 — gate removal, 39-movement corpus prep)

- Before/after repeat-mark and Verovio `<expansion>` evidence generated for all
  7 previously-deferred movements (k282/ii, k284/iii, k330/i, k333/i, k545/ii,
  k570/i, k570/iii); each "before" showed a strain replaying the wrong
  neighbour, each "after" the corrected, self-consistent expansion.
- Francisco reviewed the evidence and approved dropping the section-restart
  gate.
- The unconditional rule was then dry-run across the full 39-movement
  not-yet-ingested corpus (`scripts/dcml_corpora/mozart-piano-sonatas-remaining.toml`)
  with no unexpected injections beyond the 8 known movements.

### Risks

- **Over-injection.** A movement whose structure genuinely wants a mid-movement
  `:|` to repeat to the movement start (not a strain start) would get an unwanted
  `|:`. Originally mitigated by scoping to K331/ii only; now that the rule is
  unconditional, the mitigation is the corpus-wide dry-run + render review
  before each new batch is ingested (done above for all 8 movements matched so
  far) — revisit if a future corpus surfaces a counter-example.

### Alternatives considered

- **Correct the MEI `<expansion>` `@plist` post-import** (no visible `|:` at
  mc49) — rejected: fragile (the plist references section ids regenerated every
  prep) and it hides the repeat from the notation, contradicting the visible
  `:|` already present.
- **Keep the post-import overlay erratum** — rejected: proven unable to change
  the frozen expansion (the whole reason playback stayed wrong).
