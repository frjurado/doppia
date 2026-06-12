# ADR-025: Repeat Barlines Are Not Selection Boundaries; Volta Endings and D.C./D.S. Markers Are

**Status:** Accepted
**Date:** 2026-06-12
**Amends:** `ADR-005-sub-measure-precision.md` (edge case "Backward repeat barlines as selection barriers")

---

## Context

ADR-005 established backward repeat barlines (`:|`), da capo, and dal segno markers as hard selection barriers in the tagging tool, "by design". Forward repeat barlines (`|:`) were never gated. The Component 9 plan flagged this asymmetry as a decision to resolve before the interaction-model spec lands (Step 2, Decision 1), recommending symmetry: both repeat barline directions become gates at measure resolution.

Reproducing the Step 1 fixture matrix surfaced two relevant facts:

1. The repeat-end gate is the source of a family of bracket-geometry bugs around the partial measures that repeat barlines create (SEL-01 through SEL-05, SEL-08 in `docs/reports/component-9-reports/step-1-fixture-matrix.md`).
2. No musical justification for the gate survived scrutiny. The bars on either side of a repeat-end barline **are** heard in succession — on the final pass, after the last repetition. A fragment spanning a repeat-end (an elision across a section boundary, a retransition into repeated material) is analytically meaningful, and the project's standing principle is to keep the tool flexible and trust the annotators.

The same scrutiny identifies the one boundary that *is* semantically hard: the boundary between sibling volta endings. A first ending and its second ending are never played in succession in any pass — the first ending closes into the repeat jump, never into its sibling. A fragment whose endpoints lie in two sibling endings denotes no performable music.

## Decision

**Repeat barlines are not selection boundaries.** Selection drags cross repeat-end barlines, repeat-start barlines, and section boundaries freely, at every resolution (measure, beat, sub-beat). The existing repeat-end gate is removed; no repeat-start gate is added.

**Crossing between sibling volta endings is a hard selection gate.** A selection may not have one endpoint inside ending N and the other inside a sibling ending M ≠ N, and a selection anchored inside a non-final ending may not extend past the end of its volta group. The ending-boundary gate from the ADR-005 G2 addendum is retained (reimplemented in Step 3 as a volta-index rule in `computeSelectionKeys()`, which both clamps at the gates and excludes unreachable sibling endings from the effective range — see Consequences).

**Crossing a da capo or dal segno marker is a hard selection gate.** At a D.C./D.S. marker the jump *always* fires — unlike a repeat-end, there is no final pass that proceeds directly into the following bar. The existing D.C./D.S. clamp from ADR-005 is retained. "To Coda" and "Fine" marks are not gates (the first pass proceeds directly past both); selections into a coda section are gated by the D.C./D.S. marker they would have to cross.

The unifying principle: **a selection is valid iff its effective measure sequence occurs as a contiguous run in at least one pass of the performed (repeat-expanded) score.** Crossing a repeat-end is contiguous on the final pass. Entering exactly one volta ending is contiguous on that ending's pass. First-ending → second-ending succession occurs in no pass, and neither does succession across a D.C./D.S. marker — so both are barred.

### Playback consequence

A fragment may now contain a repeat-end whose paired repeat-start lies outside the fragment. Honouring it would jump playback out of the fragment. The rule:

- A repeat structure **wholly contained** in the fragment's effective range plays expanded — both passes, endings honoured — exactly as in full-movement playback.
- A repeat-end whose **paired repeat-start lies outside** the fragment is **ignored**: playback uses **final-pass semantics**. The fragment plays once, straight through, as the music sounds the last time through. Where the truncated repeat has volta endings, the non-final endings are already excluded from the fragment's effective range at the selection layer (`tagging-tool-design.md` §6A.3), so playback simply plays what remains.
- D.C./D.S. directives can only appear on a fragment's last bar (selections cannot cross the markers); the directive is ignored and playback ends at the fragment boundary.

This applies to fragment-scoped playback only. Full-movement playback is unchanged (`docs/architecture/playback-coordinates.md` § Repeat policy).

## Consequences

**Positive.**

- The barrier code narrows to the semantically justified gates: the `:|` barriers are removed rather than mirrored, deleting a bug surface instead of doubling it, while the ending gates and the D.C./D.S. clamps remain. (As implemented in Step 3: `buildRepeatBarriers` became `buildDirectiveBarriers`, D.C./D.S. only; `buildEndingBarriers` is replaced by `buildVoltaIndex` + `computeSelectionKeys`, which clamp at the gates and exclude unreachable sibling endings from the effective range.)
- Annotators can tag fragments that span section boundaries and repeat barlines, which the corpus genuinely contains (e.g. K331/iii section joins).
- Fixture SEL-11 ("repeat-start is not a selection barrier, asymmetric with repeat-end") becomes obsolete: the observed repeat-start behaviour is now the specified behaviour for both barline directions.

**Negative / trade-offs.**

- Fragment playback needs the final-pass rule before fragments spanning repeat-ends are auditioned (Component 9 playback work). Until then, such a fragment played via the default Verovio expansion could jump outside its own range. The likely mechanism — stripping unpaired repeat/ending markup from the fragment-scoped toolkit state before `renderToMIDI()` — is an implementation detail decided when fragment-scoped playback lands.
- A fragment that wholly contains a volta group but **not** the group's repeat-start cannot reach the first ending (the jump back is unreachable from within the fragment). The rule (`tagging-tool-design.md` §6A.3): the non-final endings are excluded from the fragment's effective range, `repeat_context` is set to the final ending, the bracket renders discontiguously over the exclusion, and playback plays the final ending only. Whether a selection keeps both endings of a contained group therefore hinges on whether it also contains the group's repeat-start. This is more rendering machinery than the naive "include everything" reading, but it guarantees a fragment never carries an ending it cannot perform.

**Neutral.**

- `repeat_context` keeps its existing roles unchanged (display label; volta filter in the harmony range query, per ADR-015 and `fragment-schema.md`).
- The dual coordinate system (ADR-015) is unaffected: cross-repeat fragments are ordinary contiguous `mc` intervals.

## Alternatives Considered

**Symmetry — both repeat barline directions become hard gates (the Component 9 plan's recommendation).** Rejected. It resolves the asymmetry but over-constrains: it makes musically meaningful cross-boundary fragments impossible to tag, contradicting the trust-the-annotator principle, and it doubles the barrier code that the Step 1 fixtures show to be the most bug-prone area of selection.

**Keep the status quo (repeat-end gates, repeat-start does not).** Rejected. The asymmetry has no rationale, and the gate blocks legitimate fragments while its implementation causes the SEL-01…05 bug family.

**Gate at measure resolution only, free at beat/sub-beat.** Rejected. Resolution-dependent boundary rules would make the committed range depend on which toggle was active during the drag — incoherent with the single-source-of-truth model in `tagging-tool-design.md` §6A.
