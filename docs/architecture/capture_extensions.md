# `capture_extensions` — Design Reference

## Purpose

`capture_extensions` is a structured specification on a concept node that tells the tagging tool what additional data to collect when a fragment of that concept type is annotated. It is the concept node's authority over what the annotator is asked to provide, beyond the base schema.

---

## The Four Schema Layers

Fragment data is composed from four distinct sources, each with a different home:

| Layer | What it captures | Where it lives |
|---|---|---|
| **Base schema** | Spatial and contextual metadata always meaningful regardless of concept type: bar/beat boundaries, key, meter | System-level Pydantic base model |
| **`capture_extensions`** | Concept-type-specific data the annotator must provide: harmony arrays, post-evasion harmony, or any other structured field analytically meaningful for that type and not derivable automatically | Concept node in Neo4j |
| **Sub-fragments** | Child fragment records created by the tagging tool when the concept has `CONTAINS` edges to stage or component nodes; each child has its own base schema and `capture_extensions` | Fragment table, linked via `parent_fragment_id` |
| **Computed fields** | Values derivable at retrieval time from existing data: bar length, ECP flag derived from stage presence, etc. | Preprocessing pipeline or query-time derivation |

---

## Key Principles

**Harmony review is not universal, but harmony storage is.** Chord-level harmonic analysis is stored once per movement in `movement_analysis` (see `docs/architecture/fragment-schema.md`), regardless of which concepts are tagged. What `capture_extensions` controls is **whether a concept requires harmony in its range to be reviewed before its fragments can be approved** — a `CadenceStage` concept declares a `harmony` extension, which triggers the approval-time review gate; a `Hemiola` does not, and approval of a Hemiola fragment proceeds without examining the harmonic content. The harmony is *visible* in both cases (via the movement-level record); it is only *analytically required* for the concepts that declare it.

**`capture_extensions` handles what neither the base schema, movement-level analysis, nor sub-fragments cover.** The clearest example is `EvadedCadence`: the harmony immediately following the evasion is a single named datum that is not a stage (no `CONTAINS` edge points to it), not universally meaningful for every concept, and not part of the base schema. It requires a specific annotator input, specified by the concept node, and lands in the fragment's `summary.concept_extensions.post_evasion_harmony`.

**If it's computable, it belongs in the pipeline, not in `capture_extensions`.** Bar length, for instance, is `bar_end - bar_start` — a retrieval-time computation. Adding it to `capture_extensions` would burden annotators with recording something the system already knows.

**`capture_extensions` must support structured values, not just scalars.** A harmony object has multiple fields; a post-evasion-harmony is a single such object. The spec format must be expressive enough to describe both scalars and structured values (and, if ever needed, arrays of structured values).

**Fields are a flat, shared namespace.** `summary.concept_extensions` is a flat object keyed by field name, not by concept. If two of a fragment's concepts both declare the same field name (e.g. both declare `harmony`), they share a single value — there are never two copies of the same analytical fact on one fragment. This imposes a discipline on concept-spec authors: **when two concepts declare a field with the same name, the type, required-ness, and semantics must agree.** If two concepts need genuinely different data with similar-sounding meaning, give them different field names (`harmony` vs. `post_evasion_harmony`). This rule is analogous to GraphQL's field-consistency rule across types and is enforced by the concept-seed validation at graph load time.

---

## Concept Node Structure

`capture_extensions` is a structured property on the concept node in Neo4j, stored as a **single JSON-encoded string** under `c.capture_extensions`. Neo4j properties cannot hold nested maps or lists of maps, so the list of extension specs is serialised to JSON on write and parsed back on read. It is inert specification metadata: never traversed, never placed in the full-text index. The tagging tool and the Pydantic write layer read it — including specs inherited via `IS_SUBTYPE_OF` (collected over an `IS_SUBTYPE_OF*0..` walk and merged) — and the flat-namespace field-consistency rule (below) is enforced in the seed loader at graph-load time, not by the graph itself. Modelling it as child nodes was rejected: it carries no relationships and is never queried in Cypher, so a dedicated node label and edge type would add vocabulary for no traversal benefit.

Two kinds of extension appear:

**Genuinely fragment-scoped fields** — data that is specific to this fragment and does not live anywhere else. These are stored on the fragment under `summary.concept_extensions.{field_name}`. `post_evasion_harmony` on `EvadedCadence` is the canonical example.

**Review-gate declarations** — a concept that declares `harmony` is asserting that the harmonic analysis in its range is analytically central to the concept, and approval of its fragments therefore depends on the harmony events in `movement_analysis` being reviewed. These do not add data to `summary.concept_extensions` (the data already lives in `movement_analysis`); their effect is purely on the approval gate. See `docs/architecture/fragment-schema.md` § "Fragment approval and harmony review".

```yaml
- id: EvadedCadence
  name: "Evaded Cadence"
  capture_extensions:
    # Fragment-scoped: lands in summary.concept_extensions.post_evasion_harmony
    - field: post_evasion_harmony
      type: harmony_object
      required: true
      description: "First harmony immediately following the evasion"

- id: CadenceStage
  name: "Cadence Stage"
  capture_extensions:
    # Review-gate: triggers approval-time review of movement_analysis events in the fragment's range.
    # No data is persisted to summary.concept_extensions; the harmony is already in movement_analysis.
    - field: harmony
      type: harmony_gate
      required: true
      description: "Harmony events in the fragment's range must be reviewed before approval"
```

