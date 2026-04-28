# Knowledge Graph — Design Reference

## Overview

The knowledge system has three distinct layers that work together: the **Knowledge Graph** of musical concepts and their typed relationships, the **PropertySchema** layer that defines the dimensions along which instances of a concept can vary, and the **PropertyValue** nodes that carry those permitted states — some of which point back into the concept graph itself.

These layers are not nested inside one another. They are all first-class graph citizens, distinguished by label and edge type, not by physical separation. Together they allow the system to represent not just *what* a musical concept is, but how it relates to everything around it, how instances of it can vary, and how those variations connect to other concepts.

---

## Part I — Architecture

### 1. The Three Layers

| Layer | What it stores | Connects via |
|---|---|---|
| **Knowledge Graph** | Musical concepts and the typed relationships between them | Semantic edges (`IS_SUBTYPE_OF`, `CONTAINS`, `RESOLVES_TO`, etc.) |
| **PropertySchema** | Dimensions along which instances of a concept can vary | `HAS_PROPERTY_SCHEMA` → `HAS_VALUE` |
| **PropertyValue** | The permitted states of a property; optionally referencing a concept node | `VALUE_REFERENCES` (optional, back into Layer 1) |

Every modelling decision starts by identifying which layer a new entity belongs to.

---

### 2. Layer 1 — The Knowledge Graph

The knowledge graph is the semantic core of the system. It is not a flat list of definitions or a simple hierarchy: it is a directed, typed graph where nodes are musical concepts and edges are labelled relationships that carry precise meaning.

#### Concept nodes

Each node represents a musical concept — anything from abstract categories like "Cadence" or "Phrase" down to specific constructs like "Neapolitan Sixth" or "Cadential 6-4". Nodes carry:

- A canonical name and known aliases
- A prose definition
- Domain and complexity metadata
- A set of typed edges to other nodes and to corpus fragments
- Two boolean fields that govern tagging tool behaviour:

| Field | Default | Meaning |
|---|---|---|
| `stub` | `false` | When `true`, the node exists in the graph as a placeholder — referenced by other edges but not yet fully modelled (no definition, no `HAS_PROPERTY_SCHEMA`, no `CONTAINS` edges). Stub nodes are excluded from all tagging UI. Set to `false` when the node is promoted to full status. |
| `top_level_taggable` | `true` | When `false`, the node does not appear in the concept picker as a direct fragment tag. Use this for abstract category nodes (`Cadence`, `AuthenticCadence`) whose instances are always better described by a specific subtype, and for structural sub-components that are only ever meaningful within their parent's stage structure. Nodes that can legitimately be tagged independently — even if they also appear as stages in other concepts — should remain `true`. |

The concept picker in the tagging tool filters to `stub: false AND top_level_taggable: true`.

#### What earns a concept node

A concept node is not a data record. It is a named musical entity that carries meaning beyond what can be derived from its constituent parts. A concept earns a node when it satisfies **at least one** of the following:

- It has a **name that experts use** and students need to learn
- It has a **prose definition** that is not merely a derivation of its parts
- It has **typed relationships** to other concepts that carry theoretical insight (`RESOLVES_TO`, `CONTRASTS_WITH`, `FOLLOWS`, etc.)
- It has a **pedagogical role** — it appears in `PREREQUISITE_FOR` chains or curriculum sequencing
- It has a **rhetorical or functional identity** beyond its surface description or chord spelling

**Examples that pass:** `GermanSixth`, `CadentialSixFour`, `DescendingFifthSequence`, `NeapolitanSixth`, `PreDominant`, `InitialTonic`

**Examples that fail:** `ii6` as distinct from `ii` (just root + first inversion — fully derivable, no independent meaning); `ii` in every key (the concept is the Roman numeral function, not the key-specific spelling)

#### The music21 boundary

The clearest test for whether something deserves a concept node is whether a library like music21 can compute it without loss of musical meaning. If it can, the entity belongs in the fragment's structured JSON data, not in the graph.

A fragment's JSON summary might record:

```json
{
  "harmony": [
    { "root": 2, "quality": "minor", "inversion": 1, "numeral": "ii6" },
    { "root": 5, "quality": "major", "inversion": 0, "numeral": "V" },
    { "root": 1, "quality": "major", "inversion": 0, "numeral": "I" }
  ],
  "concepts": ["PerfectAuthenticCadence"],
  "properties": {
    "Predominant": ["PredominantSD4"],
    "SopranoPosition": "ScaleDegree1"
  }
}
```

`ii6` lives in the harmony array — computable, queryable as data, but not a graph node. `PerfectAuthenticCadence` lives in the graph, because that is where the musical meaning is.

**The principle:** the graph is a knowledge graph, not a music theory engine. Let music21 be the engine.

#### Concept node types

Not all concept nodes have the same shape. A chord type, a cadence type, and a formal section are different kinds of things with different intrinsic attributes. Concept nodes carry a `type` field that determines what structured fields are required or permitted. In Neo4j this maps onto multiple labels: a node is simultaneously `:Concept` and `:CadenceType`, or `:Concept` and `:SequenceType`.

