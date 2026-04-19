# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Doppia is an open music analysis repository: a curated corpus of musical scores (MEI format) annotated with fragments, linked to a semantically rich knowledge graph in Neo4j. The system is currently in **Phase 1** — building the notation infrastructure, knowledge graph, and editorial tagging tools. No public-facing product exists yet.

## Commands

### Start infrastructure (hybrid dev — recommended)
```bash
docker compose up   # neo4j, postgres, redis, minio only
```

Then in separate terminals:
```bash
# API
cd backend && source .venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# Frontend
cd frontend && npm run dev
```

### Start full stack in Docker (CI / staging preview)
```bash
docker compose --profile app up
```

### Backend setup
```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt   # local dev (includes all prod deps)
# pip install -r requirements.txt     # production / Docker only
```

### Knowledge graph seeding and validation
```bash
python scripts/seed.py --domain cadences
python scripts/validate_graph.py           # run after every change to YAML seed files
python scripts/visualize_domain.py --domain <name>  # pyvis HTML for visual inspection
```

### Frontend
```bash
cd frontend
npm install
npm run dev         # outside Docker
npm run format      # Prettier
npm run lint        # ESLint
```

### Python formatting and linting
```bash
black backend/
isort backend/
ruff check backend/
```

### Tests
```bash
pytest                                          # all tests (requires Docker stack running)
pytest tests/unit/                              # fast; no Docker required
pytest tests/integration/                       # requires live Neo4j + PostgreSQL
pytest tests/graph/                             # graph structure validation
pytest tests/snapshots/                         # Verovio rendering snapshots
pytest tests/snapshots/ --update-snapshots      # regenerate baselines after Verovio upgrade
pytest --cov=backend --cov-report=term-missing  # with coverage
```

## Architecture

### Data flow
```
MEI Corpus → Verovio Tagging Interface → Fragment DB (PostgreSQL)
                                              ↕ concept tags
                                         Knowledge Graph (Neo4j)
```

The service layer in `backend/services/` owns all cross-database joins. No route handler touches a database directly. No repository crosses the PostgreSQL/Neo4j boundary.

### Database roles
- **Neo4j** — knowledge graph: concept nodes, typed relationships, PropertySchema/PropertyValue nodes. Used for multi-hop traversal (schema inheritance, prerequisite chains, exercise distractor queries).
- **PostgreSQL** — fragment database + user infrastructure. Stores MEI pointers, structured `summary` JSONB, `fragment_concept_tag` (the join surface to Neo4j), and all user/collection/exercise tables.
- **pgvector** (in PostgreSQL) — prose embedding layer; activated in Phase 3.
- **Redis** — caching and sessions; not required in Phase 1.

### Neo4j driver usage rule
- `neo4j` driver (raw Cypher) → all traversal queries → `backend/graph/queries/`
- `neomodel` ORM → routine CRUD on concept/schema nodes → `backend/graph/neomodel/`
- Never use neomodel for multi-hop traversal.

### Backend layers
- `backend/api/` — thin route handlers; no business logic; all routes prefixed `/api/v1/`
- `backend/services/` — business logic; owns cross-database joins
- `backend/models/` — Pydantic models and SQLAlchemy ORM
- `backend/graph/queries/` — named raw Cypher functions with typed parameters/returns
- `backend/graph/neomodel/` — neomodel class definitions
- `backend/seed/` — YAML seed files (seeded via `scripts/seed.py`)

### Frontend
React 18 + TypeScript + Vite + React Router v6. All `.js` files are forbidden in the source tree.

**Verovio SVG overlay rule:** Never modify Verovio's SVG output directly. All overlays (selection brackets, playback indicators) are absolutely-positioned HTML elements layered above the SVG container with `pointer-events: none`. Verovio re-renders can discard SVG changes at any time.

**MIDI playback:** Use `getElementsAtTime()` for mapping MIDI ticks to SVG elements — do not compute note positions from SVG geometry independently.

## Key Conventions

### Invariants (never violate)
- **Concept `id` values are immutable** once seeded — they are the join key between PostgreSQL `fragment_concept_tag.concept_id` and Neo4j `Concept.id`. Rename by changing `name`, never `id`.
- **`summary` JSONB is versioned** — increment `version` and write a migration script before any field name/type/structure change. See `docs/architecture/fragment-schema.md`.
- **`require_role()` is the only permitted role enforcement mechanism** — no inline role checks in route handlers or service functions.
- **Pydantic validates before every database write** — no payload reaches any database without passing through a Pydantic model.
- **Seed scripts use `MERGE`, never `CREATE`** — bare `CREATE` in a seed script is a bug.
- **MEI files are stored by S3 object key** (e.g. `mozart-piano-sonatas/k331/movement-1.mei`), never absolute path or URL. Signed URLs are resolved at request time.

### Python
- All function signatures must have complete type hints; use `from __future__ import annotations`.
- Route handlers are always `async def`; service functions that touch any DB are `async def`; pure computation is `def`.
- Google-style docstrings on all public functions, classes, and modules.
- Relationship type strings are constants in `backend/graph/queries/relationships.py` — no magic strings in application code.
- Record `music21.__version__` in `summary.music21_version` for every music21-derived field stored in `summary` JSONB.

### API
- All list endpoints use cursor-based pagination — no offset pagination.
- Error responses always use the envelope: `{"error": {"code": "SCREAMING_SNAKE", "message": "...", "detail": {}}}`. Codes defined as enums in `backend/models/errors.py`.

### Frontend design system
Before writing any UI code, read `docs/mockups/opus_urtext/DESIGN.md`. Key constraints: Henle Blue `#3f5f77`, Urtext Cream `#fbf9f0`, Newsreader for display/body, Public Sans for labels, **0px border-radius everywhere**, no 1px solid dividers, depth through tonal layering only. Deviating without a documented reason is treated as a style violation.

### Commits
Conventional Commits with a project-specific `seed:` type for knowledge graph YAML changes:
- `feat:`, `fix:`, `seed:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`
- `seed:` commits must include the domain in scope: `seed(cadences):`, `seed(sequences):`, etc.

### Branching
- `master` is always deployable to staging and must pass CI (tests + linting + graph validation).
- Feature branches: `feature/{short-description}`; fix branches: `fix/{short-description}`.

## Important Documentation
| Document | Purpose |
|---|---|
| `docs/architecture/knowledge-graph-design-reference.md` | Three-layer graph design, modelling decision rules, Cypher examples |
| `docs/architecture/edge-vocabulary-reference.md` | Authoritative edge type vocabulary — check before adding new edges |
| `docs/architecture/fragment-schema.md` | `summary` JSONB field-by-field spec and versioning policy |
| `docs/architecture/knowledge-graph-domain-map.md` | Confirmed domains, areas under exploration, and explicitly excluded scope |
| `docs/architecture/error-handling.md` | Exception hierarchy, error propagation, cross-database failure cases |
| `docs/architecture/security-model.md` | CORS policy, rate limiting, signed URL lifecycle, dev auth bypass |
| `docs/mockups/opus_urtext/DESIGN.md` | Authoritative design system for all frontend work |
| `docs/adr/` | Architecture Decision Records for all non-obvious decisions |
| `CONTRIBUTING.md` | Full coding conventions, testing strategy, and branching policy |
