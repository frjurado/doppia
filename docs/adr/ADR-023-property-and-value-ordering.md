# ADR-023 — Property and Value Ordering (`order` / `group` on `HAS_PROPERTY_SCHEMA` and `HAS_VALUE`)

**Status:** Accepted
**Date:** 2026-06-03
**See also:** `docs/architecture/edge-vocabulary-reference.md` (`HAS_PROPERTY_SCHEMA` and `HAS_VALUE` definitions; `order` precedent on `CONTAINS`), `docs/architecture/knowledge-graph-design-reference.md` (§ 5 PropertySchema node fields; § 6–7 edge property tables), `docs/adr/ADR-019-bool-property-cardinality.md` (PropertySchema cardinality; first consumer: cadences domain), `docs/architecture/fragment-schema.md` (schema-tree payload), `backend/seed/domains/cadences.yaml` (first consumer of this ordering mechanism)

---

## Context

Property schemas linked to a concept via `HAS_PROPERTY_SCHEMA` edges are currently returned in non-deterministic graph traversal order. Similarly, the permitted values linked to a schema via `HAS_VALUE` edges have no declared order. This causes two concrete problems in the tagging tool:

1. **Property form order is non-deterministic.** Semantically related properties — `CadenceFunction`, `PhraseClosure`, and `ThemeClosure` — should always appear together and in that sequence, because `PhraseClosure` and `ThemeClosure` are only meaningful when `CadenceFunction` is `Independent`. Any random permutation misleads the annotator.

2. **Value order within a property schema is non-deterministic.** Stage component properties like `Stage1Components` have a natural progression — Tonic comes before Applied Dominant of Pre-Dominant — that reflects the musical logic of the stage. Shuffling these values erodes that logic.

The `CONTAINS` edge already carries an `order` property (used to sequence cadence stages), establishing the precedent that edge properties are the right place to record display-time ordering in this graph model. Extending the same pattern to `HAS_PROPERTY_SCHEMA` and `HAS_VALUE` is the smallest-footprint fix: no new node types, no schema migration, no frontend-side hardcoding of concept-specific logic.

**On required-vs-optional and sort position.** An earlier draft proposed sorting required properties before optional ones ("required-first band"). This was rejected on the grounds that the required/optional split is a *visual annotation* concern, not a *grouping* concern: a tagger needs to fill in the required property `CadenceFunction` before interpreting the optional `PhraseClosure` and `ThemeClosure`, but those three belong together in the form regardless of their required status. Enforcing a required-first band would split logically related properties apart whenever they mix required and optional entries within the same group. The solution is to mark required properties with `*` and let `group`/`order` govern position.

---

## Decision

### 1. Add `order` (int, optional) to `HAS_PROPERTY_SCHEMA` edges

Controls the display position of a property schema in the tagging form. Integer, 1-based by convention. Unset (`null`) means "sort after all numbered schemas, ties broken alphabetically by name."

### 2. Add `group` (string, optional) to `HAS_PROPERTY_SCHEMA` edges

A label that clusters related schemas visually in the form. All schemas sharing the same non-null `group` value are rendered as a contiguous block; groups are sorted by the lowest `order` value among their members. Schemas with no `group` are rendered ungrouped, after all grouped schemas.

No fixed group vocabulary is defined here; group labels are free-form strings declared in the seed YAML and are purely a display hint — they are not concept nodes or enumerated values.

### 3. Add `order` (int, optional) to `HAS_VALUE` edges

Controls the display position of a permitted value within a property schema's value list (e.g. `Stage1Tonic` before `Stage1AppliedDominant` in `Stage1Components`). Same null-sorts-last semantics as above. No `group` on `HAS_VALUE` — value lists are flat.

### 4. Sort criterion: `(group, order, name)` — required status does not affect position

The form renders property schemas in the order: sort by group (groups sorted by their minimum `order`; no-group last), then by `order` within the group (unset last), then alphabetically by `name` as a final tiebreaker.

Required and optional schemas are **not** separated by sort position. Required status is indicated by a `*` marker in the form label. This lets a group like "closure" contain `CadenceFunction` (required) alongside `PhraseClosure` and `ThemeClosure` (optional) without forcing a split.

### 5. YAML shape for `property_schemas` under concept entries

`property_schemas` entries change from a bare id list to a list of objects:

```yaml
property_schemas:
  - schema: CadenceFunction
    order: 1
    group: "closure"
  - schema: PhraseClosure
    order: 2
    group: "closure"
  - schema: ThemeClosure
    order: 3
    group: "closure"
  - schema: ECP
    order: 4
    group:
```

