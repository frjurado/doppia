# Contributing

This document covers everything a contributor needs before writing code: conventions for Python, Cypher, and JavaScript; the testing strategy; API design rules; and the branching and commit policy.

Read this document once before your first contribution. The conventions here are not optional preferences — they are the shared contract that makes the codebase consistent and maintainable as the project grows.

---

## Table of contents

1. [Python conventions](#1-python-conventions)
2. [Cypher conventions](#2-cypher-conventions)
3. [JavaScript / TypeScript conventions](#3-javascript--typescript-conventions)
4. [Testing strategy](#4-testing-strategy)
5. [API conventions](#5-api-conventions)
6. [Invariants that must never be violated](#6-invariants-that-must-never-be-violated)
7. [Branching policy](#7-branching-policy)
8. [Commit conventions](#8-commit-conventions)
9. [Adding a new knowledge graph domain](#9-adding-a-new-knowledge-graph-domain)

See also: **[`docs/architecture/error-handling.md`](docs/architecture/error-handling.md)** — the full error propagation strategy, exception class hierarchy, and the cross-database failure case (what happens when Neo4j is down during Pydantic validation).

---

## 1. Python conventions

### Formatting and linting

All Python code is formatted with **Black** (line length 88) and imports sorted with **isort** (Black-compatible profile). Both run automatically in CI; pull requests with unformatted code will not be merged.

```bash
black backend/
isort backend/
```

Use **Ruff** for linting:

```bash
ruff check backend/
```

The configuration for all three tools is in `pyproject.toml`. Do not adjust the configuration without a discussion; style debates are resolved by the existing configuration, not by opening a PR that changes it.

### Type hints

All function signatures must have complete type hints — parameters and return types. Use `from __future__ import annotations` at the top of every module to enable forward references cleanly.

```python
from __future__ import annotations

async def get_fragment(fragment_id: UUID) -> Fragment | None:
    ...
```

If a type is genuinely unknowable (rare), annotate it as `Any` and leave a comment explaining why. Do not use `Any` as a shortcut.

### Async conventions

The FastAPI application is fully async. Follow these rules:

- Route handlers are always `async def`.
- Service layer functions that touch any database (Neo4j, PostgreSQL, Redis) are `async def`.
- Pure computation (data transformation, validation logic) can be `def`. Do not add `async` where there is no I/O.
- Do not mix sync and async database calls in the same function. If you need both, refactor into two functions.
- Use `asyncpg` for PostgreSQL, the official `neo4j` async driver for traversal queries, and `neomodel`'s async interface for ORM operations.

### Docstrings

Every public function, class, and module gets a docstring. One-liners are fine for simple functions. For anything non-trivial, use the Google docstring style:

```python
async def get_fragment_by_concept(
    concept_id: str,
    status: FragmentStatus = FragmentStatus.APPROVED,
) -> list[Fragment]:
    """Return all fragments tagged with the given concept.

    Args:
        concept_id: The knowledge graph concept id (e.g. "PerfectAuthenticCadence").
        status: Filter to fragments at this review status. Defaults to approved.

    Returns:
        A list of Fragment records, ordered by created_at descending.

    Raises:
        ConceptNotFoundError: If concept_id does not exist in the knowledge graph.
    """
```

Private helper functions (prefixed `_`) do not require docstrings, but a one-liner is encouraged.

### Service layer discipline

Route handlers are thin. They parse the request, call one service function, and return the result. Business logic lives in the service layer, not in route handlers.

The service layer owns all cross-database joins. The two-step pattern for fragment queries that span Neo4j and PostgreSQL is canonical:

```python
# services/fragment_service.py
async def get_fragments_by_concept(
    concept_id: str,
    include_subtypes: bool,
    status: FragmentStatus,
) -> list[Fragment]:
    if include_subtypes:
        concept_ids = await graph_service.get_subtypes(concept_id)
    else:
        concept_ids = [concept_id]
    return await fragment_repo.get_by_concept_ids(concept_ids, status)
```

No route handler touches a database directly. No repository crosses the PostgreSQL/Neo4j boundary.

### Pydantic as the write-time gatekeeper

Every data payload entering any database passes through a Pydantic model. This is not optional. The sequence is always: request body → Pydantic validation → service layer → database write. If validation fails, the write never happens.

Pydantic models that validate against the knowledge graph (e.g. checking that a `concept_id` exists before writing a tag) should do so by calling the graph service from within the `@model_validator`. Document this clearly in the model so readers understand the validator has a dependency.

### Neo4j driver vs. neomodel

Use them for different things and do not mix them:

- **`neo4j` driver (raw Cypher):** all traversal queries — schema inheritance, prerequisite chains, subtype trees, neighbourhood queries. Write these as named functions in `backend/graph/queries/`, each taking typed parameters and returning typed Python objects.
- **`neomodel` ORM:** routine CRUD on concept and schema nodes — creating a concept, fetching a node by id, updating a prose definition. Use the neomodel class definitions in `backend/graph/neomodel/`.

If you find yourself writing a traversal query using neomodel's relationship traversal, stop — write raw Cypher instead. neomodel's traversal API obscures what is happening and produces inefficient queries for multi-hop patterns.

### music21 version recording

Every call to music21 that produces data stored in the `summary` JSONB must record the music21 version used. The version is available as `music21.__version__`. Store it in `summary.music21_version`. This allows records generated by older versions to be identified after a library upgrade.

---

## 2. Cypher conventions

### Style

- Keywords in **uppercase**: `MATCH`, `WHERE`, `RETURN`, `CREATE`, `MERGE`, `WITH`, `OPTIONAL MATCH`.
- Parameters in **snake_case** prefixed with `$`: `$concept_id`, `$fragment_id`.
- Node aliases in **camelCase**: `(c:Concept)`, `(s:PropertySchema)`, `(v:PropertyValue)`.
- Relationship types in **UPPER_SNAKE_CASE** (as they appear in the graph): `IS_SUBTYPE_OF`, `HAS_PROPERTY_SCHEMA`.
- One clause per line for any query longer than two clauses.

```cypher
MATCH (c:Concept {id: $concept_id})
      -[:IS_SUBTYPE_OF*0..]->(ancestor:Concept)
      -[:HAS_PROPERTY_SCHEMA]->(s:PropertySchema)
      -[:HAS_VALUE]->(v:PropertyValue)
OPTIONAL MATCH (v)-[:VALUE_REFERENCES]->(ref:Concept)
RETURN s.id AS schema_id,
       s.cardinality AS cardinality,
       s.required AS required,
       collect(v.id) AS value_ids,
       collect(ref.id) AS referenced_concept_ids
```

### MERGE, not CREATE

All seed scripts use `MERGE` rather than `CREATE`. This makes re-running the seed safe — nodes are created if absent, left alone if present. Never use bare `CREATE` in a seed script.

### No magic relationship type strings in application code

Relationship types are defined as constants in `backend/graph/queries/relationships.py`, not as bare strings scattered across query functions:

```python
# relationships.py
IS_SUBTYPE_OF = "IS_SUBTYPE_OF"
CONTAINS = "CONTAINS"
HAS_PROPERTY_SCHEMA = "HAS_PROPERTY_SCHEMA"
```

Use these constants when building Cypher strings programmatically. Hardcoded relationship strings in query functions are permitted only in static query strings (where they are visually obvious).

### Validate after every seed

After any change to YAML seed files, run:

```bash
python scripts/validate_graph.py
```

This script is the test suite for graph structure. CI runs it on every commit that touches `backend/seed/`. Do not merge YAML changes without a passing validation run.

---

## 3. JavaScript / TypeScript conventions

The frontend is **React 18** with **TypeScript**, built with **Vite**, and navigated with **React Router v6**. This decision is recorded in [ADR-010](docs/adr/ADR-010-frontend-framework.md). All frontend code is TypeScript; plain `.js` files are not permitted in the frontend source tree.

Before writing any UI code, read **[`docs/mockups/opus_urtext/DESIGN.md`](docs/mockups/opus_urtext/DESIGN.md)**. It is the authoritative design system for this project and defines the colour palette (Henle Blue `#3f5f77`, Urtext Cream `#fbf9f0`), typography (Newsreader for display/body, Public Sans for labels), spacing tokens, surface hierarchy, and component rules. Key constraints: 0px border-radius everywhere, no 1px solid dividers, depth through tonal layering only. Deviating from the design system without a documented reason is treated the same as a style violation.

### Formatting

**Prettier** with the project configuration (`.prettierrc`) handles all formatting. **ESLint** handles linting. Both run in CI.

```bash
npm run format
npm run lint
```

### Component patterns

- Functional components only; no class components.
- Hooks for all state and side effects.
- One component per file. File name matches the component name (PascalCase).
- Props are typed with TypeScript interfaces defined in the same file as the component, or in a co-located `types.ts` if shared.
- No unexcused `any`. If a type is genuinely unknowable, annotate it as `any` and leave a comment explaining why.

### Verovio and the SVG overlay rule

Verovio renders to SVG. **Never modify Verovio's SVG output directly.** All overlays — fragment selection brackets, playback position indicators, fragment bracket labels — are rendered as absolutely-positioned HTML elements layered above the SVG container, not as modifications to the SVG itself.

This rule exists because Verovio can re-render at any time (on scale change, on navigation), which would discard any SVG modifications. The overlay layer is independent of the render cycle.

The overlay element must have `pointer-events: none` by default; interactive handles (e.g. drag handles for adjusting a selection) are the only exceptions.

### MIDI playback position

Verovio's `getElementsAtTime()` is the API for mapping a MIDI tick to SVG elements. Use it for playback highlighting. Do not attempt to compute note positions from the SVG geometry independently — the mapping is non-trivial and Verovio already provides it.

---

## 4. Testing strategy

### Unit tests

Pure functions, Pydantic validators, service-layer logic that can be tested without a live database. Mock all database calls. These are fast and must pass without Docker running.

```bash
pytest tests/unit/
```

Running `pytest` without arguments collects only unit tests. Integration tests are skipped by default unless `DOPPIA_RUN_INTEGRATION=1` is set.

### Integration tests

FastAPI endpoints tested against real PostgreSQL and MinIO instances. The Docker Compose stack provides both. Integration tests are the primary confidence signal for API correctness.

Every integration test file is marked with `pytestmark = pytest.mark.integration`. To run them:

```bash
docker compose up -d   # start postgres, minio, redis
DOPPIA_RUN_INTEGRATION=1 pytest tests/integration/
```

Use test fixtures that set up and tear down their own data. Do not assume a clean database; do not leave test data behind. Every integration test should be runnable in any order and in parallel.

### Graph structure validation

Validate the structure of the seeded knowledge graph: no orphaned nodes, all cross-references resolve, `CONTAINS` edges have unique `order` values per concept, every `PropertySchema` has at least one value.

```bash
python scripts/validate_graph.py
```

Run this after every change to YAML seed files in `backend/seed/`. CI runs it automatically on commits that touch the seed directory.

### Verovio snapshot tests

Snapshot tests (`tests/snapshots/`) are scaffolded but not yet populated — they are planned for Phase 2 once the Verovio rendering pipeline is stable. Do not add tests to this directory without first reading the snapshot test strategy in the Phase 2 roadmap.

### Frontend tests

No frontend test framework is configured yet. This is a deliberate Phase 1 choice — the frontend is a thin browser layer on top of four read-only endpoints. See `frontend/TESTING.md` for the rationale and the planned Phase 2 approach (Vitest + React Testing Library).

### What is not tested in Phase 1

End-to-end browser tests (Playwright, Cypress) are deferred to Phase 2. The tagging tool is an internal tool used by a small team; the investment in browser automation is not justified until there are public-facing features with a regression risk.

---

## 5. API conventions

### Versioning

All routes are prefixed with `/api/v1/`. This prefix is set once in the FastAPI application factory; it is not repeated in individual router definitions. Adding versioning later to a codebase that did not have it from the start is painful — do not remove the prefix.

### Pagination

All list endpoints use **cursor-based pagination** from day one. Offset-based pagination (`?page=2&per_page=20`) is tempting and easy to implement, but becomes incorrect under concurrent writes at any scale. The pattern:

```json
{
  "items": [...],
  "next_cursor": "eyJpZCI6ICIxMjMifQ==",
  "has_more": true
}
```

The cursor encodes the last item's stable identifier (typically `id` and `created_at`). The client passes `?cursor=<value>` on subsequent requests. The server decodes the cursor, uses it as a `WHERE` clause boundary, and returns the next page.

Do not add an offset-pagination endpoint for convenience. Migrate it later when you need it to be correct.

### Error response envelope

Every error response uses this shape:

```json
{
  "error": {
    "code": "FRAGMENT_NOT_FOUND",
    "message": "No fragment with id 'abc123' exists.",
    "detail": {}
  }
}
```

`code` is a screaming-snake-case string defined as an enum in `backend/models/errors.py`. `message` is a human-readable string for display or logging. `detail` is an optional object with structured context (e.g. validation errors, the offending field name). Never return a bare string or an unstructured dict as an error body.

For the full strategy — how errors propagate through service and repository layers, which exception classes map to which status codes, and what happens when Neo4j is down during a Pydantic validator — see **[`docs/architecture/error-handling.md`](docs/architecture/error-handling.md)**.

### Status codes

Use standard HTTP status codes precisely:

- `200 OK` — successful read or update
- `201 Created` — successful creation; include the created resource in the response body and a `Location` header
- `204 No Content` — successful deletion (no body)
- `400 Bad Request` — malformed request (client error that cannot recover without changing the request)
- `401 Unauthorized` — missing or invalid authentication
- `403 Forbidden` — authenticated but not permitted (use this for role violations, not `401`)
- `404 Not Found` — resource does not exist
- `409 Conflict` — state conflict (e.g. submitting a fragment that is already approved)
- `422 Unprocessable Entity` — request is well-formed but semantically invalid (e.g. a required property schema value is missing; a harmony entry has not been reviewed and cannot be approved)
- `500 Internal Server Error` — unexpected server fault; these should never leak stack traces to the client

### Role enforcement

Role checks use the `require_role()` middleware factory, never hardcoded role strings in route handlers:

```python
# Correct — pass require_role() in the router decorator's dependencies list
@router.post(
    "/fragments/{id}/approve",
    dependencies=[require_role("editor")],
)
async def approve_fragment(id: UUID) -> Fragment:
    ...

# Wrong — do not do this
@router.post("/fragments/{id}/approve")
async def approve_fragment(id: UUID, user: AppUser = Depends(get_current_user)):
    if user.role not in ("editor", "admin"):
        raise HTTPException(status_code=403, ...)
```

The `require_role()` function lives in `backend/api/dependencies.py`. Adding a new role in Phase 2 means adding a constant — no route handler changes required.

---

## 6. Invariants that must never be violated

These are not style preferences. Violating them silently breaks data integrity across the system.

**Concept `id` values are immutable once seeded.** The `id` field on a knowledge graph concept node is the join key between `fragment_concept_tag.concept_id` in PostgreSQL and `Concept.id` in Neo4j. If a concept is renamed, change its `name` field only — never its `id`. The seeding script warns loudly if a previously seeded `id` is absent from the YAML; treat this warning as a blocking error.

**The `summary` JSONB schema is versioned and treated as a published API.** See `docs/architecture/fragment-schema.md` for the full versioning policy. Never change field names, types, or structure without incrementing `version` and writing a migration script. The AI reasoning layer in Phase 3 will consume this structure directly.

**`require_role()` is the only permitted way to enforce roles.** No inline role checks in route handlers. No role logic in service functions (services are called from within an already-authenticated request context).

**Pydantic validates before every database write.** Nothing reaches Neo4j, PostgreSQL, or Redis without first passing through a Pydantic model. If a payload bypasses Pydantic, that is a bug, not a shortcut.

**The graph seed script uses `MERGE`, not `CREATE`.** This makes re-seeding safe. Any `CREATE` statement in a seed script is a bug.

**MEI files are referenced by S3 object key, never by absolute path or URL.** The `mei_file` column stores an object key (e.g. `mozart-piano-sonatas/k331/movement-1.mei`). The application resolves keys to signed URLs at request time. Storing URLs directly creates environment-specific data.

---

## 7. Branching policy

**`main` is always deployable to staging.** Do not merge anything into `main` that is not passing CI (all tests, linting, graph validation).

**Feature branches** are named `feature/{short-description}`, e.g. `feature/cadence-domain-seed`, `feature/fragment-tagging-tool`. Keep branches short-lived. If a feature takes more than a week, it is probably too large — break it down.

**Fix branches** are named `fix/{short-description}`, e.g. `fix/beat-start-nullable-migration`.

**Open a pull request** for every merge into `main`, even if you are the only contributor. The PR is the place where the change is described, the ADR is linked if applicable, and CI results are visible. Self-merge is permitted in Phase 1 with a small team; the discipline of writing the PR description is the point.

**Tag milestones** on `main` after significant completions:

- `phase1/corpus-ingestion-complete`
- `phase1/cadence-domain-seeded`
- `phase1/tagging-tool-live`
- `phase1/complete`

These tags mark significant milestones on `main` and make it easy to check out the codebase at a known-good state.

---

## 8. Commit conventions

All commits follow the **Conventional Commits** specification with one project-specific addition: the `seed:` type for knowledge graph YAML changes.

### Types

| Type | Use for |
|---|---|
| `feat:` | A new feature or capability |
| `fix:` | A bug fix |
| `seed:` | Changes to YAML seed files or the seeding script (knowledge graph domain changes) |
| `test:` | Adding or changing tests without touching production code |
| `docs:` | Documentation changes only |
| `chore:` | Dependency updates, build configuration, tooling changes |
| `refactor:` | Code restructuring with no behaviour change |
| `perf:` | Performance improvements |

### Format

```
<type>(<scope>): <short summary in present tense>

<optional body: what changed and why, not what the code does>

<optional footer: BREAKING CHANGE, closes #issue>
```

The summary line is 72 characters or fewer. Use the imperative mood: "add" not "added", "fix" not "fixes".

### Examples

```
feat(tagging): add concept search endpoint with hierarchy path

seed(cadences): add CompoundPredominant subtype split

seed(cadences): add stubs for harmonic function domain boundary nodes

fix(fragment): enforce reviewed=true before approving harmony entries

BREAKING CHANGE: fragments with unreviewed auto-generated harmony
can no longer be approved. Existing submitted fragments with
auto=true harmony entries must be reviewed before approval.


chore: upgrade music21 to 9.2.0
```

### `seed:` commits and the graph audit trail

The `seed:` commit type creates a clean audit trail of knowledge graph evolution that is separate from application code changes. When investigating why a concept node has a particular structure, `git log --oneline -- backend/seed/` scoped to `seed:` commits gives the full structural history without noise from application changes.

`seed:` commits for a specific domain should always reference the domain in the scope: `seed(cadences):`, `seed(sequences):`, `seed(stubs):`.

---

## 9. Adding a new knowledge graph domain

When Phase 1 is complete and adjacent domains are being modelled, follow this process:

1. **Read the modelling guide first.** `docs/architecture/knowledge-graph-design-reference.md` contains the decision rules for node eligibility, relationship types, `CONTAINS` vs `PropertySchema`, and subtype splits. Apply it to the new domain before writing any YAML.

2. **Identify boundary concepts.** Every new domain references concepts from adjacent domains. List these before writing any YAML; they become stub nodes in the new domain's `stubs.yaml` section (or reference the existing stubs file if the concept is already stubbed from another domain).

3. **Write the YAML seed file** following the structure in `backend/seed/cadences.yaml` as a template. Include all concept nodes, relationships, PropertySchemas, and PropertyValues. Inline comments flagging uncertainties are encouraged — they make review easier. Note: `backend/seed/cadences.yaml` does not exist yet; this section will become applicable once Component 3 is built.

4. **Run the seed and validate:**
   ```bash
   python scripts/seed.py --domain <new-domain>
   python scripts/validate_graph.py
   python scripts/visualize_domain.py --domain <new-domain>
   ```
   Review the pyvis HTML output before committing. Structural problems are much easier to spot visually than in YAML.

5. **Open a pull request** with the domain YAML and a brief description of the modelling decisions made — especially any choices between `CONTAINS` and `PropertySchema`, any subtype splits, and how boundary concepts were handled. Link to the relevant sections of the modelling guide in the PR description.

6. **Do not remove existing stub nodes** from adjacent domains without verifying that no fragment tags or edges depend on them. Run `python scripts/validate_graph.py` to catch broken references before and after any stub removal.
