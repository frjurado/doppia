# Cadence Domain — Design Draft

**Status:** Draft. To be converted to `backend/seed/domains/cadences.yaml` once peer-reviewed.

**Date:** 2026-05-16

**Supersedes:** the working draft circulated during the Component 4 Step 10 discussion. This document is the agreed simplification of that draft, arrived at over three review passes.

**See also:** `docs/architecture/knowledge-graph-design-reference.md` (three-layer architecture, modelling decision rules), `docs/architecture/edge-vocabulary-reference.md` (authoritative edge types), `docs/architecture/knowledge-graph-domain-map.md` (domain scope), `docs/adr/ADR-011-multi-level-tagging-design.md` (tagging tool design and the `top_level_taggable` / `display_mode` / `containment_mode` / `default_weight` conventions), `docs/adr/ADR-019-bool-property-cardinality.md` (the `BOOL` cardinality used by this domain), `docs/architecture/capture_extensions.md`.

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
│   │   │ schemas: ReinterpretedAsHC
│   │   ├── PerfectAuthenticCadence
│   │   └── ImperfectAuthenticCadence
│   │         schemas: IACSopranoDegree
│   ├── DeceptiveCadence
│   ├── EvadedCadence            [capture_extensions: post_evasion_harmony]
│   └── AbandonedCadence
│
└── HalfCadence
    ├── HalfCadenceRealised      [top_level_taggable: true]
    │   │ schemas: HalfCadenceShape
    │   └── ReopeningHalfCadence  [FOLLOWS AuthenticCadenceRealised;
    │                              capture_extensions: prior_ac_pointer]
    └── DominantArrival
          schemas: Premature

Stages (leaves, top_level_taggable: false):
  InitialTonic   schemas: Stage1Components
  PreDominant    schemas: Stage2Components
  Dominant       schemas: Cadential64
  FinalTonic     (no stage-specific schema)

Post-cadential (top-level concepts, FOLLOWS edges):
  ClosingSection      FOLLOWS AuthenticCadence
  StandingOnDominant  FOLLOWS HalfCadence
```

`Cadence`, `AuthenticCadence`, `HalfCadence`, and `AuthenticCadenceRealised` carry `top_level_taggable: false` because they are abstract or intermediate categories; an annotator who selects "cadence" should always pick a specific subtype (PAC, DC, …). `HalfCadenceRealised` is `top_level_taggable: true`: unlike `AuthenticCadenceRealised` (which always resolves to PAC or IAC), a realised half cadence is itself a terminal, directly-taggable type — it has only one specialisation (`ReopeningHalfCadence`, a cross-fragment special case) and is fully meaningful tagged on its own. Stage concepts carry `top_level_taggable: false` because they have no analytical meaning outside a parent cadence — a passage that "is a prolonged dominant" outside a cadential context is a different concept living in the Prolongation domain. This is exactly the override pattern ADR-011 §5 anticipated for stage concepts that have no independent tagging use case.

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
*Schemas:* `ReinterpretedAsHC`.
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

**ReopeningHalfCadence**
*Subtype of:* `HalfCadenceRealised`.
*Edges:* `FOLLOWS` → `AuthenticCadenceRealised`.
*Schemas:* (inherits `HalfCadenceShape`).
*Capture extensions:*

```yaml
- field: prior_ac_pointer
  type: fragment_pointer
  required: true
  description: "The authentic-cadence fragment whose closure this half cadence reopens."
