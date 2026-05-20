# Cadence Domain — Design Draft

**Status:** Draft. To be converted to `backend/seed/domains/cadences.yaml` once peer-reviewed.

**Date:** 2026-05-16

**Supersedes:** the working draft circulated during the Component 4 Step 10 discussion. This document is the agreed simplification of that draft, arrived at over three review passes.

**See also:** `docs/architecture/knowledge-graph-design-reference.md` (three-layer architecture, modelling decision rules), `docs/architecture/edge-vocabulary-reference.md` (authoritative edge types), `docs/architecture/knowledge-graph-domain-map.md` (domain scope), `docs/adr/ADR-011-multi-level-tagging-design.md` (tagging tool design and the `top_level_taggable` / `display_mode` / `containment_mode` / `default_weight` conventions), `docs/architecture/capture_extensions.md`.

---

## Context and goals

This document captures the cadence-domain knowledge-graph design that emerged from collaborative iteration on an earlier draft. The earlier draft tried to encode three distinct things at the concept-type layer: morphology (what notes/chords are present), outcome (whether the cadence is realised, deviates, or fails), and function (the formal role the cadence plays). Only morphology genuinely belongs in the concept hierarchy; outcomes and functions are better modelled as property schemas. The design below applies that principle systematically.

The design also targets future portability beyond the Classical repertoire. By keeping all `CONTAINS` edges optional and letting cadence subtypes carry expected morphologies in prose rather than enforced structure, the same vocabulary should extend to Baroque through and late-Romantic practices without requiring new subtypes per repertoire.

The result is roughly seventeen concept nodes in the cadence domain proper (down from ~30 in the original draft), a small set of property schemas, the four stage leaf concepts, and the usual stubs in adjacent domains.

The theoretical reference throughout is Caplin, *Cadence: A Study of Closure in Tonal Music* (2024).

---

## Top-level taxonomy

```
Cadence  [abstract; top_level_taggable: false]
│ contains:   InitialTonic (1), PreDominant (2), Dominant (3)   — all required: false
│ schemas:    CadenceFunction, PhraseClosure, ThemeClosure,
│             ECP, Covered, Unison
│
├── AuthenticCadence
│   │ contains:  FinalTonic (4, required: false)
│   ├── AuthenticCadenceRealised
│   │   │ schemas: HalfCadenceVariant
│   │   ├── PerfectAuthenticCadence
│   │   └── ImperfectAuthenticCadence
│   │         schemas: IACSopranoDegree
│   ├── DeceptiveCadence
│   ├── EvadedCadence            [capture_extensions: post_evasion_harmony]
│   └── AbandonedCadence
│
└── HalfCadence
    ├── HalfCadenceRealised
    │     schemas: HalfCadenceShape
    └── DominantArrival
          schemas: Premature

Stages (leaves, top_level_taggable: false):
  InitialTonic   schemas: Stage1Components
  PreDominant    schemas: Stage2Components
  Dominant       schemas: DominantElaboration
  FinalTonic     (no stage-specific schema)

Post-cadential (top-level concepts, FOLLOWS edges):
  ClosingSection      FOLLOWS AuthenticCadence
  StandingOnDominant  FOLLOWS HalfCadence
```

`Cadence`, `AuthenticCadence`, `HalfCadence`, `AuthenticCadenceRealised`, and `HalfCadenceRealised` carry `top_level_taggable: false` because they are abstract or intermediate categories; an annotator who selects "cadence" should always pick a specific subtype (PAC, DC, …). Stage concepts carry `top_level_taggable: false` because they have no analytical meaning outside a parent cadence — a passage that "is a prolonged dominant" outside a cadential context is a different concept living in the Prolongation domain. This is exactly the override pattern ADR-011 §5 anticipated for stage concepts that have no independent tagging use case.

**[`HalfCadenceRealised` MUST BE `top_level_taggable:true`!]**

---

## Concept inventory

For each concept: `id`, parent (`IS_SUBTYPE_OF`), `CONTAINS` edges if any, schemas attached at this level. Prose definitions are seed text that the YAML will expand.

### Abstract parent