The `type` value tells the tagging tool and the Pydantic validator how to handle the extension. Three types are currently defined:

- `harmony_object` — a single harmony event object, persisted into `summary.concept_extensions.{field}`.
- `harmony_gate` — no persisted value; declares that approval requires all `movement_analysis` events in the fragment's range to have `reviewed: true`.
- `fragment_pointer` — a reference to another fragment, persisted into `summary.concept_extensions.{field}` as the target fragment's id. Captures an instance-level cross-fragment relationship: a post-cadential section pointing back at the cadence it prolongs, or a reopening half cadence pointing back at the authentic cadence it undoes. See "Fragment Pointers" below.

Additional types may be added as further fragment-scoped needs arise. Adding a type is a change to the Pydantic validator and the tagging-tool form renderer; no database migration is required.

---

## Fragment Pointers

The `fragment_pointer` type captures a relationship between two fragments where the relationship is constituted at the instance level rather than being inherent to the concept. Three cadence-domain concepts use it: `ClosingSection` and `StandingOnTheDominant` (each points back at the cadence it prolongs) and `ReopeningHalfCadence` (points back at the authentic cadence whose closure it undoes).

```yaml
- id: ClosingSection
  name: "Closing Section"
  capture_extensions:
    - field: prior_cadence_pointer
      type: fragment_pointer
      required: true
      description: "The cadence fragment this post-cadential section prolongs."

- id: ReopeningHalfCadence
  name: "Reopening Half Cadence"
  capture_extensions:
    - field: prior_ac_pointer
      type: fragment_pointer
      required: true
      description: "The authentic-cadence fragment whose closure this half cadence reopens."
```

**The pointer lives on the later fragment.** The dependent fragment (the closing section, the reopening HC) is tagged *after* the fragment it refers to already exists, so a backward pointer is always resolvable at tagging time. A forward pointer would force the annotator to revisit an earlier fragment once the later one is created.

**The target concept comes from the concept's edge, not the field spec.** A `fragment_pointer` field is paired with the concept's `FOLLOWS` edge, which declares the target concept. The tagging tool reads that edge to pre-populate the field with the nearest preceding fragment tagged with the target concept (or a subtype). The field spec carries no target constraint of its own — duplicating the edge's target on the field would risk the two disagreeing. Example: `ClosingSection FOLLOWS AuthenticCadenceRealised` means its `prior_cadence_pointer` pre-populates from the nearest preceding fragment tagged as a realised authentic cadence (PAC or IAC) — the deviations (DC, EC, abandoned) are excluded because they never reach the tonic a closing section prolongs (see ADR-020 §6).

**Field naming follows the shared-namespace rule.** Because `summary.concept_extensions` is a flat namespace, two concepts that declare the same field name must agree on type, required-ness, and semantics. `ClosingSection` and `StandingOnTheDominant` share `prior_cadence_pointer` — same semantics ("the cadence this post-cadential section prolongs"), differing only in target type, which each concept's `FOLLOWS` edge supplies. `ReopeningHalfCadence` uses a distinct field name `prior_ac_pointer` because its relationship (undoing closure) is genuinely different in meaning from prolongation, even though the stored datum (a prior-AC fragment id) has the same shape.

**Validation.** The Pydantic write layer validates that the pointed-to fragment exists in PostgreSQL and carries a concept tag matching — or subtyping — the edge's target concept. The relationship is not a Neo4j edge: like all fragment-to-fragment links it is resolved at the application layer. This stays within the line the domain map draws (no Neo4j fragment nodes, no `fragment_relationship` graph) — the pointer is a single datum in the fragment's `summary`, not a general inter-fragment identity graph.

---

## Tagging Tool Behaviour

When a concept is selected, the tagging tool reads the concept's `capture_extensions` (including any inherited via `IS_SUBTYPE_OF`) and dynamically appends the specified fields to the standard annotation form. No concept-specific logic is hardcoded in the frontend. The Pydantic validation layer enforces required fields and type constraints before any write reaches the database.

Fragment-scoped extension values land in the fragment's `summary` JSONB under a `concept_extensions` key, in the flat shared namespace described above:

```json
{
  "concepts": ["EvadedCadence"],
  "properties": {},
  "concept_extensions": {
    "post_evasion_harmony": { "root": 1, "quality": "major", "inversion": 0, "numeral": "I" }
  }
}
```

Review-gate extensions (like `harmony` on `CadenceStage`) contribute nothing to `concept_extensions` — their effect is on the approval check, not on stored fragment data.

---

## When to Add `capture_extensions` to a Node

Add `capture_extensions` when all of the following hold:

- The data is analytically meaningful for this concept type specifically
- It cannot be derived automatically by the preprocessing pipeline
- It is not already captured by the base schema
- It is not better modelled as a sub-fragment via `CONTAINS`
