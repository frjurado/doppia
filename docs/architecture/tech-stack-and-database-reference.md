# Tech Stack & Database Reference
## Doppia — Open Music Analysis Repository

---

## Design Principles

These principles govern all infrastructure and tooling decisions across the stack.

**Separation of rendering and reasoning.** MEI is the source of truth for notation; no AI component reads it directly. All reasoning happens over derived JSON representations. This keeps the AI layer decoupled from the notation format.

**Let music21 be the engine.** If a property of a musical entity is fully derivable by music21 without loss of musical meaning, it belongs in the fragment's structured JSON data — not in the knowledge graph. The graph encodes expert knowledge; music21 handles chord-level computation.

**Write-time validation via Pydantic.** All data entering any database passes through a Pydantic validation layer first. Schema constraints (cardinality, required fields, valid concept references) are enforced before anything reaches the database. The databases store and serve; Pydantic guards.

**Idempotent seeding.** Knowledge graph and schema seed files are version-controlled YAML. The seeding script uses Cypher `MERGE` (not `CREATE`), making it safe to re-run at any time. This is the migration strategy for the graph layer.

**Controlled vocabulary end to end.** Fragment tags are not free text — every tag value is an `id` reference to a node in the knowledge graph. This makes cross-corpus queries reliable and drives non-AI features (exercise distractors, collection sequencing) without additional coordination.

**One database per concern.** Each database is chosen to match the query patterns of its layer. The boundaries are enforced in the service layer; no component queries across database types directly.

**Local parity with production.** The full database topology runs in Docker Compose locally. Production uses managed cloud equivalents of the same services — no local-only workarounds or schema divergence.

---

## Database Inventory

### 1. Neo4j — Knowledge Graph

**Role:** The semantic core of the system. Stores musical concept nodes, typed relationships between them, PropertySchema nodes, and PropertyValue nodes. Enables the traversal queries that drive AI reasoning, exercise generation, and pedagogical sequencing.

**What it stores:**
- Concept nodes (`:Concept` + type label, e.g. `:CadenceType`)
- PropertySchema nodes (`:PropertySchema`)
- PropertyValue nodes (`:PropertyValue`)
- Typed edges: `IS_SUBTYPE_OF`, `CONTAINS`, `RESOLVES_TO`, `HAS_PROPERTY_SCHEMA`, `HAS_VALUE`, `VALUE_REFERENCES`, `PREREQUISITE_FOR`, and the full active vocabulary — see `edge-vocabulary-reference.md`
- Edge properties: `order` and `required` on `CONTAINS` edges only. `APPEARS_IN` (concept → fragment) is **not** stored as a Neo4j edge; it is resolved at the application layer via the PostgreSQL `fragment_concept_tag` table.

**Why Neo4j:** The design depends heavily on typed directed edges and multi-hop traversal (schema inheritance, prerequisite chains, neighbourhood queries). Neo4j is the most mature property graph database, with first-class support for all of this. Cypher is readable enough to use directly in application code. No other data store in the stack handles this query shape well.

**Query language:** Cypher

**Python integration:**
- `neo4j` (official driver) — for all complex traversal queries where Cypher needs to be written directly
- `neomodel` ORM — for routine CRUD operations on concept and schema nodes; gives a Pythonic interface at the cost of some traversal flexibility

**Key query patterns:**
```cypher
-- Schema inheritance (zero-or-more hops up the type hierarchy)
MATCH (c:Concept {id: $id})-[:IS_SUBTYPE_OF*0..]->(ancestor)
      -[:HAS_PROPERTY_SCHEMA]->(s)-[:HAS_VALUE]->(v)
OPTIONAL MATCH (v)-[:VALUE_REFERENCES]->(ref)
RETURN s, collect(v), collect(ref)

-- Prerequisite chain for a concept
MATCH path = (c:Concept {id: $id})<-[:PREREQUISITE_FOR*1..]-(:Concept)
RETURN nodes(path), relationships(path)

-- Expand concept to all related concept IDs (direct + via property values)
-- Result is used to query fragment_concept_tag in PostgreSQL
MATCH (c:Concept {id: $id})
OPTIONAL MATCH (c)<-[:VALUE_REFERENCES]-(:PropertyValue)
              <-[:HAS_VALUE]-(:PropertySchema)
              <-[:HAS_PROPERTY_SCHEMA]-(related:Concept)
RETURN $id AS direct_id, collect(distinct related.id) AS via_property_ids
-- Application layer then queries PostgreSQL:
-- SELECT fragment_id FROM fragment_concept_tag
-- WHERE concept_id = ANY(:direct_id || :via_property_ids)
```