**Cadence**
*Subtype of:* (none — the domain root; `BELONGS_TO` the `cadences` domain node)
*Contains:* `InitialTonic` (order 1, required: false, default_weight: 1.0), `PreDominant` (order 2, required: false, default_weight: 1.0), `Dominant` (order 3, required: false, default_weight: 1.0).
*Schemas:* `CadenceFunction`, `PhraseClosure`, `ThemeClosure`, `ECP`, `Covered`, `Unison`.
*top_level_taggable:* false.
*Definition seed:* "A close marking the end of a phrase, theme, or section in tonal music. A cadence typically proceeds through a sequence of harmonic stages (initial tonic, pre-dominant, dominant...) toward an arrival point. The specific morphology and outcome of the close determines the cadence subtype."

### Authentic-cadence branch

**AuthenticCadence**
*Subtype of:* `Cadence`.
*Contains:* `FinalTonic` (order 4, required: false, default_weight: 1.0).
*Schemas:* (none beyond inherited).
*top_level_taggable:* false.
*Definition seed:* "A cadence whose dominant moves toward a final tonic event. Includes both realised forms (PAC, IAC) and deviations from the expected resolution (deceptive, evaded, abandoned)."

**AuthenticCadenceRealised**
*Subtype of:* `AuthenticCadence`.
*Schemas:* `HalfCadenceVariant`.
*top_level_taggable:* false.
*Definition seed:* "An authentic cadence in which the expected final tonic is actually delivered. The differentia from the deviation subtypes is morphological: the cadence reaches its Stage 4 root-position tonic on the metric arrival point."

**PerfectAuthenticCadence**
*Subtype of:* `AuthenticCadenceRealised`.
*Schemas:* (none beyond inherited).
*top_level_taggable:* true.
*Definition seed:* "A realised authentic cadence in which the soprano voice arrives on scale degree 1 (and both V and I are in root position). The strongest cadential close in the tonal system."

**ImperfectAuthenticCadence**
*Subtype of:* `AuthenticCadenceRealised`.
*Schemas:* `IACSopranoDegree`.
*top_level_taggable:* true.
*Definition seed:* "A realised authentic cadence whose soprano does not arrive on scale degree 1 — most commonly on scale degree 3, less commonly on scale degree 5. Weaker than a PAC; characteristic of antecedent phrases of periods and as a way station to a subsequent PAC."

**DeceptiveCadence**
*Subtype of:* `AuthenticCadence`.
*Schemas:* (none beyond inherited).
*top_level_taggable:* true.
*Definition seed:* "An authentic cadence whose dominant resolves to a substitute chord (most commonly VI) in place of the expected tonic. The cadential gesture is morphologically complete through Stage 3; the substitution occurs at the resolution."

**EvadedCadence**
*Subtype of:* `AuthenticCadence`.
*Schemas:* (none beyond inherited).
*Capture extensions:*

```yaml
- field: post_evasion_harmony
  type: harmony_object
  required: true
  description: "First harmony immediately following the evasion."
```

*top_level_taggable:* true.
*Definition seed:* "An authentic cadence whose dominant fails to resolve: the expected Stage 4 is replaced mid-stream by an unrelated harmony, typically launching a new phrase or repetition, as in the 'one-more-time' technique."

**AbandonedCadence**
*Subtype of:* `AuthenticCadence`.
*Schemas:* (none beyond inherited).
*top_level_taggable:* true.
*Definition seed:* "An authentic cadence whose progression breaks before any cadential arrival, typically by inverting the dominant or interrupting before Stage 3 completes. Where the evaded cadence fails at the cadential arrival, the abandoned cadence undermines or avoids altogether the cadential dominant."

### Half-cadence branch

**HalfCadence**
*Subtype of:* `Cadence`.
*Schemas:* (none beyond inherited).
*top_level_taggable:* false.
*Definition seed:* "A cadence that arrives on the dominant rather than the tonic. The cadential gesture closes on Stage 3 — the dominant is the arrival, not a preparation for further resolution. Includes the realised form and Dominant Arrival as a deviation."

**HalfCadenceRealised**
*Subtype of:* `HalfCadence`.
*Schemas:* `HalfCadenceShape`.
*top_level_taggable:* true.
*Definition seed:* "A half cadence whose dominant is reached through a cadential progression — i.e. preceded by an initial tonic or pre-dominant function. Variants are captured by the `HalfCadenceShape` property."

**DominantArrival**
*Subtype of:* `HalfCadence`.
*Schemas:* `Premature`.
*top_level_taggable:* true.
*Definition seed:* "A dominant that either disolves the cadential closure by inversion or addition of the seventh, or that is achieved not by cadential progression but through non-cadential means — for example by direct prolongation of V from a prior dominant region, or as the goal of a sequence that simply lands on V."