```

*top_level_taggable:* true.
*Definition seed:* "A realised half cadence that retrospectively undoes the closure of a preceding authentic cadence: the AC appears to close, but a subsequent arrival on the dominant reopens the cadential process and assumes the cadential weight. Modelled as a distinct concept (rather than a property on the AC) so the cross-fragment relationship can be captured by a backward pointer at tagging time — mirroring the post-cadential `FOLLOWS` pattern, where the pointer lives on the later fragment that is tagged after the earlier one already exists."

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
*Schemas:* `Cadential64`.
*top_level_taggable:* false.
*Definition seed:* "Stage 3 of a cadence: the cadential dominant. In Caplinian theory must be a root-position V or V7, optionally preceded by a cadential 6-4 elaboration. The dominant of a half cadence is the arrival point, and must be a triad; the dominant of an authentic cadence prepares Stage 4."

**FinalTonic**
*Schemas:* (none).
*top_level_taggable:* false.
*Definition seed:* "Stage 4 of a cadence: the tonic arrival in an authentic cadence (or the substitute chord in a deceptive cadence). Absent in half cadences and in evaded or abandoned authentic cadences."

### Post-cadential concepts

**ClosingSection**
*Edges:* `FOLLOWS` → `AuthenticCadence`.
*Capture extensions:* `prior_cadence_pointer` (type `fragment_pointer`; the prior AC fragment id; the form pre-populates from the nearest preceding tagged AC).
*top_level_taggable:* true.
*Definition seed:* "A post-cadential section that follows an authentic cadence, prolonging the tonic with closing material before the next phrase or theme begins. Distinguished from a new theme by its rhetorical and harmonic dependence on the prior cadence."

**StandingOnTheDominant**
*Edges:* `FOLLOWS` → `HalfCadence`.
*Capture extensions:* `prior_cadence_pointer` (type `fragment_pointer`; the prior HC fragment id; pre-populated).
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
| `ClosesHybridTheme` | "Closes a Hybrid Theme" | `HybridTheme` |
| `ClosesAntecedent` | "Closes an Antecedent" | `Antecedent` |
| `ClosesConsequent` | "Closes a Consequent" | `Consequent` |
| `ClosesContinuation` | "Closes a Continuation" | `Continuation` |

(Seeded subset — see "Seeding strategy for formal-function closure" below. The full intended vocabulary lives in `docs/seed-drafts/formal-function-design-notes.md`.)

**ThemeClosure**
*Cardinality:* MANY_OF.
*Required:* false. *Pydantic-layer rule:* only meaningful when `CadenceFunction = Independent`.
*Values:* each VALUE_REFERENCES a Formal Function stub.

| id | name | references |
|---|---|---|
| `ClosesMainTheme` | "Closes a Main Theme" | `MainTheme` |
| `ClosesTransition` | "Closes a Transition" | `Transition` |
| `ClosesSubordinateTheme` | "Closes a Subordinate Theme" | `SubordinateTheme` |
| `ClosesCoda` | "Closes a Coda" | `Coda` |

(Seeded subset — see "Seeding strategy for formal-function closure" below. The full intended vocabulary lives in `docs/seed-drafts/formal-function-design-notes.md`.)

#### Seeding strategy for formal-function closure

`PhraseClosure` and `ThemeClosure` reference the Formal Function domain, which will not be fully modelled until a later component. Rather than wait, we seed a small, deliberately *stable* subset of formal-function stubs now (the bedrock Caplinian terms above) so that the most common, least-ambiguous closure facts can be captured at tagging time — tagging of the present corpus begins before the Formal Function domain is built, so this data is collected during that window rather than reconstructed later.

The approach rests on three properties of the architecture:

- **`CadenceFunction` is the required floor.** Every cadence records its functional weight (Limited Scope / Way Station / Independent) regardless. `PhraseClosure` / `ThemeClosure` are the *optional* enrichment layer naming the specific unit closed; a cadence with both left blank is still not uninformative.
- **Only stable values are seeded.** Adding a new schema value later is non-breaking (design reference, "Forward-compatible schema evolution"); only *renaming or restructuring* a value forces re-mapping. So we seed only the terms unlikely to change — the abstract `HybridTheme` (its four subtypes deferred), `Antecedent` / `Consequent` (the compound variants deferred, as they may become property variations rather than distinct nodes).
- **Both schemas are optional.** Incomplete is never blocked. The later pass, once the Formal Function domain lands, is *enrichment* (add finer values, fill blanks) rather than *correction*. Blanks are queryable, so "cadences needing a closure pass" is a one-line query.

Deliberately deferred for now (held in `formal-function-design-notes.md`): the four hybrid subtypes, `CompoundAntecedent` / `CompoundConsequent`, and all section- and movement-level functions beyond `Coda`.

**ECP** (Expanded Cadential Progression)
*Cardinality:* BOOL.
*Required:* false.

**Covered**
*Cardinality:* BOOL.
*Required:* false.

**Unison**
*Cardinality:* BOOL.
*Required:* false.

### Subtype-level schemas

**ReinterpretedAsHC** (on `AuthenticCadenceRealised`)
*Cardinality:* BOOL.
*Required:* false.

True when a morphologically authentic cadence is heard as carrying the *functional* weight of a half cadence — the single-event "reinterpreted HC" case (the AC arrival is heard retroactively as launching an HC). The two-event "reopened HC" case — where a subsequent, separate half cadence undoes the AC's closure — is modelled instead as the `ReopeningHalfCadence` concept, not as a property here.

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
*Cardinality:* BOOL.
*Required:* false.

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

**Cadential64** (on `Dominant`)
*Cardinality:* BOOL.
*Required:* false.

True when the cadential dominant is preceded by a cadential 6-4. Modelled as a BOOL rather than a value in an elaboration bucket: the cadential 6-4 is a near-sub-stage of the dominant, structurally unlike the heterogeneous "elaborations" a MANY_OF list would have to mix. Any future Stage-3 elaboration (e.g. a dominant pedal) gets its own named BOOL rather than joining a shared bucket. The `CadentialSixFour` concept still exists as a stub in `harmonic-functions.yaml`; a fragment with `Cadential64 = true` is conceptually related to it, correlatable at the service layer (and via the harmony events in `movement_analysis` within the Dominant stage's range).

---

## Adjacent-domain stubs

The cadence domain references concepts owned by domains that have not yet been built. Per `knowledge-graph-design-reference.md` § 15 and the Component 4 Step 11 plan, stub nodes live in their eventual home domain file, not in a separate stubs file. The stubs needed:

**`backend/seed/domains/harmonic-functions.yaml`**

- `Tonic`
- `AppliedDominant`
- `SD4Predominant`
- `SD#4Predominant`
- `CadentialSixFour`

