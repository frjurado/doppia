# ADR-042 — Stage Presence: Expected Stages and the Stage Assertion Rule

**Status:** Accepted. The rule is in force for tagging from the moment the
tagging guidelines are published. The `expected_stages` field name and storage
are indicative until E1 Step 7 builds them; that step records the final shape as
an amendment here.
**Date:** 2026-11-05
**See also:** `docs/investigations/caplin-graph-review/proposals.md` (P1, P10,
with the page references), `docs/roadmap/track-e-e1-graph-revision.md` (the
plan that carries this out), `docs/seed-drafts/cadences-design.md` (hard-locked
decision 4, which this ADR amends, and decision 11, stages as child fragments),
`docs/architecture/tagging-tool-design.md` §§ 4, 7.3 (stage behaviour in the
tool), `docs/adr/ADR-041-editorial-machine-assistance-and-provenance.md`
(provenance of preselected values)

---

## Context

A cadence fragment holds stage child fragments, one per stage of the cadential
progression. Hard-locked decision 4 makes every `CONTAINS` edge optional, with
"morphological commitment in prose, not in structural required-ness". The review
of the cadence domain against Caplin, *Cadence* (2024) raised two questions.

**Should the theory's requirements be structural?** Caplin requires stages 3 and
4 of an authentic cadential progression, and the dominant of a half cadence. But
the deviations are defined by breaking exactly these stages: the evaded cadence
has no stage 4, the abandoned cadence has a stage 3 that is undermined, inverted
or missing, and a dominant arrival on a terminal dominant has no cadential
progression at all. Structural requiredness would reject correct tags. Prose, on
the other hand, cannot be read by Track E's defaults (E3) or checks (E4).

**What should be tagged when a stage's definition does not hold?** The
`CadentialDominant` definition follows Caplin: root position, throughout. Two
tagged cases contain a dominant that breaks it: an abandoned cadence whose
dominant arrives inverted, and a dominant arrival on a terminal dominant, which
may be inverted. Either the stage is not tagged, or the definition widens to
admit the deviation.

---

## Decision

### 1. Optional in structure, expected in data

Decision 4 stands: every `CONTAINS` edge stays `required: false`. It is amended,
not reversed. A concept declares which stages the theory expects of it, as data
the tools can read:

```yaml
expected_stages:
  CadentialDominant: expected
  CadentialFinalTonic: absent
```

- Each stage takes `expected` or `absent`; an unlisted stage is optional.
- The map is inherited down `IS_SUBTYPE_OF` and a subtype can override it.
- It is theory, so it lives in the graph, and not in the cold-start typicality
  hints (report § 4.5 keeps the two apart).

| Concept | Initial Tonic | Pre-dominant | Dominant | Final Tonic |
|---|---|---|---|---|
| PAC, IAC | optional | optional | expected | expected |
| Deceptive | optional | optional | expected | expected (substitute) |
| Evaded | optional | optional | expected | **absent** |
| Abandoned | optional | optional | optional | **absent** |
| HC (realised, reopening) | optional | optional | expected | — |
| Dominant Arrival | optional | optional | optional | — |

**It never blocks a submission.** E3 reads it to pre-populate (an `absent` stage
arrives toggled off, an `expected` one toggled on), and these are preselected
values under ADR-041 (`from: expected_shape`). E4 reads it to raise a flag when an
expected stage is missing or an absent stage is present.

### 2. A stage fragment asserts that the stage exists

Tag a stage only where its definition holds. Never widen a stage's definition to
fit a deviation. Where the stage is missing, leave it absent: for a deviation, the
missing stage is the analysis.

| Case | Stages |
|---|---|
| Abandoned: root-position V shifts to V⁶ or V⁶₅ | `CadentialDominant` on the root-position span |
| Abandoned: a cadential 6-4 that never reaches V | `CadentialDominant` with `Cadential64` on the 6-4 |
| Abandoned: the dominant arrives inverted, or no dominant comes | No stage 3 |
| Dominant Arrival on a final dominant (V⁷ ending a cadential progression) | Stages as in a half cadence |
| Premature dominant arrival on a triad ending a cadential progression | Stages as in a half cadence |
| Dominant Arrival on a terminal dominant, root position or inverted | No stages |

### 3. Fragment bounds follow

In contiguous mode the last stage reaches the fragment's end, so a fragment must
end at the end of its last genuine stage.

- **Abandoned cadence**, with or without a moment of arrival: the fragment ends
  where the progression is given up. The event that gives it up lies just after
  the fragment.
- **Evaded cadence:** the fragment ends at the end of its dominant stage, and the
  initiating harmony is the first event after it.
- **Dominant Arrival on a terminal dominant:** the fragment spans the last
  prolongational or sequential link into the dominant. The arrival is the last
  harmony event in the fragment.

The failing event is therefore read from the analysis data, not typed by the
editor, in line with the three-way rule of P2.

### 4. A fragment may have no stages

A concept with optional stages may have all of them absent. Contiguity governs the
stages that are present: adjacent ones share a boundary, and the outer ones meet
the main bracket. With none present there is nothing to constrain. The tool's
guard against removing the last active stage goes (E1 Step 14).

---

## Consequences

- "Every `CadentialDominant`" stays a clean set for exercises and browsing, and
  E3 and E4 get a simple rule: stage 3 is a root-position dominant.
- Absence becomes a queryable state, not a gap. `CadentialFinalTonic` already
  worked this way for evaded and abandoned cadences; the evaded cadence's
  initiating harmony sits in the stage-4 slot without being stage 4.
- A terminal-dominant arrival has no child fragment, so its location is the last
  harmony event in its range. That is enough for E4 and for display.
- An editor can remove every stage from a PAC by accident, and nothing blocks it.
  The E4 expected-stage flag catches it.
- `CadentialDominant`'s wording changes: "must be a triad" applies to a *realised*
  half cadence, because a dominant arrival on V⁷ is also a `HalfCadence`.
- Existing fragments may break the rule. E1 Step 15 lists them, and the editor
  corrects them in the tool (ADR-041). There is no bulk rewrite.

---

## Alternatives considered

- **Make the stages required on the realised concepts only.** Clean for PAC and
  IAC, but it would still need an escape for incomplete analyses, and it would put
  two mechanisms in the same edge. Rejected in favour of one field.
- **A rule list in code.** Invisible to the editor, and it duplicates the theory.
- **Prose only, as before.** E3 and E4 cannot read it.
- **Tag the stage and let the definition admit the deviation.** It needs no tool
  change and always gives a terminal dominant a child fragment. But stage 3 would
  mean "whatever dominant is around", against Caplin's axiom that it is root
  position throughout, and E3 and E4 would lose their rule.
- **A new `TerminalDominant` stage concept.** More structure for one case, against
  the decision to keep final vs terminal in the definition (Q6).
