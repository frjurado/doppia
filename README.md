# Doppia — Open Music Analysis Repository

An open repository of curated musical scores, annotated fragments, and a semantically rich knowledge graph. The system centres on a Verovio-based score viewer and expert tagging tool that links musical fragments to a structured concept graph — infrastructure that delivers standalone value for editorial work, publication, and student practice, and that is deliberately designed to remain useful regardless of whether an AI reasoning layer is ever added.

The project is currently in **Phase 1**: building the notation infrastructure, knowledge graph, and editorial tagging tools that every later phase depends on. There is no public-facing product yet. The deliverable of Phase 1 is a working tagging environment and a populated, queryable fragment database.

See `docs/architecture/project-architecture.md` for the full system overview and `docs/roadmap/phase-1.md` for the current build plan.

---

## Prerequisites

- Docker and Docker Compose
- Node.js 20+
- Python 3.12+
- A Cloudflare R2 bucket (or any S3-compatible store) for MEI file storage — use MinIO locally via Docker Compose
- A Supabase project (for auth) — or use the local Docker stack without Supabase Auth during development (see below)

---

## Local setup

### 1. Clone and configure

```bash
git clone <repo-url>
cd doppia
cp .env.example .env
```

Open `.env` and fill in the required values. Every variable has a comment explaining what it is and where to get it. The only values that require external services in local development are `OPENAI_API_KEY` (for embedding generation — not needed until Phase 3) and Supabase credentials (substitutable with a local auth stub — see below).

### 2. Start the full stack

```bash
docker compose up
```

This starts:
- **Neo4j** on `localhost:7687` (browser at `localhost:7474`)
- **PostgreSQL 16** on `localhost:5432` (with pgvector enabled)
- **MinIO** on `localhost:9000` (console at `localhost:9001`)
- **Redis** on `localhost:6379`
- **FastAPI backend** on `localhost:8000` (OpenAPI docs at `localhost:8000/api/docs`)
- **Frontend dev server** on `localhost:3000`

On first run, the database init scripts create the PostgreSQL schema and enable pgvector. Neo4j starts empty; seed the knowledge graph separately (see step 4).

### 3. Install backend dependencies

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 4. Seed the knowledge graph

```bash
python scripts/seed.py --domain cadences
python scripts/validate_graph.py
```

The seed script uses Cypher `MERGE` statements and is idempotent — safe to re-run at any time. `validate_graph.py` checks structural invariants (no orphaned nodes, no broken cross-references, unique `CONTAINS` order values) and exits non-zero if anything fails. Run it after every change to YAML seed files.

### 5. Install frontend dependencies

```bash
cd frontend
npm install
```

The frontend dev server starts automatically with `docker compose up`. You can also run it outside Docker:

```bash
npm run dev
```

---

## Development without external auth

During local development, Supabase Auth can be bypassed. Set `AUTH_MODE=local` in `.env` and the backend will accept a fixed development token (`Bearer dev-token`) on all authenticated endpoints. This is enforced only when `ENVIRONMENT=development`; it is inert in staging and production.

Do not use development auth mode in any environment that handles real data.

---

## Running tests

```bash
# From the backend directory, with the Docker stack running
pytest

# Graph structure tests only (fast; no Docker required if Neo4j is running)
pytest tests/graph/

# With coverage
pytest --cov=backend --cov-report=term-missing
```

The test suite requires a running Neo4j and PostgreSQL instance. The Docker stack satisfies this. CI runs tests against the same Docker Compose configuration.

To run the Verovio rendering snapshot tests:

```bash
pytest tests/snapshots/ --update-snapshots  # regenerate baseline
pytest tests/snapshots/                     # assert against baseline
```

Snapshot tests pin a specific Verovio version. If Verovio is upgraded, regenerate snapshots and commit the new baselines alongside the version bump.

---

## Project layout

