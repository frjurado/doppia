# Knowledge Ledger

The active half of the handbook. This file tracks what Francisco has *actually reviewed* and
how well it stuck, so study sessions can pick topics spaced-repetition style instead of
re-reading the same comfortable material.

## How a study session works (protocol for Claude)

1. Read this ledger and [`handbook.md`](handbook.md).
2. Pick **one topic**: lowest confidence first; among ties, the stalest `Last session`.
   Francisco can always override the pick.
3. Run the session (~20–30 min), drawing questions from the **real repo**, not generic
   trivia. Mix these modes:
   - **Retrieval:** "Walk me through what happens between X and Y" — answered from memory
     first, then checked against the actual code/docs.
   - **Teach-back:** Francisco explains the topic in his own words; Claude probes the gaps.
   - **Code-walk:** open the file(s) that implement the topic and read them together.
   - **Prediction:** show a real snippet (a migration, a Cypher query, a CI job) and ask
     what it does before running/explaining it.
4. Close the session: update `Conf` (0–3), set `Last session` to today's date, and note in
   `Notes` what specifically didn't stick — next session on this topic starts there.
5. **Capture (the closing move):** if the topic has no guide in [`guides/`](guides/), or its
   guide proved stale, write or refresh one *now* — Claude drafts it from the session's
   corrected understanding, Francisco reviews it (which is itself one more retrieval pass).
   New guides continue the numbering (next free: 020). If there's no time, add the idea to
   the **Guide backlog** below instead. Concepts that surfaced mid-session without a guide
   also go to the backlog.
6. If the session revealed the handbook is wrong or stale, fix `handbook.md` too.

**Confidence scale:** 0 = not reviewed · 1 = read about it · 2 = can explain it unaided ·
3 = can explain it *and* navigate/modify the code that implements it.

**Adding topics:** when a component closes or a new ADR lands, add rows for whatever new
tech or design it introduced (this is part of the component-close digest) — and add guide
ideas for any new tech to the backlog below.

---

## Topics

### Architecture & structure

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| The system map: layers and how data flows | handbook §1; project-architecture.md; guide 019 | 2 | 2026-08-26 | Read path was the gap: assumed server-side Verovio slicing (it is a presigned URL + client-side render). Also: tags live in the `fragment_concept_tag` join table, not a fragment column; and cross-DB integrity is a live Neo4j check in `services/fragment_validation.py`, not Pydantic. Redis and the translation overlay were absent from the recalled map. Next time start at the write path (submission → validation → preview task). |
| Repo layout: what lives where and why | handbook §2 | 0 | — | |
| ADR workflow and the decision clusters | handbook §8 | 0 | — | |

### Backend

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| FastAPI: lifecycle of one request (route → service → DB → response) | `backend/api/`, `backend/main.py` | 0 | — | |
| Pydantic and the write-time validation rule | guide 010; models in `backend/models/` | 0 | — | |
| SQLAlchemy async + Alembic: how a schema change ships | guide 005; `backend/migrations/` | 0 | — | |
| Task dispatch: in-process default vs Celery bulk mode | ADR-034, ADR-017; `services/task_dispatch.py` | 0 | — | |
| Error handling conventions | `backend/errors.py`; architecture/error-handling.md | 0 | — | |

### Data stores

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| PostgreSQL corpus schema: composer→corpus→work→movement | handbook §4; tech-stack ref | 0 | — | |
| Fragment table, JSONB summary, and the tag join to Neo4j | fragment-schema.md | 0 | — | |
| Neo4j model: node types, edge vocabulary, what is *not* in the graph | edge-vocabulary-reference.md | 0 | — | |
| Cypher: reading the three key traversal patterns | tech-stack ref §Neo4j | 0 | — | |
| Graph seeding: YAML → MERGE, why it replaces migrations | `backend/seed/`, `scripts/seed.py` | 0 | — | |
| Redis: the cache-boundary rule and what went wrong without it | tech-stack ref §Redis; `services/cache.py` | 0 | — | |
| Object storage: key conventions, presigned URLs, the public soundfont exception | tech-stack ref §4; security-model.md §4 | 0 | — | |

