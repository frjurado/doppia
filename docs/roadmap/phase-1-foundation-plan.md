# Phase 1 — Project Foundation: Implementation Plan

This document translates the cross-cutting foundation requirements from `phase-1.md` into a concrete, sequenced set of tasks. It covers what to do locally, what to configure in external services, what to deploy to Fly.io, and what to document before any component work begins.

---

## Step 1 — Repository & Folder Structure

Create the monorepo skeleton with the layout specified in `phase-1.md`. No logic yet — just the scaffold that CI and tooling will target from day one.

```
/backend
  /api
  /services
  /models
  /graph
  /seed
  /tests
/frontend
  /components
  /services
/docker
/docs          ← already complete
```

Within `backend/`: add `__init__.py` to each subfolder. Within `frontend/`: add placeholder `index.ts` files.

**Also in this step:**

- `backend/pyproject.toml` — Python project config with Black + isort + ruff + pytest settings
- `backend/requirements.txt` and `backend/requirements-dev.txt` — runtime deps (FastAPI, SQLAlchemy, Pydantic v2, neomodel, aioboto3, celery, music21, lxml, alembic) and dev deps (black, isort, ruff, pytest, httpx)
- `frontend/package.json` — React 18 + Vite + TypeScript
- `frontend/.eslintrc` and `frontend/tsconfig.json`
- `.env.example` at the project root — all variables documented (see the Environment Variables section below and `docs/deployment.md` for the canonical list)
- `CONTRIBUTING.md` — filled with actual conventions, not a stub (see Code Conventions section below)

**Bootstrap (run once after scaffold is created):**

```bash
# Python — from backend/
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

# Frontend — from frontend/
npm install
```

**Verification:**

```bash
# Python tooling
cd backend && black --check . && isort --check . && ruff check .
# Empty test suite — should pass
pytest tests/
# Frontend
cd frontend && npm run lint && npm run build
```

---

## Step 2 — Docker Compose

Define the full local service topology in `docker-compose.yml` at the project root before any service is implemented. Run `docker compose up` from day one.

```yaml
services:
  neo4j:      # neo4j:5 image, ports 7474/7687, APOC plugin enabled
  postgres:   # postgres:16 image, port 5432, pgvector init script
  redis:      # redis:7 image, port 6379 (Celery broker + future cache)
  minio:      # minio/minio image, ports 9000 (S3 API) / 9001 (console)
```

Key requirements:

- All credentials pulled from `.env` — no hardcoded values in the Compose file
- PostgreSQL init script runs `CREATE EXTENSION vector;` on first start
- MinIO startup script creates the `doppia-local` bucket automatically
- Neo4j has auth enabled and the APOC plugin available (needed for full-text index seeding in Component 4)

**Note on the API and frontend:** in local development both run on the host machine (not inside Docker), so they benefit from native hot-reload and direct debugger access. Docker provides the infrastructure services only; the FastAPI app and Vite dev server are started separately.

**Setup:**

```bash
# Copy the example env file and fill in local credentials
cp .env.example .env

# Start all infrastructure services
docker compose up -d

# Verify all containers are healthy
docker compose ps
```

**Local credentials for Docker services** can be any value you choose — you are creating these containers fresh. Example:

```
NEO4J_PASSWORD=localpassword
POSTGRES_PASSWORD=localpassword
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
```

External service credentials (Supabase, Cloudflare R2, Upstash, OpenAI) can be left as placeholders until staging is configured.

---

## Step 3 — FastAPI Skeleton

Create the application structure before any feature routes. The goal is to hardwire all conventions — versioning prefix, error envelope, auth middleware, role check utility — before anyone adds a real endpoint.

**Files to create:**

- `backend/main.py` — FastAPI app instantiation, CORS configuration, lifespan hooks (DB connection pool open/close on startup/shutdown)
- `backend/api/router.py` — mounts all sub-routers under `/api/v1/`
- `backend/api/middleware/auth.py` — JWT validation middleware: reads `Authorization: Bearer <token>`, validates against the Supabase JWT secret, attaches user and role to request state
- `backend/api/middleware/errors.py` — global exception handler producing the standard error envelope:
  ```json
  { "error": { "code": "...", "message": "...", "detail": {} } }
  ```