**`backend/seed/domains/formal-function.yaml`** (seeded subset only — see "Seeding strategy for formal-function closure" above; the full intended domain is in `formal-function-design-notes.md`)

Phrase-level: `Sentence`, `Period`, `HybridTheme`, `Antecedent`, `Consequent`, `Continuation`.

Theme-level: `MainTheme`, `Transition`, `SubordinateTheme`, `Coda`.

**`backend/seed/domains/prolongation.yaml`**

- `ContrapuntalCadence` (with `CONTRASTS_WITH` → `AuthenticCadence`; the future Prolongation domain will split this into Soprano / Tenor / Alto variants, probably as a `DominantInversion` property rather than as three sibling subtypes).

All stubs carry `stub: true`, `top_level_taggable: false`, and a placeholder definition ("Stub: defined in the X domain."). When their home domain is built out, the `stub` flag is removed and the definition filled in — the seed script's `MERGE` semantics handle the promotion transparently.

---

## Notes on the bool / property modelling decision

A late issue in the review pinned this down: the design reference says a typed structured field on a concept node should record something "stable across all instances of that concept" (`knowledge-graph-design-reference.md` § 2). Fragment-instance-specific bools like ECP, Covered, Unison, Premature, ReinterpretedAsHC, and Cadential64 all *vary* across instances of the same concept type (the concept `PerfectAuthenticCadence` doesn't have a unitary ECP value — each tagged PAC is or isn't ECP). They are therefore property schemas, not typed fields.

These bool-style properties use `cardinality: BOOL`, the third cardinality introduced by ADR-019. A BOOL schema has implicit true/false states and declares no `values` list. This eliminates the verbose `Expanded`/`NotExpanded`-style two-value enumerations that the prior `ONE_OF`-only vocabulary would have required, and it maps cleanly onto a toggle in the tagging tool. The cadence domain alone has six such properties (`ECP`, `Covered`, `Unison`, `Premature`, `ReinterpretedAsHC`, `Cadential64`), which is what tipped the decision from "defer" to "do now."

