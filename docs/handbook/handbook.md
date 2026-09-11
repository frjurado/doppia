# Doppia Project Handbook

**What this is.** The one map of the project that fits in your head. Everything here is
deliberately short; every section points to the document that holds the depth. It pairs with
[`ledger.md`](ledger.md), which tracks what you've actively reviewed and how well it stuck,
and with [`guides/`](guides/) — plain-language explainers that sit between this map and the
full technical docs.

**How to use it.** Re-read this file start-to-finish occasionally (~15 min). Between
re-reads, the weekly study session picks one topic from the ledger, quizzes you on it, and
walks the real code. When the project changes shape (new component, new ADR, new service),
this file changes with it — a handbook section that no longer matches the repo is a bug.

*Last synced with the repo: 2026-08-24 (Phase 2, Component 11 in flight).*

---

## 1. The system in one breath

Doppia is an open music-analysis repository: curated MEI scores, expert-tagged fragments,
and a music-theory knowledge graph, surfaced through a Verovio-based viewer/tagging tool —
with user features (glossary, collections, exercises, blog) in Phase 2 and an optional AI
tutoring layer in Phase 3.

```
MEI corpus (R2/MinIO) ──► ingest/normalize ──► PostgreSQL (works, movements, fragments,
        │                  (music21, Verovio)   analyses, users)      │
        │                                                             │ fragment_concept_tag
        ▼                                                             ▼
  Verovio viewer/tagger (React) ◄──── FastAPI API ────► Neo4j knowledge graph
        │                                  │            (concepts + typed edges)
        ▼                                  ▼
  Tone.js MIDI playback              Redis (graph cache; Celery broker in bulk windows)
```

Full component narrative and diagram: `docs/architecture/project-architecture.md`.

---

## 2. Repo layout

**Six** tracked directories at the root. Everything else up there is a config file
(`docker-compose.yml`, `fly.toml`, `pyproject.toml`, `CLAUDE.md`, `CONTRIBUTING.md`,
`README.md`, `.pre-commit-config.yaml`, `.env.example`).

| Path | What lives there |
|---|---|
| `backend/` | FastAPI app. `api/` thin route handlers (all `/api/v1/`, async) split into `routes/` and `middleware/`; `models/` SQLAlchemy + Pydantic; `services/` business logic, owns cross-DB joins, with `tasks/` for the Celery-dispatchable jobs; `graph/queries/` raw Cypher; `migrations/` Alembic **schema** revisions; `data_migrations/` one-off **data** backfills that Alembic knows nothing about; `seed/` graph YAML; `scripts/` two dev-only utilities; `tests/` (unit / integration / graph / snapshots); plus `errors.py` and `resources/` (the MEI RNG schema) |
| `frontend/` | React 18 + TypeScript SPA built with Vite. `src/` app code (`.ts`/`.tsx` only), `e2e/` Playwright — a *sibling* of `src/`, not inside it, because it drives the built bundle through `vite preview` and its specs would otherwise be swept up by `tsc -b` and the Vitest glob |
| `scripts/` | Repo-root CLI utilities: `seed.py`, `validate_graph.py`, `lint_doc_crossrefs.py`, `visualize_domain.py`, plus ingest/audit/backfill helpers and the Verovio spikes |
| `docker/` | Local infra extras (PostgreSQL init scripts) |
| `docs/` | The knowledge home: `adr/`, `architecture/`, `roadmap/`, `reports/`, `handbook/` (this file, the ledger, and `guides/`), `mockups/`, `howto/`, `investigations/`, `seed-drafts/` |
| `.github/workflows/` | CI (`ci.yml`) and keepalive |

**Untracked droppings.** `lib/` and a root-level `<domain>.html` are pyvis output from
`scripts/visualize_domain.py`, which writes its asset tree into the current working
directory; `.gitignore` covers `/lib/`, `backend/lib/` and `/*.html`. They are *not*
vendored libraries. Verovio is an ordinary pinned dependency on both sides — `verovio`
6.1.0 in `frontend/package.json` and in `backend/requirements.txt`, deliberately the same
version, since the backend renders the ADR-008 preview SVGs and the browser renders the
live view.

---

## 3. Tech stack — what and *why*

