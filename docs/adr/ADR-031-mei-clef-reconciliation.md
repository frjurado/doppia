# ADR-031: MEI Clef Reconciliation — per-voice doubles, onset alignment, and courtesy placement (Phase A)

**Date:** 2026-06-30
**Status:** Accepted — implemented; **amended 2026-07-05** (see the amendment
at the end: `sameas` restatements are kept silent instead of resolved, courtesy
groups keep one copy, recovery injects a single trailing courtesy)

---

## Context

The Component 9 staging read-through (Cluster A in
`docs/reports/component-9-reports/staging-readthrough-issues.md`) reported
"double clef" glyphs at: K283/ii m.19 & m.25, K332/iii m.210, K279/i m.86,
K279/iii m.72; plus the related per-voice scope bug A2 (a clef positioning only
one voice) and the D3 courtesy-clef placement question (clef drawn after vs.
before the barline). An earlier triage framed these as three separate
mechanisms with a "measure-start" cause and a "resolved in MEI" bucket. **That
framing was wrong** (caught on render by Francisco, 2026-06-30). The corrected,
empirically-grounded picture:

**Every "double" is one musical clef change inside a region where the staff
carries two voices** — and none are measure-start. Inspecting the raw converter
MEI (`.mscx → .mxl → .mei`) shows the MuseScore→MEI conversion scatters that
single clef change across the staff's `<layer>`s as inconsistent fragments:

| Fragment the converter emits | Effect | Seen at |
|---|---|---|
| a real `<clef>` in a layer with **no notes after it** (only `<space>`) | a spurious glyph that positions nothing | 283/ii m19 L6, 279/i m86 L5 |
| `<clef sameas="#…">` restating another layer's clef | Pass 10 resolves it to shape/line → a **2nd drawn** glyph | 283/ii m19/m25 L6 |
| the two layers' clefs at **different onsets** | glyphs spaced apart → a visible double | 279/i m86, 279/iii m72 |
| a `<clef>` **nested inside a `<beam>`** | a note *before* it stays in the old clef | 279/i m86 L6 |

### Verovio constraints (probed directly, synthetic 2-voice renders)

These rule out the obvious "fixes" and determine what is possible:

1. `@visible="false"` on a `<clef>` is **ignored** — Verovio draws it anyway.
   Glyph suppression is not available.
2. Two **identical** clefs at the **same musical onset overlap at one x** and
   render as a single glyph. The *visible* doubles are precisely the cases where
   the converter placed the two layer-clefs at **different** onsets.
3. An **unresolved** `<clef sameas>` (no `shape`/`line`) renders **no glyph**;
   Pass 10's resolution to explicit `shape`/`line` is what turns a silent
   restatement into a drawn second glyph.
4. A `<clef>` in **one layer only** repositions that layer only (this *is* A2);
   a clef in **every layer** repositions all voices but draws N glyphs. There is
   **no** in-layer encoding that is simultaneously single-glyph and all-voices
   for a mid-measure change.
5. A `<clef>` as a direct **`<staff>` child**, or a **running `<scoreDef>`**,
   draws one glyph and repositions all voices — but **only at a measure
   boundary** (neither carries a mid-bar onset), so neither helps the
   mid-measure cases.

So the only viable lever for mid-measure two-voice changes is **dedup +
onset-alignment, in-layer**: keep exactly the clefs each voice needs to be
positioned correctly, and make co-located clefs share an onset so they overlap
into one glyph.

This ADR also resolves **D3**, which ADR-029 explicitly deferred "to the
Cluster A clef work": where to place a clef change relative to the barline.

(The K331/ii multi-section clef loss — A3 and the "minuet collision" half of A1
— is a **different** root cause, Verovio's MusicXML importer keying clef
placement on the measure *number*. It is addressed separately in ADR-032 and is
out of scope here.)

---

## Decision

### 1. Pass 10 becomes a clef-reconciliation pass

`_resolve_clef_sameas` (Pass 10) is widened from "resolve `sameas`" to
"reconcile a staff's co-located clef fragments into a single rendered glyph with
every voice correctly positioned." Per `<staff>` per measure, for each clef
change shared across layers:

1. **Drop a clef from a layer with no following note/chord.** A clef whose layer
   has only `<space>`/nothing after it positions nothing; remove it. This alone
   clears the spurious-glyph cases (283/ii m19, 279/i m86 L5).