A bare string entry (legacy form) is treated as `{schema: id, order: null, group: null}` by the seed loader for backward compatibility, but new entries must use the object form.

### 6. YAML shape for values within `property_schemas` definitions

An `order` field is added to each value entry in a `property_schema` definition block:

```yaml
values:
  - id: Stage1Tonic
    name: "Tonic"
    order: 1
    references: Tonic
  - id: Stage1AppliedDominant
    name: "Applied Dominant of Pre-Dominant"
    order: 2
    references: AppliedDominant
```

Unset `order` on a value sorts it after all numbered values, ties by `name`.

### 7. Seed loader persists `order` and `group` onto edges using MERGE

The seed script merges `order` and `group` onto the `HAS_PROPERTY_SCHEMA` relationship and `order` onto the `HAS_VALUE` relationship as edge properties, consistent with the `CONTAINS` edge's existing `order` handling. Bare `CREATE` is never used (CLAUDE.md invariant).

### 8. Schema-tree query returns `order` and `group`

The `concept_schema_tree` query in `backend/graph/queries/concepts.py` includes `order` and `group` from the `HAS_PROPERTY_SCHEMA` edge and `order` from the `HAS_VALUE` edge in its return payload, so the frontend receives fully-ordered data and performs no independent sort beyond applying the `(group, order, name)` rule.

---

## Consequences

### Positive

- Property and value order is **schema-driven**: declared once in the YAML, propagated to the graph edge, returned in the schema-tree payload, and consumed by the form renderer with no concept-specific logic anywhere in the frontend.
- Related properties can cluster regardless of required status, which better reflects musical semantics (a tagger sees `CadenceFunction → PhraseClosure → ThemeClosure` as a coherent trio, not split by the required/optional boundary).
- The `order` precedent from `CONTAINS` edges is reused exactly — no new pattern introduced.
- Group labels are free-form: no graph vocabulary change needed when a new domain defines new groupings.

### Negative

- `property_schemas` entries in existing YAML files must change from bare strings to objects (a one-time migration on those files). The seed loader gains a small backward-compatibility shim for the legacy string form to avoid forcing simultaneous updates of every domain file.
- The schema-tree query payload grows two fields per schema entry (`order`, `group`) and one field per value entry (`order`). Negligible, but it is a payload change — `fragment-schema.md` must document it.
- If two schemas in the same group have the same `order`, the tie is broken by `name` (alphabetical). Authors should avoid duplicate `order` values within a group.

### Neutral

- `BOOL` schemas (ADR-019) participate in this ordering exactly like `ONE_OF`/`MANY_OF` schemas — they have a `HAS_PROPERTY_SCHEMA` edge and therefore carry `order`/`group`. They have no `HAS_VALUE` edges by definition, so the value-ordering rule does not apply to them.
- The first consumer is `backend/seed/domains/cadences.yaml`. Every subsequent domain file uses the same shape.
- `validate_graph.py` does not need a new check for this: `order`/`group` are optional edge properties; their absence is valid and is treated as sort-last. A future check for "duplicate order within the same concept's property schemas" would be a quality lint, not a structural invariant.

---

## Alternatives Considered

**Sort required properties before optional (required-first band).** Rejected. It forces a split between logically related properties that mix required and optional status (e.g. `CadenceFunction`, `PhraseClosure`, `ThemeClosure`). Required status is a completion constraint, not a semantic grouping criterion. A `*` marker communicates required status at the label level without disturbing the declared order.

**Store `order`/`group` on the `PropertySchema` node itself rather than on the edge.** Rejected. The same `PropertySchema` node may be linked to multiple concepts via separate `HAS_PROPERTY_SCHEMA` edges (e.g. `CadenceFunction` is inherited down the `IS_SUBTYPE_OF` hierarchy). Storing order on the node would force a single global position regardless of context; edge properties allow the same schema to appear at different positions under different parent concepts. This mirrors the `CONTAINS` `order` precedent exactly.

**A fixed vocabulary of group names enforced by the graph (group as a node type).** Rejected. Groups are display-time clusters with no semantic content in the knowledge graph; promoting them to concept nodes would inflate the graph with presentation concerns. Free-form strings on edges keep the boundary clean.

**Frontend-side ordering rules (hardcode concept-specific sort logic in the form).** Rejected. Hardcoding concept-specific order in frontend code creates a maintenance coupling between the knowledge graph and the UI layer that the schema-driven design explicitly avoids. Any concept-level display preference must be expressible via graph data.