---

## Notes on departures from `knowledge-graph-design-reference.md`

Several places where this design differs from the reference document. Each is a deliberate revision worth flagging when the design-reference is next updated.

**`CadentialElaboration` schema decomposed.** The design reference's Example 1 puts all elaborations (Cadential64, AppliedDominant, NeapolitanApproach, ChromaticPreDominant) into one schema on Cadence. This bundles elaborations of three different stages into a single value list and obscures what each value describes. The present design instead attaches per-stage schemas to the stage concepts themselves: `Stage1Components` and `Stage2Components` (MANY_OF, with VALUE_REFERENCES) on the Initial Tonic and Pre-Dominant stages, and a `Cadential64` BOOL on the Dominant stage. The analytical content is the same; the modelling is sharper.

**`SopranoPosition` schema dropped.** The reference document attaches `SopranoPosition` (values SD1, SD3, SD5) to `AuthenticCadence`. In this design, PAC vs IAC carries the SD1-vs-other distinction at the subtype level, and IAC's internal SD3/SD5 variation is captured by `IACSopranoDegree` on IAC itself. No `SopranoPosition` schema is needed.

**Stage concepts as leaves with property schemas, not as compound concepts with `CONTAINS` substages.** The reference's § 9 worked example splits `PreDominant` into `SimplePredominant` (property-driven) and `CompoundPredominant` (CONTAINS-driven Substage2a/2b). The present design keeps a single `PreDominant` leaf concept and captures the component identity via `Stage2Components` (MANY_OF). The structural-claim cost is real (we lose the assertion that compound Stage 2 has two ordered substages) but the temporal ordering is recoverable from the harmony events in `movement_analysis`, and the simpler model travels better to repertoires with different stage decompositions.

**All `CONTAINS` edges `required: false`.** The design reference is silent on the question of whether stage requirements should be enforced at the structural level; the present design says no, every stage is optional. The cadence subtype carries the morphological expectation in its prose definition; tag-time reality says what is actually present. This frees the model to handle non-conforming cadences (Baroque, late-Romantic) without needing repertoire-specific subtype splits, and supports the "let laws emerge from tagging" stance taken in the review discussion.

**Stage concepts set to `top_level_taggable: false`.** ADR-011 §5 set the default to `true` (rationale: a prolonged dominant region might be tagged standalone). The present design exercises the explicit override the ADR anticipated: the four cadence-stage concepts have no analytical meaning outside a parent cadence; passages that are dominant prolongations live in the Prolongation domain as distinct concepts, not as cadence-stage tags.

**Two-event closure relationships modelled as concepts, not properties.** The "reopened HC" case — where a subsequent half cadence undoes a prior authentic cadence's closure — is a relationship between two distinct fragments. Rather than a forward-pointing property on the AC (which fails at tagging time, since the HC is not yet tagged when the AC is annotated), it is modelled as a dedicated `ReopeningHalfCadence` concept carrying a `FOLLOWS` edge to `AuthenticCadenceRealised` and a backward `prior_ac_pointer` capture extension — exactly mirroring the post-cadential `FOLLOWS` pattern. The single-event "reinterpreted HC" case remains a property (`ReinterpretedAsHC`) on the AC, because there is only one fragment involved.

---

## Open items

The following are deferred to the appropriate later step or to community / peer review; they are not blockers for the YAML pass.