**Seeding:** YAML seed files → Python seeding script → idempotent Cypher `MERGE` statements. All `id` fields are unique-constrained in Neo4j.

**Local dev:** Neo4j Community Edition in Docker (`neo4j:5` image). Neo4j Browser available at `localhost:7474`. Bloom available via Neo4j Desktop (separate install, connects to the Docker instance).

**Production:** Neo4j AuraDB (managed cloud). Free tier covers early development; AuraDB Professional for production load. Connection string and credentials injected via environment variables.

---

### 2. PostgreSQL — Fragment Database + User Infrastructure

**Role:** Two logically distinct concerns share one PostgreSQL instance: the fragment database (scored excerpts, their structured analytical summaries, MEI pointers, and hierarchical concept tags) and all user infrastructure (accounts, roles, collection ownership, exercise history, reading history).

**Why PostgreSQL for both:** The fragment database has enough structured fields alongside its variable JSON content that a relational store is the right fit. PostgreSQL's JSONB column type handles the analytical summary natively — it is binary-stored, indexable with GIN indexes, and queryable with path operators — without requiring a separate document database. Consolidating user infrastructure into the same instance avoids a third database technology for what is fundamentally a well-structured relational problem.

**Why not MongoDB:** Adding MongoDB would introduce a third database technology to operate and reason about, while providing no capability that PostgreSQL with JSONB does not already cover for this use case. Fragment records have well-defined structural fields (`movement_id`, bar/beat range, concept tag references) alongside the variable JSON summary; JSONB handles the variable part cleanly.

#### Music works infrastructure

The corpus is organised as a four-level hierarchy: composer → corpus → work → movement. The MEI object key lives on `movement` as `mei_object_key` and follows the convention `{composer.slug}/{corpus.slug}/{work.slug}/{movement.slug}.mei`. These tables own the licensing and provenance metadata that travels with ingested MEI; fragments reach the source via `movement_id` rather than carrying their own MEI pointer.

