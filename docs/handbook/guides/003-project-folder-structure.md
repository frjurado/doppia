# Project Folder Structure

## What it is

The Doppia repository is organized into zones, one per concern: the browser interface, the
Python server, the operational scripts, and the documentation. Six directories are tracked
at the root — `backend/`, `frontend/`, `scripts/`, `docker/`, `docs/`, `.github/` — and
everything else up there is a config file.

## What it does

A consistent structure means you can find (or place) code without reading the whole
codebase. It also encodes architectural rules physically: route handlers never touch a
database, the frontend never imports backend code, and end-to-end tests sit outside the
source tree because they test the *built* product rather than the source.

## How it works

```
doppia/
├── frontend/                 # React 18 + TypeScript SPA, built with Vite
│   ├── src/                  # .ts / .tsx only — allowJs is false
│   │   ├── components/       # Reusable UI (auth, browse, score, ui)
│   │   ├── routes/           # One file per page/URL
│   │   ├── hooks/            # Custom React hooks (playback, selection, …)
│   │   ├── services/         # Typed clients for the backend API
│   │   ├── i18n/             # Locale files + the translation setup
│   │   ├── utils/ types/     # Pure helpers and shared type definitions
│   │   └── styles/           # tokens.css + base.css
│   └── e2e/                  # Playwright — a SIBLING of src/, see below
│
├── backend/                  # FastAPI server (Python)
│   ├── api/
│   │   ├── routes/           # Thin HTTP handlers, all prefixed /api/v1/
│   │   ├── middleware/       # auth, cors, errors, security headers
│   │   └── rate_limiting.py  # slowapi, backed by Redis
│   ├── services/             # Business logic; owns all cross-database joins
│   │   └── tasks/            # The jobs Celery can dispatch in bulk mode
│   ├── models/               # SQLAlchemy ORM + Pydantic schemas
│   ├── graph/queries/        # Raw Cypher for Neo4j (see the neomodel note)
│   ├── migrations/           # Alembic — SCHEMA revisions
│   ├── data_migrations/      # One-off DATA backfills — not Alembic's business
│   ├── seed/                 # YAML that populates the knowledge graph
│   ├── scripts/              # Two dev-only helpers (dev users, MEI backfill)
│   ├── resources/            # mei-CMN.rng, the MEI validation schema
│   ├── errors.py             # The exception hierarchy
│   └── tests/                # unit / integration / graph / snapshots + fixtures
│
├── scripts/                  # Repo-root CLI utilities — the ones you actually run
│                             # seed.py, validate_graph.py, lint_doc_crossrefs.py,
│                             # visualize_domain.py, ingest/audit/backfill, spikes
├── docker/                   # Local infra extras (PostgreSQL init scripts)
├── .github/workflows/        # ci.yml and keepalive.yml
│
└── docs/
    ├── adr/                  # Architecture Decision Records — the "why"
    ├── architecture/         # Design and data-model specifications
    ├── roadmap/              # Phase and component plans
    ├── reports/              # Per-issue reports; the working backlog
    ├── handbook/             # handbook.md, ledger.md, guides/ (you are here)
    ├── mockups/              # UI design references and the design system
    ├── howto/                # Operational recipes (e.g. soundfont setup)
    ├── investigations/       # One-off deep dives into specific problems
    └── seed-drafts/          # Domain content drafted before it is seeded
```

### Four distinctions worth holding on to

**`migrations/` vs `data_migrations/`.** Alembic owns `backend/migrations/versions/` and
records in the database which revisions have run: tables, columns, indexes, applied
automatically and in order. `backend/data_migrations/` is a folder of hand-run scripts that
repair *data* on an unchanged schema (`renumber_movement_bars.py`,
`backfill_harmony_mc.py`, …). Nothing tracks whether they have run — that is the price of
keeping slow one-off data surgery out of the automatic migration path.

**`scripts/` (root) vs `backend/scripts/`.** The root folder holds the utilities that are
part of the workflow: seeding the graph, validating it, visualising a domain, linting the
docs. `backend/scripts/` holds two narrow dev helpers. When a document says "run the seed
script", it means `python scripts/seed.py` from the repository root.

**`e2e/` is outside `src/` on purpose.** `tsconfig.app.json` has `"include": ["src"]`, and
`vite.config.ts` scopes Vitest to `src/**/*.{test,spec}.{ts,tsx}` precisely so that Vitest's
default `**/*.spec.ts` glob does not try to execute the Playwright specs — they import
`@playwright/test` and fail under the Vitest runner. The deeper reason: Playwright runs
against a `vite preview` of the production build on port 4173, with the API stubbed per
test. It is a black-box client of the built bundle, so it does not belong inside the source
it tests. (Unit tests live in `src/**/__tests__/` because they import your modules.)

**Root `lib/` is not a library folder.** `scripts/visualize_domain.py` uses pyvis, which
writes `<domain>.html` plus a `lib/` asset tree (`bindings/`, `tom-select/`, `vis-9.1.2/`)
into the current working directory. CLAUDE.md has you run it from the repo root after every
YAML change, so `lib/` and a stray `cadences.html` accumulate there; `.gitignore` covers
`/lib/`, `backend/lib/` and `/*.html`. Verovio is an ordinary pinned dependency, 6.1.0 in
both `frontend/package.json` and `backend/requirements.txt` — the same version on both
sides, because the backend renders the ADR-008 static preview SVGs and the browser renders
the live view.

### The rules the layout encodes

- `frontend/` and `backend/` never import from each other; they talk over HTTP.
- Inside the backend, data flows downward: `api/ → services/ → models/` and
  `graph/queries/`. Route handlers hold no business logic and touch no database.
- `services/` is the only place a PostgreSQL read and a Neo4j read meet.
- `docs/` lives in the repository so CI can hold it to the code: `ci.yml` runs
  `scripts/lint_doc_crossrefs.py`, which fails the build if any Markdown file references a
  repo path that does not exist. Note what that does *not* check — whether the description
  next to the path is still true.

### Known drift

`backend/graph/` is documented as having two halves — raw Cypher in `queries/` and neomodel
ORM classes in `neomodel/` — and CLAUDE.md, the handbook, the tech-stack reference, the
knowledge-graph design reference and the security model all describe the ORM half. In the
working tree `backend/graph/neomodel/` is empty and no first-party code imports neomodel;
all graph access is raw Cypher. Treat the ORM rule as aspirational until that is either
built or retired.