### Stage concepts (leaves)

**InitialTonic**
*Schemas:* `Stage1Components`.
*top_level_taggable:* false.
*Definition seed:* "Stage 1 of a cadence: the opening tonic region from which the cadential motion departs. May consist of a tonic harmony alone, an applied dominant of the pre-dominant, or both in succession."

**PreDominant**
*Schemas:* `Stage2Components`.
*top_level_taggable:* false.
*Definition seed:* "Stage 2 of a cadence: the predominant function preceding the cadential dominant. May include scale degree 4, frequently in the bass (subdominant family: IV, ii, ii6, …), raised scale degree 4 (applied dominants of V, augmented sixths), or both in succession."

**Dominant**
*Schemas:* `DominantElaboration`.
*top_level_taggable:* false.
*Definition seed:* "Stage 3 of a cadence: the cadential dominant. In Caplinian theory must be a root-position V or V7, optionally preceded by a cadential 6-4 elaboration. The dominant of a half cadence is the arrival point, and must be a triad; the dominant of an authentic cadence prepares Stage 4."

**FinalTonic**
*Schemas:* (none).
*top_level_taggable:* false.
*Definition seed:* "Stage 4 of a cadence: the tonic arrival in an authentic cadence (or the substitute chord in a deceptive cadence). Absent in half cadences and in evaded or abandoned authentic cadences."

### Post-cadential concepts

**ClosingSection**
*Edges:* `FOLLOWS` → `AuthenticCadence`.
*Capture extensions:* `prior_cadence_pointer` (the prior AC fragment id; the form pre-populates from the nearest preceding tagged AC).
*top_level_taggable:* true.
*Definition seed:* "A post-cadential section that follows an authentic cadence, prolonging the tonic with closing material before the next phrase or theme begins. Distinguished from a new theme by its rhetorical and harmonic dependence on the prior cadence."

**StandingOnTheDominant**
*Edges:* `FOLLOWS` → `HalfCadence`.
*Capture extensions:* `prior_cadence_pointer` (the prior HC fragment id; pre-populated).
*top_level_taggable:* true.
*Definition seed:* "A post-cadential section that follows a half cadence, prolonging the dominant — typically as the close of a transition or at the end of the development."

---

## Property schemas

### Cadence-level schemas

**CadenceFunction**
*Cardinality:* ONE_OF.
*Required:* true.
*Values (terminal — no VALUE_REFERENCES):*

| id | name |
|---|---|
| `LimitedScope` | "Limited Scope" |
| `WayStation` | "Way Station" |
| `Independent` | "Independent" |

The function of an individual cadence is mutually exclusive across these three. `Independent` indicates that the cadence closes a formal unit in its own right; `WayStation` indicates a deferral (typically toward an eventual stronger cadence); `LimitedScope` indicates a cadence gesture whose closing force is contained within a minor formal level, such as it doesn't exert a real cadential function on the phrase & theme levels.

**PhraseClosure**
*Cardinality:* MANY_OF.
*Required:* false. *Pydantic-layer rule:* only meaningful when `CadenceFunction = Independent`. Enforced at write-time, not in the graph.
*Values:* each VALUE_REFERENCES a Formal Function stub.

| id | name | references |
|---|---|---|
| `ClosesSentence` | "Closes a Sentence" | `Sentence` |
| `ClosesPeriod` | "Closes a Period" | `Period` |
| `ClosesAntecedentPhrase` | "Closes an Antecedent" | `AntecedentPhrase` |
| `ClosesConsequentPhrase` | "Closes a Consequent" | `ConsequentPhrase` |
| `ClosesHybridTheme` | "Closes a Hybrid Theme" | `HybridTheme` |
| `ClosesCompoundAntecedent` | "Closes a Compound Antecedent" | `CompoundAntecedent` |
| `ClosesCompoundConsequent` | "Closes a Compound Consequent" | `CompoundConsequent` |

(Starter list. Expand when the Formal Function domain is built out.)

**ThemeClosure**
*Cardinality:* MANY_OF.
*Required:* false. *Pydantic-layer rule:* only meaningful when `CadenceFunction = Independent`.
*Values:* each VALUE_REFERENCES a Formal Function stub.