```sql
CREATE TABLE composer (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT UNIQUE NOT NULL,     -- e.g. "mozart", "beethoven"
    name          TEXT NOT NULL,            -- "Wolfgang Amadeus Mozart"
    sort_name     TEXT NOT NULL,            -- "Mozart, Wolfgang Amadeus"
    birth_year    INTEGER,
    death_year    INTEGER,
    nationality   TEXT,                     -- free text; ISO codes premature
    wikidata_id   TEXT,                     -- e.g. "Q254"; nullable
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX composer_sort_name_idx ON composer (sort_name);

CREATE TABLE corpus (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    composer_id       UUID NOT NULL REFERENCES composer(id) ON DELETE RESTRICT,
    slug              TEXT NOT NULL,        -- e.g. "piano-sonatas"
    title             TEXT NOT NULL,        -- "Piano Sonatas"
    source_repository TEXT,                 -- e.g. "DCML/mozart-piano-sonatas"
    source_url        TEXT,                 -- canonical URL to the upstream source
    source_commit     TEXT,                 -- git SHA of the ingested snapshot
    analysis_source   TEXT CHECK (analysis_source IN
                          ('DCML', 'WhenInRome', 'music21_auto', 'none')),
    licence           TEXT NOT NULL,        -- SPDX: "CC-BY-SA-4.0", "CC0-1.0", …
    licence_notice    TEXT,                 -- attribution text if required
    notes             TEXT,
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now(),
    UNIQUE (composer_id, slug)
);
CREATE INDEX corpus_analysis_source_idx ON corpus (analysis_source);

CREATE TABLE work (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corpus_id        UUID NOT NULL REFERENCES corpus(id) ON DELETE RESTRICT,
    slug             TEXT NOT NULL,         -- e.g. "k331", "op2-no1"
    title            TEXT NOT NULL,         -- "Piano Sonata No. 11 in A major"
    catalogue_number TEXT,                  -- "K. 331", "Op. 2 No. 1", "BWV 846"
    year_composed    INTEGER,               -- nullable; ranges go in year_notes
    year_notes       TEXT,                  -- "c. 1783", "1782–1784"
    key_signature    TEXT,                  -- overall key; optional
    instrumentation  TEXT,                  -- free text for Phase 1
    notes            TEXT,
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now(),
    UNIQUE (corpus_id, slug)
);

CREATE TABLE movement (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id                 UUID NOT NULL REFERENCES work(id) ON DELETE RESTRICT,
    slug                    TEXT NOT NULL,    -- e.g. "movement-1", "allegro"
    movement_number         INTEGER NOT NULL, -- 1-indexed; unique within work
    title                   TEXT,             -- "Andante grazioso"
    tempo_marking           TEXT,             -- "Allegro", "Andante con moto"
    key_signature           TEXT,             -- canonical: "A major"
    meter                   TEXT,             -- starting meter: "6/8"
    mei_object_key          TEXT NOT NULL,    -- S3 key of the normalized MEI
    mei_original_object_key TEXT,             -- pre-normalization; nullable
    duration_bars           INTEGER,          -- cached last bar @n; populated by the normalizer
    normalization_warnings  JSONB,            -- structured warnings; null = clean
    incipit_object_key      TEXT,             -- S3 key of the rendered incipit SVG; nullable until generated
    incipit_generated_at    TIMESTAMPTZ,      -- cache-buster input for the public-URL branch (see security-model.md §4)
    pending_analysis        BOOLEAN NOT NULL DEFAULT TRUE,  -- ADR-018: cleared when analysis ingestion completes
    ingested_at             TIMESTAMPTZ DEFAULT now(),
    created_at              TIMESTAMPTZ DEFAULT now(),
    updated_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE (work_id, movement_number),
    UNIQUE (work_id, slug)
);
CREATE INDEX movement_mei_key_idx ON movement (mei_object_key);
```

**Slug scoping.** Slugs are unique per parent (corpus per composer, work per corpus, movement per work). This is what makes the composed path `{composer.slug}/{corpus.slug}/{work.slug}/{movement.slug}.mei` globally unique without a central registry.

**`duration_bars`** caches the last `@n` value found in the normalized MEI. It is populated by the normalizer and is the natural upper bound for fragment `bar_end` validation; the service layer uses it to reject fragments that overshoot the movement without re-parsing the MEI on every write.

**`ingested_at` vs. `created_at`.** `created_at` is when the row was first inserted. `ingested_at` is when the MEI passed the pipeline and was normalized. A re-ingest after an MEI correction updates `ingested_at` without re-creating the row.

#### Fragment table (core schema sketch)

```sql
CREATE TABLE fragment (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id   UUID NOT NULL REFERENCES movement(id) ON DELETE RESTRICT,
    bar_start     INTEGER NOT NULL,
    bar_end       INTEGER NOT NULL,
    summary       JSONB NOT NULL,         -- full structured analytical summary
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

-- GIN index for querying into the JSONB summary
CREATE INDEX fragment_summary_gin ON fragment USING GIN (summary);

CREATE TABLE fragment_concept_tag (
    fragment_id     UUID REFERENCES fragment(id) ON DELETE CASCADE,
    concept_id      TEXT NOT NULL,          -- references Concept.id in Neo4j
    is_primary      BOOLEAN NOT NULL DEFAULT true,  -- true for the concept that drove the tag; see fragment-schema.md
    PRIMARY KEY (fragment_id, concept_id)
);
```

The `fragment_concept_tag` table is the join surface between PostgreSQL and Neo4j. `concept_id` values are the same `id` strings used as primary keys in the graph. No foreign key enforcement across databases — referential integrity is maintained by the application layer and Pydantic validation.

This sketch shows the MEI-pointer columns (`movement_id`) and the JSONB summary field — the parts that distinguish fragment-table design at the database level. It deliberately omits columns that belong to the peer-review state machine and editorial metadata (`beat_start`, `beat_end`, `repeat_context`, `parent_fragment_id`, `prose_annotation`, `data_licence`, `status`, `created_by`). The full schema, including the peer-review state machine and per-fragment licence, is in:

**[`fragment-schema.md`](fragment-schema.md)**

`key`, `meter`, and harmonic analysis are **not** columns on `fragment`. Key and meter live inside the `summary` JSONB; chord-level harmonic analysis lives in `movement_analysis` (per-event, mutable, reviewable) and is sliced at read time by the fragment's bar/beat range. See `fragment-schema.md` for the rationale.

#### User infrastructure tables

Phase 1 created only `app_user`. Component 12 added `user_role` (migration
`0010`, ADR-037), dropped `app_user.role`, added the profile columns (migration
`0011`), and created the four user-state tables — `exercise_type`,
`exercise_session`, `exercise_result`, `reading_history` (migration `0012`).

The user-state tables exist **before** the features that fill them. That is the
"record from day one" principle, and it is not tidiness: history that was not
recorded cannot be reconstructed later, so the tables have to be in place the
day the surfaces they observe go live. `exercise_type` is empty until
Component 15 seeds it from YAML; `reading_history` records from now, for the
one reading surface that exists.

`collection` / `collection_fragment` remain deferred to Component 13, where
they can be designed against the real feature.

```sql
-- Named app_user, not user, because USER is a SQL keyword (alias for CURRENT_USER).
-- Avoiding it means no double-quoting in queries and no surprising semantics.
CREATE TABLE app_user (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    -- Self-reported and optional. NOT a permission: the granted set lives in
    -- user_role, and the two are deliberately never named alike in the API.
    -- NULL means "prefer not to say", which is better expressed as an absent
    -- value than as another vocabulary entry (migration 0011).
    self_declared_role TEXT CHECK (self_declared_role IN
      ('student', 'educator', 'researcher', 'hobbyist',
       'professional_musician', 'other')),
    -- Consent for reading_history. Opt-in by design, so every row starts off
    -- and only an explicit toggle turns it on. Landed before the table it
    -- governs: the consent has to exist before anything could be recorded.
    reading_history_opt_in BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- One row per role grant. A user holds a *set* of roles; 'registered' is implicit
-- in having an account and is never stored, so a new registration has no rows at
-- all and default-deny falls out of the schema (ADR-037).
CREATE TABLE user_role (
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,          -- 'editor' | 'author' | 'admin'
    granted_by  UUID REFERENCES app_user(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

```

#### User-state tables (migration 0012)

Shapes taken verbatim from the sketch in
[`../roadmap/component-15-exercises.md`](../roadmap/component-15-exercises.md) § 6,
which supersedes the earlier "shape open" note here.

```sql
CREATE TABLE exercise_type (          -- seeded from YAML in Component 15
    id            TEXT PRIMARY KEY,   -- 'cadence-identification'
    definition    JSONB NOT NULL,     -- validated YAML payload
    seeded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exercise_session (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    exercise_type_id TEXT NOT NULL REFERENCES exercise_type(id),
    -- The testing-contamination flag is on the session, not the role: an admin
    -- genuinely practising produces valid data, the preview tool does not.
    mode             TEXT NOT NULL DEFAULT 'standard'
                     CHECK (mode IN ('standard', 'preview')),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ            -- NULL = abandoned, which is data
);
CREATE INDEX exercise_session_user_time_idx ON exercise_session (user_id, started_at);

CREATE TABLE exercise_result (        -- one row per question answered
    id               BIGSERIAL PRIMARY KEY,
    session_id       UUID NOT NULL REFERENCES exercise_session(id) ON DELETE CASCADE,
    -- No FK: a result records what the user was asked and answered, and stays
    -- true after the fragment is deleted or re-ingested. A cascade here would
    -- erase a user's history as a side effect of an editorial action.
    fragment_id      UUID NOT NULL,
    concept_id       TEXT NOT NULL,   -- the correct answer (Neo4j Concept.id)
    distractors      JSONB NOT NULL,  -- concept ids in the order shown
    response         TEXT,            -- concept id chosen (NULL = skipped)
    correct          BOOLEAN NOT NULL,
    latency_ms       INTEGER,
    aids             JSONB,           -- {listens: 3, slowed: true, transpose: -1}
    answered_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user visit log across fragments and (from Component 16) blog posts.
-- The surrogate PK is the point: the naive (user_id, content_ref) composite
-- cannot record a repeat visit, which is what the table exists to observe.
CREATE TABLE reading_history (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    content_type  TEXT NOT NULL CHECK (content_type IN ('fragment', 'blog_post')),
    content_ref   TEXT NOT NULL,           -- UUID-as-text for fragments; slug for blog posts
    visited_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reading_history_user_time_idx ON reading_history (user_id, visited_at DESC);
CREATE INDEX reading_history_content_idx   ON reading_history (content_type, content_ref);
```