- `backend/models/base.py` — SQLAlchemy async engine setup and declarative base
- `backend/api/routes/health.py` — `GET /api/v1/health` returning `{"status": "ok"}` (used by Fly.io health checks)

**Role check utility** — implement as a parameterised dependency from the start:

```python
# backend/api/middleware/auth.py
def require_role(role: str):
    # Returns a FastAPI dependency that enforces the given role.
    # Adding new roles in Phase 2 requires only adding new role constants,
    # not modifying route handlers.
    ...
```

**API conventions** — enforce these before any endpoint is written:

- All routes prefixed `/api/v1/`
- Cursor-based pagination on all list endpoints
- Consistent error envelope (see above) on all error responses
- RESTful resource naming: `GET /scores`, `GET /scores/{id}`, `POST /fragments`, `PATCH /fragments/{id}`

**Verification:**

```bash
uvicorn backend.main:app --reload
curl http://localhost:8000/api/v1/health   # expects {"status": "ok"}
```

---

## Step 4 — Database Migrations Scaffold

Initialize Alembic and create the initial migration covering the full schema as specified in `docs/architecture/tech-stack-and-database-reference.md` and `docs/architecture/fragment-schema.md`. The two documents are authoritative; the sketch below is for at-a-glance orientation only — do not copy-paste it into the migration without reading the source docs.

```bash
cd backend
alembic init migrations
```

Configure `alembic.ini` to read `DATABASE_URL` from the environment (not hardcoded).

**Initial migration creates (in dependency order):**