2. **Do not materialise a redundant `sameas` into a drawn duplicate.** A
   `<clef sameas>` that restates a sibling layer's clef at the same onset is
   either dropped (when its layer needs no clef change to be positioned
   correctly) or **kept unresolved / onset-aligned** so it does not add a second
   visible glyph. Pass 10 no longer blindly resolves every `sameas` to explicit
   `shape`/`line`.
3. **Onset-align genuinely co-active two-voice changes.** When two voices both
   continue past the change and both need the new clef (283/ii m25), align the
   two clefs to the **same** musical onset so their glyphs overlap into one
   (constraint 2 above). Each voice keeps a clef so each is positioned, but only
   one glyph is drawn.
4. **Hoist a beam-nested clef** to its layer's correct position so the note that
   should follow the new clef is not left under the old one (279/i m86 L6).

The pass remains idempotent and prints nothing musical: it changes only which
`<clef>` elements exist and their position within a layer — never pitch,
duration, or any printed accidental/articulation.

### 2. Measure-start whole-staff clef changes — single glyph, all voices

The corpus-prep `recover_measure_start_clefs` currently injects a recovered
measure-start clef into **every** `<layer>` of the staff (the A2 fix). On a
multi-voice measure-start that is a latent double-generator. It is brought under
the same reconciliation: a recovered measure-start change is encoded so it draws
**one** glyph and repositions **all** voices, via the placement decided in (3)
below.

### 3. D3 — courtesy clef placement: BEFORE the barline, always

Decided with Francisco (2026-06-30): a clef change at a measure start is placed
as the **trailing courtesy clef of the previous measure** (the
before-the-barline position MuseScore itself uses and that the engraving
convention expects), not at the head of the new measure. Because a trailing clef
is layer-scoped like any in-layer clef, the dedup + onset-alignment of (1) above
applies to it directly, so a multi-voice courtesy clef still renders as a single
glyph.

This is why the measure-start recovery uses the **trailing-in-layer** encoding
rather than a `<staff>`-child clef or running `<scoreDef>`: the latter two draw
*after* the barline (constraint 5), which violates the before-barline decision.

---

## Consequences

- **The reported doubles clear** (283/ii m19/m25, 332/iii m210, 279/i m86,
  279/iii m72) and A2 is re-settled, because every co-located clef change yields
  exactly one glyph with all voices positioned.
- **D3 is uniform** across the corpus: measure-start clef changes appear as
  courtesy clefs before the barline.
- **`mc` / fragment coordinates are untouched.** The pass adds, removes, or
  repositions `<clef>` elements within layers only; it never adds or removes a
  `<measure>`, so document-order `mc` (ADR-015) is invariant.
- **Verification is on render, not the audit alone.** Per the lesson recorded in
  the staging read-through (prep audits have blind spots), each case is confirmed
  by a Verovio glyph-count + note-y check (the methodology used to derive the
  constraints above), and `scripts/clef_audit.py` is extended to assert
  render-equivalent facts (one glyph per co-located change; no clef in a
  noteless layer; both voices share a clef onset). Closed out on the
  15-movement re-ingest + mc-stability check.
- **Idempotent.** A reconciled staff has no noteless-layer clefs, no
  unresolved-then-resolved `sameas` doubles, and aligned onsets, so a second run
  is a no-op.

### Alternatives considered

- **`@visible="false"` on the redundant clef** — rejected: Verovio ignores it
  (constraint 1).
- **`<staff>`-child clef or running `<scoreDef>` for measure-start changes** —
  works for single-glyph/all-voices at a barline, but renders *after* the
  barline, contradicting the D3 before-barline decision. Kept on record as the
  encoding to use **if** the D3 decision is ever revisited.
- **Keep every voice's clef and accept the double** — rejected: it is exactly
  the reported defect.

### Deferred

- Multi-instrument staves (out of scope; corpus is solo piano).
- The K331/ii multi-section clef loss (ADR-032).

---

## Addendum (2026-07-04): audit false positive found while auditing the remaining 39 movements

Running `clef_audit.py` against the not-yet-ingested corpus surfaced two
further findings, neither of which changes the design above:

- **A2 audit false positive (K533/iii m118).** `_layer_leads_with_clef`
  checked only the layer's direct first child. When the converter's native
  clef is the first child of a `<beam>` rather than a direct child of the
  layer (the same beam-nesting artifact constraint 4/row 4 of the table above
  already documents), the check missed it and both the A2 audit and the
  measure-start recovery's already-encoded guard treated a voice that already
  had its clef as if it did not. Fixed by making `_layer_leads_with_clef`
  descend through beam/tuplet-style transparent containers to find the true
  first musical event — no MEI output changed, only the audit/guard's read of
  it. Covered by `TestLayerLeadsWithClefBeamed` in
  `backend/tests/unit/test_prepare_dcml_corpus.py`.
