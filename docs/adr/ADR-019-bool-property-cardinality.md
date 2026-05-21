# ADR-019 — `BOOL` PropertySchema Cardinality

**Status:** Accepted
**Date:** 2026-05-21
**See also:** `docs/architecture/knowledge-graph-design-reference.md` § 5 (PropertySchema node fields), `docs/seed-drafts/cadences-design.md` (first consumer), `docs/roadmap/component-4-knowledge-graph.md` § Step 6 (Pydantic schema models)

---

## Context

`PropertySchema` nodes carry a `cardinality` field that governs how many values an instance may select: `ONE_OF` (mutually exclusive) or `MANY_OF` (combinable). These were the only two cardinalities defined.

Two distinct pressures surfaced the gap during the cadence-domain design (Component 4, Step 10):

1. **Typed-field-vs-property correction.** The design reference states that a typed structured field on a concept node should record something "stable across all instances of that concept" (`knowledge-graph-design-reference.md` § 2). Several cadence attributes — Expanded Cadential Progression, Covered, Unison, Premature, "reinterpreted as half cadence", "preceded by a cadential 6-4" — are binary facts that *vary per fragment instance*. They are therefore property schemas, not typed fields. But each is a simple yes/no, not a selection among named alternatives.

2. **Verbosity of the workaround.** With only `ONE_OF` and `MANY_OF` available, a binary property had to be modelled as `ONE_OF` with two declared terminal values (`Expanded` / `NotExpanded`, `Covered` / `Uncovered`, and so on). This is boilerplate: two `PropertyValue` nodes and two `HAS_VALUE` edges per boolean, none of which carry independent meaning. The cadence domain alone accumulated six such properties; across eleven planned domains the redundant value nodes would multiply.

A boolean is also the cleanest possible mapping to the tagging tool: a single toggle, no dropdown.

---

## Decision

Introduce a third cardinality value, `BOOL`, alongside `ONE_OF` and `MANY_OF`.

A `BOOL` PropertySchema:

- Has implicit `true` / `false` states. It declares **no** `values` list, **no** `PropertyValue` nodes, and **no** `HAS_VALUE` edges.
- Is subject to the `required` flag like any other schema. `required: true` means the annotator must set the toggle explicitly (true or false); `required: false` permits "unset / unknown".
- Renders in the tagging tool as a toggle.
- Stores its value in the fragment's `summary.properties` as a JSON boolean, e.g. `"ECP": true`.

The change is additive. Existing `ONE_OF` / `MANY_OF` schemas are unaffected, and no existing data needs migration.

The graph validation suite's check "every PropertySchema has at least one `HAS_VALUE` edge" (`knowledge-graph-design-reference.md` § 16, validation check 5) must be amended to exempt `BOOL` schemas, which by definition have no `HAS_VALUE` edges.

---

## Consequences

### Positive

- Binary properties are declared in one line (`cardinality: BOOL`) instead of an `ONE_OF` plus two synthetic value nodes. Less boilerplate in every domain.
- The data model matches the musical fact: a yes/no attribute is stored as a JSON boolean, not as a string drawn from a two-element enumeration.
- Clean, unambiguous tagging-tool affordance (toggle).

### Negative

- The validation suite gains a special case (skip the `HAS_VALUE` check for `BOOL`). Small, but it is a carve-out.
- A property authored as `BOOL` that later needs a third state must be migrated to `ONE_OF` with explicit values — a schema change plus a data backfill of existing fragments. The risk is low (genuinely binary attributes rarely sprout a third state) but real; authors should reach for `BOOL` only when the attribute is intrinsically binary, not merely binary today.

### Neutral

- The Pydantic seed model's `cardinality` literal expands from two members to three (`Literal["ONE_OF", "MANY_OF", "BOOL"]`). The seeding script's value-handling branches on cardinality; the `BOOL` branch creates the schema node with no value children.
- The first consumer is the cadence domain (`ECP`, `Covered`, `Unison`, `Premature`, `ReinterpretedAsHC`, `Cadential64`).

---

## Alternatives Considered

**Keep `ONE_OF` with two terminal values for booleans.** Rejected as the standing approach because it produces redundant `PropertyValue` nodes with no independent meaning, multiplied across every domain, and stores a boolean fact as a string enumeration. It remains the correct choice for any attribute that is binary *today* but plausibly tri-state later.

**Model booleans as typed structured fields on concept nodes.** Rejected because typed fields are reserved for attributes stable across all instances of a concept (`knowledge-graph-design-reference.md` § 2). These attributes vary per fragment instance, so they are properties by definition.

**A general "value-less property" mechanism rather than a named `BOOL` cardinality.** Rejected as over-engineering; the only value-less case in sight is the boolean, and naming it `BOOL` is clearer than a generic flag plus convention.