```
/
├── backend/
│   ├── api/            Route handlers (all prefixed /api/v1/)
│   ├── services/       Business logic; the layer that owns cross-database joins
│   ├── models/         Pydantic models and SQLAlchemy ORM definitions
│   ├── graph/
│   │   ├── queries/    Raw Cypher query functions (neo4j driver)
│   │   └── neomodel/   neomodel class definitions (routine CRUD only)
│   └── seed/           YAML seed files (seeding script is scripts/seed.py)
│
├── frontend/
│   ├── components/     Verovio renderer, MIDI player, tagging UI, browsing UI
│   └── services/       API client, graph query client
│
├── scripts/
│   ├── seed.py         Knowledge graph seeding (idempotent)
│   ├── validate_graph.py   Post-seed structural validation
│   ├── visualize_domain.py Pyvis HTML export for dev-time graph inspection
│   └── migrations/     Summary JSONB version migration scripts
│
├── docker/             Dockerfile and Docker Compose service configs
│
├── output/             Pyvis dev-time graph exports (gitignored; produced by scripts/visualize_domain.py)
│
└── docs/
    ├── architecture/   System design documents and setup guides (including bloom-setup.md)
    ├── roadmap/        Phase build plans (checked off as work completes)
    ├── adr/            Architecture Decision Records
    ├── mockups/
    │   └── opus_urtext/
    │       └── DESIGN.md   Design system: colour tokens, typography, component rules
    └── deployment.md   Staging and production deployment procedure
```

---

## Key operational links

| Service | Local URL | Purpose |
|---|---|---|
| FastAPI | `localhost:8000/api/docs` | OpenAPI documentation and interactive API explorer |
| Neo4j Browser | `localhost:7474` | Graph inspection and ad-hoc Cypher queries |
| MinIO Console | `localhost:9001` | MEI file storage (S3-compatible) |
| Frontend | `localhost:3000` | Score viewer and tagging tool |

Default local credentials are in `.env.example`. Do not use them outside of local development.

---

## Documentation map

| Document | What it covers |
|---|---|
| `docs/architecture/project-architecture.md` | Full system overview, component relationships, design principles |
| `docs/architecture/knowledge-graph-design-reference.md` | Three-layer graph design (concept nodes, PropertySchema, PropertyValue), modelling decision rules, and Cypher examples |
| `docs/architecture/knowledge-graph-domain-map.md` | Confirmed domains, areas under exploration, and explicitly excluded domains — the design boundary for the knowledge graph's scope |
| `docs/architecture/edge-vocabulary-reference.md` | Authoritative edge type vocabulary for the knowledge graph: active types, retired types with rationale, and conventions |
| `docs/architecture/fragment-schema.md` | Fragment table definitions and the `summary` JSONB schema specification |
| `docs/architecture/corpus-and-analysis-sources.md` | Score source priority order (OpenScore, DCML, KernScores), analysis source priority (DCML TSV, When in Rome, music21 auto), DCML normalisation spec, and Mozart piano sonatas first-case detail |
| `docs/architecture/tech-stack-and-database-reference.md` | Database inventory, query patterns, tool choices, Docker Compose topology |
| `docs/roadmap/phase-1.md` | Phase 1 component breakdown, build order, and open decisions |
| `docs/adr/` | Architecture Decision Records for all non-obvious decisions |
| `docs/mockups/opus_urtext/DESIGN.md` | Design system: colour palette, typography, spacing, component rules, and the "Living Score" visual language that governs all frontend work |
| `docs/architecture/security-model.md` | CORS policy, rate limiting, input sanitisation, signed URL lifecycle, and the development auth bypass |
| `docs/deployment.md` | Staging and production deployment procedure, environment variables, rollback, and monitoring |
| `CONTRIBUTING.md` | Code conventions, testing strategy, API conventions, branching and commit policy |

---

## Contributing

Read `CONTRIBUTING.md` before writing any code. It contains the conventions, testing strategy, and branching policy that keep the codebase consistent across contributors.
