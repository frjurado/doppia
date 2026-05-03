# Phase 1 — Notation Infrastructure: Design & Roadmap

## Purpose

Phase 1 builds the knowledge asset and editorial tooling on which every later phase depends. It has no public-facing user product; its deliverable is a working tagging environment, a populated and queryable fragment database, a seeded knowledge graph, and the rendering infrastructure that will serve both the editorial tools and the eventual public interface.

Nothing in Phase 2 can be built without the fragment database. Nothing in Phase 3 can reason well without the knowledge graph and the structured summaries. Phase 1 is the foundation.

---

## What Phase 1 Delivers

- A version-controlled MEI corpus with validated metadata and measure-number integrity
- Score rendering (Verovio) and MIDI playback for whole movements and individual fragments
- A seeded knowledge graph covering the cadence domain — the first of 11 confirmed domains planned for the full knowledge graph (see `docs/architecture/knowledge-graph-domain-map.md`) — with visualization tooling
- A tagging tool allowing expert annotators to select fragments, classify them against the knowledge graph, record property values, and attach music21-derived summaries and prose annotations
- A fragment database with full CRUD, peer-review workflow, and browsing by concept tag
- Enough populated data to validate the full pipeline end to end before any public launch

---

## Cross-Cutting Concerns

These decisions and patterns touch every component. They should be settled before implementation begins and documented in the project's root README or a dedicated `CONTRIBUTING.md`.

### Project Foundation

**Folder structure.** Establish a clear monorepo or multi-repo split at the outset. The recommended layout:

```
/backend          FastAPI application
  /api            Route handlers
  /services       Business logic (graph, fragment, music21, tagging)
  /models         Pydantic models and SQLAlchemy ORM definitions
  /graph          Neo4j Cypher queries and neomodel definitions
  /seed           YAML seed files and seeding scripts
  /tests
/frontend         JS application
  /components     Verovio renderer, MIDI player, tagging UI, browsing UI
  /services       API client, graph query client
/docker           Docker Compose and service configs
/docs             Architecture docs, this roadmap, ADRs
```

**Code conventions.** Establish and document: Python formatting (Black + isort), type hints everywhere, docstring conventions, async vs. sync conventions in FastAPI, Cypher style (uppercase keywords, snake_case parameters). JavaScript conventions (ESLint config, component patterns).

**Testing strategy.** Define at the outset:
- Unit tests: Pydantic validators, service-layer logic, music21 extraction functions
- Integration tests: FastAPI endpoints with a test Neo4j instance and test PostgreSQL (use Docker in CI)
- Graph tests: validate that YAML seeds produce the expected node/edge structure after loading
- Snapshot tests: Verovio rendering output for a pinned MEI file (catches Verovio version regressions)
- No end-to-end browser tests in Phase 1 (tagging tool is internal; defer Playwright/Cypress to Phase 2)

**Architecture Decision Records (ADRs).** Every non-obvious architectural decision (file storage choice, display mode default, music21 pipeline trigger, etc.) should be recorded as a short ADR in `/docs/adr/`. This is the institutional memory that prevents re-litigating settled decisions.

### API Conventions

Establish before building any endpoints:

- RESTful conventions: `GET /scores`, `GET /scores/{id}`, `POST /fragments`, `PATCH /fragments/{id}`, etc.
- API versioning: prefix all routes with `/api/v1/` from day one. Changing this later is painful.
- Error response envelope: a consistent JSON shape for all error responses (`{ "error": { "code": "...", "message": "...", "detail": {...} } }`).
- Pagination: cursor-based pagination from day one for all list endpoints. Offset-based pagination is tempting early and becomes a problem at scale.
- Response envelope vs. bare resources: decide one pattern and apply it consistently.

### Authentication

**Phase 1 requires authentication even without public users.** The tagging tool must be restricted to authorized annotators. The minimum viable auth setup:

- Use Supabase Auth. Do not build custom auth.
- Define roles: `editor` (can tag and annotate), `admin` (can manage corpus, delete fragments, manage users).
- JWT-based auth for the FastAPI backend; validate tokens in a middleware layer.
- Defer role granularity beyond `editor`/`admin` to Phase 2 when the full role model is needed.

**Decision:** Supabase Auth (ADR-001). Supabase Auth is tightly integrated with the Supabase PostgreSQL instance already chosen for the relational database. It eliminates Auth0 as a third managed service, issues JWTs verifiable with the Supabase JWT secret, and stores user role information in the same PostgreSQL instance as application data. Account creation is admin-only in Phase 1 (no public registration). See ADR-001 for the full rationale and consequences.

### File Storage

**Decision:** Cloudflare R2 in production and staging; MinIO in local development (ADR-002).

Both expose the same S3-compatible API. The application interacts with file storage exclusively through the `aioboto3` S3 client, configured via environment variables. Switching between MinIO and R2 requires only changing environment variable values; no application code changes.

MEI files are stored at corpus ingestion time under a stable object key:

```
{composer_slug}/{corpus_slug}/{work_id}/{movement_id}.mei
```

Example: `mozart/piano-sonatas/k331/movement-1.mei`

The four-component path mirrors the Composer → Corpus → Work → Movement browsing hierarchy and is the authoritative key format across all documents.

The `mei_object_key` column on the `movement` table stores this key. The application resolves it to a signed URL at request time when the frontend needs direct access, or fetches to a temporary path for backend processing. Nothing stores a resolved URL — URLs expire; object keys do not. See ADR-002 for the full rationale.

### Docker Compose

The full local topology — Neo4j, PostgreSQL (with pgvector), Redis, MinIO (S3-equivalent), and the API — should be defined in a single `docker-compose.yml` before any service is implemented. Run `docker compose up` from day one. This eliminates "works on my machine" drift and establishes local-production parity immediately.

```yaml
services:
  neo4j:       # neo4j:5 image, port 7474/7687
  postgres:    # postgres:16 image, port 5432, pgvector init script
  redis:       # redis:7 image, port 6379 (Phase 2, but wire in now)
  minio:       # minio/minio image, S3-compatible storage, ports 9000/9001
  api:         # FastAPI backend
  frontend:    # Dev server with hot reload
```