All four have Row Level Security enabled (the migration 0005 pattern). They
hold per-user history, so a missing default-deny would be a data leak rather
than merely an inconsistency — PostgREST exposes every public-schema table to
the anon role whose key ships in the frontend bundle.

`exercise_activation` (the `(type, concept)` gate) is **not** created: nothing
references it and its status vocabulary is a Component 15 design question.

**How `reading_history` is written.** Recording happens server-side in
`GET /api/v1/public/fragments/{id}` — the only reading surface that exists —
through `services/reading_history.py`. The consent lives inside the SQL
statement (`INSERT ... SELECT ... WHERE reading_history_opt_in`) rather than in
a preceding check, so there is no window between reading the consent and acting
on it, and no branch a future caller can forget. A user who has not opted in, or
who has no `app_user` row, produces zero rows. Recording never fails the
request: a lost analytics row is cheaper than a broken page.

Nothing about the *response* depends on the caller — the fragment is still
fetched with `caller_id=None`, so a signed-in reader and an anonymous one are
served the same bytes. Recording also happens after the 404 branch, so probing
for an unapproved fragment records nothing.

One row per visit. If storage growth becomes a concern, dedupe per day via a
unique `(user_id, content_type, content_ref, date_trunc('day', visited_at))`
constraint plus a `visit_count INTEGER`. That is a later decision, not one to
pre-empt.

#### Moderation (migration 0014)

```sql
CREATE TABLE moderation_report (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- One opaque string, deliberately no FK: 'collection:{uuid}' today, other
    -- surfaces later, and no single foreign key can point at two tables.
    resource_ref TEXT NOT NULL,
    reporter_id  UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    reason       TEXT NOT NULL CHECK (reason IN ('spam','abuse','copyright','other')),
    detail       TEXT,
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','dismissed','actioned')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_by  UUID REFERENCES app_user(id),
    resolved_at  TIMESTAMPTZ
);

-- "One open report per user per resource" is this index, not application
-- logic: two simultaneous reports would both pass a check-then-insert. Partial
-- on purpose — after a report is resolved the same person may report the same
-- resource again, because it may have changed since.
CREATE UNIQUE INDEX moderation_report_open_unique
    ON moderation_report (reporter_id, resource_ref) WHERE status = 'open';
CREATE INDEX moderation_report_queue_idx    ON moderation_report (status, created_at);
CREATE INDEX moderation_report_resource_idx ON moderation_report (resource_ref);
```

RLS enabled, per the migration 0005 pattern. The table ships before anything is
reportable: the moderation tool must be live before sharing is
(`../roadmap/phase-2.md` § Component 13).

**Deferred — documented here so the intent is captured but not yet schema'd:**

`collection` and `collection_fragment` — user-curated ordered sets of fragments with intent (class_prep, practice, research), visibility, and per-item annotations. Deferred to Component 13; the column list needs the real feature to pull on it. The deletion/tombstone rules that shape their foreign keys are recorded in Component 12's data-rights ADR.

**Python integration:** SQLAlchemy (ORM + Core) with async support via `asyncpg`. Alembic for schema migrations.

**Local dev:** PostgreSQL 16 in Docker (`postgres:16` image). `pgAdmin` or `psql` for inspection.

**Production:** AWS RDS (PostgreSQL 16) or Supabase. Supabase is worth considering in early phases — it gives PostgreSQL plus a REST API, auth helpers, and a decent dashboard UI for inspecting data without a separate admin tool. Either way the connection string is environment-variable injected; the application code does not change.

---

### 3. Vector Store — Prose and RAG Layer

