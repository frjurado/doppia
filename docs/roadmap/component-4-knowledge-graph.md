# Phase 1 — Component 4: Knowledge Graph (Cadence Domain) — Implementation Plan

This document translates Component 4 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It also absorbs the carry-ins recorded at the end of Component 3: four pieces of decided technical debt that should land before Component 4's main work begins, three open Component 3 GitHub issues that ride along as parallel side-tracks, a cluster of small score-viewer polish items, and one open investigation (the Sonata 1 mvt 1 accidentals/MIDI bug) slotted at the very end.

Component 4 has four deliverables:

1. **Carry-in cleanup** — five items decided after Component 3 closed: the Supabase RLS warning on `alembic_version`, the stale `worker` process group in `fly.toml`, R2/I12 partial-failure recovery, the zero-coverage fragment data layer (R7/I8), and the playback-coordinates architecture doc that pins down pickup/repeat/non-quarter-meter behaviour for the score viewer.
2. **Knowledge graph foundation** — the YAML schema, Pydantic validation models, seeding script, validation suite, and pyvis development visualisation. Built once and reused for every subsequent domain.
3. **Cadence domain** — the seed YAML for the first of the eleven confirmed domains in `docs/architecture/knowledge-graph-domain-map.md`, plus stubs for the adjacent domains it references (harmonic functions, formal structure, scale degrees). Iterated collaboratively from a draft MD design.
4. **Visualisation and integration** — the Neo4j Bloom perspective documented in `docs/architecture/bloom-setup.md`, graph structure tests living in `backend/tests/graph/`, and CI wiring so the validation suite runs on every YAML change.

The ordering matters: the cleanup lands first so Component 4 begins on a clean staging environment and a tested fragment data layer; the graph foundation lands before the domain YAML so the YAML iteration loop has Pydantic validation from line one; the cadence YAML lands before stubs and visualisation so the visualisation has something meaningful to show.

---

## Prerequisites

Component 4 assumes the following hard gates from Component 3 have passed (per `docs/roadmap/component-3-score-viewer.md` § "Hard gates before Component 4 begins"):

- `npm run lint`, `npm run lint:css`, and `npm test` all pass in CI.
- The score viewer renders the Mozart corpus correctly in staging: progressive SVG rendering, staff size and transposition controls function, MIDI playback starts and the highlight tracks notes.
- Fragment rendering is verified for both linear and volta fixtures using `mc_start`/`mc_end` coordinates; findings are in `docs/architecture/mei-ingest-normalization.md`.
- ADR-016 (JWT browser storage) is written and linked from `security-model.md`.
- The `onPositionUpdate(bar, beat)` callback abstraction is in place.

It additionally assumes that the existing architecture docs are settled and authoritative:

- `docs/architecture/knowledge-graph-design-reference.md` — three-layer architecture, modelling decision rules, Cypher examples, the `stub` and `top_level_taggable` boolean conventions.
- `docs/architecture/edge-vocabulary-reference.md` — authoritative edge type list. Adding a new edge type requires editing this file first.
- `docs/architecture/knowledge-graph-domain-map.md` — confirmed domains, areas under exploration, explicit out-of-scope items.
- ADR-011 — multi-level tagging design.

These four documents are the inputs to the YAML iteration; the plan below does not duplicate their content.

---

## Part 1 — Carry-In Cleanup

The five items below were decided after Component 3 closed. They are independent of each other and of the knowledge graph work, but they should land before Part 2 begins so the staging environment is clean and the fragment data layer is locked in by tests before any code in Component 5 will start writing fragments.

---

### Step 1 — Silence the Supabase `alembic_version` RLS warning

**Impact: Supabase linter warning; no functional consequence.**

The `public.alembic_version` table is created by Alembic to track migration state. Supabase's linter flags any `public.*` table without RLS because PostgREST exposes it through the auto-generated REST API. Alembic only ever connects as the `postgres` superuser (per `DATABASE_URL`), and superusers bypass RLS entirely, so enabling RLS without writing any policies silences the linter without breaking migrations.

Execute against staging (and production once it exists):

```sql
ALTER TABLE public.alembic_version ENABLE ROW LEVEL SECURITY;
```

Do not write any policies. The combination "RLS enabled, no policies, queried by superuser" is exactly what we want: invisible to PostgREST's `anon` and `authenticated` roles, fully accessible to Alembic.

Make the change idempotent across environments by adding a one-line Alembic migration:

```python
def upgrade() -> None:
    op.execute("ALTER TABLE alembic_version ENABLE ROW LEVEL SECURITY")

def downgrade() -> None:
    op.execute("ALTER TABLE alembic_version DISABLE ROW LEVEL SECURITY")
```

This way a fresh Supabase project picks the correct setting up automatically; a production environment provisioned later does not need a separate ops procedure.

**Verification.** Re-open the Supabase linter — the warning is gone. Run `alembic upgrade head` against the staging DB and confirm migrations still apply (no permission error). Update `docs/architecture/security-model.md` with one paragraph noting that the table is RLS-enabled with no policies and explaining why.

---

### Step 2 — Delete the stale `worker` process group from `fly.toml`

**Impact: Fly app health-check noise; misleading log line.**

The Fly logs show `Cannot connect to redis://red-...:6379` from a worker process. The `red-...` hostname pattern is a Render-managed Redis URL that predates the move to Upstash; ADR-017 §2 says staging should not point at Upstash anyway, and `deployment.md` § "Upstash Redis" is explicit that no Celery worker is deployed in Phase 1.

Three things to do, in order:

1. Open `fly.toml` for the staging app and remove the `[processes]` block's `worker = "..."` entry (or the `[[vm]]` group dedicated to it). Keep only the `app` (web) process group.
2. Delete the matching Fly secrets that were pointing the worker at the stale Redis URL. Leave `REDIS_URL`, `CELERY_BROKER_URL`, and `CELERY_RESULT_BACKEND` in place — the API process imports `celery_app` at startup and dispatches tasks via `.delay()`, which writes to the broker even with no worker draining it. Per `deployment.md`, the message ends up logged-and-skipped on the API side, which is the desired Phase 1 behaviour. Do confirm the values are not the stale `red-...` URL; if they are, replace them with a non-Upstash Redis URL per ADR-017 (a small free Redis on Render or Railway is appropriate). Do **not** point staging at Upstash.
3. Redeploy: `fly deploy --app doppia-staging`. The `Cannot connect to redis://red-...` log lines should disappear within one release.

Update `docs/deployment.md` § "Upstash Redis" to add a sentence: *"Staging has no `worker` process group in `fly.toml`. The `app` process imports `celery_app` so `.delay()` calls succeed (the message is enqueued and dropped); they will execute once a worker is deployed against the appropriate non-Upstash broker."*

**Verification.** `fly status --app doppia-staging` shows only the `app` process group. `fly logs --app doppia-staging` no longer surfaces the Redis-connection warning.

---

### Step 3 — Implement R2/I12: `pending_analysis` flag and re-dispatch endpoint

**Impact: orphaned movements have no recovery path today.**

Per Report 2 Issue 12, `services/ingestion.py` correctly rolls back the DB transaction if R2 storage fails (storage and DB are atomic), but the inverse failure is unhandled: if the DB commits and the Celery dispatch then crashes — broker unreachable, process kill mid-loop — the movement row exists, the MEI is in R2, but no `movement_analysis` row will ever be written and no incipit will ever be generated. With Phase 1 having no worker deployed yet, this is *every* movement uploaded to staging right now: the rows exist, the MEI is there, the analysis is missing. Once a worker comes online, the same mechanism is the natural backfill path.

**Decision.** Option 1 from the report: a `pending_analysis: bool` flag on `movement`. Confirmed in conversation; ADR follows below.

**3.1 — Schema migration.** Add an Alembic migration that:

- Adds `pending_analysis BOOLEAN NOT NULL DEFAULT TRUE` to `movement`.
- Backfills existing rows: every existing row is set to `TRUE` (because we know none of them have `movement_analysis` yet — the worker has never run).
- Adds a partial index: `CREATE INDEX movement_pending_analysis_idx ON movement (id) WHERE pending_analysis = TRUE`. The partial form keeps the index small as the corpus grows, since the steady-state expectation is "almost all movements have `pending_analysis = FALSE`."

**3.2 — Wiring.** In `services/ingestion.py`, the upsert block already sets all movement fields; add `pending_analysis = TRUE` explicitly. In `services/tasks/ingest_analysis.py` `_dcml_branch` and the music21 branch, set `pending_analysis = FALSE` in the same transaction that writes `movement_analysis`. If the task fails partway, the flag stays `TRUE` and the movement is re-eligible for the next dispatch. The flag is only flipped to `FALSE` on a *successful* analysis ingest.

**3.3 — Admin endpoint.** Add `POST /api/v1/admin/dispatch-pending-analysis` (require `admin` role). The handler queries `SELECT id, mei_object_key FROM movement WHERE pending_analysis = TRUE`, dispatches `ingest_movement_analysis.delay(...)` for each, and returns a summary report `{dispatched: N, failed_to_dispatch: [...]}`. No retry budget on the endpoint — the admin re-runs it manually if needed.

**3.4 — Optional periodic re-dispatch.** Out of scope for Phase 1. Once a worker is running 24/7 and the corpus grows, a Celery beat task that re-dispatches movements with `pending_analysis = TRUE` and `updated_at` older than N minutes is the natural extension. Mention in the ADR but do not implement.

**3.5 — ADR-018.** Write `docs/adr/ADR-018-partial-failure-recovery-for-ingestion.md`. Status: Accepted. Date: today. Sections: Context (the partial-failure mode and why it gets worse not better in Phase 1), Decision (the `pending_analysis` flag plus admin endpoint, deferring the periodic worker), Consequences (admin must run the re-dispatch endpoint after restarts; the flag is the canonical "needs analysis" signal that the eventual transactional outbox would supersede; storage-then-DB ordering remains atomic so "MEI without movement row" is still impossible). Reference Report 2 Issue 12 for traceability.

**3.6 — Tests.** Unit test for the upsert: a fresh `ingest_corpus` run sets `pending_analysis = TRUE` for each movement. Integration test for `_dcml_branch`: after success, the movement's `pending_analysis = FALSE`. Integration test for the admin endpoint: pre-seed three movements with `pending_analysis = TRUE`, call the endpoint, assert the Celery dispatcher received three calls (use `celery_app.send_task` mock or eager mode).

**Verification.** Manually: kill the staging API after upload but before dispatch (rare but reproducible by stopping Redis briefly); re-upload, run the admin endpoint, confirm the analysis tasks are dispatched and (when a worker exists) `pending_analysis` flips to `FALSE`.

---

### Step 4 — Fragment data layer test coverage (R7/I8)

**Impact: the data type Component 5 will write against is currently un-pinned by tests.**

Per Report 7 Issue 8, `backend/models/fragment.py` defines `Fragment`, `FragmentConceptTag`, and `FragmentReview` — the central data type Phase 2 will be built on — and has zero tests. No service or route writes fragments yet, so the schema is not yet locked in by data; the moment Component 5 begins, tests are the only mechanism that will catch a breaking change to the `summary` JSONB shape, the `parent_fragment_id` cascade rule, or the cross-system referential integrity contract for `concept_id`.