All credentials via environment variables; a `.env.example` committed to the repository.

### Staging and Deployment

Phase 1 ends with a working internal tool that real annotators will use — it must be deployable to a non-local environment before tagging begins.

The staging environment runs the full stack on production services (AuraDB, Supabase, Cloudflare R2) and is accessible only to the team. The production service mapping is documented in `tech-stack-and-database-reference.md`; the deployment procedure is in `docs/deployment.md`.

---

## Component 1 — MEI Corpus Ingestion

**Purpose:** Establish the corpus as the system's raw material. All subsequent components depend on a clean, validated, well-described set of MEI files.

Score and analysis source selection, licensing constraints, conversion pipelines, and the Mozart piano sonatas first-case plan are documented in `docs/architecture/corpus-and-analysis-sources.md`.

### Scope

- Bulk upload workflow for a coherent corpus (Mozart piano sonatas — see corpus doc for source and pipeline)
- MEI file validation before storage
- Metadata schema, validation, and intra-corpus coherence checks
- Measure number protocol
- Post-upload correction strategy and its test suite

### Metadata Schema

Define a required metadata schema at composer, corpus, work, and movement level. Composer is a first-class entity: any given composer may have multiple corpora, and the browsing hierarchy (Composer → Corpus → Work → Movement) requires a stable composer identifier. The following fields are required:

**Composer-level:**
- `composer_slug`: stable identifier, e.g. `mozart`
- `composer_name`: canonical name (e.g. `Wolfgang Amadeus Mozart`)

