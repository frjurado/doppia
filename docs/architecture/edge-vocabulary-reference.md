# Edge Vocabulary Reference
## Knowledge Graph — Music Theory Tutor System

**Status:** Revised  
**Date:** 2026-04-13  
**Supersedes:** Edge vocabulary tables in `knowledge-graph-system.md`, `knowledge-graph-modelling-guide.md`, and `music_theory_tutor_architecture.md`

---

## Design Principles

1. **No redundant inverses.** Neo4j supports reverse traversal natively (`<-[:EDGE_TYPE]-`). An inverse edge type is only warranted when it carries semantics the reverse traversal does not — not merely a direction flip.

2. **Earn your edge type.** A new edge type must express a relationship that cannot be captured by an existing type plus an edge property. The vocabulary should stay small enough to reason over systematically.

3. **Cross-database joins are virtual.** Relationships that span Neo4j and PostgreSQL (concept → fragment) are resolved at the application layer, not materialized as Neo4j edges.

---

## Active Edge Types

### Concept ↔ Concept

| Edge type | Direction | Meaning | Notes |
|---|---|---|---|
| `IS_SUBTYPE_OF` | Child → Parent | Taxonomic hierarchy. "PAC is a subtype of Authentic Cadence." | Drives PropertySchema inheritance. Single hierarchy edge for all taxonomic depth; replaces the former `IS_A` / `IS_SUBTYPE_OF` split. |
| `BELONGS_TO` | Concept → Domain | Domain membership. "Neapolitan Sixth belongs to the Harmony domain." | Lightweight domain classification. Domain nodes are simple grouping entities, not full concept nodes with definitions. |
| `CONTAINS` | Whole → Part | Structural composition with ordered, required/optional components. "Authentic Cadence contains a Dominant stage." | Carries edge properties: `order`, `required`, `display_mode`, `containment_mode`, and `default_weight`. Inherited down the `IS_SUBTYPE_OF` hierarchy by query convention. See modelling guide §6–7 and the edge property table below. No inverse `PART_OF` edge — use reverse traversal. |
| `PRECEDES` | Earlier → Later | Syntactic expectation: "I prepare what comes next." "Pre-Dominant precedes Dominant." | Use when the source concept is the structurally dependent element that leads into the target. |
| `FOLLOWS` | Later → Earlier | Structural extension: "I extend what came before." "Post-cadential codetta follows Cadence." | Use when the source concept is the dependent element that refers back to the target. `FOLLOWS` is **not** the inverse of `PRECEDES` — they encode different dependency directions. Both are warranted. |
| `RESOLVES_TO` | Tension → Resolution | Directed functional motion where tension is discharged. "V7 resolves to I." "Suspension resolves to consonance." | Not limited to chord-level harmony — applicable wherever a concept discharges tension into a target (harmonic resolution, formal resolution, suspension resolution). **On probation:** if every use proves reducible to `PRECEDES` with an edge property, consolidate. |
| `CONTRASTS_WITH` | Concept ↔ Concept | Comparative relationship. "Neapolitan sixth contrasts with diatonic ii." "Monte contrasts with Fonte." | **Undirected by convention** — if A contrasts with B, B contrasts with A. Store as a single edge with an arbitrary direction; queries should traverse both directions. Captures cross-branch contrasts not derivable from sibling position in the `IS_SUBTYPE_OF` tree. Drives exercise distractor selection. |
| `IS_EQUIVALENT_TO` | Concept ↔ Concept | Cross-domain conceptual identity. "Monte (Schema domain) is equivalent to ascending-second sequence (Sequence domain)." | **Undirected by convention.** For concepts that are the same musical entity described from different theoretical perspectives or in different domains. **Not for aliases** — use the `aliases` field on a single node for notational variants (e.g., bII6 / Neapolitan sixth). |
| `PREREQUISITE_FOR` | Prereq → Dependent | Pedagogical sequencing. "Triads are a prerequisite for Seventh Chords." | Direction reads: A is a prerequisite for B. To find prerequisites of B, traverse backward. To find what A unlocks, traverse forward. Drives curriculum ordering and AI explanation calibration. |

### Concept ↔ PropertySchema ↔ PropertyValue

| Edge type | Direction | Meaning | Notes |
|---|---|---|---|
| `HAS_PROPERTY_SCHEMA` | Concept → PropertySchema | Links a concept to a dimension of instance variation. | Inherited down `IS_SUBTYPE_OF` by query convention. Define once on the highest applicable concept. |
| `HAS_VALUE` | PropertySchema → PropertyValue | Lists a permitted value for a property. | |
| `VALUE_REFERENCES` | PropertyValue → Concept | Links a property value back to a concept node in the graph. | Enables unified traversal: a query for "all fragments involving Applied Dominant" traverses both direct concept tags and VALUE_REFERENCES links. Values with no independent conceptual identity (e.g., "complete", "incomplete") carry no VALUE_REFERENCES edge. |

