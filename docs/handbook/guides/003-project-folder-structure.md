# Project Folder Structure

## What it is

The Doppia repository is organized into clearly separated zones — one for each major concern: the browser-based interface, the Python server, the music data, and the project documentation.

## What it does

Having a consistent folder structure means every contributor knows exactly where to look (or add) code without reading the whole codebase. It also enforces the architectural rule that different parts of the system stay separated — for example, route handlers never touch the database directly, and the frontend never imports backend code.

## How it works

Think of the repo as a building with distinct floors:

```
doppia/
├── frontend/        # The "lobby" — React/TypeScript UI served to the browser
│   └── src/
│       ├── components/   # Reusable UI pieces (buttons, score viewer, etc.)
│       ├── routes/       # One file per page/URL
│       ├── services/     # Calls to the backend API
│       └── types/        # TypeScript type definitions
│
├── backend/         # The "engine room" — Python/FastAPI server
│   ├── api/         # Thin HTTP route handlers (no business logic here)
│   ├── services/    # Business logic; the only place cross-DB joins happen
│   ├── models/      # Pydantic validators + SQLAlchemy ORM definitions
│   ├── graph/       # Everything Neo4j: raw Cypher queries + neomodel classes
│   ├── seed/        # YAML files that populate the knowledge graph
│   ├── migrations/  # Database schema change scripts
│   └── tests/       # Unit, integration, graph, and snapshot tests
│
├── scripts/         # One-off CLI utilities (seed, validate, visualize)
├── docker/          # Dockerfiles and init scripts for local services
│
└── docs/            # Human-readable documentation
    ├── architecture/ # Design decisions and data-model specs
    ├── adr/          # Architecture Decision Records (the "why" behind choices)
    ├── mockups/      # UI design references and design system
    ├── roadmap/      # Phase plans
    └── handbook/     # Handbook, ledger, and plain-language guides (you are here)
```

The key discipline: `frontend/` and `backend/` never import from each other — they communicate only through HTTP. Inside the backend, data flows downward through `api/ → services/ → models/graph/`, never sideways or upward.
