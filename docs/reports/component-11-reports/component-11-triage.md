# Component 11 triage — glossary and tagging-tool read-through

**Date:** 2026-08-24 / 2026-08-25
**Author:** Francisco (raw lists) · investigation & triage in Claude Code
**Source:** Francisco's read-through of the glossary and the tagging tool after Step 13F, in two batches: a mostly-bug batch (items 1–7) and a mostly-design batch (items 8–13), plus item 14 split out of a mis-triaged entry on 2026-08-25.
**Status:** batch A dispositions decided and **all fix-now items landed** (`510c06f`, `4152e1c`). **Batch B deferred in full to Component 12** (Francisco, 2026-08-25) — none of it implemented. Signalled in `../../roadmap/phase-2.md` § Component 12 → *Carried in from the Component 11 triage*, which is the planning surface; this report stays the grounded detail behind each item.

This report is the canonical surface for both batches, following the pattern of
`../component-9-reports/part-8-campaign-triage.md`. Every item is grounded in
code, cited inline, and carries a disposition: **fixed**, **deferred to
Component 12**, or **defer to Phase 2**.

---

## Batch A — landed

| # | Item | Root cause | Landed |
|---|---|---|---|
| 1 | Clef wrong in the fragment viewer (K279/iii mm. 52–54) | `breaks:'smart'` does not carry a clef declared before the selection; `'none'` does. Corpus-wide — no movement declares `clef.shape` on its `staffDef`s. | `4152e1c` |
| 2 | "Cadential 6-4" label missing | The sub-part form hides a lone schema label as redundant; a BOOL is the one control with no placeholder to carry the name. | `510c06f` |
| 3 | Keys shown as "BB MAJOR" | Stored ASCII spelling rendered raw under `text-transform: uppercase`. | `510c06f` |
| 4 | Bracket clickable only on its first system | Click target gated on `seg.isFirst`. | `510c06f` |
| 5 | Stage brackets overlapping / overrunning | A range ending on a barline matched no onset, and "no onset matched" shared a branch with "no geometry available", which keeps the whole measure. | `510c06f` |
| 6 | "More specific types" as a hierarchy | Not a bug — the payload carries direct children only. | **Defer** (below) |
| 7 | "Examples" on stage pages | Stages exist only as child fragments; the draw returns top-level ones, so the section could only ever be empty. | `510c06f` |

Item 5 also exposed that the same bar/beat→pixel projection exists **three
times** and has now had the same class of endpoint bug fixed separately in each.
Filed for unification in `../../roadmap/phase-2-entry-backlog.md` § 3.

---

## Batch B — triaged, deferred in full to Component 12

### 8. Stage component value names are far too long

**What.** `Stage2Components` offers "Pre-dominant on Scale Degree 4 (IV, ii, ii6, …)" and "Pre-dominant on Raised Scale Degree 4 (applied V, +6, …)"; `Stage1Components` offers "Applied Dominant of Pre-dominant". These are the labels an editor reads on every single cadence they tag.

**Finding.** The long form is the value's `name`, and `name` is the *only* label the API carries: `PropertyValueItem` ([`backend/models/concepts.py`](../../../backend/models/concepts.py)) exposes `id`, `name`, `order`, `referenced_concept`, `translation_missing`. There is no short form and no per-value description (the ⓘ popover is per *schema*, not per value), so the disambiguating detail currently has nowhere else to live — which is presumably why it ended up in the name.

Worth knowing: `PropertyValueYAML` already has an `aliases` list, and `merge_property_value` already writes `pv.aliases` to Neo4j ([`backend/graph/queries/seed.py:72`](../../../backend/graph/queries/seed.py)) — but **no read query returns it and no model exposes it**. It is seeded and unused.

**Options.**

| | Cost | Trade-off |
|---|---|---|
| (a) Shorten `name` outright | YAML only, zero code | Loses the "(IV, ii, ii6, …)" gloss everywhere, including the glossary |
| (b) Surface the existing `aliases` as the short label | Cypher + model + frontend | No new seed field, but overloads "alias" (abbreviation) to mean "short name" |
| (c) Add `short_name` to `PropertyValueYAML` | Seed schema + merge + read query + model + frontend | Explicit; `name` stays the full form for the glossary, forms use `short_name ?? name` |

**Recommendation: (c).** Five small touch points, and it says what it means. The precedent is concept `aliases`, which already act as the short label in the score sidebar (`subPartLabel` renders the primary concept alias — "PAC" rather than "Perfect Authentic Cadence"); this gives values the same affordance without redefining `aliases`. **Disposition: deferred to Component 12** — the naming is editorial and Francisco writes the short forms.

