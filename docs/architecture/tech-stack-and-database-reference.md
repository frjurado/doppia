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

**Why not MongoDB:** Adding MongoDB would introduce a third database technology to operate and reason about, while providing no capability that PostgreSQL with JSONB does not already cover for this use case. Fragment records have well-defined structural fields (MEI pointer, key, meter, formal role, concept tag references) alongside the variable JSON summary; JSONB handles the variable part cleanly.

#### Fragment table (core schema sketch)

```sql
CREATE TABLE fragment (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mei_file      TEXT NOT NULL,          -- path/reference to the MEI source file
    bar_start     INTEGER NOT NULL,
    bar_end       INTEGER NOT NULL,
    key           TEXT,                   -- e.g. "C major"
    meter         TEXT,                   -- e.g. "4/4"
    formal_role   TEXT,                   -- e.g. "consequent phrase"
    summary       JSONB NOT NULL,         -- full structured analytical summary
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

-- GIN index for querying into the JSONB summary
CREATE INDEX fragment_summary_gin ON fragment USING GIN (summary);

CREATE TABLE fragment_concept_tag (
    fragment_id     UUID REFERENCES fragment(id) ON DELETE CASCADE,
    concept_id      TEXT NOT NULL,          -- references Concept.id in Neo4j
    structural_role TEXT,                   -- e.g. "cadence", "opening gesture"
    formal_context  TEXT,                   -- e.g. "within antecedent phrase"
    is_primary      BOOLEAN NOT NULL DEFAULT true,  -- false for secondary/contextual tags
    PRIMARY KEY (fragment_id, concept_id)
);
```

The `fragment_concept_tag` table is the join surface between PostgreSQL and Neo4j. `concept_id` values are the same `id` strings used as primary keys in the graph. No foreign key enforcement across databases — referential integrity is maintained by the application layer and Pydantic validation.

**The structured JSON summary** (`summary` JSONB) carries the music21-derivable content and the property instance record. The authoritative field-by-field specification — including the `harmony_source` provenance field, versioning policy, and review workflow — is in:

**[`fragment-schema.md`](fragment-schema.md)**

#### User infrastructure tables

```sql
CREATE TABLE app_user (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    experience_level TEXT,
    role          TEXT NOT NULL DEFAULT 'user',  -- user | editor | admin
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE collection (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID REFERENCES app_user(id),
    title         TEXT NOT NULL,
    intent        TEXT,           -- class_prep | practice | research | other
    description   TEXT,
    is_public     BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE collection_fragment (
    collection_id UUID REFERENCES collection(id) ON DELETE CASCADE,
    fragment_id   UUID REFERENCES fragment(id),
    position      INTEGER NOT NULL,
    annotation    TEXT,
    PRIMARY KEY (collection_id, fragment_id)
);

CREATE TABLE exercise_result (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES app_user(id),
    exercise_type TEXT NOT NULL,
    fragment_id   UUID REFERENCES fragment(id),
    concept_id    TEXT NOT NULL,    -- the target concept
    correct       BOOLEAN NOT NULL,
    response      TEXT,             -- what the user answered
    answered_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE reading_history (
    user_id       UUID REFERENCES app_user(id),
    content_id    TEXT NOT NULL,    -- fragment id or blog post slug
    content_type  TEXT NOT NULL,    -- 'fragment' | 'blog_post'
    visited_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, content_id)
);
```

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

### 4. Redis — Caching and Session State (Phase 2+)

**Role:** Not required in Phase 1. Introduced in Phase 2 when user sessions and repeated knowledge graph queries start to matter.

**What it stores:**
- User session tokens (if not using a managed auth service like Supabase Auth)
- Cached knowledge graph query results — concept neighbourhoods, prerequisite chains, schema lookups — which are expensive to recompute and change infrequently
- Cached exercise distractor sets per concept

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
| Task queue | Celery + Redis | Required from Phase 1 for async music21 preprocessing (on MEI upload); also used in Phase 2 for embedding generation |
| Embedding generation | OpenAI Python SDK | `text-embedding-3-small`; called from a background task, not inline |

### Frontend

| Concern | Tool | Notes |
|---|---|---|
| Framework | React 18 | Functional components and hooks throughout; see ADR-010 |
| Language | TypeScript | All frontend code; props typed with interfaces, no unexcused `any` |
| Build tool | Vite | Dev server with `/api` proxy to FastAPI; produces static bundle for deployment |
| Routing | React Router v6 | Client-side navigation; explicit route definitions in a top-level config |
| Score rendering | Verovio (JS, WASM) | Client-side MEI rendering; MIDI playback via embedded synth |
| Graph visualization (embedded) | Cytoscape.js | Served by a FastAPI endpoint returning Cytoscape JSON format |
| Blog editor | Block-based editor (TipTap preferred; Lexical as fallback) | Custom fragment-picker block backed by the fragment DB; TipTap is React-native |

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
| `api` container | Fly.io, Railway, or AWS App Runner | Stateless FastAPI; scales independently of databases |
| pgvector (in postgres) | Supabase Vector / pgvector on RDS | No migration needed unless scale demands a dedicated vector DB |

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
| Caching / sessions | Redis | Session tokens, cached graph query results, exercise distractor sets |
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