This step is deliberately scoped before Component 5 begins so the schema is locked in *before* the tagging tool starts writing rows.

Add `backend/tests/unit/test_fragment_models.py` with at minimum:

1. Construction and defaults: build a `Fragment` ORM instance with all required fields, assert `status` defaults to `"draft"`, `created_at`/`updated_at` default to now-ish, the `summary` dict round-trips through SQLAlchemy's JSONB serialisation with `summary["version"] == 1`.
2. `summary` JSONB version invariant: a Pydantic schema for `FragmentSummary` should require `version` and reject unknown versions. If no Pydantic schema exists for `summary` yet, this step adds one in `models/summary.py` and the test asserts the validation. The schema mirrors `docs/architecture/fragment-schema.md` § "Summary JSONB schema."
3. `parent_fragment_id` cascade: deleting a parent `Fragment` cascades to all child rows. Use a SQLite in-memory DB in the test (no Docker) — sufficient for ON DELETE CASCADE behaviour at the SQL level. Assert children are gone.
4. `fragment_concept_tag` cross-system contract: the docstring on the column says `concept_id` values are Neo4j `Concept.id` strings with no DB-level FK; referential integrity is enforced at the Pydantic write layer. Add a test that constructs a `FragmentConceptTag` with a `concept_id` that does not exist in Neo4j (mocked) and asserts the validation layer raises. If the validation layer does not exist yet, the test serves as a TODO marker referenced by Component 5's design.
5. `FragmentReview` `UNIQUE (fragment_id, reviewer_id)`: insert two reviews for the same fragment-reviewer pair; assert `IntegrityError`.

Roughly 8–12 tests, all unit-level, no Docker.

**Verification.** `pytest backend/tests/unit/test_fragment_models.py` passes. `pytest --cov=backend.models.fragment backend/tests/unit/` shows ≥80% coverage.

---

### Step 5 — Playback coordinates architecture doc

**Impact: three of the open Component 3 GitHub issues share a root cause that has never been pinned down in writing.**

The repeats note-highlight bug, the transport-bar `measure:beat` glitches (no pickup handling, no repeat policy, hardcoded quarter-note beats), and the transposition dropdown's semitone bug all touch the same surface: how the score viewer translates between MEI coordinates, display coordinates, MIDI ticks, and the `onPositionUpdate(bar, beat)` callback. Without a settled spec, each fix risks contradicting another.

Write `docs/architecture/playback-coordinates.md`. The doc should pin down:

**A. The four coordinate systems and the conversions between them.**