```sql
-- 1. User infrastructure (Phase 1 subset — collections/exercises/history are deferred)
CREATE TABLE app_user (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'user',  -- user | editor | admin
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- 2. Music works infrastructure
CREATE TABLE composer (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    sort_name TEXT NOT NULL,
    birth_year INTEGER,
    death_year INTEGER,
    nationality TEXT,
    wikidata_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE corpus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    composer_id UUID NOT NULL REFERENCES composer(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    source_repository TEXT,
    source_url TEXT,
    source_commit TEXT,
    analysis_source TEXT CHECK (analysis_source IN
        ('DCML', 'WhenInRome', 'music21_auto', 'none')),
    licence TEXT NOT NULL,
    licence_notice TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (composer_id, slug)
);

CREATE TABLE work (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corpus_id UUID NOT NULL REFERENCES corpus(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    catalogue_number TEXT,
    year_composed INTEGER,
    year_notes TEXT,
    key_signature TEXT,
    instrumentation TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (corpus_id, slug)
);

CREATE TABLE movement (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_id UUID NOT NULL REFERENCES work(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL,
    movement_number INTEGER NOT NULL,
    title TEXT,
    tempo_marking TEXT,
    key_signature TEXT,
    meter TEXT,
    mei_object_key TEXT NOT NULL,
    mei_original_object_key TEXT,
    duration_bars INTEGER,
    normalization_warnings JSONB,
    ingested_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (work_id, movement_number),
    UNIQUE (work_id, slug)
);

-- 3. Fragment and tagging
CREATE TABLE fragment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id UUID NOT NULL REFERENCES movement(id) ON DELETE RESTRICT,
    bar_start INTEGER NOT NULL,
    bar_end INTEGER NOT NULL,
    beat_start FLOAT,              -- nullable; Phase 1 leaves null (ADR-005)
    beat_end FLOAT,                -- nullable; Phase 1 leaves null (ADR-005)
    repeat_context TEXT,           -- e.g. 'first_ending'
    parent_fragment_id UUID REFERENCES fragment(id) ON DELETE CASCADE,
    summary JSONB NOT NULL,        -- pinned schema, version field required
    prose_annotation TEXT,         -- stored now; embedded in Phase 3 (ADR-007)
    data_licence TEXT,             -- per-fragment licence field (ADR-009)
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    created_by UUID REFERENCES app_user(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE fragment_concept_tag (
    fragment_id UUID REFERENCES fragment(id) ON DELETE CASCADE,
    concept_id  TEXT NOT NULL,     -- stable Neo4j concept id
    is_primary  BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (fragment_id, concept_id)
);

CREATE TABLE fragment_review (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fragment_id UUID NOT NULL REFERENCES fragment(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    comment TEXT,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (fragment_id, reviewer_id)
);

-- 4. music21 preprocessing — movement-level single source of truth for harmony
CREATE TABLE movement_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id UUID UNIQUE NOT NULL REFERENCES movement(id) ON DELETE CASCADE,
    events JSONB NOT NULL,         -- per-event timeline; each event carries source, auto, reviewed
    music21_version TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Scaffolded for Phase 3; not populated until then
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE prose_chunk (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type TEXT NOT NULL
        CHECK (content_type IN ('concept_annotation', 'fragment_annotation', 'blog_post')),
    source_id TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(1536),        -- pgvector; dimension matches text-embedding-3-small
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**Not included in the initial migration** (deferred to Phase 2): `collection`, `collection_fragment`, `exercise_result`, `reading_history`, and any `self_declared_role` / `experience_level` addition to `app_user`. See `tech-stack-and-database-reference.md` for the rationale and the drafted-for-later shape of `reading_history`.

**Summary JSONB** is validated against the Pydantic schema documented in `fragment-schema.md`. Note in particular that `harmony` and `harmony_source` are **not** top-level fields of `summary` — harmonic analysis lives in `movement_analysis` as a per-event timeline, mutable and reviewable, sliced at read time by the fragment's bar/beat range.

**Indexes to create alongside the tables** (full list in the source docs):

```sql
CREATE INDEX composer_sort_name_idx              ON composer (sort_name);
CREATE INDEX corpus_analysis_source_idx          ON corpus (analysis_source);
CREATE INDEX movement_mei_key_idx                ON movement (mei_object_key);
CREATE INDEX fragment_summary_gin                ON fragment USING GIN (summary);
CREATE INDEX fragment_parent_idx                 ON fragment (parent_fragment_id) WHERE parent_fragment_id IS NOT NULL;
CREATE INDEX fragment_status_idx                 ON fragment (status);
CREATE INDEX fragment_movement_idx               ON fragment (movement_id);
CREATE INDEX fct_concept_idx                     ON fragment_concept_tag (concept_id);
CREATE INDEX fragment_review_fragment_idx        ON fragment_review (fragment_id);
CREATE INDEX movement_analysis_music21_version_idx ON movement_analysis (music21_version);
CREATE INDEX movement_analysis_events_gin        ON movement_analysis USING GIN (events);
-- prose_chunk_embedding_idx is created in Phase 3, once embeddings are populated.
```

**Run the migration against local PostgreSQL (Docker):**

```bash
alembic upgrade head
```

Every migration must include a `downgrade()` function. Do not skip it.

---

## Step 5 — Testing Scaffold

Establish the test harness before writing any tests, so that the CI pipeline and local verification both work from the first commit.

**Files to create:**

- `backend/tests/conftest.py` — fixtures for: async test client (httpx `AsyncClient`), test PostgreSQL connection, test Neo4j instance, test MinIO bucket
- `backend/tests/unit/test_health.py` — a single smoke test hitting `GET /api/v1/health` and asserting a 200 response. This proves the harness works.
- `scripts/validate_graph.py` — stub entry point for the graph validation suite (fleshed out in Component 4, but the script should exist and be runnable from day one)

**Verification:**

```bash
pytest tests/unit/   # one passing test
python scripts/validate_graph.py   # exits cleanly (no-op until Component 4)
```

---

## Step 6 — External Services

These require configuration outside the codebase. Complete before staging deployment.

### Supabase

- Create a new Supabase project
- Disable public user registration (admin-only account creation per ADR-001)
- Create initial roles: `editor` and `admin`
- Note `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- The JWT secret (from Supabase project settings) is used in the FastAPI auth middleware

### Cloudflare R2