| Layer | Choice | Why (one line) | Depth |
|---|---|---|---|
| API | FastAPI | Async-native, Pydantic-integrated, free OpenAPI docs | guide 011 |
| Validation | Pydantic v2 | **Hard rule:** nothing reaches any DB without passing a Pydantic model | guide 010 |
| Relational ORM | SQLAlchemy 2 (async, `asyncpg`) + Alembic | Mature async ORM; Alembic = git-for-schema | guide 005 |
| Graph access | `neo4j` driver + `neomodel` | Raw Cypher for traversals; ORM only for routine CRUD | tech-stack ref |
| Music processing | music21 | "Let music21 be the engine": anything it can derive goes in JSON, not the graph | tech-stack ref |
| Score rendering | Verovio **6.1.0, pinned client & server** | MEI → SVG; same version both sides so renders match | ADR-013 |
| MIDI playback | Tone.js + `@tonejs/midi` | Client-side sampled piano playback | ADR-012 |
| Frontend | React 18 + TypeScript + Vite, React Router v6 | SPA; functional components/hooks; `.js` forbidden in `src/` | ADR-010 |
| i18n | i18next / react-i18next (EN + ES) | ESLint plugin bans hardcoded strings | ADR-006 |
| Background work | In-process dispatch by default; Celery+Redis only for bulk-ingest windows | A worker fleet was overkill for current load | ADR-034, ADR-017 |
| Auth | Supabase Auth → JWT; PyJWT verification; HttpOnly refresh cookie | Rent login instead of building it; python-jose dropped for CVEs | ADR-001, ADR-035, ADR-016 |

Guides live in [`guides/`](guides/) beside this file; the authoritative stack document is
`docs/architecture/tech-stack-and-database-reference.md`.

---

## 4. Data: four stores, one concern each

**PostgreSQL 16** — everything relational. Two concerns in one instance:
the corpus/fragment DB and user infrastructure. Core shape:

- Corpus hierarchy: `composer → corpus → work → movement`. Slugs are unique per parent,
  which makes the composed MEI key `{composer}/{corpus}/{work}/{movement}.mei` globally
  unique. `movement` owns the MEI object keys, licensing, and normalization metadata.
- `fragment`: a bar/beat range into a movement plus a JSONB `summary` (key, meter,
  analysis features — GIN-indexed). Chord-level harmonic analysis is *not* on the
  fragment: it lives in `movement_analysis` and is sliced by range at read time.
- `fragment_concept_tag`: the join surface to the graph — `concept_id` strings that match
  Neo4j node ids. No cross-DB foreign keys; the app layer + Pydantic keep integrity.
- `app_user` (roles: user / editor / admin; more tables arrive with Phase 2 components).
- pgvector extension is installed but dormant until Phase 3 (RAG prose layer, 1536-dim).

**Neo4j 5** — the knowledge graph: `Concept`, `PropertySchema`, `PropertyValue` nodes and
typed edges (`IS_SUBTYPE_OF`, `CONTAINS`, `RESOLVES_TO`, `PREREQUISITE_FOR`, …).
Multi-hop Cypher traversals power schema inheritance and prerequisite chains.
Note the boundary: concept→fragment (`APPEARS_IN`) is **not** a Neo4j edge — it's resolved
via the PostgreSQL tag table. Seeding = version-controlled YAML → idempotent Cypher `MERGE`
(`scripts/seed.py`); that *is* the migration strategy for the graph.

**Redis 7** — three hats: cache for graph-structure reads (invalidated on seed — never cache
anything that changes on fragment lifecycle events); Celery broker when bulk-ingest mode is on;
and rate-limit counters (`api/rate_limiting.py`, `RATELIMIT_STORAGE_URI` — Upstash in prod,
`memory://` locally, so dev and tests need no Redis).