**Resolved in Component 12, Step 15 (2026-09-05) — (c), plus a `description`.**
`short_name` alone would have forced a choice between losing the
"(IV, ii, ii6, …)" gloss and keeping it in the name, because the ⓘ is per
*schema*, so the gloss had nowhere to go. Step 15 therefore added **two**
fields to `PropertyValueYAML`: `short_name` (the context-elided label) and
`description` (per-value help). `description` rather than the referenced
concept's definition, because most values have no `references:` at all
(`SD3`, `SD5`, `Basic`, `Converging`, `Independent`, …), so a referenced
definition could never be the general home for it.

The editorial outcome, Francisco's call:

| id | `name` | `short_name` | `description` |
|---|---|---|---|
| `Stage1AppliedDominant` | Applied Dominant of Pre-dominant | Applied Dominant | — |
| `Stage2SD4` | Pre-dominant on Scale Degree 4 | On Scale Degree 4 | IV, ii, ii6, … |
| `Stage2SDSharp4` | Pre-dominant on Raised Scale Degree ♯4 | On Scale Degree ♯4 | Applied V, augmented sixths, … |

`name` stays the absolute form deliberately — it is what context-free
consumers need (exports, Component 15 distractors), and a short label cannot
be expanded back into a long one. Rendering is `short_name ?? name` in the
tagging form and the fragment record panel; both print the schema heading
beside the value, so the elided context is always present on screen.