| id | name | references |
|---|---|---|
| `ClosesMainTheme` | "Closes a Main Theme" | `MainTheme` |
| `ClosesTransition` | "Closes a Transition" | `Transition` |
| `ClosesSubordinateTheme` | "Closes a Subordinate Theme" | `SubordinateTheme` |
| `ClosesClosingTheme` | "Closes a Closing Theme" | `ClosingTheme` |
| `ClosesCodaTheme` | "Closes a Coda Theme" | `CodaTheme` |

(Starter list. Expand when the Formal Function domain is built out.)

**ECP** (Expanded Cadential Progression)
*Cardinality:* ONE_OF.
*Required:* false.
*Values (terminal):* `Expanded`, `NotExpanded`.

**Covered**
*Cardinality:* ONE_OF.
*Required:* false.
*Values (terminal):* `Covered`, `Uncovered`.

**Unison**
*Cardinality:* ONE_OF.
*Required:* false.
*Values (terminal):* `Unison`, `NotUnison`.

### Subtype-level schemas

**HalfCadenceVariant** (on `AuthenticCadenceRealised`)
*Cardinality:* ONE_OF.
*Required:* false.
*Values (terminal):* `ReinterpretedHC`, `ReopenedHC`.

The two values describe cases where a morphologically authentic cadence carries the *functional* weight of a half cadence — Reinterpreted (the AC arrival is heard retroactively as launching an HC) and Reopened (the closure of an AC is undone and a subsequent HC takes over the cadential weight). Mutually exclusive.

**IACSopranoDegree** (on `ImperfectAuthenticCadence`)
*Cardinality:* ONE_OF.
*Required:* false.
*Values (terminal):* `SD3`, `SD5`.

**HalfCadenceShape** (on `HalfCadenceRealised`)
*Cardinality:* MANY_OF.
*Required:* false.
*Values (terminal):* `Basic`, `Converging`, `Expanding`.

MANY_OF because hybrid shapes (expanding-then-converging, etc.) do occur in repertoire.

**Premature** (on `DominantArrival`)
*Cardinality:* ONE_OF.
*Required:* false.
*Values (terminal):* `Premature`, `OnTime`.

### Stage-level schemas

**Stage1Components** (on `InitialTonic`)
*Cardinality:* MANY_OF.
*Required:* false.
*Values:* each VALUE_REFERENCES a harmonic-function stub.

| id | name | references |
|---|---|---|
| `Stage1Tonic` | "Tonic" | `Tonic` |
| `Stage1AppliedDominant` | "Applied Dominant of Pre-Dominant" | `AppliedDominant` |

**Stage2Components** (on `PreDominant`)
*Cardinality:* MANY_OF.
*Required:* false.
*Values:* each VALUE_REFERENCES a harmonic-function stub.

| id | name | references |
|---|---|---|
| `Stage2SD4` | "Predominant on Scale Degree 4 (IV, ii, ii6, …)" | `SD4Predominant` |
| `Stage2SharpSD4` | "Predominant on Raised Scale Degree 4 (applied V, +6, …)" | `SD#4Predominant` |

**DominantElaboration** (on `Dominant`)
*Cardinality:* MANY_OF.
*Required:* false.
*Values:* each VALUE_REFERENCES a harmonic-function stub (or its own concept node).

| id | name | references |
|---|---|---|
| `Cadential64` | "Cadential 6-4" | `CadentialSixFour` |