**Corpus-level (set once per corpus, inherited by all works unless overridden):**
- `corpus_slug`: stable identifier, e.g. `piano-sonatas` (unique within the composer's scope)
- `source_repository`: e.g. `OpenScore`, `DCML` (see corpus doc for priority order)
- `source_url`: URL to the originating repository
- `license`: SPDX identifier (e.g. `CC-BY-4.0`)
- `transcription_source`: edition or manuscript on which the transcription is based
- `edition_notes`: free text for caveats about the specific edition

**Work-level:**
- `work_title`: canonical title (e.g. `Piano Sonata No. 11 in A major`)
- `catalogue_number`: e.g. `K. 331` (covers opus numbers, Köchel numbers, BWV numbers, and any other cataloguing system — do not add a separate `opus_number` field)
- `year_composed`: integer or range string

**Movement-level:**
- `movement_number`: integer
- `movement_title`: optional (e.g. `Alla Turca`)
- `tempo_marking`: optional
- `key_signature`: canonical string (e.g. `A major`)
- `time_signature`: optional (may be mixed-meter)

**Metadata storage:** store composer/corpus/work/movement metadata in PostgreSQL, with a foreign key join to the `fragment` table. This allows SQL queries over metadata without parsing files at runtime. The `metadata.yaml` sidecar in the upload ZIP is the *import format*: it is validated and parsed into PostgreSQL at ingest time and not stored as a file. See the Upload Workflow section below.

### MEI Validation

Before any MEI file is stored, validate:

1. **Well-formed XML**: parse with `lxml`; reject on parse error.
2. **MEI schema compliance**: validate against the MEI RelaxNG schema (available from the MEI project). Use `lxml` with the schema document.
3. **Measure number integrity**: every `<measure>` element must have an `@n` attribute. Gaps, duplicates, or non-integer values are flagged.
4. **Staff count consistency**: the number of staves declared in `<scoreDef>` must match those present in all measures.

### MEI Normalization

MEI files from different corpus sources (MuseScore exports, Humdrum conversions, scholarly editions) are inconsistent in areas where the spec does not enforce uniqueness or presence — particularly around pickup bar encoding, `<ending>` structure, and meter change propagation. The tagging tool's ghost construction logic depends on these attributes being present and consistent. Rather than building defensive fallbacks into the front-end, normalization runs at ingest time and the stored MEI in S3 is always the normalized version. The original source file is retained separately for provenance.

The normalization step runs after validation and before storage. A file that fails validation is rejected; a file that passes validation but requires normalization is normalized and the changes logged in the ingestion report. The full normalization specification — including the exact transformations applied and edge cases handled — is in `docs/architecture/mei-ingest-normalization.md`. The Measure Number Protocol section below establishes the coordinate conventions that normalization enforces.

In brief, the normalizer enforces:

- **Pickup bars**: measures preceding the first full bar with fewer beats than the time signature are assigned `@n="0"` and `@metcon="false"` if not already set.
- **Meter changes within measures**: if a meter change is encoded only as a `<staffDef>` update, the normalizer copies a `<meterSig>` child into the affected `<measure>` element, so that `getMeterForMeasure()` in the tagging tool finds it reliably.
- **`<ending>` structure**: verify that `<ending>` elements are well-formed and contain at least one measure. Flag (but do not auto-correct) files where `<ending @n>` values are missing or non-sequential.
- **Repeat barline pairs**: verify that every opening repeat barline has a matching close (and vice versa). Flag mismatches in the ingestion report; do not silently ingest structurally malformed repeat sections.
5. **Encoding sanity**: check that at least one `<note>` or `<rest>` is present (reject empty files).

Validation errors are returned as structured JSON to the uploader, not as a generic failure. Each error should identify the measure and element that caused it.

### Measure Number Protocol

**This decision has downstream consequences for the tagging tool and the fragment data model.** Measure numbers in MEI (`@n` attributes) are the coordinate system used to store fragment boundaries (`bar_start`, `bar_end` in the `fragment` table). Establish the following conventions before any tagging begins:

- Measure numbers are 1-indexed integers corresponding to `<measure @n>` values in MEI. They are not derived from display bar numbers, which can differ due to repeat sections, first/second endings, or pickup bars.
- Pickup bars (anacrusis): if an MEI file encodes a pickup bar as measure 0, normalize to 0 in the database. Document this convention explicitly.
- Repeat sections: if the same notated bars appear in a first and second ending, they have the same `@n` values in MEI. The tagging tool must be aware of this and allow the annotator to disambiguate (e.g. by attaching a `repeat_context` field to the fragment, such as `first_ending` or `second_ending`). **Flag this as a known complexity; decide how to handle it before the tagging tool is built.**
- Corpus setup correction: if measure numbers in an uploaded MEI file pass validation but violate the project's conventions, a correction tool may be needed to renumber measures in the MEI XML and update fragment pointers atomically. **This is deferred.** The first corpus (Mozart piano sonatas) carries no printed measure numbers in editions, so there is no external reference to mismatch against; the normalizer already handles the structural pickup-bar case. The right shape of tool — and whether a simple linear offset or a full remapping table is needed — will be clearer once a corpus with edition-specific printed numbering is actually ingested. Revisit then.

### Upload Workflow

The bulk upload endpoint (`POST /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/upload`) should:

1. Accept a ZIP archive containing MEI files and a `metadata.yaml` sidecar.
2. Validate each MEI file (schema + measure numbers + normalization).
3. Validate the metadata YAML against the metadata Pydantic schema.
4. Check intra-corpus coherence: all works in the corpus share the same composer and license; year ranges are plausible; catalogue numbers are unique within the corpus.
5. On success: write MEI files to object storage under keys of the form `{composer_slug}/{corpus_slug}/{work_id}/{movement_id}.mei` (e.g. `mozart/piano-sonatas/k331/movement-1.mei`); parse the metadata YAML into PostgreSQL (composer, corpus, work, movement tables). The YAML file itself is not persisted — PostgreSQL is the authoritative metadata store from this point on.
6. Enqueue a music21 preprocessing task for each movement (see Component 6).
7. Return a structured ingestion report: files accepted, files rejected (with reasons), metadata warnings.

For Phase 1, this is an authenticated endpoint restricted to `admin` role only.

---

## Component 2 — Corpus Browsing

**Purpose:** Allow annotators (and later readers) to navigate the corpus and open a score for viewing or tagging.

### Scope

- Composer → Corpus → Work → Movement selector, column layout on desktop
- Incipit preview before full score load
- Mobile layout consideration

### Data Model

The Composer → Corpus → Work → Movement hierarchy maps naturally to four PostgreSQL tables:

```sql
CREATE TABLE composer (id, slug, name, ...);
CREATE TABLE corpus (id, composer_id, slug, source_repository, license, ...);
CREATE TABLE work (id, corpus_id, title, catalogue_number, year_composed, ...);
CREATE TABLE movement (id, work_id, movement_number, title, mei_object_key, ...);
```

The `mei_object_key` on `movement` is the S3 object key (`{composer_slug}/{corpus_slug}/{work_id}/{movement_id}.mei`), resolved to a signed URL at request time.

### Incipit Preview

Rather than loading an entire MEI file to show a preview, generate a static incipit image at upload time:

- After a successful MEI upload, a background task (Celery job) runs Verovio server-side (Python bindings) to render the first 4 bars as an SVG or PNG.
- Store the rendered incipit in object storage alongside the MEI file.
- The corpus browsing API returns the incipit URL directly; no Verovio computation at browse time.
- Incipit images are regenerated if the MEI file is corrected.

### Mobile Layout

The tagging tool is a desktop-only workflow — no mobile adaptation needed for Phase 1's editorial functions. The corpus browser, however, may be accessed on mobile by collaborators reviewing the corpus. Minimum viable mobile: the four-column selector should collapse to a stacked accordion on narrow viewports. The score viewer (Component 4) is explicitly not mobile-optimized in Phase 1.

---

## Component 3 — Verovio Visualization & MIDI Playback

**Purpose:** Render MEI scores in the browser and provide synchronized MIDI playback. This is the core rendering infrastructure used by both the tagging tool and, later, the public-facing features.

### Scope

- Score rendering in the browser via Verovio (WASM)
- Multiple display modes (to decide)
- Staff size control and automatic system breaks
- Transposition via drop-down
- MIDI playback with playback position indicator
- Midway playback start deferred to Phase 2

### Display Mode Decision

**Decision:** vertical infinite scroll (ADR-003).

Systems stack downward in the standard web layout. Verovio's multi-page SVG output maps directly onto this: each rendering segment is appended to the DOM in sequence, with no layout transformation required. MIDI playback synchronisation follows a straightforward pattern (scroll the viewport to keep the currently playing element visible). Horizontal scroll is not implemented for the general score viewer in Phase 1; it is deferred to Phase 2, where the blog's scrollytelling layout will require it regardless. See ADR-003 for the full rationale and the consequences for the overlay architecture.

### Verovio Rendering Architecture

Verovio's JavaScript/WASM build is used client-side. Key decisions:

- **Initial render:** load the full MEI file, call `verovio.renderToSVG()` for each rendering segment. Verovio produces output in fixed-height segments regardless of display mode; in vertical infinite scroll these segments are appended to the DOM in sequence. Display segments progressively (render segment 1, display, render segment 2 in background, etc.) to avoid a blank screen on large scores.
- **Staff size:** Verovio's `scale` option controls staff size. Expose as a slider or preset buttons (small / medium / large). Changing scale requires re-rendering all pages; debounce the control.
- **System breaks:** Verovio handles automatic system breaks based on page width and scale. The rendered SVG output should be treated as canonical for display purposes. Do not attempt to manually control line breaks in Phase 1.
- **Transposition:** Verovio supports transposition via rendering options (`transpose` parameter). This is display-only — the underlying MEI file is not modified. MIDI follows the display transposition: if the score is transposed up a tone for display, MIDI playback sounds at that transposition.

### MIDI Playback

**Decision:** `@tonejs/midi` + Tone.js (ADR-012). The architecture:

1. On score load, call `verovio.renderToMIDI()` to generate a base64-encoded MIDI string.
2. Decode the MIDI buffer and pass it to `@tonejs/midi`'s `Midi` constructor to obtain a structured note schedule.
3. Load a piano SoundFont into Tone.js (`Tone.Sampler`). Host the SoundFont from Cloudflare R2 or a CDN; do not bundle it with the frontend.
4. Schedule notes onto the Tone.js Transport. At each note onset, fire the position callback:
   ```javascript
   onPositionUpdate({ bar: noteBar, beat: noteBeat });
   ```
5. The `onPositionUpdate` handler calls `verovio.getElementsAtTime()` to identify the sounding SVG element and applies the highlight class. Highlight is simpler to implement than a caret; start there.
6. Playback controls: play, pause, stop, scrub. Tone.js Transport supports all of these with correct position tracking.

**The `onPositionUpdate(bar, beat)` callback is the sole interface between the playback layer and the score viewer.** Neither the MIDI player nor any future real audio player calls into the score viewer directly. Both MIDI synthesis and real audio call the same callback; switching between them is a configuration change, not a refactor.

**Forward-compatibility with real audio:** the playback architecture is designed to accommodate real audio recordings as a future optional upgrade tier, when open-licence recordings exist for a given work. The `onPositionUpdate` abstraction is the primary forward-compatibility mechanism. See `docs/architecture/real-audio-playback-research.md` for the full assessment of availability, alignment technology (parangonar DTW), and the two new tables (`audio_recording`, `audio_score_alignment`) the feature would add. No design decisions need revisiting; the architecture is already compatible.

### Fragment Rendering

The same Verovio infrastructure renders individual fragments in the tagging tool and later in the public fragment browser. Fragment rendering differs from full-score rendering in one important way: it must display only a subset of bars.

Verovio supports this via the `select` option (selecting a range of measures by `@n`). **This must be verified as a spike before tagging tool implementation begins** — the `select` option's behaviour with repeat sections, first/second endings, and mid-system starts is not fully documented and has had issues in past Verovio versions. Run the verification against the actual Mozart piano sonata corpus; document the results and any workarounds in `docs/architecture/mei-ingest-normalization.md`.

---

## Component 4 — Knowledge Graph: Cadence Domain

**Purpose:** Define the cadence domain — the seed domain of the knowledge graph — in YAML, load it into Neo4j, and validate the graph structure. This seeds the tagging tool's concept vocabulary for Phase 1. Cadence is also where the core graph modelling decisions emerged: the three-layer architecture, `CONTAINS` edges with `order` and `required` properties, and the stub-node convention for domain boundaries. The full planned domain scope (11 confirmed domains plus areas under exploration) is in `docs/architecture/knowledge-graph-domain-map.md`.

**YAML ecosystem:** domain seed files live in `backend/seed/domains/`, one file per domain (e.g. `cadences.yaml`, `harmonic-functions.yaml`, `formal-structure.yaml`). Stub nodes — concepts that will be fully defined in a later domain — live in their eventual home domain file, tagged `stub: true`. There is no separate `stubs.yaml`: keeping stubs in their home file makes promotion natural (remove `stub: true`, fill in the full definition) without moving nodes between files. The seeding script processes all files in `backend/seed/domains/` and treats `stub: true` as an informational flag, not a structural distinction. The graph validation suite reports stub counts by domain as expected tracking data.

### Scope

- YAML seed file for the cadence domain (concept nodes, relationships, PropertySchemas, PropertyValues)
- Python seeding script with idempotent `MERGE` statements
- Pydantic validation layer for all graph writes
- Neo4j Bloom setup for editorial visualization
- pyvis-based dev visualization for debugging
- Stub nodes at domain boundaries

### YAML Seed Structure

The cadence domain YAML must conform to the schema established in the modelling guide. Each file should contain:

```yaml
concepts:
  - id: Cadence
    name: "Cadence"
    type: CadenceType
    definition: "..."
    complexity: foundational
    relationships:
      - type: IS_SUBTYPE_OF
        target: FormalUnit
    contains: []
    property_schemas: []

property_schemas:
  - id: SopranoPosition
    name: "Soprano Position"
    description: "..."
    cardinality: ONE_OF
    required: false
    values:
      - id: ScaleDegree1
        name: "Scale Degree 1"
        references: null
      - id: ScaleDegree3
        name: "Scale Degree 3"
        references: null
```

The seeding script validates each YAML file against Pydantic models before issuing any Cypher statements. Any validation error aborts the seed with a descriptive message.

### Graph Validation After Seeding

After every seed run, execute a validation suite:

- No concept node has zero outgoing edges (every node must be connected to the graph).
- Every `IS_SUBTYPE_OF` reference points to an existing concept `id`.
- Every `CONTAINS` target is a defined concept `id`.
- Every `PropertyValue` with a `references` field points to an existing concept `id`.
- Every `PropertySchema` has at least one `HAS_VALUE` edge.
- `CONTAINS` edges on a given concept have unique `order` values.

This suite should be a Python script runnable at any time: `python scripts/validate_graph.py`. Run it in CI after any YAML change.

### Stub Nodes at Domain Boundaries

The cadence domain references concepts from adjacent domains — harmonic functions (Tonic, Dominant, PreDominant), formal units (Phrase), scale degree concepts. These must exist as stub nodes so that edges do not point into the void.

Stub nodes are defined in their eventual home domain file (e.g. `harmonic-functions.yaml`, `formal-structure.yaml`), not in a separate stubs file:

```yaml
# harmonic-functions.yaml — concepts stub-defined here, to be fully specified when the domain is built
concepts:
  - id: Tonic
    name: "Tonic"
    stub: true
    definition: "Stub: defined in the harmonic-function domain."

  - id: Phrase
    name: "Phrase"
    stub: true
    definition: "Stub: defined in the formal-structure domain."
```

When a domain is fully implemented, the `stub: true` flag is removed and the definition is filled in — no files need to be moved. Stub nodes carry a corresponding property in Neo4j. The graph validation suite reports stub node counts by domain; stubs are expected and tracked, not errors.

### Visualization Setup

- **Neo4j Bloom:** configure a saved Bloom perspective for the cadence domain before handing off to annotators. The perspective should show Concept, PropertySchema, and PropertyValue nodes in distinct colours, with `IS_SUBTYPE_OF`, `CONTAINS`, and `HAS_PROPERTY_SCHEMA` as visible relationship types. Document the setup in `docs/architecture/bloom-setup.md`.
- **pyvis dev visualization:** implement a `python scripts/visualize_domain.py --domain cadences` script that exports a pyvis HTML file for the cadence subgraph. Run this after every seed to spot structural problems without opening Bloom.

---

## Component 5 — Tagging Tool

**Purpose:** Allow expert annotators to select a fragment from a rendered score, classify it against the knowledge graph, record property values (via a schema-driven dynamic form), identify sub-parts, add music21-derived summaries, and submit the record for peer review.

This is the most technically complex component in Phase 1. It should be scoped and designed carefully before implementation begins.

### Sub-components

1. Score selection interface (click-and-drag on rendered SVG)
2. Concept search and selection (query against Neo4j)
3. Dynamic property form (driven by PropertySchema nodes)
4. Sub-part tagging (nested selections within the main fragment)
5. music21 summary display and prose annotation field
6. Submission and peer review state machine

### 5.1 Score Selection Interface

**This is the hardest part of the tagging tool technically.** Verovio renders SVG; the tagging tool needs to let annotators click-and-drag over that SVG to select a range of measures.

**SVG interaction model:** Verovio attaches `data-id` attributes (or similar) to SVG elements corresponding to MEI elements. A measure's bounding box can be obtained by querying `verovio.getElementAttr()` or by traversing the rendered SVG for `<g>` elements with `data-id` matching measure ids. The selection model should work as follows:

1. On mousedown on the score: record the measure at the mouse position (query Verovio or traverse SVG to find the enclosing measure `<g>`).
2. On mousemove: extend the selection to the current measure; highlight the selected range by overlaying a semi-transparent rectangle (do not modify the SVG directly — use an absolutely-positioned overlay `<div>` or `<canvas>`).
3. On mouseup: commit the selection. Display the selection as a coloured bracket overlay. Allow adjustment of each side (drag the left/right edge of the overlay to expand or contract the selection by one measure at a time).

**Rhythmic subdivision grid:** selection at beat or sub-beat precision is implemented in Phase 1. **Decision (ADR-005):** implement beat-level and sub-beat-level precision in Phase 1. `beat_start` / `beat_end` columns are nullable (null = "full extent of the measure range") but populated from the first annotation session. The original deferral to Phase 2 is superseded — see ADR-005 for the rationale. See also ADR-011 for the multi-level tagging design decisions.

**Repeat section handling:** see the measure number protocol note above. The tagging tool must surface a disambiguation field if the selected measure range falls within a repeated section.

### 5.2 Concept Search and Selection

The annotator needs to search for and select a concept from the knowledge graph. The concept picker should:

- Support incremental text search across concept `name` and `aliases` fields. Concept nodes live in Neo4j; the search endpoint queries Neo4j's full-text index (created over `name` and `aliases` at seed time) rather than maintaining a separate PostgreSQL mirror of concept names.
- Display the concept's position in the hierarchy (e.g. "PAC > Authentic Cadence > Cadence") so annotators can confirm they have the right node.
- Show a brief definition on hover/focus.
- Not require the annotator to know the exact node `id` — they search by natural name.

**Backend endpoint:** `GET /api/v1/concepts/search?q={query}&domain={optional_domain_filter}` returning a paginated list of matching concept nodes with id, name, hierarchy path, and definition summary.

### 5.3 Dynamic Property Form

Once a concept is selected, the tagging tool fetches the concept's applicable PropertySchemas (including inherited ones via the `IS_SUBTYPE_OF*0..` traversal) and renders a form dynamically.

- `ONE_OF` schemas render as a radio group or dropdown.
- `MANY_OF` schemas render as a checkbox group or multi-select.
- `required: true` schemas are marked; the form cannot be submitted without a value.
- Values that carry `VALUE_REFERENCES` links should display the referenced concept name, not just the value id.

**Backend endpoint:** `GET /api/v1/concepts/{id}/schemas` returning the full schema tree applicable to that concept, as defined in `docs/architecture/knowledge-graph-design-reference.md`.

**Form state:** the form's current values should persist if the annotator changes the selected concept. If the new concept shares schemas with the previous one (via inheritance), carry the values over. If a schema is no longer applicable, discard its value.

### 5.4 Sub-part Tagging

Many fragments contain identifiable sub-parts — a cadence has a pre-dominant stage, a dominant stage, and a resolution. The tagging tool should allow annotators to tag these sub-parts as nested fragment records.

**Data model consideration:** sub-parts are themselves fragment records, linked to their parent via a `parent_fragment_id` foreign key on the `fragment` table. The parent's `bar_start`/`bar_end` constrains the range within which sub-parts may be defined. A sub-part can have its own concept tag and property values.

**UI:** after the main selection is committed and a concept chosen, the system checks whether that concept has `CONTAINS` edges. If so, it renders a secondary selection interface above the music (as described in the plan) with the list of expected sub-parts pre-populated from the `CONTAINS` structure. The annotator draws selections for each sub-part within the main fragment's bounds.

**Phase 1 scope:** implement sub-part tagging for one level of nesting only. Deeply nested sub-parts (sub-sub-parts) are deferred.

### 5.5 music21 Summary and Prose Annotation

After the fragment is selected and classified, the annotator sees a panel with:

1. **music21-derived summary:** computed automatically when the fragment record is created (see Component 6). The annotator can review and correct values but not free-text-edit them. The summary is a structured display of the JSONB fields (harmony array, key, meter).
2. **Prose annotation field:** a free-text area where the annotator writes a short expert commentary on what is theoretically significant about this fragment. This is the content that will be ingested into the vector store for RAG.

**Prose annotation storage (ADR-007):** store the prose annotation as a `prose_annotation TEXT` column on the `fragment` table from day one. The vector embedding is generated lazily in Phase 3; the pgvector table (`prose_chunk`) is scaffolded now but not populated until then. This avoids a data migration and ensures that annotations written during Phase 1 are immediately available to the Phase 3 vector store without archaeology.

### 5.6 Submission and Peer Review State Machine

Fragment records move through the following states:

```
draft → submitted → approved
                 ↘ rejected → draft
```

- `draft`: created by the annotator, not yet submitted. Visible only to the creating annotator and admins.
- `submitted`: annotator marks as complete and submits for review. Visible to all editors.
- `approved`: a second editor (not the creator) has reviewed and confirmed the annotation. Visible in the public fragment database.
- `rejected`: a reviewer has sent the record back with a comment. Visible to the original annotator, who can revise and resubmit.

Add a `status` enum column to the `fragment` table, and a separate `fragment_review` table to record per-reviewer decisions. The review table is the forward-compatible shape: when the approval threshold grows from one reviewer to two, no data migration is needed — only a configuration change to the approval-check service function. See `docs/architecture/fragment-schema.md` for the full `fragment_review` definition.

**Who can approve/reject:** any `editor` who is not the fragment's creator. Admins can approve or reject any fragment. This rule is enforced in the service layer, not only in the UI. The approval check is a parameterised service function that counts approving reviews in `fragment_review` excluding the fragment's creator; the threshold (currently one reviewer) is a configuration value.

**Phase 1 note:** with a small team of annotators in Phase 1, the peer review workflow may feel heavyweight. It is still worth implementing correctly now, because the data model and state machine established here will inform Phase 2's full role model and the public fragment display logic (which shows only `approved` fragments).

---

## Component 6 — music21 Preprocessing Pipeline

**Purpose:** Automatically extract structured musical information from tagged fragments, reducing manual annotation burden and populating the `summary` JSONB field.

### Scope

- Key signature and meter extraction (reliable)
- Chord-level harmonic analysis (requires calibration)
- Human review and correction workflow for auto-extracted data
- Pipeline trigger timing

### Pipeline Trigger Decision

**Decision:** trigger on MEI upload, asynchronously via Celery task, processing the whole movement (ADR-004).

When an MEI file passes ingestion (see Component 1, step 6 of the upload workflow), a Celery task is enqueued immediately. The task processes the entire movement and stores results in the `movement_analysis` table, keyed by `movement_id`. When an annotator creates a fragment, the preprocessing service reads the relevant bar range from the cached analysis rather than re-running music21 — the annotator sees pre-populated data immediately, with no waiting state. music21 runs once per movement regardless of how many fragments are tagged from it. See ADR-004 for the full rationale, including the consequence for corrected MEI files (correction must enqueue a re-analysis task).

### Analysis Source Priority

Expert harmonic annotations are preferred over music21 auto-analysis wherever they exist. The pipeline follows the source priority documented in `docs/architecture/corpus-and-analysis-sources.md`:

Provenance is tracked **per event** on `movement_analysis.events`, not per fragment. Each event row carries a `source` value (`"DCML"`, `"WhenInRome"`, `"music21_auto"`, or `"manual"`), along with `auto` and `reviewed` flags. Because events are per-beat, a single movement can mix provenances over its timeline. The ingestion priority is:

1. **DCML `harmonies.tsv`** — for any movement in a DCML corpus (Mozart piano sonatas, Beethoven, Corelli, etc.), import the DCML harmonic annotations directly into `movement_analysis.events`. One row per harmony label, with bar, beat, Roman numeral, inversion, and related fields. Each ingested event gets `source: "DCML"`, `auto: false`, `reviewed: false`.
2. **When in Rome** — for repertoire not in DCML but covered by the When in Rome meta-corpus. Each ingested event gets `source: "WhenInRome"`, `auto: false`, `reviewed: false`.
3. **music21 auto-analysis** — fallback only, used when no expert annotation exists. Each emitted event gets `source: "music21_auto"`, `auto: true`, `reviewed: false`, along with the `music21_version` that produced it.
4. **Manual** — values entered, inserted, or corrected by the annotator via the tagging tool. Edits write back into `movement_analysis.events` directly; the affected event's `source` becomes `"manual"`, `auto` becomes `false`, and `reviewed` becomes `true`.

The pipeline must check for DCML/When in Rome annotations before running music21. music21 is not the default — it is the fallback.

### Extraction Targets

| Field | music21 reliability | Notes |
|---|---|---|
| Key signature | High | Read directly from MEI/MusicXML `<key>` elements |
| Time signature | High | Read directly from MEI/MusicXML `<time>` elements |
| Actual key (via analysis) | Medium | music21's `analyze('key')` is probabilistic; flag confidence score |
| Chord numeral (Roman analysis) | Medium | music21's `romanText` output requires clean voice separation; flag for review |
| Bass note | High | Lowest pitch in each beat position |
| Soprano note | High | Highest pitch in each beat position |
| Inversion | High | Derivable from bass note + chord root |

Fields with "Medium" reliability should be flagged in the UI as "auto-generated, review required." Annotators should be able to correct them via a structured edit, not a free-text field.

### Summary JSONB Schema

Pin the summary JSONB structure before any data is written. Changing it later requires a migration of all existing records. The authoritative field-by-field specification is in `docs/architecture/fragment-schema.md`; the shape at a glance:

```json
{
  "version": 1,
  "key": "A major",
  "meter": "4/4",
  "actual_key": { "value": "A major", "confidence": 0.92, "auto": true, "reviewed": false },
  "music21_version": "9.1.0",
  "concepts": ["PerfectAuthenticCadence"],
  "properties": {
    "SopranoPosition": "ScaleDegree1",
    "CadentialElaboration": ["Cadential64"]
  },
  "concept_extensions": {}
}
```

**Harmony is not stored in `summary`.** Chord-level harmonic analysis is stored once per movement in `movement_analysis` as a per-event timeline (with per-event `source`, `auto`, and `reviewed` flags) and sliced by the fragment's bar/beat range at read time. A fragment that needs to display or reason about harmony reads from `movement_analysis`, not from its own `summary`. See `fragment-schema.md` § "Harmonic analysis: movement-level single source of truth" for the rationale and the re-analysis smart-merge policy.

The `version` field is essential. Any future schema change bumps the version and triggers a migration path for records at the old version.

---

## Component 7 — Fragment Database: CRUD & Display

**Purpose:** Persist fragment records, expose them via a CRUD API, and display them on the score with visual indicators.

### Schema (Full)

The full fragment schema — `fragment`, `fragment_concept_tag`, `fragment_review`, and the `movement_analysis` timeline that fragments read from at render time — is specified in `docs/architecture/fragment-schema.md` and included in the initial Alembic migration produced by Step 4 of `phase-1-foundation-plan.md`. Component 7 does not add columns or tables; it wires up the CRUD endpoints, the review state transitions, and the on-score display against the schema already established by the foundation migration.

The relevant foundation schema summary for this component:

- `fragment` — one row per tagged excerpt; includes `movement_id`, bar/beat range, `repeat_context`, `parent_fragment_id`, `summary` JSONB, `prose_annotation`, `data_licence`, `status`, `created_by`, and audit timestamps.
- `fragment_concept_tag` — join to Neo4j concept ids; `is_primary` distinguishes the driving concept from cross-reference tags.
- `fragment_review` — per-reviewer decisions (`approved` | `rejected`) with comment and timestamp; `UNIQUE (fragment_id, reviewer_id)`. The approval threshold is a configurable service-layer parameter.
- `movement_analysis` — per-event harmonic timeline, mutable, with per-event `source` / `auto` / `reviewed` flags. Fragments do **not** persist harmony in `summary`; they slice from `movement_analysis` at read time.

### On-Score Visual Indicators

Once fragments are stored, the score viewer should display them as visual overlays:

- A bracket above the relevant measures, rendered as an SVG overlay (not inside Verovio's SVG, to avoid conflicts with re-renders).
- A short alias label at the left edge of the bracket (e.g. "PAC", "IAC", "HC"). The alias is the concept's abbreviated name, stored as an `alias` field on the Concept node in Neo4j.
- **Default state (collapsed):** top-level brackets only are shown; sub-part brackets within a fragment are hidden.
- **Active/selected state (expanded):** when an annotator clicks or selects a fragment bracket, sub-part brackets are rendered within its bounds. The expanded state makes sub-part nesting visible without cluttering the score when browsing.
- Clicking a bracket in either state opens a side panel with the full fragment record: concept name, property values, music21 summary, prose annotation, and (for editors) edit/delete buttons.

Each fragment bracket component carries a `collapsed`/`expanded` state prop. The overlay renderer uses this to determine whether to draw sub-brackets. This architecture is the same one needed for the Phase 2 filter UI.

**Display filtering (Phase 2):** implement the overlay rendering from day one in a way that supports a filter state (`show: boolean`, `category_filter: string[]`). Even if the filter UI is not built in Phase 1, the data model and rendering architecture should not require refactoring to add it.

### Delete Permissions

Who can delete a fragment:

- The creating annotator can delete their own `draft` fragments.
- `approved` fragments cannot be deleted by annotators; only admins can delete them.
- Deleting a parent fragment cascades to all child (sub-part) fragments (`ON DELETE CASCADE` on `parent_fragment_id`). The API and UI both require explicit confirmation before deleting a parent record, since the cascade may affect many sub-parts.

---

## Component 8 — Fragment Browsing

**Purpose:** Allow annotators (and later, public users) to browse the fragment database by concept tag, and to view individual fragments in isolation.

### Scope

- Hierarchical tag browsing (Cadence → Authentic Cadence → PAC)
- Fragment list view with Verovio-rendered previews
- Individual fragment detail view with full Verovio rendering and MIDI playback

### Tag Browsing

The browsing hierarchy follows the `IS_SUBTYPE_OF` structure in the knowledge graph. The API endpoint:

```
GET /api/v1/fragments?concept_id={id}&include_subtypes=true&status=approved
```

With `include_subtypes=true`, the query traverses the `IS_SUBTYPE_OF` tree downward from the given concept node and returns fragments tagged with any concept in that subtree. This requires a join across PostgreSQL (`fragment_concept_tag`) and Neo4j (subtree traversal); implement it as: (1) query Neo4j for all subtype ids of the given concept, (2) query PostgreSQL for fragments whose `concept_id` is in that set. Cache the subtree results in Redis — Redis is available from day one (it is in the Docker Compose stack as the Celery broker), so this cache can be implemented in Phase 1.

### Fragment List Previews

Each fragment in the list view should show a small Verovio-rendered preview of the fragment's bars. Generate this as a static SVG at fragment submission time (Celery task, server-side Verovio Python bindings), stored in object storage. Return the preview URL from the list endpoint. Do not render fragments client-side in the list view — it would be too slow for large result sets.

### Fragment Detail View

The individual fragment detail view is the same Verovio rendering + MIDI playback infrastructure used in the score viewer, constrained to the fragment's `bar_start`/`bar_end` range (whole containing measures as the default). Display the full concept tag, property values, music21 summary, and prose annotation. If the fragment has sub-parts, display them as nested brackets within the rendered fragment.

**Forward-compatibility — rendering context:** the fragment detail API should accept an optional `context_bars` integer parameter (default: 0) specifying how many additional bars to render on each side of the fragment's range. Phase 1 leaves this at 0 (containing measures only), but future contexts — blog embeds, MCQ exercises, or showing the parent container fragment for orientation — will need configurable context without a data model change. Design the API contract to accept the parameter now; the implementation ignores any non-zero value until the consuming feature is built.

---

## Component 9 — Initial Corpus Population & Testing

**Purpose:** Validate the entire pipeline with real data before Phase 2 begins.

### Scope

- Ingest a coherent test corpus (e.g. 5–10 Mozart piano sonata movements)
- Tag a meaningful set of fragments (target: 50–100 fragments across the cadence domain)
- Exercise every code path: upload → validation → corpus browsing → tagging → music21 preprocessing → fragment DB → peer review → fragment browsing
- Document all bugs, edge cases, and data quality issues encountered

### Test Targets

| Code path | Minimum test coverage |
|---|---|
| MEI upload with valid file | 5 files across 3 works |
| MEI upload with invalid file (schema error, bad measure numbers) | 1 each |
| Measure number correction workflow | 1 file requiring correction |
| Concept search (cadence domain) | All concept nodes should be findable |
| Fragment tagging (PAC, IAC, HC, DC at minimum) | 10+ per type |
| Sub-part tagging | 10+ fragments with at least one sub-part |
| Peer review workflow (submit → approve, submit → reject → revise → approve) | 5 full cycles |
| Fragment browsing by concept | All four cadence types browsable |

---

## Build Order & Dependencies

The following order respects hard dependencies between components:

```
1. Project foundation (Docker Compose, API conventions, auth, ADRs)
   ↓
2. MEI corpus ingestion (defines the coordinate system for everything else)
   ↓
3. Corpus browsing (depends on ingestion; unblocks human review of uploaded files)
   ↓
4. Verovio visualization (depends on corpus; unblocks tagging tool UI)
   ↓
5. Knowledge graph: cadence domain (can proceed in parallel with 3–4)
   ↓
6. music21 preprocessing pipeline (depends on corpus ingestion; can run in parallel with 5)
   ↓
7. Tagging tool (depends on 4, 5, and 6 — the last component to start)
   ↓
8. Fragment database CRUD & display (depends on tagging tool producing records)
   ↓
9. Fragment browsing (depends on fragment DB being populated)
   ↓
10. Corpus population & testing (depends on all of the above)
```

Components 3–4 and 5–6 can be built in parallel by different developers. The tagging tool (7) is the integration point; it should not begin until its dependencies are stable.

---

## Decisions Log

All architectural decisions have been recorded as ADRs in `docs/adr/`. The table below summarises the Phase 1 decisions for quick reference.

| Decision | Resolution | ADR |
|---|---|---|
| Auth provider | Supabase Auth | ADR-001 |
| File storage | Cloudflare R2 (production), MinIO (local) | ADR-002 |
| Default score display mode | Vertical infinite scroll | ADR-003 |
| music21 pipeline trigger | On MEI upload, async via Celery | ADR-004 |
| Sub-measure precision | Implement beat-level and sub-beat-level selection in Phase 1; `beat_start`/`beat_end` are populated from the first annotation session | ADR-005 |
| Internationalisation strategy | English as canonical; language-agnostic IDs; translation tables scaffolded in Phase 1; second language deferred | ADR-006 |
| MIDI player library | `@tonejs/midi` + Tone.js | ADR-012 |
| Repeat section handling in selection | Flag as known limitation; add `repeat_context` column; defer disambiguation UI to Phase 2 | — |
| Prose annotation vector embedding | Store raw text now; scaffold pgvector; generate embeddings in Phase 3 | ADR-007 |
| Fragment preview generation | Server-side static image at submit time (Celery + Verovio Python bindings) | ADR-008 |
| DCML licensing constraint | CC BY-SA 4.0 per-fragment `data_licence` field; ABC corpus excluded from public API | ADR-009 |
| Frontend framework | React 18 + Vite + TypeScript + React Router v6; no SSR | ADR-010 |
| Multi-level tagging design | See ADR | ADR-011 |

---

## Forward-Compatibility Notes

These are things that cost little to do correctly now but would require expensive migrations or refactoring if done wrong.

**Fragment data model.** The `fragment` table schema, and especially the `summary` JSONB structure, should be treated as a published API from day one. Phase 3's AI reasoning tools will consume this structure directly; changing it retroactively means re-processing every fragment. Pin the `summary` JSON schema with a `version` field and document it in `/docs/fragment-schema.md`.

**Concept ID stability.** The `concept_id` values in `fragment_concept_tag` are the join keys between PostgreSQL and Neo4j. Once a concept node is seeded with a given `id`, that id must not change. Renaming a concept's display name is safe; renaming its `id` breaks all fragment references. Establish this as an invariant from the start and enforce it in the seeding script (warn loudly if a previously seeded `id` is absent from the YAML).

**PropertySchema extensibility.** The dynamic property form in the tagging tool must be driven entirely by the schema layer, with no hardcoded concept-specific logic. As new domains are added to the knowledge graph (sequences, modulations, formal sections), their schemas should automatically produce correct tagging forms without frontend changes.

**Editor role model.** The `editor`/`admin` roles introduced in Phase 1 are a subset of the full Phase 2 role model (`anonymous visitor`, `registered user`, `editor`, `admin`). Implement the role check as a parameterized middleware function (`require_role("editor")`) rather than hardcoded role strings scattered through route handlers. Adding new roles in Phase 2 then requires only adding new role constants, not modifying route handlers.

**Tagging tool selection model.** The scaffolding decisions for sub-measure precision are captured in ADR-005 (nullable `beat_start`/`beat_end` columns) and ADR-011 (multi-level tagging design). The overlay rendering architecture (absolutely-positioned overlay div, not SVG modification) is already compatible with sub-measure selection without a rewrite.

**Peer review state machine.** The `draft → submitted → approved/rejected` state machine established in Phase 1 will be extended in Phase 2 when registered users can view only `approved` fragments. Ensure the `status` filter is applied at the service layer, not just the UI, so it cannot be bypassed by direct API calls.

**music21 analysis versioning.** music21's Roman numeral analysis can produce different results across library versions. Store the music21 version used to generate each summary as a field in the JSONB (or a separate column). This makes it possible to identify records that need reanalysis when the library is upgraded.

**Prose annotation → vector store.** Store prose annotations in the `fragment` table from day one. When the vector store is built in Phase 3, a one-time migration generates embeddings from existing annotations. If prose annotations are stored only in a workflow tool or a spreadsheet, that migration becomes a data archaeology problem.

**Fragment browsing as the precursor to AI retrieval.** The concept-tag browsing API built in Phase 1 (`GET /fragments?concept_id=...&include_subtypes=true`) is structurally identical to the graph traversal queries the AI reasoning layer will issue in Phase 3. Write this query as a reusable service function, not as inline route logic. Phase 3 will call the same function from within tool-calling context.

**Real audio playback.** The `onPositionUpdate(bar, beat)` abstraction established in Phase 1's MIDI playback layer is the primary forward-compatibility mechanism for real audio. When a suitable open-licence recording exists for a work (Musopen, Open Goldberg Variations, etc.), the real audio path replaces the MIDI synthesis path while calling the same callback. No rendering layer changes are required. See `docs/architecture/real-audio-playback-research.md` for the full design: two new tables (`audio_recording`, `audio_score_alignment`), the parangonar alignment pipeline, and the assessment of open recording availability by repertoire.
