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

`capture_extensions` is a structured property on the concept node in Neo4j. Two kinds of extension appear:

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

The `type` value tells the tagging tool and the Pydantic validator how to handle the extension. Two types are currently defined:

- `harmony_object` — a single harmony event object, persisted into `summary.concept_extensions.{field}`.
- `harmony_gate` — no persisted value; declares that approval requires all `movement_analysis` events in the fragment's range to have `reviewed: true`.

Additional types may be added as further fragment-scoped needs arise. Adding a type is a change to the Pydantic validator and the tagging-tool form renderer; no database migration is required.

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