| Coordinate | What it is | Source |
|---|---|---|
| MEI `@n` (notated bar number) | The integer the score editor wrote on each `<measure>` | MEI file |
| Position index | The 1-based ordinal of the measure in the rendered score (Verovio's `select` operand and what `_build_measure_map` returns as keys) | Computed at ingest |
| Display bar | What the transport bar shows the user | Derived from `@n` plus display rules |
| MIDI tick | Verovio's internal time for `getElementsAtTime` | `renderToMIDI()` output |

The doc walks through each pairing and gives a worked example from the Mozart corpus.

**B. Pickup bar handling.** Per the measure-number protocol in `phase-1.md` § Component 1, pickup bars are `@n="0"` after normalisation. The display rule: a pickup bar shows as `0:beat`, with the beat numbered against the *partial* bar's beat count, not the time signature's. So a 4/4 movement with a 1-beat pickup that begins on beat 4 shows `0:1` for the first event, not `0:4`. The transport bar reads from `_build_measure_map` to know the pickup's beat count.

**C. Repeat policy.** Verovio's `getElementsAtTime` returns the same SVG element for both passes through a repeated section by default. The rule for Phase 1: highlight follows the *MIDI's* pass count — first pass highlights the first ending's elements, second pass highlights the second ending's. Since `tk.renderToMIDI()` already expands repeats into the linear MIDI stream, the bar number reported by the position callback should be the *display* bar (`@n` of the SVG element about to highlight), not a re-numbered linear position. The transport bar shows the display bar of the currently highlighted element. The volta bracket is the only visual cue distinguishing the two passes.

This rule is the simplest one consistent with what the user sees on the page; anything more elaborate (a "repeat-aware" linear bar count) is a Phase 2 concern when scrollytelling needs it.

**D. Non-quarter-meter beat normalisation.** The transport bar reports beats in the *prevailing time signature's denominator unit*, not in quarters. A 6/8 measure reports beats 1–6 (eighth notes) when an eighth note sounds; a 3/2 measure reports beats 1–3 (half notes). The `onPositionUpdate(bar, beat)` callback's `beat` is a 1-based integer in those units. The conversion happens once, at MIDI generation time, by reading the prevailing meter from `_build_measure_map` and dividing the MIDI tick offset within the bar by the appropriate unit.

**E. Transposition's semitone bug.** Document the existing bug as the doc is written: `transpose: "d2"` (diminished second = enharmonic semitone) is what Verovio expects for a chromatic semitone shift; "Up a semitone" in the dropdown should map to `"a1"` (augmented unison) for an *up* chromatic semitone. The bug is almost certainly an interval-string mismatch. The doc lists the canonical interval strings for each dropdown option as a reference table, and the fix is a one-liner in the dropdown's value map.

**F. Forward-compatibility hooks.** A short closing section explicitly noting that the `onPositionUpdate(bar, beat)` callback is the single integration point for any future real-audio path; the coordinates above are the contract real-audio alignment must satisfy.

The doc is reference material, not a decision log — none of the rules above is novel; they just have not been written down. Once the doc is in place, Step 6 (the three GitHub-issue fixes in Part 5) becomes a mechanical application of the rules.

**Verification.** Doc review against the score viewer's current behaviour: each rule maps to a specific code location either correctly implemented or noted as a known bug. The three GitHub issues are referenced inline as test cases.

---

## Part 2 — Knowledge Graph Foundation

The infrastructure pieces that the cadence YAML (Part 3) will exercise. Build them once, reuse for every subsequent domain.

---

### Step 6 — YAML schema and Pydantic validation models

The seed YAML structure is prescribed in `phase-1.md` § Component 4 but has not been pinned in code. Define the Pydantic models that mirror the YAML, in `backend/seed/schemas.py` (a new module).

```python
class PropertyValueYAML(BaseModel):
    id: str
    name: str
    references: str | None = None      # concept id this value points back to (optional)
    aliases: list[str] = []

class PropertySchemaYAML(BaseModel):
    id: str
    name: str
    description: str
    cardinality: Literal["ONE_OF", "MANY_OF", "BOOL"]   # BOOL: implicit true/false, no values (ADR-019)
    required: bool = False
    values: list[PropertyValueYAML] = []                 # empty for BOOL schemas
    model_config = {"extra": "forbid"}

class RelationshipYAML(BaseModel):
    type: str                          # validated against edge-vocabulary-reference.md
    target: str                        # concept id

class ContainsEntryYAML(BaseModel):
    target: str
    order: int
    required: bool = True

class ConceptYAML(BaseModel):
    id: str
    name: str
    aliases: list[str] = []
    type: Literal["Chord", "CadenceType", "SequenceType", "FormalUnit", ...] | None = None
    definition: str
    domain: str                        # "cadences", "harmonic-functions", ...
    complexity: Literal["foundational", "intermediate", "advanced"] | None = None
    stub: bool = False
    top_level_taggable: bool = True
    relationships: list[RelationshipYAML] = []
    contains: list[ContainsEntryYAML] = []
    property_schemas: list[str] = []   # ids of PropertySchemas applicable to this concept
    model_config = {"extra": "forbid"}

class DomainYAML(BaseModel):
    domain: str
    concepts: list[ConceptYAML] = []
    property_schemas: list[PropertySchemaYAML] = []
```

`extra="forbid"` is non-negotiable: a typo in a YAML key must produce a validation error, not be silently ignored. The `type` literal list is the closed enumeration from `knowledge-graph-design-reference.md` § "Concept node types"; expand it as new types arise, never accept an unknown value.

The `RelationshipYAML.type` field validates against the edge vocabulary at *load* time. Add a class-level validator that reads the vocabulary list from a constants module (`backend/graph/queries/relationships.py` per CLAUDE.md) — never hardcode the edge type list in two places.

Add unit tests in `backend/tests/unit/test_seed_schemas.py`:

1. Round-trip: a known-good YAML literal parses, serialises, and re-parses identically.
2. `extra="forbid"`: a YAML with a misspelled key raises `ValidationError` and the error message identifies the bad key.
3. Cardinality literal: `cardinality: "FOO"` raises with a clear message.
4. Edge type validation: `relationships: [{type: NONSENSE_EDGE, target: X}]` raises.
5. Stub and `top_level_taggable` defaults: a concept with neither field defined gets `stub=False` and `top_level_taggable=True` per `knowledge-graph-design-reference.md`.

About 15 tests. Unit-level, no Docker.

---

### Step 7 — Seeding script (`scripts/seed.py`)

The script is invoked as `python scripts/seed.py --domain cadences` (or `--all` to load every YAML file). It is idempotent — the rerun policy from `phase-1.md` is `MERGE`, never `CREATE`. CLAUDE.md confirms the rule: bare `CREATE` in a seed script is a bug.

Behaviour:

1. Load every `*.yaml` file in `backend/seed/domains/` (or just the named domain) and validate each against `DomainYAML`.
2. Build an in-memory dependency graph: for each concept, its `relationships[].target`, `contains[].target`, and `property_schemas[]` references must resolve to a concept id or property-schema id known to the union of all loaded files. If a reference is unresolved, the script aborts before issuing any Cypher with a clear message identifying the unresolved id and the file/concept that referenced it.
3. Issue `MERGE` statements in dependency order: PropertySchemas and PropertyValues first, then concepts (with their boolean and prose properties), then relationships, then `CONTAINS` edges with their `order` and `required` properties, then `HAS_PROPERTY_SCHEMA` edges. Each `MERGE` is keyed on `id`; properties are set with `ON CREATE SET ... ON MATCH SET ...` so re-runs update prose changes.
4. **Concept id immutability check:** before issuing any writes, query Neo4j for the set of existing concept ids. If any id present in the previous run is *absent* from the YAML, log a loud warning identifying the orphaned id and ask for confirmation (`--force` to proceed without confirmation in CI). A renamed `id` is a breaking change that invalidates `fragment_concept_tag.concept_id` foreign keys; this guardrail is the only mechanism enforcing the invariant.
5. Use the raw `neo4j` driver (per CLAUDE.md: "neo4j driver → all traversal queries → backend/graph/queries/"); seeding is bulk DDL, not routine CRUD, and the explicit Cypher is auditable. Place the Cypher fragments in `backend/graph/queries/seed.py`.
6. Print a structured summary at the end: concepts created, concepts updated, edges created, edges updated, stub-node count by domain.

Exit codes: 0 on success, 1 on validation error, 2 on unresolved reference, 3 on user-cancelled id-immutability warning. CI distinguishes these.

Add an integration test in `backend/tests/graph/test_seed.py` that seeds a tiny synthetic YAML against a Neo4j docker container and asserts the expected nodes/edges exist. Mark with the `integration` marker per Report 7 Issue 5.

---

### Step 8 — Validation suite (`scripts/validate_graph.py`)

The validation queries are listed in `phase-1.md` § Component 4. Implement each as a separate Cypher query in `backend/graph/queries/validation.py`, exposed as a typed Python function returning a list of offending node ids. The script aggregates the results and prints a structured report.

Required checks:

1. No concept node has zero outgoing edges (every concept must connect to the graph somehow).
2. Every `IS_SUBTYPE_OF` reference points to an existing concept id.
3. Every `CONTAINS` target is a defined concept id.
4. Every PropertyValue with a `references` field points to an existing concept id.
5. Every PropertySchema has at least one `HAS_VALUE` edge — except `BOOL`-cardinality schemas, which carry no values by definition (ADR-019).
6. `CONTAINS` edges on a given concept have unique `order` values (no two children share `order`).

Add three further checks not listed in `phase-1.md` but logically required:

7. Every concept has a non-empty `definition` *unless* `stub == true`.
8. Every concept's `id` matches `^[A-Z][A-Za-z0-9]*$` (PascalCase, no underscores) — enforces the convention that `id` is the immutable join key, not a display string.
9. No two concepts share the same `id` across files (the cross-file uniqueness check happens in Step 7's loader, but this validates the actual graph state).

The script prints a per-check pass/fail table and exits non-zero if any check fails. Stub-node counts by domain are reported as informational data (not errors), per `phase-1.md`.

Run after every seed in CI.

---

### Step 9 — pyvis development visualisation (`scripts/visualize_domain.py`)

Implement the script as `python scripts/visualize_domain.py --domain cadences --output cadences.html`. Reads the seeded graph from Neo4j (not the YAML), filters to the domain plus any directly referenced stubs from adjacent domains, and exports a pyvis HTML file with:

- Concept nodes coloured by `domain` (cadences vs. stubs from harmonic-functions vs. stubs from formal-structure visibly distinct).
- Stub nodes drawn with a dashed border and a "[stub]" suffix on the label.
- PropertySchema nodes a different shape (square or diamond).
- PropertyValue nodes smaller and lighter.
- Edges labelled with their type; `CONTAINS` edges show `(order: N, required: true|false)` in the tooltip.

This is a development tool, not a published artefact — keep the script under 200 lines and skip styling polish.

Add a CLAUDE.md / CONTRIBUTING entry: *"After every YAML change, run `python scripts/visualize_domain.py --domain <name>` and visually confirm the structure before committing."*

---

## Part 3 — Cadence Domain

The collaborative core of Component 4. The user has a draft MD design for the cadence domain; this part is the conversion of that draft to YAML and the iteration loop until the validation suite is clean.

The work is structured as a tight loop rather than a single linear step because the YAML almost always surfaces design questions ("does this property apply to all subtypes or only authentic cadences?", "is the post-cadential extension a `CONTAINS` child or a separate concept?") that send us back to the MD draft. Plan three to four passes.

---

### Step 10 — MD-to-YAML first pass

Inputs: the user's draft MD design.

Output: `backend/seed/domains/cadences.yaml`.

**Working pattern.** The user shares the MD draft (likely as an attachment or pasted into chat). Together we walk through it section by section:

1. List the concepts the MD names. For each, decide id, name, type (`CadenceType` for most cadence concepts; `FormalUnit` for the abstract category Cadence; etc.), domain (`"cadences"`), complexity, `stub`, `top_level_taggable`, and prose definition. Apply the "what earns a concept node" criterion from `knowledge-graph-design-reference.md` § 2 to anything ambiguous.
2. Map relationships: every IS_SUBTYPE_OF chain from the MD's hierarchy. Use `RESOLVES_TO`, `CONTRASTS_WITH`, `FOLLOWS` only where the MD calls for them and the edge is in the active vocabulary per `edge-vocabulary-reference.md`. Anything new requires editing that doc first; flag and stop.
3. Map `CONTAINS` for cadences with internal stage structure (PAC → Predominant + Dominant + Resolution, etc.). Each child entry gets an `order` and `required` flag.
4. Identify the PropertySchemas the MD implies. Common cadence schemas: `SopranoPosition`, `BassPosition`, `CadentialElaboration`, `Predominant`. For each, list values; mark `cardinality` as `ONE_OF` or `MANY_OF`; mark `required`. PropertyValues that point back into the concept graph (e.g. `Cadential64` as a value of `CadentialElaboration`) get a `references` field.
5. Wire every concept's `property_schemas` list to the schemas it inherits — directly or via `IS_SUBTYPE_OF` from a parent that owns the schema. Per the design reference, schema inheritance is implicit through `IS_SUBTYPE_OF*0..` traversal at query time, so the YAML only needs to declare the schema at the *highest* concept that owns it; subtypes inherit automatically.
6. Identify the stub references (concepts that the cadence domain points at but does not own — `Tonic`, `Dominant`, `PreDominant`, `Phrase`, `ScaleDegree1`, etc.). Hold those for Step 11.

**Practical mechanics.** The user drives the design decisions; I draft the YAML chunk by chunk. After each chunk:

```bash
python scripts/seed.py --domain cadences --dry-run
python scripts/validate_graph.py
python scripts/visualize_domain.py --domain cadences --output /tmp/cadences.html
```

Open the pyvis HTML, walk through it together, iterate. The `--dry-run` flag on the seed script (add it in Step 7 if not already there) validates the YAML through Pydantic and the dependency-resolution pass without touching Neo4j — useful for the loop.

**Working folder.** Drafts of the YAML in progress can live in `docs/seed-drafts/cadences-draft.yaml` (since this Cowork project's edits are scoped to `docs/`); the final move to `backend/seed/domains/cadences.yaml` happens via Claude Code.

**Exit criterion for this step.** A `cadences.yaml` that:

- Validates through Pydantic with `extra="forbid"`.
- Resolves all internal references (every `relationships[].target` and `contains[].target` is either a concept defined in this file or — by Step 11's end — a stub in an adjacent file).
- Loads cleanly into Neo4j against an empty database.
- Passes the validation suite (Step 8) with the *expected* stub count for adjacent domains and zero hard failures.

---

### Step 11 — Stub nodes for adjacent domains

The cadence domain references concepts owned by domains that have not yet been built: harmonic functions (`Tonic`, `Dominant`, `PreDominant`), formal structure (`Phrase`), scale degrees (`ScaleDegree1` through `ScaleDegree7`), and possibly others depending on what Step 10 produces.

Per `phase-1.md` § Component 4: stub nodes live in *their eventual home domain file*, not in a separate stubs file. So harmonic-function stubs go in `backend/seed/domains/harmonic-functions.yaml`, formal-structure stubs in `backend/seed/domains/formal-structure.yaml`, scale-degree stubs in `backend/seed/domains/scale-degrees.yaml`. Each stub:

```yaml
- id: Tonic
  name: "Tonic"
  domain: harmonic-functions
  stub: true
  definition: "Stub: defined in the harmonic-functions domain."
  top_level_taggable: false
```

`top_level_taggable: false` for stubs because they should never appear in the concept picker until promoted. This is also enforced by the picker query (`stub: false AND top_level_taggable: true`) per `knowledge-graph-design-reference.md` § 2, so it is belt-and-suspenders.

Walk the cadence YAML's references, list every external id, group by home domain, write the stub files. Run the seed and validation scripts again. The validation report should show: zero hard failures, expected stub count by domain.

When a domain is fully built later, the `stub: true` flag is removed and the definition filled in — no files move. The seed script's `MERGE` semantics handle the promotion correctly: `ON CREATE SET stub=false ON MATCH SET stub=false` overwrites the previous stub state.

---

### Step 12 — Concept full-text index

Per Component 5's design (`phase-1.md` § 5.2), the concept picker queries a Neo4j full-text index over `name` and `aliases`. The index is a one-time DDL operation; create it as part of the seed script's first-run path:

```cypher
CREATE FULLTEXT INDEX concept_search IF NOT EXISTS
FOR (c:Concept) ON EACH [c.name, c.aliases]
```

`IF NOT EXISTS` makes it idempotent — re-runs are no-ops. Place the DDL in `backend/graph/queries/seed.py` alongside the seeding queries. Verify by running a sample query: `CALL db.index.fulltext.queryNodes("concept_search", "perfect authentic")` should return PAC and similar concepts after seeding.

This step exists in Component 4 (not deferred to Component 5) because the index must be present whenever the cadence domain is loaded — including in CI, where Component 5's tests will run against the seeded fixtures.

---

## Part 4 — Visualisation, Tests, and CI

The remaining infrastructure that turns the cadence domain from "loaded" to "operational and protected against regression."

---

### Step 13 — Neo4j Bloom perspective

Bloom is the editorial visualisation tool annotators will use to inspect the graph during tagging. Per `phase-1.md`: configure a saved perspective for the cadence domain, document the setup in `docs/architecture/bloom-setup.md`.

**Perspective contents:**

- Categories: Concept (one colour, e.g. Henle Blue), PropertySchema (a contrasting colour, square shape), PropertyValue (small, lighter), Stub (dashed outline, applied as a Bloom rule on `stub == true`).
- Visible relationship types: `IS_SUBTYPE_OF`, `CONTAINS` (with `order` shown on the edge), `HAS_PROPERTY_SCHEMA`, `HAS_VALUE`, `VALUE_REFERENCES`, plus any cadence-specific edges (`RESOLVES_TO`, `CONTRASTS_WITH`).
- A saved search: "Cadence subtypes" → `MATCH (c:Concept)-[:IS_SUBTYPE_OF*]->{Cadence} RETURN c`.
- A saved search: "PAC stage structure" → `MATCH (PAC:Concept {id: 'PerfectAuthenticCadence'})-[:CONTAINS]->(stage) RETURN PAC, stage`.

Export the perspective JSON (Bloom → Settings → Export) and commit to `backend/seed/bloom/cadence-perspective.json`. The doc walks through how to import it into a fresh AuraDB Bloom instance.

`docs/architecture/bloom-setup.md` sections: prerequisites (AuraDB instance, Bloom enabled), step-by-step import of the perspective JSON, the four saved searches and what each is for, conventions for adding new perspectives as future domains land.

---

### Step 14 — Graph structure tests

Populate `backend/tests/graph/` (currently empty per Report 7 Issue 2). Replace the empty directory with real tests, all marked `integration` per Report 7 Issue 5.

**Test file 1: `test_seed_idempotence.py`.** Seed cadence + adjacent stubs into a fresh test Neo4j, then seed again. Assert node and edge counts are identical after the second seed. Catches the most common seed-script regression: a `CREATE` that should have been a `MERGE`.

**Test file 2: `test_validation_suite.py`.** Run each of the nine validation queries from Step 8 against the seeded graph. Assert each passes. Then deliberately break the graph in three ways (delete a `HAS_VALUE` edge, add a duplicate `CONTAINS` order, add a dangling `IS_SUBTYPE_OF` reference) and assert the corresponding query catches each.

**Test file 3: `test_concept_search.py`.** Index a small fixture, run full-text queries against expected results ("perfect authentic" → PAC; "half" → HC). Asserts the index is created and behaves.

**Test file 4: `test_schema_inheritance.py`.** A concept that inherits a PropertySchema from a parent via `IS_SUBTYPE_OF*` resolves correctly. This is the query Component 5's `GET /api/v1/concepts/{id}/schemas` endpoint will run; pin its expected behaviour now.

About 15–20 tests across the four files.

---

### Step 15 — CI integration

Wire the validation suite and graph tests into CI. Per Report 7 Issue 3, CI exists now (the issue is marked solved); this step adds the graph-specific jobs.

Add to `.github/workflows/ci.yml`:

1. A job that boots a Neo4j service container, runs `python scripts/seed.py --domain cadences` followed by `python scripts/validate_graph.py`, and fails the build on any non-zero exit.
2. A job that runs `pytest -m integration backend/tests/graph/` against the same Neo4j service container.
3. A pre-commit hook (`.pre-commit-config.yaml`) that runs `python scripts/seed.py --dry-run` against any modified file in `backend/seed/domains/`. Catches Pydantic validation errors before they reach CI.

Update `CONTRIBUTING.md` testing section to mention `backend/tests/graph/` and the integration marker pattern.

---

## Part 5 — Side Tracks

These items run in parallel with Parts 1–4. They do not block Component 4 and do not depend on its outcomes; they exist on this plan to keep them visible. Pick them up between the heavier YAML iteration sessions or between Steps 14 and 15 once the main sequence is winding down.

---

### Step 16 — Score viewer polish (minor UI items)

Four small fixes called out in conversation. All in `frontend/src/routes/ScoreViewer.tsx` or its CSS module.

**Score width.** Reduce the score panel `max-width` from 1400px (Step 12.4 of Component 3) to ~1100px. The score is currently too wide on standard laptop displays.

**Centred toolbar and playback bar.** The score panel itself centres correctly; the controls above and below it should match. Apply `justify-content: center` to the toolbar and playback-bar inner containers (or change their layout to use `margin: 0 auto` on a max-width inner wrapper).

**Staff size mapping.** The current Small/Medium/Large preset values undersize the score. Rebind: Small=35 (current Medium), Medium=45 (current Large), Large=55. Update the preset buttons' `aria-label` and the keyboard shortcut docs accordingly. Run a quick visual check on a standard movement at each setting.

**Hide page numbers.** Per ADR-003, the score uses vertical infinite scroll; "page" is a Verovio implementation detail with no semantic meaning for the reader. Set Verovio's `footer: "none"` (or `pageHeader/pageFooter` to disable page numbering) in the rendering options. Do not conflate with measure numbers, which absolutely should remain visible — those use Verovio's `multiRest`/`measureNumber` options, untouched.

Wrap all four into one PR titled `fix(score-viewer): width, centring, staff sizes, page numbers`.

---

### Step 17 — Note highlight on repeats

GitHub issue. The MIDI re-plays a repeated section but the SVG highlight either disappears or sticks to the wrong volta. Fix per the rules in Step 5's playback-coordinates doc: the highlight follows the bar number reported by the position callback, which is the *display* bar of the SVG element about to highlight; volta brackets are the visual cue distinguishing first from second pass.

Implementation:

1. In `verovio.ts`'s `renderMidi`, capture the linear-to-display bar map at MIDI generation time. The map is a list whose i-th entry is the display bar for the i-th MIDI bar. For a movement with no repeats, this is the identity; for a movement with one repeat, it expands.
2. In the position callback handler, translate the linear bar reported by Tone.js to the display bar via the map, then call `tk.getElementsAtTime(displayBar, beat)`.
3. For voltas: the map distinguishes first vs second ending naturally — the first repeat pass uses the first-ending measures' display bars, the second pass uses the second ending's. `getElementsAtTime` returns the right SVG group because the coordinate system is unambiguous.

Test: a Mozart fixture with a clear repeat (e.g. K. 331 mvt 1 — the theme has a written-out repeat) plays through, and the highlight tracks correctly through both passes including any volta divergence.

---

### Step 18 — Transport bar (`measure:beat`) fixes

GitHub issue, three sub-defects. All resolved by the playback-coordinates doc (Step 5).

1. **Pickup bar handling.** The transport reads `_build_measure_map` to determine if a measure is a pickup; if so, formats as `0:beat` with the beat numbered against the partial bar, not the time signature. Already specified in the doc.
2. **Repeat policy.** The transport shows the *display* bar of the currently sounding element, not a re-numbered linear counter. Already specified.
3. **Non-quarter beat normalisation.** The `beat` value in `onPositionUpdate` is in the prevailing time signature's denominator unit. The transport renders it as-is. The conversion happens once at MIDI generation time; the transport bar stays simple.

Implementation: update `frontend/src/components/playback/TransportBar.tsx` (or wherever the bar lives) to read from `_build_measure_map` for pickup detection; remove any hardcoded quarter-note assumption.

Tests: a 6/8 fixture, a fixture with a pickup, and a fixture with a repeat each play through and the transport reports correctly.

---

### Step 19 — Transposition dropdown: semitone bug + design polish

GitHub issue. The semitone bug is a one-line fix per Step 5's reference table: "Up a semitone" maps to `"a1"` (augmented unison), not `"d2"` (diminished second). Apply, add a unit test that asserts the dropdown's value map matches the table in `playback-coordinates.md`.

Design polish items from conversation: minor visual things (label alignment, dropdown width consistency with other controls). Treat as a CSS-only follow-up; no functional code changes. Bundle with Step 16's polish PR if both ship in the same window.

---

## Part 6 — Accidentals Investigation

The Sonata 1 (K. 279) mvt 1 accidentals/MIDI bug is sufficiently open-ended that it gets the last slot. Reproduce first, classify, then decide on the fix. The investigation should not begin until Steps 1–18 are done — the bug is not blocking anything.

---

### Step 20 — Reproduction

Pick one specific measure where the bug is observable. Listen through K. 279 mvt 1 with the score visible, identify a measure where the rendering is correct but the MIDI sounds a wrong pitch, and note the measure number.

Capture the evidence:

1. Extract the `<measure @n="N">` block from the source MEI using `lxml`. Note every `<note>`'s `@pname`, `@oct`, `@accid`, and `@accid.ges` attributes.
2. Decode `tk.renderToMIDI()`'s base64 output for the score and isolate the events in measure N. Use `@tonejs/midi` in a small script to dump pitch + tick.
3. Diff: MEI says X, MIDI says Y, SVG (correct) renders X.

Save the artefacts (MEI excerpt + MIDI dump) under `docs/investigations/accidentals-k279-mvt1/`. The diff is the reproduction; everything else flows from it.

---

### Step 21 — Classification and fix

Three buckets the bug could fall into, per the Component 3 close-out conversation:

1. **Verovio MIDI bug.** `renderToMIDI()` resolves accidentals via internal logic separate from the SVG renderer. If the diff shows "MEI has `@accid="s"`, SVG plays the sharp, MIDI plays natural" and similar, this is a Verovio-side reconciliation issue. The fix is filing upstream and pinning a workaround (post-process the MIDI output, or pre-process the MEI to set explicit `@accid.ges` to match `@accid` before passing to Verovio).
2. **MEI source defect.** OpenScore Mozart files sometimes encode `@accid` (notated) without `@accid.ges` (gestural). Verovio's MIDI path may interpret missing `@accid.ges` as "no alteration." If this is the cause, the fix lives in `services/mei_normalizer.py` as a new pass that copies `@accid` to `@accid.ges` when the latter is absent. ADR-019 documents the choice.
3. **Normalisation regression.** One of the existing normalisation passes touches accidentals on courtesy or cautionary cases. Less likely but possible. The fix is correcting the offending pass.

Once classified, write the fix in the appropriate location and add a regression test at the level it lives:

- Bucket 1: a frontend Vitest test that runs the WASM toolkit on the offending MEI excerpt and asserts the MIDI pitch is correct (after the workaround is applied).
- Bucket 2 or 3: a backend unit test in `backend/tests/unit/test_mei_normalizer.py` that runs the relevant normalisation pass on a fixture and asserts the `@accid.ges` is set or preserved correctly.

If bucket 2 or 3, write `docs/adr/ADR-019-mei-accidental-normalization.md` with the diagnosis, the chosen approach, and the fixture as evidence.

---

## Sequencing

Parts 1 and 2 are mostly independent; Parts 3 and 4 depend on Part 2; Parts 5 and 6 are parallel.

```
Day 1:    Step 1 (Supabase RLS) + Step 2 (fly.toml worker delete)
Day 2-3:  Step 3 (R2/I12 implementation + ADR-018)
Day 4:    Step 4 (fragment data layer tests)
Day 5:    Step 5 (playback coordinates doc)
Day 6:    Step 6 (YAML schema + Pydantic models) + Step 7 starts (seed script)
Day 7:    Step 7 finishes + Step 8 (validation suite)
Day 8:    Step 9 (pyvis visualisation)
Day 9-12: Step 10 (cadence YAML iteration, multiple passes)
Day 13:   Step 11 (stub nodes for adjacent domains)
Day 14:   Step 12 (concept full-text index)
Day 15:   Step 13 (Bloom perspective + bloom-setup.md)
Day 16:   Step 14 (graph structure tests)
Day 17:   Step 15 (CI integration)
Day 18:   Step 16 (score viewer polish — can move earlier if convenient)
Day 19:   Steps 17-19 (the three GitHub issues)
Day 20+:  Step 20 (accidentals reproduction) + Step 21 (classification and fix)
```

Steps 16–19 are independent of the main sequence; if they happen earlier in the calendar (e.g. between cadence iteration sessions when a fresh head is needed), the calendar shifts but the dependencies do not.

---

## Hard gates before Component 5 begins

1. The cadence domain seeds cleanly into staging Neo4j and `python scripts/validate_graph.py` reports zero hard failures.
2. The concept full-text index is created and a sample query returns the expected concepts.
3. The Bloom perspective opens against staging AuraDB and the saved searches return expected nodes.
4. `pytest -m integration backend/tests/graph/` passes in CI.
5. The fragment data layer has ≥80% test coverage on `models/fragment.py` per Step 4.
6. The `pending_analysis` flag is in place and the admin re-dispatch endpoint works against staging (Step 3).
7. ADR-018 is written and linked from the partial-failure recovery context. ADR-019 is written if the accidentals fix landed (Step 21).
8. `docs/architecture/playback-coordinates.md` exists and the three GitHub issues (Steps 17-19) are closed against its rules.
9. The `worker` process group is gone from `fly.toml`; the Redis-connection warning no longer appears in `fly logs`.
10. `docs/architecture/bloom-setup.md` documents the perspective import procedure.