Folded in while the ⓘ was open: it used to render the *referenced concept*,
whose definition for these values is stub boilerplate ("Stub: defined in the
harmonic-functions domain") under a title that merely repeated the value.
The ⓘ now shows the value's own `description`, falls back to a referenced
concept only when it is **not** a stub and has a real definition, and
renders nothing at all otherwise — so `ReferencedConcept` gained a `stub`
flag to make that decision possible client-side.

### 9. "Covered" and "Unison" are too rare to sit inline

**Finding — the mechanism already exists.** ADR-023 put a `group` label on the `HAS_PROPERTY_SCHEMA` edge, and `PropertyForm` already renders schemas sharing a group as a contiguous cluster under a visible group label (`groupSchemas`, [`PropertyForm.tsx:506–538`](../../../frontend/src/components/score/PropertyForm.tsx)). `Cadence` already uses it: `CadenceFunction`, `PhraseClosure` and `ThemeClosure` all carry `group: "closure"`.

So clustering `ECP` / `Covered` / `Unison` under an "Other" heading is a **YAML-only change** — three `group:` lines in `cadences.yaml`, no code at all.

**The gap.** Francisco asked to *hide* them, and a group renders expanded with a label — clustering is not collapsing. A collapsible group needs a disclosure control and a default-collapsed flag on the edge, which is real UI work.

**Recommendation:** do the YAML grouping first and see whether the cluster is enough; build collapsibility only if it is not. One editorial call for Francisco: `ECP` is arguably common enough to stay inline, in which case "Other" holds only `Covered` and `Unison`. **Disposition: deferred to Component 12** (the YAML grouping is three lines whenever it is picked up); collapsibility filed separately in the Phase-2 backlog.

### 10. Cancel/Delete at the top, Save/Submit at the bottom

**Finding.** They live in two different components. Cancel and Delete render inside `fragmentHeaderActions` in the fragment header ([`FormPanel.tsx:455–475`](../../../frontend/src/components/score/FormPanel.tsx)) and appear **only in edit mode**. Save Draft and Submit for Review are props of `SubmissionChecklist`, rendered at the panel's foot (`FormPanel.tsx:676–700`), and appear **always**. Nothing but layout ties them apart — no state or ordering constraint.

**Recommendation:** one action row at the foot, with the destructive action visually separated from the constructive ones. The one wrinkle is the mode asymmetry: the row must read sensibly with two buttons (create: Save / Submit) and with four (edit: Cancel / Delete / Save changes). Cheap, but it is a design-system decision — `DESIGN.md` should be consulted for the destructive-action treatment, since there is no existing precedent for one in this panel. **Disposition: deferred to Component 12**, whose design pass already owns the shared button library (F8–F13).

### 11. What is IAC's "Soprano Scale Degree", and why does it look like the stage components?

**What it is.** The scale degree the soprano arrives on at the cadential arrival of an Imperfect Authentic Cadence — 3 or 5. A PAC is degree 1 by definition, so this is the axis on which the two IAC flavours differ; the concept definition already says so ("most commonly on scale degree 3, less commonly on scale degree 5").

**Why it looks that way — by design, not a bug.** `PropertyForm` switches presentation on **value count, not cardinality**: ≤2 values render inline, >2 render as a popover dropdown ([`PropertyForm.tsx:291` and `:371`](../../../frontend/src/components/score/PropertyForm.tsx)). `IACSopranoDegree` is ONE_OF with exactly two values, so it renders inline as a radio pair — visually the same family as `Stage1Components`/`Stage2Components`, which are MANY_OF with two values and render as a checkbox pair.

**The real concern underneath.** An exclusive choice (radio) and a multi-select (checkbox) that look alike is a genuine usability problem, independent of the threshold: the control should tell the editor whether picking a second value replaces the first or adds to it. Worth checking on screen whether the radio and checkbox states are visually distinct in this design system — 0px radii and tonal-only depth make the usual circle-vs-square cue weak.

**Recommendation:** no functional change; verify the radio/checkbox distinction on screen and strengthen it if it is not obvious. **Disposition: investigation answered; the design check rides Component 12's design pass.**

### 12. A fragment too short for its stages shows *no* stages at all

**The one bug-like item, and the detection is already written.**

`computeAutoPrePopulate` ([`ScoreViewer.tsx:352–358`](../../../frontend/src/routes/ScoreViewer.tsx)) computes `blocked` when the selection cannot seat every stage even at sub-beat resolution, and returns empty assignments. Its own docstring states the contract:

> `blocked` is true when the selection cannot fit stages even at sub-beat resolution — **the caller should surface a UI note** and keep assignments empty.

The caller does half of it. `blocked` is stored in `stageGridBlocked` (`ScoreViewer.tsx:685`) and used at `:1812` to force `complete = false`, correctly preventing submission — **but it is never rendered anywhere**. The editor sees the stages silently vanish with no explanation, and the workaround (select wider, mark stages absent, shrink again) is undiscoverable, exactly as Francisco describes.

So this is not a broken computation; it is a notice that was specified and never built. The fix is to render it — the state is already in hand and already correct.

**Recommendation:** show a note in the stage area when `stageGridBlocked` is true, saying the selection is too short for the concept's stages and offering the remedy (lengthen the selection, or mark stages absent). Small. **Disposition: deferred to Component 12.** Rare in practice, but the failure mode is silent, which is the worst kind — worth pulling forward if anything else touches the stage area first.

### 13. Capture extensions — roadmapped, or missing?

**Answer: neither, quite. They are declared, seeded, and never captured — and no component's plan owns building them.**

`cadences.yaml` declares four, beyond the `harmony_gate` added in 13F:

| Field | Type | Concept |
|---|---|---|
| `post_evasion_harmony` | `harmony_object` | `EvadedCadence` |
| `prior_ac_pointer` | `fragment_pointer` | `ReopeningHalfCadence` |
| `prior_cadence_pointer` | `fragment_pointer` | `ClosingSection` |
| `prior_cadence_pointer` | `fragment_pointer` | `StandingOnTheDominant` |

What exists: the YAML schema (`CaptureExtensionYAML`), persistence as a JSON string on the concept node ([`seed.py:301`](../../../backend/graph/queries/seed.py)), and a storage slot on the fragment — `summary.concept_extensions` ([`backend/models/fragment.py:102`](../../../backend/models/fragment.py)), which is an always-empty dict today.

What does not exist: **any consumer**. The only code that reads `capture_extensions` is the `harmony_gate` ancestor check ([`concepts.py:412`](../../../backend/graph/queries/concepts.py)). Nothing exposes the declarations on a concept payload, nothing renders a control for them, and nothing validates a captured value. `harmony_gate` is the sole implemented type — and it is the one type that needs no capture UI, because its whole effect is on the approval gate.

**Roadmap status.** `cadences-design.md` § Open items records the `fragment_pointer` validator as "a code task for the YAML/seed pass" — never done. `component-15-exercises.md:256–259` records "the unimplemented capture-extensions concept … may constrain which concepts are cleanly exercisable — triage during implementation of this component". So the gap is *known and referenced downstream*, but no plan owns closing it.

**Why it matters more than a missing field.** For `ReopeningHalfCadence` the pointer is not an optional extra: per `cadences-design.md` § departures, that concept exists as a concept at all *because* the relationship is constituted at the instance level and captured by a backward pointer. Tagging one today records the concept but not the thing that makes it that concept. The same holds, more weakly, for the two post-cadential concepts, whose `FOLLOWS` edge says which *kind* of cadence they follow but not *which* one.

**Recommendation: Phase-2 backlog item**, scoped as: expose declarations on the concept payload → render a control per type (`harmony_object` = a harmony picker, `fragment_pointer` = a fragment picker pre-populated from the nearest preceding tagged match, per `capture_extensions.md` § Fragment Pointers) → validate on write → surface on the read models. Note in the entry that `harmony_gate` is already done, so the remaining work is the two *capturing* types. **Disposition: defer to Phase 2**, and record it in the backlog with the close-out.

### 14. Six of the ten taggable cadence concepts render an unlabelled bracket

**Added 2026-08-25, correcting this report.** The `issues-deferred-for-phase-2.md`
entry "279/ii m. 3: evaded no text" was first written up here as the missing
`post_evasion_harmony` capture extension (item 13). Francisco corrected that:
they are two different problems. This is the other one, and it is still live.

**Finding.** A stored fragment's bracket takes its label from the concept's
*alias*, with no fallback:

```tsx
// FragmentOverlay.tsx — parent bracket
alias: frag.primary_concept_alias,
…
{seg.isFirst && alias !== null && (<span className={bracketStyles.aliasLabel}>{alias}</span>)}
```

and **six of the ten taggable cadence concepts declare no alias**:
`EvadedCadence`, `AbandonedCadence`, `ReopeningHalfCadence`, `DominantArrival`,
`ClosingSection`, `StandingOnTheDominant`. Only PAC, IAC, DC and HC have one, so
only those four brackets carry text; the other six are silently nameless.

The asymmetry is the tell. The *sub-part* path in the same file already solves
this deliberately — `subPartLabel` falls back `alias ?? name ?? "Part N"`, and
its docstring says so explicitly ("the whole-score stage lane is never
nameless"). The parent path never got the same treatment.

**Options.**

| | Cost | Trade-off |
|---|---|---|
| (a) Fall back to the concept name on the parent bracket | One line, matches `subPartLabel` | "Standing on the Dominant" is long for a bracket label — which is why aliases exist |
| (b) Add aliases to the six concepts in `cadences.yaml` | YAML only | Several have no conventional abbreviation; inventing one is an editorial call |
| (c) Both | — | Aliases where a conventional short form exists, name as the guaranteed floor so nothing is ever nameless |

**Recommendation: (c).** The fallback is the correctness fix and should land
regardless — a nameless bracket is never the intended outcome; aliases are then
a display improvement on top, wherever Francisco is happy to coin one. Note this
is the same underlying gap as item 8: the display needs a short label and the
data model only reliably carries a long one. Worth solving once, together.

**Disposition: deferred to Component 12**, with item 8.

**Resolved in Component 12, Step 15 (2026-09-05) — (c), as recommended.**
The fallback landed on both surfaces that label a fragment by alias: the
parent bracket (`FragmentOverlay.tsx`) and the review queue
(`ReviewQueue.tsx`), the latter reached through a new
`ReviewQueueItem.primary_concept_name` — the queue payload carried the alias
only, so it had nothing to fall back *to*. This confirmed M4's naming piece
("Evaded Cadences are not named as such in the review queue") as the same
alias gap, resolved by the same rule.

Aliases Francisco coined, mostly following Caplin: `Ev.Cad.`
(`EvadedCadence`), `Abnd.` (`AbandonedCadence`), `Dom.Arr.`
(`DominantArrival`), `HC (reopening)` (`ReopeningHalfCadence`), and `DC` →
`Dec.Cad.` for consistency with them. `ClosingSection` and
`StandingOnTheDominant` keep no alias — no conventional abbreviation exists
— which is exactly the case the fallback now covers.

---

## Carried forward from batch A

**6. "More specific types" as a hierarchy.** `ConceptPage` maps `concept.children`, which the API defines as *direct* `IS_SUBTYPE_OF` children only. Nesting needs descendant data the concept-detail payload does not carry; the index endpoint already returns a domain forest the frontend assembles, so the pieces exist, but it is an API-shape decision plus a component rewrite. **Defer to Phase 2** — filed in `../../roadmap/phase-2-entry-backlog.md` § 3 (2026-08-25).

---

## Summary of dispositions

| Disposition | Items |
|---|---|
| **Landed in Component 11** | 1, 2, 3, 4, 5, 7 |
| **Landed in Component 12** | 10 (button row), 11 (radio/checkbox design check) — Step 14; 8 (short names), 14 (unlabelled brackets) — Step 15 |
| **Deferred to Component 12** | 9 (grouping) — Step 16; 12 (blocked notice) — Step 17 |
| **Re-homed to Component 15** | 13 (capture extensions) — see the Component 12 plan, § Decisions |
| **Phase-2 backlog** | 6 (glossary hierarchy), collapsible property groups, bracket-geometry unification |

Deferring batch B in full was Francisco's call (2026-08-25). The items are
small individually, but they cluster around the tagging tool's chrome and the
design system, and splitting them would mean two design passes over the same
panel. Item 13 is the exception: a capture feature with no relationship to
Component 12's purpose, sitting there only because nothing else owns it.