**Role:** Stores all natural-language content as embeddings for semantic retrieval: concept prose annotations, fragment expert annotations, blog post body text, explanatory text about expressive qualities and historical context. This is the layer that carries the *why* — the things that resist tabular encoding — and that would serve as the retrieval backbone for a Phase 3 AI reasoning layer.

**What it stores:**
- Chunk text and its embedding vector
- Source metadata: content type (`concept_annotation` | `fragment_annotation` | `blog_post`), source id (concept id, fragment id, or post slug), and any structural context
- Enough metadata to reconstruct a citation or link back to the source

**Technology decision — pgvector vs. dedicated vector DB:**

For early phases, **pgvector** (a PostgreSQL extension) is the right default. It runs inside the existing PostgreSQL instance, requires no additional service, and is capable up to hundreds of thousands of vectors — comfortably beyond Phase 1 and Phase 2 scale. This keeps the local Docker Compose topology simple and production deployment lean.

The migration path is clear: if retrieval quality or query latency becomes a bottleneck at scale, move to **Weaviate** (open-source, self-hostable, good Python client) or **Pinecone** (fully managed, minimal ops). The application's RAG service layer should be written against an interface, not directly against a pgvector-specific API, so this migration is a backend swap without touching the AI reasoning layer.

```sql
-- pgvector setup (once extension is enabled)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE prose_chunk (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type  TEXT NOT NULL,     -- concept_annotation | fragment_annotation | blog_post
    source_id     TEXT NOT NULL,     -- concept.id, fragment.id, or post slug
    chunk_text    TEXT NOT NULL,
    embedding     vector(1536),      -- null until Phase 3; dimension fixed at 1536 (text-embedding-3-small)
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Created in Phase 3 once embeddings are populated:
-- CREATE INDEX prose_chunk_embedding_idx
--     ON prose_chunk USING ivfflat (embedding vector_cosine_ops)
--     WITH (lists = 100);
```

**Python integration:** `psycopg2` or `asyncpg` with the `pgvector` Python package. For Pinecone/Weaviate if migrated: their official Python clients.

**Embedding model:** OpenAI `text-embedding-3-small` is a practical default (1536 dimensions, good quality/cost ratio). The dimension is set once at schema creation; changing it requires re-embedding the entire corpus, so pin this decision early.

**Production:** pgvector on the same RDS/Supabase instance as the main PostgreSQL DB. Supabase has first-class pgvector support including a vector search API, which is an additional argument for using it in early phases.

---

### 4. Object Storage — MEI Files and SoundFont Assets

**Local dev:** MinIO (`minio/minio` image) running on port 9000. Accessed by the API to resolve `mei_object_key` values into signed URLs (15-minute TTL). Bucket name: `doppia`.

**Production:** Cloudflare R2. The API generates pre-signed R2 URLs; the frontend fetches MEI content directly from R2 without proxying through the API server.

**MEI object key convention** (stored in `movement.mei_object_key`):
```
{composer.slug}/{corpus.slug}/{work.slug}/{movement.slug}.mei
```
Example: `mozart/piano-sonatas/k331/movement-1.mei`