**Object storage (S3 API)** — MinIO locally, Cloudflare R2 in production. MEI files
(original + normalized), incipit/preview SVGs — private, fetched via 15-minute presigned
URLs. Soundfonts are the one public-read bucket (Tone.js can't carry signed params).

Schemas and rationale: `tech-stack-and-database-reference.md`, `fragment-schema.md`,
`edge-vocabulary-reference.md`, `knowledge-graph-domain-map.md`.

---

## 5. External services (prod ⇄ local)

Same code everywhere; only environment variables change.

| Concern | Local (Docker Compose) | Production | Notes |
|---|---|---|---|
| Relational + vector DB | `postgres:16` (pgvector image in CI) | Supabase | also the auth provider |
| Knowledge graph | `neo4j:5` (+APOC) | Neo4j AuraDB | Browser at `:7474` locally |
| Cache/broker | `redis:7` | Upstash | serverless, pay-per-use |
| Object storage | MinIO (`:9000`) | Cloudflare R2 | S3-compatible either way |
| Auth | `AUTH_MODE=local` (dev-token bypass) | Supabase Auth JWTs | verified in `api/middleware/auth.py` |
| API hosting | `docker compose up` / venv | Fly.io | stateless container; `fly.toml` |

Deployed reality (env vars, buckets, staging): `docs/deployment.md`. Guide: `guides/009`.

---

## 6. CI — what must pass before code lands

Six jobs in `.github/workflows/ci.yml`, on push and PRs to `main`:

1. **Lint** — black / isort / ruff (backend), doc cross-reference lint, ESLint + stylelint +
   Vitest (frontend). Fast, no services.
2. **E2E** — Playwright drives the built SPA with the backend stubbed per-test.
3. **Audit** — `pip-audit` on backend requirements (**blocking** since the PyJWT
   migration); `npm audit` report-only (dev-tooling noise).
4. **Unit** — pytest with coverage gate (≥60%), plus Verovio render snapshot guards
   (informational tripwire for version bumps, per ADR-013).
5. **Integration** *(needs unit)* — real PostgreSQL + Redis + Neo4j services, MinIO started
   by hand, Alembic migrations, then `pytest -m integration`.
6. **Graph** *(needs unit)* — seed all domains → `validate_graph.py` → graph tests.
   (Seeding also writes translation overlays to PostgreSQL, so this job needs both DBs.)

---

## 7. Rules of the house (recurring design patterns)

These show up everywhere; internalizing them explains most code you'll read:

1. **Pydantic guards every write.** Databases store and serve; validation happens before.
2. **Controlled vocabulary end to end.** Tags are never free text — always graph node ids.
3. **One database per concern**, boundaries enforced in the service layer; nothing queries
   across stores directly.
4. **Separation of rendering and reasoning.** MEI is the notation source of truth; derived
   JSON carries the analysis. Verovio's SVG output is read-only — overlays go on top.
5. **Local parity with production.** Docker Compose mirrors the managed services 1:1.
6. **Idempotent seeding** (`MERGE`, YAML) instead of graph migrations.
7. **Let music21 be the engine** — derivable properties go in JSON, expert knowledge in
   the graph.
8. **Spikes before commitments** — unknowns get a timeboxed throwaway experiment first
   (guide 013); decisions get an ADR.

---

## 8. Decisions: how to navigate the 36 ADRs

Don't memorize them; know the clusters, and read the actual ADR when the topic comes up:

- **Platform choices:** 001 auth (Supabase), 002 file storage, 003 score display mode,
  010 React, 012 Tone.js, 013 Verovio pinning, 006 i18n.
- **Auth/session:** 016 JWT storage → superseded in part by 035 (HttpOnly refresh cookie).
- **Task execution:** 017 Celery/Redis config, 034 in-process default.
- **MEI normalization family** (the deep end): 021/022 accidentals, 026 ties, 027
  corrections overlay, 028 gestural resolution, 029 staff presentation, 030 deterministic
  xml:ids, 031 clefs, 032/033 import repairs, 025 repeats/voltas, 036 movement sections.
- **Graph & tagging model:** 011 multi-level tagging, 019 bool cardinality, 020 cadence
  prerequisite edges, 023 ordering, 005/015 measure coordinates, 024 fragment rendering
  context.
- **Content/licensing:** 009 DCML licensing constraint, 014 original-MEI retention,
  007 prose vectorisation, 008 fragment previews, 004 pipeline trigger, 018 ingestion
  failure recovery.

---

## 9. Where the project stands

- **Phase 1 (components 1–9): done.** Ingested the DCML Mozart piano-sonatas corpus,
  built the tagging tool, seeded the Cadence domain, hardened in Component 9.
- **Phase 2 (agreed 2026-07-15): in progress.** Order: 10 foundations/public read path
  (done — security debt retired July 2026) → **11 Concept Glossary (current)** →
  12 user infrastructure → 13 collections → 14 presentation mode → 15 exercises →
  16 blog/scrollytelling. Track M (editorial repairs) runs in parallel.
- **Phase 3 (AI tutoring): designed-for but not started** — pgvector and user-history
  schemas exist so no migration is needed if/when it happens.

Live sources: `docs/roadmap/phase-2.md`, `phase-2-entry-backlog.md`, per-issue reports
under `docs/reports/`.

---

## 10. Where the depth lives

| Question | Read |
|---|---|
| Why is the system shaped this way? | `architecture/project-architecture.md` |
| What exactly is in each DB? | `architecture/tech-stack-and-database-reference.md`, `architecture/fragment-schema.md` |
| How does auth/security work? | `architecture/security-model.md` |
| What does the graph contain? | `architecture/knowledge-graph-design-reference.md`, `edge-vocabulary-reference.md`, `knowledge-graph-domain-map.md` |
| How does MEI get cleaned up? | `architecture/mei-ingest-normalization.md` + ADR 021–033 |
| How is it deployed? | `deployment.md` |
| Want the plain-language version of a tool or concept? | `handbook/guides/` (18 short explainers; backlog in the ledger) |
| Why was X decided? | `adr/ADR-*.md` (see §8 clusters) |
| What's planned / what broke? | `roadmap/`, `reports/` |