| Concept type | Typed structured fields | Leave to prose definition |
|---|---|---|
| `Chord` | root, quality, inversion, figures | Voice-leading tendencies, stylistic context |
| `CadenceType` | approach function, resolution function | Expressive character, elaboration norms |
| `SequenceType` | interval, direction | Rhetorical effect, period conventions |
| `FormalUnit` | scope (phrase / theme / section) | Relationship to form type |

**The criterion for typed field vs. prose:** if the attribute is discrete, enumerable, and likely to be used as a filter or traversal condition, it belongs in a typed field. If it requires explanation or contextual nuance, it belongs in the prose definition.

The music21 boundary applies here too: a typed field on a concept node should record something stable across all instances of that concept. If it varies by fragment instance (e.g. the actual bass note in a specific passage), it belongs in the fragment JSON.

---

### 3. The Relationship Vocabulary

Edges between concept nodes are typed and semantically precise. The type is not decoration — it determines what questions the graph can answer. The vocabulary should remain small enough to reason over systematically.

The authoritative, up-to-date edge type reference — including active types, retired types with rationale, conventions for undirected edges, and the gate for adding new types — is maintained in:

**[`edge-vocabulary-reference.md`](edge-vocabulary-reference.md)**

The graph enables *reasoning*, not just retrieval. Traversal allows the system to answer comparative questions ("what distinguishes X from Y?"), sequencing questions ("what must a student understand before this?"), and contextual questions ("what role does this gesture play in the larger form?").

---

### 4. Structural Composition via `CONTAINS` Edges

When a concept is **internally structured** — it consists of ordered components, some required and some optional — that structure is modelled as `CONTAINS` edges with metadata on the edge, not as a property schema.

**The key distinction:** a `PropertySchema` describes variation *across instances* of a concept. A `CONTAINS` edge describes the *definition* of the concept's internal composition. These are different questions.

`CONTAINS` edges carry two edge properties:

| Edge property | Type | Meaning |
|---|---|---|
| `order` | integer | Position of this component in the sequence |
| `required` | boolean | Whether an instance must include this component |