**SoundFont key convention** (Step 14.2 — piano audio samples for MIDI playback):
```
soundfonts/piano/{note}.mp3
```
Example notes: `C4.mp3`, `Ds4.mp3` (D#4), `Fs4.mp3` (F#4), `A4.mp3`.

Soundfonts are the one public-read artifact class (no signed URL — Tone.js cannot carry signed query parameters). In deployed environments they live in the dedicated public `doppia-soundfonts` bucket, separate from the private artifact bucket (Component 10 Step 1; `security-model.md` § 4). The frontend loads them via `VITE_SOUNDFONT_BASE_URL` (the MinIO base URL in dev, the soundfonts bucket's public URL in staging/production); the backend never touches this bucket. Upload Salamander Grand Piano reduced samples (1–2 MB total) to this path before enabling MIDI playback.

---

### 5. Redis — Caching and Task Broker

**Role:** Live from Phase 1, in two capacities: the cache for knowledge-graph read queries (the Component 8 concept-subtree/tree cache, language-scoped keys, invalidated on seed), and the Celery broker for the `celery` dispatch mode (ADR-017; since ADR-034 the default dispatch mode is in-process, so broker traffic occurs only in deliberate bulk-ingest windows).

**Cache-boundary rule:** these caches hold **graph structure only** — nothing derived from the fragment database. Graph structure changes only when `scripts/seed.py` runs, which is exactly what the seed-time invalidation covers; anything that changes on a fragment-lifecycle transition (approve / reject / delete / re-tag) is read live per request. Per-concept approved-fragment counts are the case in point: they used to ride inside the cached tree response and went stale for up to an hour (fixed in Component 11 Step 8 / M11 — see `services/cache.py`).

**What it stores (Phase 1):**
- Cached concept subtree/tree query results — structure only, no fragment counts (`services/cache.py`)
- Celery broker state, only while a worker window is active

**Phase 2 additions:**
- User session state if needed beyond Supabase Auth JWTs
- Cached exercise distractor sets per concept
- Rate-limit counters (`slowapi` — see `security-model.md` §2)

**Local dev:** `redis:7` image in Docker Compose.

**Production:** AWS ElastiCache (Redis) or Upstash (serverless Redis, cheaper for low-throughput early production). **Python integration:** `redis-py` with async support.

---

## Application Stack

### Backend

| Concern | Tool | Notes |
|---|---|---|
| Web framework | FastAPI | Async-native, automatic OpenAPI docs, excellent Pydantic integration |
| Validation | Pydantic v2 | Write-time enforcement of all schema constraints before DB writes |
| Graph driver (low-level) | `neo4j` (official) | Used for all traversal queries written in raw Cypher |
| Graph ORM (high-level) | `neomodel` | Used for routine concept/schema CRUD; not for complex traversal |
| Relational ORM | SQLAlchemy 2 (async) | Covers PostgreSQL fragments, user tables, and pgvector queries |
| DB migrations | Alembic | PostgreSQL schema migrations only; graph seeding handled separately |
| Music processing | music21 | Auto-extraction of harmonic and structural summaries from MEI |
| Score rendering (server-side) | Verovio Python bindings | Generating rendered snippets or validating MEI in preprocessing pipelines |
| Background tasks | Celery task modules + `services/task_dispatch.py` (ADR-034) | Incipit generation, fragment previews, analysis ingestion. Executed in-process by default; Celery + Redis broker mode reserved for bulk ingest windows (ADR-017). music21 preprocessing (Component 6) deferred |
| Embedding generation | OpenAI Python SDK | `text-embedding-3-small`; called from a background task, not inline |

### Frontend

| Concern | Tool | Notes |
|---|---|---|
| Framework | React 18 | Functional components and hooks throughout; see ADR-010 |
| Language | TypeScript | All frontend code; props typed with interfaces, no unexcused `any` |
| Build tool | Vite | Dev server with `/api` proxy to FastAPI; produces static bundle for deployment |
| Routing | React Router v6 | Client-side navigation; explicit route definitions in a top-level config |
| Score rendering | Verovio (JS, WASM) | Client-side MEI rendering, pinned 6.1.0 client and server (ADR-013); MIDI playback via Tone.js (ADR-012) |
| Internationalisation | i18next + react-i18next | UI ships in English and Spanish (ADR-006); language switcher in the nav bar; `eslint-plugin-i18next` guards against hardcoded strings |
| Graph visualization (embedded) | Cytoscape.js — *Phase 2, not yet built* | Served by a FastAPI endpoint returning Cytoscape JSON format |
| Blog editor | Block-based editor (TipTap preferred; Lexical as fallback) — *Phase 2, not yet built* | Custom fragment-picker block backed by the fragment DB; TipTap is React-native |

### Infrastructure & Tooling

| Concern | Tool | Notes |
|---|---|---|
| Containerization | Docker + Docker Compose | Full local topology; Compose file is the canonical dev environment spec |
| Knowledge graph seed format | YAML | Human-readable, comment-friendly; loaded by a Python seeding script |
| Graph visualization (editorial) | Neo4j Bloom | Runs against the local or AuraDB instance; zero-code, for domain experts |
| Graph visualization (dev/debug) | pyvis | Generates standalone interactive HTML from NetworkX subgraph exports |
| Full-graph audit | Gephi | Periodic: Neo4j → GraphML export → Gephi for structural analysis |
| Authentication | Supabase Auth | Managed OAuth + email/password; see ADR-001 |

---

## Docker Compose Topology (Local Dev)

```
services:
  neo4j:
    image: neo4j:5
    ports: ["7474:7474", "7687:7687"]
    environment:
      NEO4J_AUTH: neo4j/localpassword
      NEO4J_PLUGINS: '["apoc"]'
    volumes: ["neo4j_data:/data"]

  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: doppia
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: localpassword
    volumes: ["postgres_data:/var/lib/postgresql/data"]

  redis:
    image: redis:7
    ports: ["6379:6379"]

  api:
    build: ./backend
    ports: ["8000:8000"]
    depends_on: [neo4j, postgres, redis]
    environment:
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_AUTH: neo4j/localpassword
      DATABASE_URL: postgresql+asyncpg://postgres:localpassword@postgres/doppia
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
```

pgvector is enabled on the PostgreSQL container via an init script (`CREATE EXTENSION IF NOT EXISTS vector;`). No additional container required.

---

## Production Service Mapping

| Local (Docker) | Production | Notes |
|---|---|---|
| `neo4j` container | Neo4j AuraDB | Free tier for development; Professional for production |
| `postgres` container | Supabase (or AWS RDS) | Supabase preferred early — includes pgvector, auth helpers, and UI |
| `redis` container | Upstash (serverless Redis) | Low cost for early production traffic |
| `api` container | Fly.io | Stateless FastAPI; scales independently of databases |
| pgvector (in postgres) | Supabase Vector | No migration needed unless scale demands a dedicated vector DB |

The deployed mapping (Supabase, Cloudflare R2, Upstash, Fly.io) and the full environment-variable list are authoritative in `docs/deployment.md`.

All credentials are injected as environment variables. No credentials in code or Docker Compose files in the production path. The application code references the same environment variable names regardless of environment.

---

## Summary Table

| Layer | Technology | Purpose |
|---|---|---|
| Knowledge graph | Neo4j + Cypher | Concept nodes, typed relationships, schema inheritance, traversal |
| Graph driver | `neo4j` + `neomodel` | Raw Cypher for traversal; ORM for CRUD |
| Fragment database | PostgreSQL 16 + JSONB | MEI pointers, structured analytical summaries, concept tag joins |
| User infrastructure | PostgreSQL 16 (same instance) | Accounts, collections, exercise history, reading history |
| Prose/RAG layer | pgvector (→ Weaviate/Pinecone if scale demands) | Semantic retrieval over concept annotations, fragment prose, blog content |
| Caching / task broker | Redis | Concept-subtree cache (Phase 1); Celery broker in `celery` dispatch mode (ADR-017/034); sessions and distractor sets in Phase 2 |
| ORM / migrations | SQLAlchemy 2 + Alembic | PostgreSQL access and schema versioning |
| Write-time validation | Pydantic v2 | Schema constraints enforced before any database write |
| Seed management | YAML + Python seeding script | Version-controlled graph seeding via idempotent Cypher `MERGE` |
| Music processing | music21 | Harmonic/structural auto-extraction from MEI |
| Score rendering | Verovio (WASM client-side) | MEI → engraved notation + MIDI |
| Frontend framework | React 18 + Vite | SPA; functional components, hooks, TypeScript; see ADR-010 |
| Frontend routing | React Router v6 | Client-side navigation across all application surfaces |
| Web framework | FastAPI | Async API, OpenAPI docs, Pydantic integration |
| Editorial graph UI | Neo4j Bloom | Zero-code graph browsing for domain experts |
| Embedded graph UI | Cytoscape.js | Student-facing concept neighbourhood views |
| Debug visualization | pyvis + Gephi | Development-time and audit-time graph inspection |
| Embeddings | OpenAI `text-embedding-3-small` | 1536-dimension vectors; pin early, reseeding is expensive |
| Auth | Supabase Auth | Managed OAuth + email/password (ADR-001) |
| Local environment | Docker Compose | Full topology parity with production services |
| Production (graph) | Neo4j AuraDB | Managed Neo4j cloud |
| Production (relational + vector) | Supabase or AWS RDS | PostgreSQL 16 with pgvector |
| Production (cache) | Upstash | Serverless Redis |