- **A1b — cross-layer clefs at different onsets, 10 occurrences across 7
  movements** (K309/ii m77, K310/ii m70, K333/iii m7/47/118, K570/ii m12,
  K570/iii m56, plus two pre-existing occurrences in the already-ingested
  K283/iii m56/m227 and K331/i mX1). Francisco's read (2026-07-04) of the raw
  `.mscx` for each: one real clef, with a second voice starting or ending
  around it and MuseScore placing invisible rests such that the layers'
  onsets disagree — but this is unconfirmed pending an actual Verovio render
  review (published as an Artifact, `clef_spots_review.html`). Resolved by
  the 2026-07-05 amendment below.

---

## Amendment (2026-07-05): silent restatements — one drawn glyph per change

A systematic root-cause investigation of every known double-clef occurrence —
the 5 this ADR originally fixed plus 10 then-open A1b survivors, traced
through `.mscx` → MusicXML → converter MEI → recovery → normalizer — revised
two of this ADR's premises. Full evidence: the four-stage traces and the
three synthetic Verovio probes (2026-07-05).

### Corrected facts (probed on Verovio 6.1.0, the pinned version in both
`backend/requirements.txt` and `frontend/package.json`)

1. **An unresolved `<clef sameas>` positions its voice.** Constraint 3 above
   recorded only that it "renders no glyph"; the probe shows the layer's
   following notes ARE repositioned. So a per-voice restatement kept as an
   unresolved `sameas` is *silent but functional* — and resolving it to
   explicit shape/line (the original Pass 10) is precisely what created the
   visible A1b doubles. Constraint 4's dilemma ("no in-layer encoding is
   single-glyph and all-voices") is thereby dissolved: one explicit anchor +
   silent `sameas` copies is exactly that encoding.
2. **Cross-measure clef state is staff-scoped.** An end-of-measure courtesy
   clef in any single layer re-clefs every layer of the next measure;
   per-layer copies only matter *within* a measure. So the measure-start
   recovery's per-voice trailing injection (§2 above) was over-encoding — and
   at unequal layer-end ticks it was itself a double-glyph generator (K570/ii
   m12, K570/iii m56).

### Amended decisions

- **Pass 10 is reversed on `sameas`:** restatements are *kept silent* (never
  resolved wholesale). Per staff-wide change event — same-key clefs adjacent
  in onset order — exactly one member is the drawn **bearer** (explicit, at
  the change point, the anchor voice's clef); every other positioning member
  stays/becomes an unresolved `sameas` pointing at the bearer; a member that
  positions nothing is dropped. Late copies are still pulled back to the
  change point when reachable (the onset-alignment machinery is kept — a
  `_ppq_per_quarter` inference bug that dotted first notes triggered, which
  had silently disabled it for K333/iii, is fixed); an unreachable copy
  (sounding note across the change point, K310/ii m70) harmlessly stays put,
  silent.
- **Bar-end courtesy groups keep one copy:** a group in which no member
  positions a note is the next measure's courtesy; only the latest-onset
  member survives, materialized to explicit (staff-scoped persistence, fact 2)
  — its glyph sits just before the barline. Covers K309/ii m77, K283/iii
  m56/m227, K331/i mX1.
- **Recovery injects one trailing courtesy, not per-voice** (in the layer
  whose content reaches the bar end), keeps per-voice injection only for
  *leading* placement (within-measure state is per-layer), completes a
  natively-half-encoded change in place (K533/iii m118), and switches to
  leading placement across a repeat barline, where NMA prints no courtesy
  before the barline (K570/ii m12→13).
- **Safety invariant (regression guard for the original Step 6 bug):** every
  surviving `sameas` must reference a live explicit clef; survivors are
  re-pointed at their bearer, anything unresolvable is materialized from the
  last known target or flagged `CLEF_SAMEAS_DANGLING`. A clef change can
  never silently render nothing.

`clef_audit.py` audits accordingly: A1/A1b count only *drawn* clefs, and a
new A4 flags dangling restatements. The Verovio-version caveat stands: the
silent-`sameas` behavior is an empirical property of the pinned 6.1.0 — any
Verovio upgrade must re-run the probes before shipping.