- Create a bucket named `doppia-staging`
- Generate an API token with R2 read/write permissions
- Note `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- A separate `doppia-production` bucket is created in Phase 2

### Neo4j AuraDB

- Create a free-tier AuraDB instance for staging
- Note `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- The local Docker Neo4j instance is independent; AuraDB is staging/production only

### Upstash Redis

- Create a free-tier Upstash Redis instance
- Note `REDIS_URL` and `REDIS_TOKEN`
- Not actively used until Phase 2, but the env variable slots must exist from the start

---

## Step 7 — Fly.io Staging Deployment

Once the skeleton runs cleanly locally, deploy the staging environment.

```bash
# From the project root
fly launch   # creates doppia-staging, generates fly.toml

# Set all secrets (never commit credentials to fly.toml)
fly secrets set NEO4J_URI=... NEO4J_PASSWORD=... DATABASE_URL=... \
                SUPABASE_URL=... SUPABASE_ANON_KEY=... \
                R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
                --app doppia-staging

# Deploy
fly deploy --app doppia-staging

# Run migrations against Supabase staging DB
fly ssh console --app doppia-staging
alembic upgrade head
exit

# Verify
curl https://doppia-staging.fly.dev/api/v1/health   # expects {"status": "ok"}
```

**`fly.toml` configuration:**

- Health check: `GET /api/v1/health`
- One machine initially; autoscaling deferred to production
- `ENVIRONMENT=staging` set as a non-secret env var

**Note:** the frontend is not deployed to staging in the foundation step. A staging frontend deploy is warranted when Component 3 (Verovio rendering) produces something worth sharing with the team.

---

## Step 8 — Documentation to Complete

Before any component work begins, the following must be finalized and committed:

### `CONTRIBUTING.md`

Must be complete, not a stub. Cover:

- **Python:** Black (line length 88), isort (profile = black), ruff for linting, type hints on all function signatures, Google-style docstrings, async-first in FastAPI route handlers (sync only where a library forces it)
- **Cypher:** uppercase keywords, snake_case parameters, one clause per line
- **JavaScript/TypeScript:** ESLint config (extend `eslint:recommended` + `@typescript-eslint/recommended`), functional components only, no `any` types
- **Bootstrap instructions:** venv creation + `pip install -r requirements-dev.txt` + `npm install` — so any new contributor (or a new Claude Code session) can get running without guessing

### `.env.example`

Every variable present, with a comment explaining what it is and where to obtain it. The canonical variable list is in `docs/deployment.md`. Commit this file; never commit `.env`.

### ADR review

All 12 ADRs in `docs/adr/` are written. Before closing the foundation step, verify that each one accurately reflects the decisions as implemented — particularly ADR-001 (Supabase Auth), ADR-002 (MinIO/R2), and ADR-010 (frontend framework), which have the most direct bearing on the scaffold.

---

## Sequencing

```
Day 1:  Repo scaffold + Docker Compose running locally (Steps 1–2)
Day 2:  FastAPI skeleton + Alembic init + smoke test passing (Steps 3–5)
Day 3:  External services configured (Step 6)
Day 4:  Fly.io staging deploy, health check live (Step 7)
Day 5:  CONTRIBUTING.md and .env.example complete, everything committed (Step 8)
→ Foundation done. Component 1 (MEI corpus ingestion) can begin.
```

The hard gates for the rest of Phase 1 are:

1. `docker compose up -d` starts all infrastructure services cleanly
2. The FastAPI auth middleware validates Supabase JWTs correctly
3. `alembic upgrade head` applies successfully against both local PostgreSQL and Supabase staging

Everything else in the foundation is scaffolding. Once these three gates pass, component work can begin in the order defined in `phase-1.md`.

---

## Environment Variables Reference

Full variable list and descriptions are in `docs/deployment.md`. The categories are:

- **Application:** `ENVIRONMENT`, `AUTH_MODE`
- **Neo4j AuraDB:** `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- **Supabase:** `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Cloudflare R2:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT_URL`
- **Upstash Redis:** `REDIS_URL`, `REDIS_TOKEN`
- **OpenAI:** `OPENAI_API_KEY` (Phase 3; wire in now)