**Example — Authentic Cadence (Caplin's four stages):**

```yaml
- id: AuthenticCadence
  name: Authentic Cadence
  contains:
    - concept: InitialTonic
      order: 1
      required: false
    - concept: PreDominant
      order: 2
      required: false
    - concept: Dominant
      order: 3
      required: true
```

In Neo4j these become relationship properties, not node properties:

```cypher
(AuthenticCadence)-[:CONTAINS {order: 1, required: false}]->(InitialTonic)
(AuthenticCadence)-[:CONTAINS {order: 2, required: false}]->(PreDominant)
(AuthenticCadence)-[:CONTAINS {order: 3, required: true}]->(Dominant)
```

**The signal for `CONTAINS` rather than a `PropertySchema`:** if you find yourself wanting to add `required` or `order` to a set of property values, you are describing structural composition, not instance variation. Use `CONTAINS` edges.

#### What `CONTAINS` edge properties should not carry

Edge properties on `CONTAINS` are for structural metadata only: `order` and `required`. They should not constrain the identity of what fills the slot. If a structural slot is always occupied by a specific concept or subtype, express that by pointing the `CONTAINS` edge directly at that specific node.

**Wrong:** a `CONTAINS` edge pointing at a generic `PreDominantChord` with `{chord_family: "SD4"}` on the edge

**Right:** a `CONTAINS` edge pointing directly at `SD4Predominant`

The constraint is expressed by *which node the edge points to*, not by edge metadata.

#### Inheritance of `CONTAINS` edges

`CONTAINS` edges are inherited down the `IS_SUBTYPE_OF` hierarchy by query convention. Neo4j does not propagate edges automatically — inheritance is implemented in the query: when resolving the full structure of a concept, traverse `IS_SUBTYPE_OF` upward, collect all `CONTAINS` edges at every level, and merge them sorted by `order`.

It is both valid and natural to define stages at different levels of the hierarchy. The parent defines what is common to all subtypes; children add only what is specific to them.

```yaml
# Parent defines stages 1–3 (common to all authentic cadences)
- id: AuthenticCadence
  contains:
    - concept: InitialTonic
      order: 1
      required: false
    - concept: PreDominant
      order: 2
      required: false
    - concept: Dominant
      order: 3
      required: true

# Children each define stage 4 differently
- id: PerfectAuthenticCadence
  is_subtype_of: AuthenticCadence
  contains:
    - concept: PACFinalTonic
      order: 4
      required: true

- id: ImperfectAuthenticCadence
  is_subtype_of: AuthenticCadence
  contains:
    - concept: IACFinalTonic
      order: 4
      required: true
```

**Rule for open slots:** if children diverge at a given stage, do not define that stage on the parent. Leave it open. Defining a generic stage 4 at the parent and overriding it in children requires an override convention; omitting it is unambiguous.

#### Display depth and the two-level constraint

The tagging UI renders `CONTAINS` targets as either a separate bracket row (`display_mode: 'stage'`) or a visual subdivision within the parent concept's bracket (`display_mode: 'segment'`). See `edge-vocabulary-reference.md` for the full property definition.

**The two-level constraint:** at most two levels of bracket rows are rendered. A concept may have `CONTAINS` edges with `display_mode: 'stage'` (level 1), and those stage concepts may have `CONTAINS` edges with `display_mode: 'segment'` (rendered within level 1, not as a third row). `CONTAINS` edges with `display_mode: 'stage'` on a stage concept that is itself a `display_mode: 'stage'` child are not permitted — the seeding script enforces this.

In practice: for a compound structural slot (e.g. `CompoundPredominant` with two sub-stages), set `display_mode: 'segment'` on the sub-stage `CONTAINS` edges. The two sub-stages appear as segments within the Pre-Dominant bracket, not as a third row of brackets. The hierarchy in the data is preserved; only the visual display is flattened.

---

### 5. Layer 2 — PropertySchema

Concept nodes describe *what* something is. `PropertySchema` nodes describe *what an instance of that thing can be like* — the dimensions along which individual occurrences of a concept can vary. They answer: *in what ways can one occurrence of this concept differ meaningfully from another?*

Rather than embedding property definitions directly on concept nodes, `PropertySchema` nodes are first-class graph citizens. A concept points to its applicable schemas via `HAS_PROPERTY_SCHEMA` edges, and multiple concepts can point to the same schema node — shared properties are genuinely shared, not copied, and updating a schema propagates automatically to every concept that uses it.

#### PropertySchema node fields

| Field | Description |
|---|---|
| `id` | Stable identifier: `SopranoPosition` |
| `name` | Human-readable label: `"Soprano Position"` |
| `description` | Prose explanation of what the property captures |
| `cardinality` | `ONE_OF` (mutually exclusive) or `MANY_OF` (combinable) |
| `required` | Whether an instance must supply a value for this property |

A property schema is appropriate when:
- Instances of the same concept appear in distinct configurations worth distinguishing analytically
- Those configurations form a bounded, enumerable set of values
- The variation is musically meaningful, not just notational detail

A property schema is **not** appropriate when:
- The values themselves have ordered or required sub-structure → use `CONTAINS` edges instead
- The values should carry their own relationships, definitions, or pedagogical roles → they are concept nodes, not values
- The variation is fully computable from the fragment's harmony data

#### Inheritance via `IS_SUBTYPE_OF`

Define a schema once at the highest concept where it applies. All subtypes inherit it automatically via `IS_SUBTYPE_OF` traversal — no redundant edges needed. `SopranoPosition` defined on `AuthenticCadence` is automatically available on `PerfectAuthenticCadence`, `ImperfectAuthenticCadence`, and any future subtype.

This keeps the graph lean: a schema defined once on `Cadence` is automatically available on `Authentic Cadence`, `Perfect Authentic Cadence`, and any future subtype — without any redundant edges.

---

### 6. Layer 3 — PropertyValues and Graph References

`PropertySchema` nodes point to `PropertyValue` nodes via `HAS_VALUE` edges. Each value represents one permitted state of that property — for example, the possible values of `SopranoPosition` are `ScaleDegree1`, `ScaleDegree3`, and `ScaleDegree5`.

The critical design move is that a `PropertyValue` can carry a `VALUE_REFERENCES` edge pointing to a concept node in the main graph. Saying that a cadence *includes* a cadential 6-4 is a different relationship from the edges used elsewhere in the graph (`INTENSIFIES`, `APPEARS_IN`, etc.); the property system gives it a structured, typed slot. And because the reference is a graph edge, fragments tagged with that value are implicitly connected to the referenced concept — traversal works across the boundary.

Values that do not correspond to an existing concept (such as `"complete"`, `"incomplete"`, `"ascending"`) carry no `VALUE_REFERENCES` edge. They are terminal descriptors.

**Why this matters for querying:** a query for "all fragments involving an applied dominant" can traverse both direct `APPEARS_IN` links from the `AppliedDominant` concept node and `VALUE_REFERENCES` links from any property value pointing to it — in a single graph query, without collapsing the distinction between a fragment *about* applied dominants and a cadence that merely *contains* one as an elaboration.

**Why this matters for explanations:** the property record, combined with `VALUE_REFERENCES` traversal, makes it possible to reason about a specific instance rather than just a type — "this cadence in particular uses a Neapolitan approach" rather than a generic description of the cadence type. This is useful for human prose annotations and, in Phase 3, would allow a reasoning layer to produce grounded instance-level explanations.

---

### 7. The Full Three-Layer Picture

```
                    KNOWLEDGE GRAPH
                    ───────────────
          Concept: "Cadence"
             │ IS_SUBTYPE_OF ▲
             │
          Concept: "Authentic Cadence"
             │ IS_SUBTYPE_OF ▲      │ HAS_PROPERTY_SCHEMA
             │                      ▼
          Concept: "PAC"       PropertySchema: "SopranoPosition"   ← LAYER 2
             │                      │ HAS_VALUE
             │ HAS_PROPERTY_SCHEMA  ▼
             │               PropertyValue: "ScaleDegree1"          ← LAYER 3
             ▼               PropertyValue: "ScaleDegree3"
        PropertySchema:      PropertyValue: "ScaleDegree5"
        "CadentialElaboration"
             │ HAS_VALUE
             ▼
        PropertyValue: "Cadential64"       ──VALUE_REFERENCES──► Concept: "Cadential 6-4"
        PropertyValue: "AppliedDominant"   ──VALUE_REFERENCES──► Concept: "Applied Dominant"
        PropertyValue: "NeapolitanApproach"──VALUE_REFERENCES──► Concept: "Neapolitan Sixth"
```

---

## Part II — Modelling Decisions

### 8. Identifier Convention

Every node — concept, schema, value — carries two name fields:

| Field | Purpose | Format | Example |
|---|---|---|---|
| `id` | Stable internal identifier; used in all references, Cypher queries, and YAML seed files | PascalCase, no spaces | `PerfectAuthenticCadence` |
| `name` | Human-readable label; rendered in the UI and editorial tools | Natural language | `"Perfect Authentic Cadence"` |

The `id` field is the primary key in Neo4j (`REQUIRE c.id IS UNIQUE`). All cross-references in YAML use `id` values. The `name` field can change without breaking any reference. **The `id` field is immutable once a node is in use by fragment tags** — renaming an `id` breaks all fragment references. This is a hard invariant enforced by the seeding script.

---

### 9. Subtype Split vs. Property Variation

The most consequential structural decision when modelling a concept with variable form: is this variation in **content** (same structure, different values) or in **shape** (the structure itself differs between cases)?

- **Variation in content** → a `PropertySchema` on the existing concept
- **Variation in shape** → a subtype split into distinct concept nodes

**The `PreDominant` case:**

The Pre-Dominant stage can be:
- A **simple** predominant: a single chord slot, varying in which chord family fills it
- A **compound** predominant: two ordered substages (2a then 2b), each structurally fixed

These are not the same structure with different values. They are structurally different things. The model is:

```
PreDominant
├── SimplePredominant
│     PropertySchema: ChordFamily (ONE_OF: SD4Family, SD4SharpFamily)
└── CompoundPredominant
      CONTAINS {order: 1, required: true} → Substage2a  (SD4 chord)
      CONTAINS {order: 2, required: true} → Substage2b  (SD#4 chord)
```

`SimplePredominant` gets a `PropertySchema` because it has a single slot with enumerable content variation. `CompoundPredominant` gets `CONTAINS` edges because it has internal ordered structure.

**The signal for a subtype split:** a concept slot can be either a leaf (atomic) or a branch (internally composed). When the same slot can be either, that is not a property — it is a structural difference. Model it as a pair of subtypes.

---

### 10. The Nesting Test

If you find yourself wanting to nest property values — values that have sub-values, which have sub-sub-values — stop. This is the graph signalling that those values want to be concept nodes with their own `IS_SUBTYPE_OF` taxonomy.

The predominant chord taxonomy illustrates this. What looks like a deeply nested property structure:

```
Predominant
└── SD4 chords
      └── on BN4 → IV, ii
      └── on BN2 → ii6
      └── on BN6 → ii65
└── SD#4 chords
      └── Applied Dominants
      └── Augmented Sixth Chords
            └── Italian, French, German
```

...is actually a concept hierarchy. Every node in that tree is a named musical entity with its own definition, relationships, and pedagogical role. The `Predominant` property schema stays flat; its values reference concept nodes in the hierarchy via `VALUE_REFERENCES`.

**The test:** if a property value has a name a musicologist would use in a textbook, it is a concept node, not a value.

---

### 11. Complete Case Map

| Situation | Resolution |
|---|---|
| A named musical concept with a definition and relationships | Concept node in the knowledge graph |
| An entity fully derivable by music21 without loss of meaning | Structured field in the fragment JSON — not a graph node |
| A concept whose instances vary in enumerable, meaningful ways | `PropertySchema` attached via `HAS_PROPERTY_SCHEMA` |
| A concept with internal ordered components, some optional | `CONTAINS` edges with `order` and `required` as edge properties |
| A structural slot always filled by a specific concept type | `CONTAINS` edge pointing directly at that concept — not a generic node with edge-level constraints |
| A property value that is itself a named musical concept | Concept node + `VALUE_REFERENCES` edge from the `PropertyValue` |
| A property value with no independent musical meaning | Terminal `PropertyValue` — no `VALUE_REFERENCES` edge |
| Property values that want sub-values with their own structure | The values are concept nodes — push the taxonomy into the graph |
| A concept slot that can be either atomic or internally structured | Subtype split: atomic subtype gets `PropertySchema`; composed subtype gets `CONTAINS` edges |
| A property shared across several related concepts | Define `PropertySchema` once on the common ancestor; subtypes inherit automatically |
| Structural stages common to all subtypes, with one stage diverging per child | Parent defines common stages; each child defines its divergent stage at the appropriate `order` |
| An attribute that varies per fragment instance, not per concept | Fragment JSON field — not a concept node field |
| An attribute that is stable across all instances of a concept | Typed field on the concept node itself (e.g. `root`, `quality` on a `Chord` type) |
| A concept that is referenced by other edges but has not been fully modelled | Set `stub: true`; excluded from tagging UI until promoted |
| A concept that should never appear as a direct fragment tag (too abstract, or only meaningful as a stage target) | Set `top_level_taggable: false` |
| A stage concept whose sub-stages should appear as visual segments within its bracket row | Set `display_mode: 'segment'` on the sub-stage `CONTAINS` edges |

---

### 12. Decision Flowchart

```
Is this fully derivable by music21 without loss of musical meaning?
│
├── YES → Fragment JSON field. Not a graph node. Stop.
│
└── NO  → Does it have a name, definition, or relationships
          that carry meaning beyond its parts?
          │
          ├── NO  → Re-examine. If a musicologist would not name it
          │         in a textbook, it likely belongs in the JSON.
          │
          └── YES → Create a concept node.
                    │
                    Does this concept have internal ordered structure?
                    (components with sequence and required/optional status)
                    │
                    ├── YES → CONTAINS edges with order + required
                    │         on each edge.
                    │         Do the stages differ across subtypes?
                    │         │
                    │         ├── YES → Define common stages on the parent.
                    │         │         Each child adds its own divergent stages.
                    │         │         Leave open slots undefined on the parent.
                    │         │
                    │         └── NO  → Define all stages on this concept.
                    │
                    └── NO  → Does this concept have meaningful instance
                              variation worth recording analytically?
                              │
                              ├── YES → Is the variation in content
                              │         (same structure, different values)
                              │         or in shape (structure itself differs)?
                              │         │
                              │         ├── CONTENT → PropertySchema.
                              │         │             ONE_OF or MANY_OF.
                              │         │             Do the values reference
                              │         │             other concept nodes?
                              │         │             │
                              │         │             ├── YES → Concept nodes
                              │         │             │         + VALUE_REFERENCES.
                              │         │             │
                              │         │             └── NO  → Terminal values.
                              │         │                       No VALUE_REFERENCES.
                              │         │
                              │         └── SHAPE → Subtype split.
                              │                     Model as distinct subtypes.
                              │                     Apply PropertySchema or
                              │                     CONTAINS to each separately.
                              │
                              └── NO  → Concept stands alone.
                                        Ensure semantic edges capture
                                        its relationships to other concepts.
```

---

## Part III — Worked Examples

### Example 1 — Perfect Authentic Cadence

```
Concept: "Cadence"
  ──HAS_PROPERTY_SCHEMA──► PropertySchema: "CadentialElaboration"
                             cardinality: MANY_OF
                             required: false
                             values: Cadential64, AppliedDominant,
                                     NeapolitanApproach, ChromaticPreDominant

Concept: "Authentic Cadence"   IS_SUBTYPE_OF "Cadence"
  ──HAS_PROPERTY_SCHEMA──► PropertySchema: "SopranoPosition"
                             cardinality: ONE_OF
                             required: false
                             values: ScaleDegree1, ScaleDegree3, ScaleDegree5

Concept: "Perfect Authentic Cadence"   IS_SUBTYPE_OF "Authentic Cadence"
  ← inherits SopranoPosition from "Authentic Cadence"
  ← inherits CadentialElaboration from "Cadence"
```

A fragment tagged as a PAC with a cadential 6-4 and an applied dominant carries this instance record in its structured JSON summary:

```json
{
  "concept": "PerfectAuthenticCadence",
  "properties": {
    "SopranoPosition": "ScaleDegree1",
    "CadentialElaboration": ["Cadential64", "AppliedDominant"]
  }
}
```

At tagging time, the schema validates this: `SopranoPosition` must be exactly one value; `CadentialElaboration` may be a list or absent entirely.

The two values in `CadentialElaboration` both carry `VALUE_REFERENCES` edges:

```
PropertyValue: "Cadential64"       ──VALUE_REFERENCES──► Concept: "Cadential 6-4"
PropertyValue: "AppliedDominant"   ──VALUE_REFERENCES──► Concept: "Applied Dominant"
```

The fragment is therefore reachable by traversing from either concept node — without conflating the distinct roles those concepts play in this excerpt.

---

### Example 2 — Descending Fifth Sequence

```
Concept: "Sequence"
  ──HAS_PROPERTY_SCHEMA──► PropertySchema: "SequenceInterval"
                             cardinality: ONE_OF
                             required: true
                             values: DescendingFifth, DescendingThird,
                                     AscendingSecond, ...

  ──HAS_PROPERTY_SCHEMA──► PropertySchema: "SequenceType"
                             cardinality: ONE_OF
                             required: false
                             values: Diatonic, ChromaticDescendingFifths,
                                     FauxBourdon, ...

Concept: "Descending Fifth Sequence"   IS_SUBTYPE_OF "Sequence"
  ──HAS_PROPERTY_SCHEMA──► PropertySchema: "ChordQualityPattern"
                             cardinality: ONE_OF
                             required: false
                             values: AllTriads, AlternatingSevenths, AllSevenths
```

`SequenceInterval` is `required: true` — a fragment tagged as a sequence must specify its interval, because that is definitionally central. `SequenceType` and `ChordQualityPattern` are optional refinements.

```json
{
  "concept": "DescendingFifthSequence",
  "properties": {
    "SequenceInterval": "DescendingFifth",
    "ChordQualityPattern": "AlternatingSevenths",
    "SequenceType": "Diatonic"
  }
}
```

---

## Part IV — Implementation

### 13. Database: Neo4j

Neo4j is the graph database for this system. It has first-class support for typed, directed edges and multi-hop traversal — the patterns this design depends on heavily. Its query language, Cypher, is readable enough to use directly in application code.

**Key query patterns:**

Schema inheritance (zero-or-more hops up the type hierarchy):

```cypher
MATCH (c:Concept {id: $id})-[:IS_SUBTYPE_OF*0..]->(ancestor)
      -[:HAS_PROPERTY_SCHEMA]->(s)-[:HAS_VALUE]->(v)
OPTIONAL MATCH (v)-[:VALUE_REFERENCES]->(ref)
RETURN s, collect(v), collect(ref)
```

Prerequisite chain for a concept:

```cypher
MATCH path = (c:Concept {id: $id})<-[:PREREQUISITE_FOR*1..]-(:Concept)
RETURN nodes(path), relationships(path)
```

All fragments containing a specific concept (direct or via property):

`APPEARS_IN` is **not** a Neo4j edge — it is resolved at the application layer via the PostgreSQL `fragment_concept_tag` table (see `tech-stack-and-database-reference.md`). Fragment nodes do not exist in Neo4j. The correct two-step pattern is:

```cypher
-- Step 1 (Neo4j): expand concept to all related concept IDs.
MATCH (c:Concept {id: $id})
OPTIONAL MATCH (c)<-[:VALUE_REFERENCES]-(:PropertyValue)
              <-[:HAS_VALUE]-(:PropertySchema)
              <-[:HAS_PROPERTY_SCHEMA]-(related:Concept)
RETURN $id AS direct_id, collect(distinct related.id) AS via_property_ids
```

Then in PostgreSQL:

```sql
-- Step 2 (PostgreSQL): query fragments tagged with any of those concepts.
SELECT fragment_id FROM fragment_concept_tag
WHERE concept_id = ANY(:direct_id || :via_property_ids)
```

Creating nodes and the property schema layer:

```cypher
// Concept nodes
CREATE (cadence:Concept {id: "Cadence", name: "Cadence", definition: "A harmonic close..."})
CREATE (pac:Concept {id: "PerfectAuthenticCadence", name: "Perfect Authentic Cadence"})
CREATE (pac)-[:IS_SUBTYPE_OF]->(cadence)

// PropertySchema
CREATE (s:PropertySchema {
  id: "CadentialElaboration",
  name: "Cadential Elaboration",
  description: "Harmonic or melodic gestures that precede or intensify the cadence",
  cardinality: "MANY_OF",
  required: false
})
MATCH (c:Concept {id: "Cadence"}), (s:PropertySchema {id: "CadentialElaboration"})
CREATE (c)-[:HAS_PROPERTY_SCHEMA]->(s)

// PropertyValues linked back to concept nodes
CREATE (v1:PropertyValue {id: "Cadential64", name: "Cadential 6-4"})
CREATE (s)-[:HAS_VALUE]->(v1)
MATCH (v:PropertyValue {id: "Cadential64"}), (c:Concept {id: "CadentialSixFour"})
CREATE (v)-[:VALUE_REFERENCES]->(c)
```

The `*0..` syntax in traversal queries means "zero or more hops" — it captures schemas attached directly to the concept *and* all ancestors, implementing inheritance in a single query.

---

### 14. Python Integration

**`neo4j` (official driver)** — for all complex traversal queries written in raw Cypher:

```python
from neo4j import GraphDatabase

driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "password"))

def get_schemas_for_concept(concept_id: str) -> list[dict]:
    query = """
        MATCH (c:Concept {id: $id})
              -[:IS_SUBTYPE_OF*0..]->(ancestor:Concept)
              -[:HAS_PROPERTY_SCHEMA]->(s:PropertySchema)
              -[:HAS_VALUE]->(v:PropertyValue)
        OPTIONAL MATCH (v)-[:VALUE_REFERENCES]->(ref:Concept)
        RETURN s.id AS schema,
               s.cardinality AS cardinality,
               s.required AS required,
               collect(v.id) AS values,
               collect(ref.id) AS references
    """
    with driver.session() as session:
        result = session.run(query, id=concept_id)
        return [record.data() for record in result]
```

**`neomodel`** — ORM layer for routine CRUD on concept and schema nodes:

```python
from neomodel import StructuredNode, StringProperty, BooleanProperty, RelationshipTo

class PropertySchema(StructuredNode):
    id = StringProperty(required=True, unique_index=True)
    name = StringProperty()
    description = StringProperty()
    cardinality = StringProperty(choices={"ONE_OF": "ONE_OF", "MANY_OF": "MANY_OF"})
    required = BooleanProperty(default=False)
    values = RelationshipTo("PropertyValue", "HAS_VALUE")

class Concept(StructuredNode):
    id = StringProperty(required=True, unique_index=True)
    name = StringProperty()
    definition = StringProperty()
    subtypes = RelationshipTo("Concept", "IS_SUBTYPE_OF")
    schemas = RelationshipTo("PropertySchema", "HAS_PROPERTY_SCHEMA")
```

Use `neomodel` for routine operations; prefer raw Cypher for complex traversal queries where ORM abstraction obscures what is happening.

**Pydantic** — write-time validation layer, enforcing cardinality and required constraints before anything reaches the database:

```python
from pydantic import BaseModel, model_validator
from enum import Enum

class Cardinality(str, Enum):
    ONE_OF = "ONE_OF"
    MANY_OF = "MANY_OF"

class PropertySchemaDefinition(BaseModel):
    id: str
    name: str
    description: str
    cardinality: Cardinality
    required: bool
    allowed_values: list[str]

class FragmentTag(BaseModel):
    concept: str
    properties: dict[str, str | list[str]]

    @model_validator(mode="after")
    def validate_against_schema(self) -> "FragmentTag":
        # fetch applicable schemas for self.concept from the graph,
        # then check cardinality and required constraints
        ...
        return self
```

The Pydantic layer and Neo4j are complementary: the graph stores and traverses the schema definitions; Pydantic enforces them at write time in application code.

---

### 15. Seeding from YAML

The knowledge graph and its schemas are authored as YAML seed files and loaded via a Python seeding script. This keeps the canonical schema definition in version control while the database serves as the live, queryable runtime representation.

```yaml
concepts:
  - id: Cadence
    name: "Cadence"
    type: CadenceType
    definition: "A harmonic close marking the end of a phrase or section."
    complexity: foundational
    relationships:
      - type: IS_SUBTYPE_OF
        target: FormalUnit

  - id: AuthenticCadence
    name: "Authentic Cadence"
    type: CadenceType
    is_subtype_of: Cadence
    property_schemas:
      - SopranoPosition

property_schemas:
  - id: SopranoPosition
    name: "Soprano Position"
    description: "Scale degree in the soprano voice at the point of resolution."
    cardinality: ONE_OF
    required: false
    values:
      - id: ScaleDegree1
        name: "Scale Degree 1"
      - id: ScaleDegree3
        name: "Scale Degree 3"
      - id: ScaleDegree5
        name: "Scale Degree 5"
```

The seeding script uses Cypher `MERGE` (not `CREATE`), making it safe to re-run at any time — nodes are created if absent, left alone if already present. Any `id` present in the database but absent from the YAML triggers a loud warning; this is the mechanism that enforces `id` immutability.

**Stub nodes at domain boundaries.** The knowledge graph is built domain by domain (see [`knowledge-graph-domain-map.md`](knowledge-graph-domain-map.md) for the full confirmed domain list). Each domain references concepts that belong to adjacent domains not yet fully modelled. These must exist as stub nodes so edges do not point into the void. For example, the cadence domain references concepts from harmonic function and formal structure domains (Tonic, Dominant, PreDominant, Phrase):

```yaml
# harmonic-functions.yaml — stub nodes defined here; promoted to full status when the domain is built
concepts:
  - id: Tonic
    name: "Tonic"
    stub: true
    definition: "Stub: defined in the harmonic-function domain."
```

Stubs live in their eventual home domain file (not a separate `stubs.yaml`). When a domain is fully implemented, `stub: true` is removed and the definition filled in — no files need to move. Stub nodes carry a `stub: true` flag in YAML and a corresponding property in Neo4j. The graph validation suite reports stub node counts by domain; stubs are expected and tracked, not errors.

---

### 16. Graph Validation

After every seed run, execute a validation suite (`python scripts/validate_graph.py`):

- No concept node has zero outgoing edges (every node must be connected to the graph)
- Every `IS_SUBTYPE_OF` reference points to an existing concept `id`
- Every `CONTAINS` target is a defined concept `id`
- Every `PropertyValue` with a `references` field points to an existing concept `id`
- Every `PropertySchema` has at least one `HAS_VALUE` edge
- `CONTAINS` edges on a given concept have unique `order` values

Run this suite in CI after any YAML change.

---

## Part V — Visualization

Visualization serves two purposes: **editorial** (helping domain experts browse and audit the graph during construction) and **administrative** (debugging schema structure and traversal paths during development).

### Neo4j Bloom — editorial, zero-code

Neo4j Bloom is the primary visualization surface for domain experts who need to browse the concept hierarchy, inspect node properties, and trace relationships — no coding required.

Configure a saved Bloom perspective for each domain before handing off to annotators. The perspective should show `Concept`, `PropertySchema`, and `PropertyValue` nodes in distinct colours, with `IS_SUBTYPE_OF`, `CONTAINS`, and `HAS_PROPERTY_SCHEMA` as visible relationship types. Ships with Neo4j Desktop (free for local use) and Neo4j AuraDB.

### Cytoscape.js — embedded web views

For embedded visualization within the application — showing a student the prerequisite chain leading to a concept, or letting an editor see what a concept node is connected to:

```python
# FastAPI endpoint
@app.get("/graph/concept/{id}/neighbourhood")
def concept_neighbourhood(id: str, depth: int = 2):
    nodes, edges = graph_service.get_neighbourhood(id, depth)
    return {
        "elements": {
            "nodes": [{"data": n} for n in nodes],
            "edges": [{"data": e} for e in edges]
        }
    }
```

```javascript
const cy = cytoscape({
  container: document.getElementById("graph"),
  elements: await fetch(`/graph/concept/PerfectAuthenticCadence/neighbourhood`).then(r => r.json()),
  style: [
    { selector: "node[type='Concept']",        style: { "background-color": "#4A90D9" } },
    { selector: "node[type='PropertySchema']", style: { "background-color": "#E8A838" } },
    { selector: "node[type='PropertyValue']",  style: { "background-color": "#7BC67E" } }
  ],
  layout: { name: "breadthfirst", directed: true }
});
```

### pyvis — development and debugging

During development, `pyvis` produces a self-contained interactive HTML file from a NetworkX subgraph export — useful for sharing graph snapshots with domain experts without standing up a front-end:

```python
from pyvis.network import Network

def export_subgraph_to_html(concept_id: str, output_path: str):
    G = graph_service.to_networkx(concept_id, depth=2)
    net = Network(directed=True, height="700px")
    net.from_nx(G)
    for node in net.nodes:
        if node["label_type"] == "Concept":        node["color"] = "#4A90D9"
        elif node["label_type"] == "PropertySchema": node["color"] = "#E8A838"
    net.write_html(output_path)
```

Implement a `python scripts/visualize_domain.py --domain cadences` script that exports a pyvis HTML for a given domain subgraph. Run this after every seed to spot structural problems without opening Bloom.

### Gephi — periodic full-graph auditing

For periodic audits of the full graph — checking for orphaned nodes, visualizing the density of `APPEARS_IN` connections across the corpus, reviewing the full concept hierarchy — Gephi handles graphs of tens of thousands of nodes with statistical analysis built in. Export from Neo4j to GraphML, or serialize via NetworkX's `write_graphml`.

---

## Part VI — Why This Design

### Richer, validated fragment tagging

Without a property schema layer, a tagger can only say "this is a PAC." With it, they can record precisely *what kind* of PAC — and the schema enforces that their choices are conceptually valid for that concept. Cardinality rules prevent logically incoherent combinations (two mutually exclusive values) while permitting genuinely coexistent ones.

### Shared properties without duplication

Both PAC and IAC fragments can be queried by soprano position, because `SopranoPosition` is attached once to their shared parent and inherited by both. Adding a new cadence subtype in the future automatically inherits the same schemas — no schema maintenance required.

### Unified graph traversal

`VALUE_REFERENCES` edges mean that property-level connections to other concepts are first-class graph edges, not metadata strings. A query for "all fragments involving an applied dominant" can traverse both direct `APPEARS_IN` links and `VALUE_REFERENCES` links in a single graph query — without collapsing the distinction between a fragment *about* applied dominants and a cadence that *contains* one.

### Precision in exercise generation

The property system opens up a much richer space of exercise types. Rather than only asking "identify this cadence type," the system can ask "what elaboration technique does this cadence use?" — with distractors drawn from sibling `PropertyValue` nodes on the same schema, all structurally plausible and drawn from real corpus examples.

### Grounded explanations — now and in Phase 3

The property record of a fragment, combined with `VALUE_REFERENCES` traversal, makes it possible to state precisely what is distinctive about a specific instance: "this cadence is approached by a Neapolitan sixth preceding a cadential 6-4" rather than a generic description of PACs in general. This is useful for human-authored prose annotations today, and would allow a Phase 3 reasoning layer to construct instance-grounded explanations rather than relying on generic concept descriptions.

### Forward-compatible schema evolution

Because `PropertySchema` nodes are graph citizens, the schema can evolve without breaking existing data. Adding a new permissible value to `CadentialElaboration` does not require touching any existing fragment records — only untagged fragments need review. Existing tagged fragments remain valid.

---

## Tool Summary

| Concern | Tool |
|---|---|
| Graph database | Neo4j (local: Desktop; production: AuraDB) |
| Query language | Cypher |
| Python driver (traversal queries) | `neo4j` (official) |
| Python ORM (routine CRUD) | `neomodel` |
| Write-time validation | `pydantic` v2 |
| Graph seeding / migrations | YAML seed files + Python seeding script + Cypher `MERGE` |
| Editorial visualization (no-code) | Neo4j Bloom |
| Embedded web visualization | Cytoscape.js fed by a FastAPI endpoint |
| Development / debugging visualization | `pyvis` (interactive HTML) |
| Full-graph auditing | Gephi (via GraphML export) |
