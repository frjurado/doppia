# Neo4j Bloom — Setup and Usage Guide

## What Bloom is for

Bloom is Neo4j's browser-based graph explorer. It requires no coding and is the primary tool for domain experts — musicologists, annotators, and editorial reviewers — to browse the concept hierarchy, inspect node properties, trace relationships, and audit the graph structure during and after knowledge graph construction.

Bloom is not used for application development. Developers use pyvis for quick visualisation during seeding and Gephi for full-graph audits. Bloom is for the people who need to read and navigate the graph as a knowledge structure, not as a database.

---

## Connecting Bloom to the graph

### Option A — Local development (Neo4j Desktop)

Neo4j Desktop is the recommended way to run Bloom against the local Docker instance. It is free for local use.

1. Download Neo4j Desktop from [neo4j.com/download](https://neo4j.com/download/).
2. Install and open it. You do not need to create a new database inside Desktop — you will connect to the Docker instance instead.
3. In the Desktop home screen, click **Add** → **Remote connection**.
4. Enter the connection details:
   - **Connect URL:** `bolt://localhost:7687`
   - **Username:** `neo4j`
   - **Password:** `localpassword` (or whatever is set in your local `.env`)
5. Click **Connect**. The remote instance appears in your project panel.
6. Click **Open** → **Neo4j Bloom** from the instance panel.

Bloom opens in a browser tab connected to your local Docker Neo4j instance.

### Option B — Staging / AuraDB

1. Go to [console.neo4j.io](https://console.neo4j.io) and open the AuraDB instance.
2. Click **Open with** → **Neo4j Bloom**. Bloom opens pre-authenticated with the AuraDB credentials — no manual connection setup required.

AuraDB Bloom uses the same interface as the Desktop version. All perspective configurations described below apply to both.

---

## Setting up the cadence domain perspective

A **perspective** in Bloom is a saved view configuration: which node types are visible, how they are styled, which relationship types are shown, and which search phrases are pre-defined. Setting up the cadence domain perspective once means every member of the team opens the same calibrated view.

### Step 1 — Open the perspective panel

In Bloom, click the **Perspective** icon in the left sidebar (the layered circle icon). This opens the perspective drawer. Click **Create new perspective** → **Generate from database**. Bloom will inspect the graph and create a default perspective that includes all node labels and relationship types it finds.

Rename the perspective to `Cadence Domain`.

### Step 2 — Set node styles

Select each node label in the perspective panel and configure its visual style. The colour scheme used consistently across all tooling in this project:

| Node label | Colour | Shape | Caption property |
|---|---|---|---|
| `Concept` | `#4A90D9` (blue) | Circle | `name` |
| `PropertySchema` | `#E8A838` (amber) | Rounded rectangle | `name` |
| `PropertyValue` | `#7BC67E` (green) | Diamond | `name` |

To set a style: click the label in the perspective panel → click the colour swatch → enter the hex value. Change the shape from the shape dropdown. Set the caption to `name` so nodes display their human-readable name rather than their internal id.

For `Concept` nodes, add a **size rule** based on the number of outgoing `IS_SUBTYPE_OF` edges: concepts higher in the hierarchy (more subtypes) appear larger. This makes the hierarchy immediately legible in the graph view. To add a size rule: click the `Concept` label → **Styling** → **Size** → **Based on relationship count** → select `IS_SUBTYPE_OF`.

### Step 3 — Configure visible relationship types

In the perspective panel, scroll to the **Relationship types** section. Enable these types and give each a label colour:

| Relationship type | Colour | When visible |
|---|---|---|
| `IS_SUBTYPE_OF` | `#4A90D9` (blue, matching Concept) | Always |
| `BELONGS_TO` | `#A8DADC` (light teal) | Always |
| `CONTAINS` | `#2D6A4F` (dark green) | Always |
| `PRECEDES` | `#90BE6D` (sage green) | Always |
| `FOLLOWS` | `#43AA8B` (teal) | Always |
| `RESOLVES_TO` | `#E63946` (red) | Always |
| `CONTRASTS_WITH` | `#457B9D` (steel blue) | Always |
| `IS_EQUIVALENT_TO` | `#FFD166` (gold) | Always |
| `PREREQUISITE_FOR` | `#6D6875` (mauve) | Always |
| `HAS_PROPERTY_SCHEMA` | `#E8A838` (amber, matching PropertySchema) | Always |
| `HAS_VALUE` | `#7BC67E` (green, matching PropertyValue) | Always |
| `VALUE_REFERENCES` | `#C77DFF` (violet) | Always |

Note: `APPEARS_IN` (concept → fragment) is not a Neo4j edge — it is resolved at the application layer via the PostgreSQL `fragment_concept_tag` table. It does not appear in Bloom and requires no colour assignment.

### Step 4 — Filter stub nodes

Stub nodes (concepts from adjacent domains, not yet fully modelled) carry `stub: true` as a node property. Add a **category rule** to the `Concept` label that styles stub nodes differently: set their colour to `#CED4DA` (light grey) and their border to dashed. This makes it immediately obvious when a node in view is a placeholder rather than a fully defined concept.

To add a category rule: click `Concept` label → **Styling** → **Color** → **Based on property value** → property: `stub`, value: `true` → set colour to `#CED4DA`.

### Step 5 — Save the perspective

Click **Save perspective** at the bottom of the perspective panel. The perspective is stored in Bloom and will be available the next time you open it against the same database. Perspectives are per-user and per-database connection — each team member should configure their own copy using these instructions, or import an exported perspective file.

**Exporting for the team:** once configured, export the perspective via the perspective panel's menu → **Export**. This produces a JSON file. Commit it to the repository at `docs/bloom-perspective-cadence.json`. Team members can import it directly: perspective panel → **Import** → select the file. This avoids each person repeating the manual setup.

---

## Common editorial tasks

### Browsing the concept hierarchy

In the Bloom search bar, type the name of a concept and select it from the autocomplete list. Bloom displays the node. Press **Ctrl+E** (or **Cmd+E** on Mac) to expand all relationships from the selected node.

To see the full `IS_SUBTYPE_OF` hierarchy rooted at `Cadence`:

1. Click the search bar and type `Cadence`. Select the `Concept` node.
2. Right-click the node → **Expand** → **IS_SUBTYPE_OF** (incoming direction, to see subtypes).
3. Continue expanding nodes to traverse the hierarchy.

Alternatively, use a **search phrase** (see below) to load the full subtree in one step.

### Inspecting a concept node

Click any node to open its property panel on the right side of the screen. For `Concept` nodes, you will see:

- `id` — the stable internal identifier used in YAML and API calls
- `name` — the human-readable label
- `definition` — the prose definition
- `type` — the concept type (e.g. `CadenceType`)
- `complexity` — the pedagogical complexity tier
- `stub` — `true` if this is a placeholder from an adjacent domain; absent or `false` otherwise

For `PropertySchema` nodes:
- `id`, `name`, `description`
- `cardinality` — `ONE_OF` or `MANY_OF`
- `required` — whether instances must supply a value

For `PropertyValue` nodes:
- `id`, `name`
- Follow the `VALUE_REFERENCES` edge (violet) to see which `Concept` node this value points to, if any

### Tracing the schema for a concept

To see what PropertySchemas apply to a concept (including inherited ones):

1. Load the concept node (e.g. `PerfectAuthenticCadence`).
2. Expand `HAS_PROPERTY_SCHEMA` edges from the node and from any ancestor reachable via `IS_SUBTYPE_OF`.
3. Expand `HAS_VALUE` from each schema node to see the permitted values.
4. Expand `VALUE_REFERENCES` from any value nodes to see which concepts they link back to.

This traversal is easier to do interactively in Bloom than in Cypher during editorial review, because you can follow edges visually rather than writing a multi-hop query.

### Checking for isolated nodes

Any node with no visible edges after a full expand is suspicious — it may be an orphaned stub or a concept that was created but never connected to the graph. Run `python scripts/validate_graph.py` to catch these programmatically, but Bloom's visual layout makes them visually obvious: isolated nodes float away from the main cluster.

### Following a `CONTAINS` chain

`CONTAINS` edges (dark green) represent the structural composition of a concept: its ordered stages. To trace the full stage structure of `AuthenticCadence`:

1. Load `AuthenticCadence`.
2. Expand `CONTAINS` edges (outgoing). Each child node is a required or optional structural stage.
3. The `order` and `required` properties are on the edge, not the node — click an edge to see its properties in the panel on the right.

### Reviewing `VALUE_REFERENCES` connections

`VALUE_REFERENCES` edges (violet) connect `PropertyValue` nodes back into the concept graph. To audit which concept nodes are reachable via property values from a given concept:

1. Load the concept (e.g. `Cadence`).
2. Expand `HAS_PROPERTY_SCHEMA` → expand `HAS_VALUE` → expand `VALUE_REFERENCES`.
3. The terminal nodes are `Concept` nodes in the main graph that are implicated when this concept's properties are recorded on a fragment.

This traversal is important for verifying that the property system connects correctly back into the knowledge graph — fragments tagged with a cadence elaboration value should be reachable from the referenced concept node.

---

## Saved search phrases

Bloom supports **search phrases** — named, parameterisable queries that non-technical users can run without writing Cypher. Configure these in the perspective panel → **Search phrases**.

Add the following phrases to the cadence domain perspective:

**"Show all cadence subtypes"**

```cypher
MATCH (c:Concept)-[:IS_SUBTYPE_OF*1..]->(root:Concept {id: "Cadence"})
RETURN c, root
```

**"Show concept and its schemas"**

```cypher
MATCH (c:Concept {name: $name})-[:IS_SUBTYPE_OF*0..]->(ancestor)-[:HAS_PROPERTY_SCHEMA]->(s)-[:HAS_VALUE]->(v)
OPTIONAL MATCH (v)-[:VALUE_REFERENCES]->(ref)
RETURN c, ancestor, s, v, ref
```
Parameter: `name` (text input). Example: `Perfect Authentic Cadence`.

**"Show prerequisite chain for concept"**

```cypher
MATCH path = (c:Concept {name: $name})<-[:PREREQUISITE_FOR*1..]-(:Concept)
RETURN nodes(path), relationships(path)
```
Parameter: `name` (text input).

**"Show all stub nodes"**

```cypher
MATCH (c:Concept {stub: true})
RETURN c
```

**"Show concepts contrasting with"**

```cypher
MATCH (a:Concept {name: $name})-[:CONTRASTS_WITH]-(b:Concept)
RETURN a, b
```
Parameter: `name` (text input). Note: `CONTRASTS_WITH` is modelled as undirected in editorial queries; the `CONTRASTS_WITH` relationship may be stored in either direction in the graph.

To add a search phrase: perspective panel → **Search phrases** → **Add search phrase** → enter the name and Cypher. For parameterised phrases, Bloom will prompt for the parameter value when the phrase is run.

---

## Sharing graph snapshots

For sharing a subgraph view with team members who do not have Bloom set up, use the pyvis dev script instead:

```bash
python scripts/visualize_domain.py --domain cadences
```

This produces a self-contained interactive HTML file at `output/graph-cadences.html`. Open it in any browser — no Neo4j connection required. It uses the same colour scheme as the Bloom perspective. Share the HTML file directly.

For static diagrams in documentation or presentations, Bloom's **Export image** feature (right-click on the canvas → **Export as PNG**) produces a clean screenshot of the current view. Use this for inline images in ADRs or design documents.
