# ADR-029: MEI Staff-Presentation Normalization (Pass 11)

**Date:** 2026-06-28
**Status:** Accepted — implemented

---

## Context

The Component 9 staging read-through (Cluster D1 in
`docs/reports/component-9-reports/staging-readthrough-issues.md`) flagged the
grand staff of the piano corpus rendering **inconsistently** across movements:
some scores show a brace joining the two staves and barlines that cross the
staff gap, others do not; instrument labels appeared variously as nothing,
`"Piano"`, or `"Piano, Piano right"`.

The MuseScore→MEI conversion is the source of the variance — the normalizer has
never had a pass touching `<staffGrp>` structure, `@bar.thru`, `<grpSym>`, or
`<staffDef>`/`<instrDef>` labels, so whatever the converter emits per file
survives. A fresh prep of all **54** movements
(`.mscx → .mxl → .mei → recover_measure_start_clefs`) shows exactly three
structural shapes for the solo-piano grand staff:

| Shape | Movements | `staffGrp` nesting | brace | `bar.thru` | `instrDef` |
|---|---|---|---|---|---|
| **A — canonical** | 49/54 | outer → **inner**(2 `staffDef`) | `<grpSym symbol="brace">` on inner | `true` on inner | 1, group-level |
| **B — unbraced, over-nested** | K332/i | outer → mid → **inner**(2 `staffDef`) | *absent* | `true` on inner | 1, group-level |
| **C — flat, ungrouped** | K332/ii, K576/i–iii | **outer**(2 `staffDef`) directly | *absent* | *absent* | 2, staff-level |

So the live, reproducible defect is **structural**, in 5 of 54 movements: the
brace is missing (B, C) and inter-staff barlines do not connect (C). The label
inconsistency Francisco observed is **not reproducible on the current prep** —
no `<label>`/`@label` exists anywhere in the 54-movement prep, and Verovio
renders empty `<g class="label">` placeholders with no text. The "Piano" /
"Piano, Piano right" strings came from the *older* staging ingest; the current
converter no longer emits them. We still strip labels defensively (below) so
the corpus is uniform regardless of converter drift.

The structural inconsistency degrades every render of the affected movements,
including their incipits. Because incipits regenerate on re-ingest (Component 9
Step 8b), folding this normalisation in before the Band 1 re-verification means
incipits regenerate **once**, already correct.

## Decision

Add **Pass 11 — `_normalize_staff_presentation`** to the MEI normalizer,
standardising the presentation of a single-instrument piano grand staff to the
canonical shape (A) that 49/54 movements already hold:

1. **Brace.** Each *leaf* `<staffGrp>` — a group whose **direct** children
   include `<staffDef>` — is ensured braced. "Braced" is recognised in either
   MEI form (`@symbol="brace"` **or** a `<grpSym symbol="brace">` child); when
   neither is present a `<grpSym symbol="brace"/>` child is inserted as the
   group's first child. The `<grpSym>` child is chosen as the canonical form
   because it is what the converter already emits for the 49 canonical
   movements, so the corpus converges on one representation and Pass 11 is a
   no-op there.
2. **Through-barlines.** The same leaf group is given `bar.thru="true"` if it
   lacks it, so barlines connect across the staff gap.
3. **Redundant labels.** On a single-instrument score, `@label` attributes and
   `<label>` children are removed from every `<staffDef>`, and `<label>`
   children from every `<instrDef>`. A solo piano needs no instrument label in
   the browser; this is a defensive, idempotent strip (a no-op on the current
   prep).

`<instrDef>` elements themselves — and their `midi.*` attributes — are **kept**:
they drive MIDI playback. Only their *labels* are stripped. Pitches, durations,
`xml:id` values, and all printed musical content are untouched.

### Scope guard — single-instrument grand staff only

The pass operates only when the score is a single-instrument grand staff: **all
`<staffDef>` elements belong to one leaf group** (equivalently, there is exactly
one leaf `<staffGrp>`). The entire Mozart piano corpus satisfies this. A future
multi-instrument score (multiple leaf groups, e.g. a string quartet) must **not**
be force-braced or have its instrument labels stripped, so in that case Pass 11
is a conservative no-op and logs nothing. Multi-instrument staff presentation is
out of scope until such a corpus exists.

### What this pass deliberately does **not** do

- It does **not restructure** the `<staffGrp>` tree. Shape B's redundant empty
  middle group is left in place (it carries no `@symbol`, so Verovio renders
  nothing for it); the brace is added to the leaf group, matching shape A's
  brace-directly-above-the-staves placement. Shape C's brace/`bar.thru` are set
  on its existing (outer = leaf) group rather than wrapping the staves in a new
  inner group — the result renders identically to A and avoids moving
  `xml:id`-bearing elements.
- It does **not** add or synthesise instrument labels; it only removes
  redundant ones.
- It does **not** touch courtesy-clef placement (D3) — that is designed with the
  Cluster A clef work and deferred (see the interlock plan).

## Consequences

- **Brace + connected barlines on all 54 movements** after re-ingest; the 49
  canonical movements are unchanged (Pass 11 is a verified no-op on them, so the
  pass preserves idempotence and byte-stability there).
- **Idempotent.** A second run finds every leaf group already braced and
  `bar.thru="true"`, and all labels already absent → no changes, byte-identical
  output, `is_clean` report.
- **Incipits improve for free.** Re-ingest (Band 1 Item 6) regenerates incipits
  from the normalised MEI; K332/i–ii and K576/i–iii pick up the brace and
  through-barlines. No incipit-renderer change is needed — the staff
  presentation is encoded in the MEI the renderer already consumes, and the
  Step 8b title strip (`header="none"`) is unaffected.
- **Verification.** `scripts/staff_audit.py` (sibling of `clef_audit.py` /
  `accidental_trace.py`) preps + normalizes a movement and flags any leaf group
  lacking a brace or `bar.thru`, or any residual label — corpus-wide
  re-application is Band 1 Item 6.
- **Pass ordering.** Pass 11 runs after the clef passes; it inspects only the
  `<scoreDef>` `<staffGrp>` subtree, which no earlier pass modifies, so order
  relative to passes 0–10 is immaterial.