(Starter list. Future additions might include other Stage-3 elaborations as Caplin's vocabulary is exhausted.)

**[I disagree on the shape of this one. Difficult to extend, as 6-4 is a sub-stage in its own right. Right now I would call it something like `Cadential64`, cardinality `BOOL` (see below). If we rather keep a harmonic concept node reference, as in the other stages, we can leave it like that, but with no intention to expand the list really.]**

---

## Adjacent-domain stubs

The cadence domain references concepts owned by domains that have not yet been built. Per `knowledge-graph-design-reference.md` § 15 and the Component 4 Step 11 plan, stub nodes live in their eventual home domain file, not in a separate stubs file. The stubs needed:

**`backend/seed/domains/harmonic-functions.yaml`**

- `Tonic`
- `AppliedDominant`
- `SD4Predominant`
- `SD#4Predominant`
- `CadentialSixFour`

**`backend/seed/domains/formal-function.yaml`**

Phrase-level: `Sentence`, `Period`, `AntecedentPhrase`, `ConsequentPhrase`, `HybridTheme`, `CompoundAntecedent`, `CompoundConsequent`.

Theme-level: `MainTheme`, `Transition`, `SubordinateTheme`, `ClosingTheme`, `CodaTheme`.

**`backend/seed/domains/prolongation.yaml`**

- `ContrapuntalCadence` (with `CONTRASTS_WITH` → `AuthenticCadence`; the future Prolongation domain will split this into Soprano / Tenor / Alto variants, probably as a `DominantInversion` property rather than as three sibling subtypes).

All stubs carry `stub: true`, `top_level_taggable: false`, and a placeholder definition ("Stub: defined in the X domain."). When their home domain is built out, the `stub` flag is removed and the definition filled in — the seed script's `MERGE` semantics handle the promotion transparently.

---

## Notes on the bool / property modelling decision

A late issue in the review pinned this down: the design reference says a typed structured field on a concept node should record something "stable across all instances of that concept" (`knowledge-graph-design-reference.md` § 2). Fragment-instance-specific bools like ECP, Covered, Unison, and Premature all *vary* across instances of the same concept type (the concept `PerfectAuthenticCadence` doesn't have a unitary ECP value — each tagged PAC is or isn't ECP). They are therefore property schemas, not typed fields.

The architecture currently supports two cardinalities (`ONE_OF`, `MANY_OF`) and no `BOOL`. Bool-style properties are therefore modelled as `ONE_OF` with two terminal values (`Expanded` / `NotExpanded`, `Covered` / `Uncovered`, `Unison` / `NotUnison`, `Premature` / `OnTime`). This is slightly verbose but consistent with the existing schema vocabulary.

A future small architecture amendment could introduce a `BOOL` cardinality with implicit True/False values, eliminating the redundant terminal-value declarations. This would be an additive change to the Pydantic schema and the seeding script with no breakage to existing data. Worth considering when we have a clearer sense of how many bool-style properties accumulate across all domains; not urgent now.

**[I think I'm in for setting this `BOOL` cardinality. We have four, possibly five, only in cadence. Also, among other things, it translates cleanly to tagging tool: a toggle!]**

---

## Notes on departures from `knowledge-graph-design-reference.md`

Several places where this design differs from the reference document. Each is a deliberate revision worth flagging when the design-reference is next updated.

**`CadentialElaboration` schema decomposed.** The design reference's Example 1 puts all elaborations (Cadential64, AppliedDominant, NeapolitanApproach, ChromaticPreDominant) into one schema on Cadence. This bundles elaborations of three different stages into a single value list and obscures what each value describes. The present design instead attaches per-stage component schemas to the stage concepts themselves: `Stage1Components`, `Stage2Components`, `DominantElaboration`. The analytical content is the same; the modelling is sharper.

**`SopranoPosition` schema dropped.** The reference document attaches `SopranoPosition` (values SD1, SD3, SD5) to `AuthenticCadence`. In this design, PAC vs IAC carries the SD1-vs-other distinction at the subtype level, and IAC's internal SD3/SD5 variation is captured by `IACSopranoDegree` on IAC itself. No `SopranoPosition` schema is needed.

**Stage concepts as leaves with property schemas, not as compound concepts with `CONTAINS` substages.** The reference's § 9 worked example splits `PreDominant` into `SimplePredominant` (property-driven) and `CompoundPredominant` (CONTAINS-driven Substage2a/2b). The present design keeps a single `PreDominant` leaf concept and captures the component identity via `Stage2Components` (MANY_OF). The structural-claim cost is real (we lose the assertion that compound Stage 2 has two ordered substages) but the temporal ordering is recoverable from the harmonic events in `movement_analysis`, and the simpler model travels better to repertoires with different stage decompositions.

**All `CONTAINS` edges `required: false`.** The design reference is silent on the question of whether stage requirements should be enforced at the structural level; the present design says no, every stage is optional. The cadence subtype carries the morphological expectation in its prose definition; tag-time reality says what is actually present. This frees the model to handle non-conforming cadences (Baroque, late-Romantic) without needing repertoire-specific subtype splits, and supports the "let laws emerge from tagging" stance taken in the review discussion.

**Stage concepts set to `top_level_taggable: false`.** ADR-011 §5 set the default to `true` (rationale: a prolonged dominant region might be tagged standalone). The present design exercises the explicit override the ADR anticipated: the four cadence-stage concepts have no analytical meaning outside a parent cadence; passages that are dominant prolongations live in the Prolongation domain as distinct concepts, not as cadence-stage tags.

---

## Open items

The following are deferred to the appropriate later step or to community / peer review; they are not blockers for the YAML pass.

- **`default_weight` values on `CONTAINS` edges.** For the first seed, set to 1.0 across all stages (equal distribution). Refine empirically once tagging sessions accumulate. Per ADR-011 §6, the field is set at the graph level and read by the tagging tool — no UI code change required to tune.
- **`confidence` field on the fragment tag.** A base-schema concern (not per-concept). To be specified in `docs/architecture/fragment-schema.md` when that doc is next updated. Pedagogical hook: difficulty calibration for exercise assignment.
- **Reinterpreted / Reopened HC and the implied subsequent HC.** A cross-fragment relationship — explicitly excluded by `knowledge-graph-domain-map.md`'s Thematic/Motivic exclusion principle (cross-fragment identity relationships are not modelled). The `HalfCadenceVariant` property records the AC's deferred-HC status; the subsequent HC is just tagged separately. A future query can correlate them by proximity if needed.
- **Formal Function vocabulary.** The starter list of phrase- and theme-level closure values is a sketch; the Formal Function domain (Component-after-next) will produce the authoritative set. Adding values to `PhraseClosure` / `ThemeClosure` later is non-breaking.
- **`DominantElaboration` value list.** Currently only `Cadential64`. Caplin's full vocabulary of Stage-3 elaborations should be reviewed once the cadence YAML stabilises.
- **`BOOL` cardinality as an architecture amendment.** Optional. Eliminates the `Expanded`/`NotExpanded`-style verbosity in property declarations. Defer until we have a count of bool-style properties across all domains.
- **`Premature` vs nuanced timing categories on `DominantArrival`.** Currently a two-value ONE_OF. If Caplin or repertoire study suggests intermediate categories (early / on-time / late), expanding the value list is non-breaking.
- **Adding `CadenceType` typed structured fields back to the design reference.** The current design-reference table lists "approach function, resolution function" as typed structured fields for `CadenceType`, which doesn't reflect the present design (function is a property, approach is captured by stage CONTAINS + properties). Worth a small update to the design reference to either drop the row or replace it with a more honest minimal set.

---

## Hard-locked decisions from the review

For future reference, when this design is questioned:

1. **Tripartite split (Basic / Deviation / Prolongational) dropped.** Single hierarchy under `Cadence` → `AuthenticCadence` / `HalfCadence`. Deviations are subtypes of their respective parents. Prolongational closure stubs out to the Prolongation domain (single `ContrapuntalCadence` stub for now).
2. **Symmetric `*Realised` intermediate nodes.** Both `AuthenticCadenceRealised` and `HalfCadenceRealised` exist, partly for schema-hosting and partly for clarity of the proper-vs-deviation distinction. Asymmetric was a defensible alternative but rejected.
3. **Stages are leaf concepts, not compound nodes.** Component identity captured via property schemas, not via further `CONTAINS` substages.
4. **All `CONTAINS` edges optional.** Morphological commitment lives in prose, not in structural required-ness. Trusts the cadence subtype to communicate expected shape.
5. **Function modelled as property, not as concept-type hierarchy.** `CadenceFunction` (ONE_OF: LimitedScope, WayStation, Independent), with `PhraseClosure` and `ThemeClosure` as two MANY_OF schemas only meaningful when `Independent` is selected.
6. **Stage `top_level_taggable: false`.** Explicit override of ADR-011's default for the cadence-domain stages.
7. **Bool-style properties as ONE_OF schemas with two terminal values.** Consistent with the existing cardinality vocabulary. **[Review if we decide to go ahead with `BOOL`.]**
8. **Ambiguity captured by a `confidence` field plus prose, not by double-tagging.**
9. **Cross-fragment relationships (Reopened HC's "implied subsequent HC", Way Station's "terminal cadence") not modelled.** Domain-map exclusion of cross-fragment identity links applies.

**[About this last point 9, on cross-fragment relationships: I think the situation is similar to the Cadence/Post-Cadence case: there we signal the relationship at concept level with `FOLLOWS`, and at the fragment level with a `prior_cadence_pointer` through capture_extensions. Here the relationship is similar, with some caveats: both situations are signaled through properties (reopened, way station), so the relationship is not inherent to the concept node; also, way station could be un-fulfilled, without the actual terminal; and obvious tagging workflow in reopened is weird here, as the HC would probably be untagged when the AC reopened is being tagged. Ideas?]**