- **`default_weight` values on `CONTAINS` edges.** For the first seed, set to 1.0 across all stages (equal distribution). Refine empirically once tagging sessions accumulate. Per ADR-011 §6, the field is set at the graph level and read by the tagging tool — no UI code change required to tune.
- **`confidence` field on the fragment tag.** A base-schema concern (not per-concept). To be specified in `docs/architecture/fragment-schema.md` when that doc is next updated. Pedagogical hook: difficulty calibration for exercise assignment.
- **`fragment_pointer` capture-extension type.** Registered in `capture_extensions.md` (§ Fragment Pointers) as the third extension type, used by `ClosingSection`, `StandingOnTheDominant`, and `ReopeningHalfCadence`. The Pydantic validator implementation (target fragment exists + carries the edge's target concept) remains a code task for the YAML/seed pass.
- **WayStation fulfilment not modelled.** A `WayStation` cadence implies an eventual terminal cadence, but the relationship is deliberately not modelled: a WayStation may be unfulfilled, and any cadence can serve as the terminal, so a dedicated terminal-cadence concept would over-fit. Fulfilment is observed via fragment chronology at query time. (Contrast the Reopened HC case, which *is* modelled — see departures above — because the reopening HC's identity is constituted by its relationship to the prior AC.)
- **Formal Function vocabulary.** Only a stable subset of closure values is seeded now (see "Seeding strategy for formal-function closure"); the full intended vocabulary is captured in `formal-function-design-notes.md` and will be authored when the Formal Function domain is modelled. Adding values then is non-breaking; a one-time enrichment pass over cadences tagged in the interim fills blanks and adds finer values.
- **`Premature` nuance.** Currently a BOOL on `DominantArrival`. If Caplin or repertoire study suggests intermediate timing categories (early / on-time / late), switching to a `ONE_OF` with named values is non-breaking.
- **Adding `CadenceType` typed structured fields back to the design reference.** The current design-reference table lists "approach function, resolution function" as typed structured fields for `CadenceType`, which doesn't reflect the present design (function is a property, approach is captured by stage CONTAINS + properties). Worth a small update to the design reference to either drop the row or replace it with a more honest minimal set.

---

## Hard-locked decisions from the review

For future reference, when this design is questioned:

1. **Tripartite split (Basic / Deviation / Prolongational) dropped.** Single hierarchy under `Cadence` → `AuthenticCadence` / `HalfCadence`. Deviations are subtypes of their respective parents. Prolongational closure stubs out to the Prolongation domain (single `ContrapuntalCadence` stub for now).
2. **Symmetric `*Realised` intermediate nodes.** Both `AuthenticCadenceRealised` and `HalfCadenceRealised` exist, partly for schema-hosting and partly for clarity of the proper-vs-deviation distinction. Asymmetric was a defensible alternative but rejected. (`HalfCadenceRealised` is itself directly taggable; `AuthenticCadenceRealised` is not, because it always resolves to PAC/IAC.)
3. **Stages are leaf concepts, not compound nodes.** Component identity captured via property schemas, not via further `CONTAINS` substages.
4. **All `CONTAINS` edges optional.** Morphological commitment lives in prose, not in structural required-ness. Trusts the cadence subtype to communicate expected shape.
5. **Function modelled as property, not as concept-type hierarchy.** `CadenceFunction` (ONE_OF: LimitedScope, WayStation, Independent), with `PhraseClosure` and `ThemeClosure` as two MANY_OF schemas only meaningful when `Independent` is selected.
6. **Stage `top_level_taggable: false`.** Explicit override of ADR-011's default for the cadence-domain stages.
7. **Bool-style properties use `cardinality: BOOL`.** The third cardinality, introduced in ADR-019; replaces the earlier "ONE_OF with two terminal values" workaround. Six such properties in the cadence domain (`ECP`, `Covered`, `Unison`, `Premature`, `ReinterpretedAsHC`, `Cadential64`).
8. **Ambiguity captured by a `confidence` field plus prose, not by double-tagging.**
9. **Cross-fragment relationships modelled only where they fit the `FOLLOWS` + backward-pointer pattern.** The Reopened HC case becomes the `ReopeningHalfCadence` concept (FOLLOWS `AuthenticCadenceRealised` + `prior_ac_pointer`). Relationships that don't fit — a WayStation's eventual terminal cadence — remain unmodelled (a WayStation may be unfulfilled, any cadence can be a terminal). The single-event Reinterpreted HC case is a property, not a cross-fragment link.