### Cross-Database (Virtual)

| Relationship | Stored in | Meaning | Notes |
|---|---|---|---|
| `APPEARS_IN` | PostgreSQL (`fragment_concept_tag` table) | Connects a concept to fragment examples. | **Not materialized as a Neo4j edge.** Resolved at the application layer: query PostgreSQL with a `concept_id` obtained from the graph. Documented here for architectural completeness and use in diagrams / API descriptions. |

---

## Retired Edge Types

| Former edge type | Disposition | Rationale |
|---|---|---|
| `IS_A` | **Dropped.** Use `IS_SUBTYPE_OF`. | Redundant — both expressed taxonomic subsumption. A single edge type eliminates ambiguity about which to use. |
| `PART_OF` | **Dropped.** Use reverse traversal of `CONTAINS`. | Pure inverse; carries no additional semantics. Reverse traversal in Cypher (`<-[:CONTAINS]-`) is native and zero-cost. |
| `INTENSIFIES` | **Dropped.** | The relationship it captured (e.g., cadential 6-4 intensifies a cadence) is already modeled structurally via `CONTAINS` components and `VALUE_REFERENCES` from PropertyValues. "Intensifies" is an interpretive gloss, not a distinct structural relationship. |
| `IMPLIES` | **Dropped.** | Too vague; overlapped with `PRECEDES` (syntactic expectation), `RESOLVES_TO` (harmonic expectation), and `CONTAINS` (structural expectation). No concrete use case identified that the surviving edges cannot cover. Can be reintroduced if a clear need emerges. |
| `HISTORICALLY_IN` | **Deferred.** Use a `style_period` property field on concept nodes. | Historical periodization is its own domain and deserves full modeling when developed. Until then, a simple property field (`style_period: "Classical"`) avoids half-modeling period nodes. When period nodes are introduced, a dedicated edge type can be added and the property data migrated. |

---

## Conventions

### Undirected edges

`CONTRASTS_WITH` and `IS_EQUIVALENT_TO` are semantically symmetric. Store a single directed edge (arbitrary direction) and always query with direction-agnostic traversal:

```cypher
MATCH (a:Concept)-[:CONTRASTS_WITH]-(b:Concept)
WHERE a.id = $id
RETURN b
```

### CONTAINS edge properties

Only `CONTAINS` carries edge properties. All other edges are property-free. If a relationship needs metadata, first consider whether a PropertySchema or a distinct edge type is more appropriate.

| Property | Type | Required? | Meaning |
|---|---|---|---|
| `order` | integer | Yes | Position of this component in the sequence. Used to sort stages in the tagging UI and to compute adjacency for split-handle interaction. |
| `required` | boolean | Yes | Whether an instance must include this component. Required stages block submission if unset; optional stages must be explicitly confirmed present or marked absent. |
| `display_mode` | `'stage'` \| `'segment'` | No (default: `'stage'`) | `'stage'` — this component creates its own bracket row below the staff in the tagging tool. `'segment'` — this component is rendered as a subdivision within the parent concept's bracket row (no third row is created). Use `'segment'` for sub-stages of compound structural slots (e.g. the two chords of a `CompoundPredominant`). Concepts with `display_mode: 'stage'` must not themselves have children with `display_mode: 'stage'` — the UI supports at most two levels of bracket nesting. |
| `containment_mode` | `'contiguous'` \| `'free'` | No (default: `'contiguous'`) | `'contiguous'` — adjacent sibling stages share a single split handle; no gaps or overlaps are possible. `'free'` — each stage bracket has independent endpoints; gaps and overlaps are permitted (submission generates a warning but is not blocked). |
| `default_weight` | float | No (default: `1.0`) | Relative width of this stage in the pre-populated default bracket layout. Normalised across siblings: a stage with weight 2.0 among three siblings of weight 1.0 each receives 2/4 of the main bracket width. Equal weight for all siblings is the fallback when no `default_weight` is set. |

### Adding new edge types

Before proposing a new edge type, verify:

1. No existing edge type (with or without an edge property) already captures the relationship.
2. The relationship is not a pure inverse of an existing type.
3. At least two concrete, non-hypothetical uses exist in the current or planned graph.
4. Record the addition as an ADR.