### Frontend

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| React + TypeScript + Vite: how the SPA is built and served | guide 015; `frontend/vite.config.ts` | 0 | — | |
| Verovio in the browser: MEI → SVG, and the overlay pattern | guide 012; ADR-013 | 0 | — | |
| MIDI playback path: fragment → Tone.js → sound | ADR-012; playback-coordinates.md | 0 | — | |
| i18n: how a string gets translated, and what ESLint enforces | ADR-006 | 0 | — | |

### External services & deployment

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| Auth end to end: Supabase JWT, middleware, HttpOnly refresh cookie | ADR-001, ADR-035; `api/middleware/auth.py` | 0 | — | |
| The local⇄prod service mapping and env-var pattern | handbook §5; deployment.md | 0 | — | |
| Fly.io: what a deploy actually does | deployment.md; `fly.toml` | 0 | — | |

### CI & quality

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| The six CI jobs: what gates what, and why audit/npm differ | handbook §6; `.github/workflows/ci.yml` | 0 | — | |
| Test types: unit / integration / graph / snapshot / e2e, and their fixtures | guide 006; `backend/tests/` | 0 | — | |
| Linters and formatters across both stacks | guides 002, 017 | 0 | — | |

### Domain modelling (the design, not the music theory)

| Topic | Start from | Conf | Last session | Notes |
|---|---|---|---|---|
| MEI normalization pipeline: what gets fixed and why | mei-ingest-normalization.md; ADR-021…033 | 0 | — | |
| Measure coordinates: dual system, sub-measure precision | ADR-015, ADR-005 | 0 | — | |
| Security model: roles, CORS, rate limits, signed URLs | security-model.md | 0 | — | |
| Licensing constraints shaping the corpus (DCML) | ADR-009; corpus-and-analysis-sources.md | 0 | — | |

---

## Guide backlog

Guides waiting to be written (in [`guides/`](guides/), numbered from 019). Preferred
workflow: a guide gets written as the closing move of the study session that covered its
topic — drafted by Claude from the corrected understanding, reviewed by Francisco. Cold
drafting is the fallback, not the default.

| Guide idea | Why / where it bites | Written? |
|---|---|---|
| Cypher & querying Neo4j | Every graph feature; the three key traversals | — |
| SQLAlchemy async patterns (engine, sessions, asyncpg) | All relational access | — |
| Auth end to end: Supabase JWT, PyJWT, HttpOnly cookies | ADR-001/016/035; `api/middleware/auth.py` | — |
| Presigned URLs & S3-compatible object storage | MinIO/R2, MEI + preview fetching | — |
| JSONB & GIN indexes | The fragment `summary` column | — |
| React hooks (state, effects, custom hooks) | All frontend components | — |
| React Router: how navigation works in the SPA | Route config, params | — |
| Vite & the dev proxy | Why `/api` works locally; build vs dev | — |
| Tone.js & Web Audio | MIDI playback path, soundfonts | — |
| WebAssembly: why Verovio runs in the browser | Rendering; CSP `worker-src blob:` | — |
| Playwright & e2e testing vs Vitest | CI job 1a; stubbed-backend pattern | — |
| GitHub Actions anatomy (jobs, services, caching) | Reading/modifying `ci.yml` | — |
| Redis caching patterns & invalidation | The cache-boundary rule; `services/cache.py` | — |
| Rate limiting with slowapi | Redis' third hat; `api/rate_limiting.py`, security-model §2 | — |
| The translation overlay (Neo4j English + PostgreSQL locales) | ADR-006 §3; `services/translation.py`; es data lands at Step 26 | — |
| pgvector, embeddings & RAG *(park until Phase 3)* | Dormant `prose_chunk` table | — |
