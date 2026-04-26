# Doppia Code Review — Report 1: Docs, API, and Middleware

## Summary

**Scope.** This report covers the documentation set (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`), the FastAPI application bootstrap (`backend/main.py`), the API layer (`backend/api/`), and the error/auth middleware. It does not cover the service layer, models, scripts, frontend, or the wider `docs/` directory — those are addressed in subsequent reports.

**General view.** The documentation is unusually thorough and well-organized for a project this young: clear separation between the user-facing README, the agent-facing CLAUDE.md, and the contributor-facing CONTRIBUTING.md; explicit invariants section; sensible commit and branching conventions; and a documentation map that points readers to the right place. The middleware bootstrap is also strong — middleware-ordering comment in `main.py` is exactly the comment Starlette beginners need.

The problems are of two kinds. First, several **real bugs** in the code: a 404→INTERNAL_SERVER_ERROR mapping, a broken docstring example for `require_role()`, a `ENVIRONMENT=development` vs `ENVIRONMENT=local` mismatch between README and code, and an empty orphan `routers/` directory. Second, **documentation drift**: the project layout in the README and CLAUDE.md describes seed files, snapshot tests, graph queries, and frontend structure that don't exist yet, and one type name (`AppUser` vs `AuthenticatedUser`) is wrong everywhere it's mentioned. None of the bugs are critical, but the doc drift will slow down new contributors at exactly the moment they're trying to build a mental model of the project.

---

## Issue 1: 404 maps to `INTERNAL_SERVER_ERROR` in the error envelope

**Issue.** `backend/api/middleware/errors.py` line 38 maps HTTP status 404 to `ErrorCode.INTERNAL_SERVER_ERROR`. Every 404 response from the API (including all four `HTTPException(404, ...)` raises in `routes/browse.py`) returns an envelope with `code: "INTERNAL_SERVER_ERROR"`. The `ErrorCode` enum has specific not-found codes (`FRAGMENT_NOT_FOUND`, `MOVEMENT_NOT_FOUND`, `WORK_NOT_FOUND`, `CORPUS_NOT_FOUND`, `COMPOSER_NOT_FOUND`) but no generic `NOT_FOUND` to use as a fallback for the status-code-based mapping.

**Solution.** Pick one of:

1. **Add a generic `NOT_FOUND` code** to `ErrorCode` and map 404 to it: `404: ErrorCode.NOT_FOUND,`. Specific codes (`COMPOSER_NOT_FOUND`, etc.) remain available when raised explicitly via typed exceptions.
2. **Replace status-code-based mapping with typed exceptions.** Define a `ResourceNotFoundError(code: ErrorCode)` exception class. Route handlers raise `ComposerNotFoundError(slug)` which carries `ErrorCode.COMPOSER_NOT_FOUND`. Middleware reads the typed code directly and never has to guess from a status number. This is the cleaner long-term solution and makes the typed codes the enum already defines actually usable.

**Verification.** Add an integration test asserting on 404 response shape:

```python
async def test_404_returns_proper_error_code(client):
    r = await client.get("/api/v1/composers/does-not-exist/corpora")
    assert r.status_code == 404
    body = r.json()
    assert body["error"]["code"] != "INTERNAL_SERVER_ERROR"
    assert "not found" in body["error"]["message"].lower()
```

Without this test, the bug can re-emerge silently.

---

## Issue 2: README says `ENVIRONMENT=development` for dev-auth bypass; code requires `ENVIRONMENT=local`

**[SOLVED]**

**Issue.** `README.md` line 84 instructs developers:

> Set `AUTH_MODE=local` in `.env` and the backend will accept a fixed development token (`Bearer dev-token`) on all authenticated endpoints. This is enforced only when `ENVIRONMENT=development`.

But `backend/api/middleware/auth.py` lines 80–88 explicitly check `if environment != "local"` and reject with 401 otherwise. `main.py` `_ALLOWED_ORIGINS` also keys on `"local"`. A new contributor following the README will get a 401 with no clue why.

**Solution.** Fix the README to say `ENVIRONMENT=local`. The code is internally consistent and is the source of truth here.

**Verification.** Manual: `cp .env.example .env`, set `ENVIRONMENT=local` and `AUTH_MODE=local`, run `docker compose up`, then `curl -H "Authorization: Bearer dev-token" http://localhost:8000/api/v1/composers` should return 200 (not 401). Worth adding this to a setup-smoke-test script in `scripts/`.

---

## Issue 3: Empty orphan `backend/api/routers/` directory

**Issue.** `backend/api/` contains both `routes/` (the real one, used by `router.py`) and `routers/` (only `__init__.py`, empty). Likely a rename leftover from an earlier iteration. Confusing for new contributors who'll have to figure out which is canonical.

**Solution.** Delete `backend/api/routers/` and its `__init__.py`.

**Verification.** `find backend/api -name routers` returns nothing. `pytest` still passes (it doesn't import from there, but worth confirming).

---

## Issue 4: Broken docstring example for `require_role()`

**Issue.** `backend/api/dependencies.py` line 73 shows this usage example:

```python
_: AppUser = require_role("editor"),
```

This won't work as written. `require_role()` returns a `Depends(...)` object; used as a default value it doesn't resolve. The actual call sites in `routes/browse.py` and `routes/corpora.py` use `dependencies=[require_role("editor")]`. CONTRIBUTING.md shows yet a third style: `_: Annotated[AppUser, Depends(require_role("editor"))]`.

So we have three documented styles, only one of which (the `dependencies=[...]` form) is actually used, and the other two won't run.

**Solution.** Pick one canonical style and update every doc + docstring to match. Recommendation: the `dependencies=[require_role("editor")]` form, because it (a) keeps the role check out of the function signature, (b) is what the codebase already uses, and (c) doesn't pollute the handler's parameter list with a `_` parameter.

**Verification.** `grep -rn "require_role" backend/ docs/ CLAUDE.md CONTRIBUTING.md` — every result should show the same style. Add an `assert` in a unit test that imports a route handler and inspects its `dependencies` to ensure `require_role` is wired correctly.

---

## Issue 5: `AppUser` vs `AuthenticatedUser` — documentation uses a name the code doesn't have

**Issue.** Every doc reference (CLAUDE.md, CONTRIBUTING.md, the docstring inside `dependencies.py` itself) calls the type `AppUser`. The actual class defined in `backend/api/dependencies.py` is `AuthenticatedUser`. New readers searching the codebase for `AppUser` will find nothing.

**Solution.** Rename **either the class or the documentation references**, but make them consistent. Recommendation: rename the class to `AppUser` — it's shorter, fits CONTRIBUTING's tone, and the class isn't widely used yet (only `dependencies.py` and `middleware/auth.py` import it). If you keep `AuthenticatedUser`, update three files: CLAUDE.md, CONTRIBUTING.md §5 "Role enforcement", and the docstring example inside `dependencies.py`.

**Verification.** `grep -rn "AppUser\|AuthenticatedUser" backend/ docs/ CLAUDE.md CONTRIBUTING.md` — only one of the two names should appear.

---

## Issue 6: README "Project layout" section describes structure that doesn't exist yet

**Issue.** README.md lines 118–151 list a project layout that includes:

- `backend/seed/` "YAML seed files" — currently contains only `__init__.py`. No YAML.
- `scripts/migrations/` — does not exist. Migrations are at `backend/migrations/`.
- `backend/services/` "owns cross-database joins" — there is currently no Neo4j code; `backend/graph/queries/` has only the `relationships.py` constants module, no actual query functions; `backend/graph/neomodel/` is empty.
- `frontend/components/` and `frontend/services/` — actual layout is `frontend/src/` (standard Vite).
- `output/` — doesn't exist (would be created by `scripts/visualize_domain.py`, which is itself a stub).

**Solution.** Two parts:

1. **Be explicit about what's built vs. planned.** Either remove the not-yet-built directories from the README layout, or add a "Phase 1 status" column. New contributors should not have to clone the repo to learn that half the layout is aspirational.
2. **Move "planned structure" detail to `docs/roadmap/phase-1.md`** where it belongs. The README should show the codebase as it exists today.

**Verification.** Run `tree -L 2 backend/ frontend/ scripts/` and diff against the README's project-layout block. Every entry in the README should correspond to an existing path. If it doesn't exist, it shouldn't be in the layout.

---

## Issue 7: CLAUDE.md describes commands that won't run

**Issue.** CLAUDE.md "Commands" section advertises operations that fail or no-op today:

- `pytest tests/snapshots/` — `backend/tests/snapshots/` contains only `__init__.py`. No snapshot tests yet.
- `python scripts/seed.py --domain cadences` — `scripts/seed.py` exists but is a 1.5K stub. No `cadences.yaml` exists in `backend/seed/`. CONTRIBUTING.md §9 even refers to `backend/seed/cadences.yaml` as a template — the file isn't there.
- `pytest tests/graph/` — `backend/tests/graph/` contains only `__init__.py`.
- `python scripts/visualize_domain.py --domain <n>` — script is also a stub.

When a Claude Code session reads CLAUDE.md and runs these commands as part of a "smoke test before working", they'll fail or silently do nothing.

**Solution.** Two parts:

1. **Mark planned commands explicitly.** Add a `(planned)` or `(Phase 1 — not yet implemented)` annotation on each entry that's still a stub. Or move them to a separate "Planned commands" subsection.
2. **Fix CONTRIBUTING.md §9** to either (a) point to a real example file once the cadences seed exists, or (b) explicitly say "the cadences seed file does not exist yet; this section will become applicable once Component 3 is built."

**Verification.** Each command in CLAUDE.md should either succeed against a fresh clone or be explicitly marked as planned. Worth a CI smoke-test: a script that parses CLAUDE.md's command blocks and runs the ones not marked as planned.

---

## Issue 8: README first-time-setup steps reference operations that aren't ready

**Issue.** README §4 ("Seed the knowledge graph") instructs new users:

```bash
python scripts/seed.py --domain cadences
python scripts/validate_graph.py
```

Both scripts are stubs. A new contributor following the setup steps in order will hit step 4 and find that nothing happens (or it errors), with no signal whether the project is broken or whether they did something wrong.

**Solution.** Replace step 4 with: *"Knowledge graph seeding is part of Component 3 (in progress). Until then, Neo4j stays empty after `docker compose up`. Skip this step."* When Component 3 lands, restore the original instructions.

**Verification.** A new user can clone, run all README setup steps in order, and end up with a working backend on `localhost:8000` without any failed commands.

---

## Issue 9: 404 path bypasses the typed `ErrorCode` enum entirely

**Issue.** Route handlers in `backend/api/routes/browse.py` raise:

```python
raise HTTPException(
    status_code=status.HTTP_404_NOT_FOUND,
    detail=f"Composer '{composer_slug}' not found.",
)
```

They pass a bare string for `detail` and rely on the middleware to wrap it. The middleware then has to *guess* the error code from the status number (and currently guesses wrong — see Issue 1). The enum already has `COMPOSER_NOT_FOUND`, `WORK_NOT_FOUND`, etc., but nothing connects the raise sites to those codes.

**Solution.** Define typed exceptions at `backend/models/errors.py` (or `backend/api/exceptions.py`):

```python
class DomainError(HTTPException):
    code: ErrorCode
    def __init__(self, code: ErrorCode, message: str, status_code: int, detail: dict | None = None):
        ...

class ComposerNotFoundError(DomainError):
    def __init__(self, slug: str):
        super().__init__(
            code=ErrorCode.COMPOSER_NOT_FOUND,
            message=f"Composer '{slug}' not found.",
            status_code=404,
        )
```

Route handlers raise the typed exception; middleware reads `exc.code` directly. No status-number guessing. The mapping bug from Issue 1 disappears as a side effect.

**Verification.** Integration tests for each not-found path should assert on the exact `code` value:

```python
assert r.json()["error"]["code"] == "COMPOSER_NOT_FOUND"
```

---

## Issue 10: Inconsistent role-enforcement style across the codebase

**Issue.** Three different styles are documented or used for `require_role()`:

- `dependencies=[require_role("editor")]` — used in `routes/browse.py` and `routes/corpora.py` (the actual production style).
- `_: Annotated[AppUser, Depends(require_role("editor"))]` — taught in CONTRIBUTING.md §5.
- `_: AppUser = require_role("editor")` — shown in `dependencies.py`'s own docstring (broken, won't run).

**Solution.** Pick one style; update every reference. Recommendation as in Issue 4: the `dependencies=[...]` form. Document the choice once in CONTRIBUTING.md and remove the alternative examples.

**Verification.** All `require_role` use-sites in the codebase use the chosen style. Linting could enforce this with a custom rule, but a periodic `grep` review is sufficient at this scale.

---

## Issue 11: Code-quality nits in middleware (non-blocking)

**Issue.** Several minor patterns in `dependencies.py` and `middleware/auth.py`:

- `_ROLE_HIERARCHY` is built inside `require_role()` on every call. Should be module-level.
- `os.environ.get("ENVIRONMENT")` and `AUTH_MODE` are read inside `dispatch()` on **every request**. Env-var reads in the hot path are wasteful and make the security-critical guard hard to test.
- `_make_401()` does `from models.errors import ...` lazily "to break a potential circular import." If the import is real, the comment should name the cycle; if it isn't, move the import to module scope.
- `http_exception_handler()` does `message = exc.detail if isinstance(exc.detail, str) else str(exc.detail)`. When `detail` is a dict (e.g. from `services/ingestion.py`'s `_raise_422`), the message becomes `str({'error': {...}})` — not human-readable.

**Solution.**

1. Lift `_ROLE_HIERARCHY` to module scope in `dependencies.py`.
2. Replace the env-var reads in `AuthMiddleware.dispatch` with a module-level `_AuthConfig` dataclass loaded once at import time, or use `@functools.lru_cache` on a `get_config()` function.
3. Verify the circular import in `_make_401`. If not real, move to module scope.
4. Handle dict `detail` explicitly in `http_exception_handler`: if `exc.detail` is a dict and looks like an `ErrorResponse`, return it as-is; if it's a dict but unstructured, put it in `detail` field of a fresh envelope; only if it's a string, use it as the message.

**Verification.**

1 and 3 are small refactors verified by running tests.
2 is verified by a unit test that mocks `os.environ` once at import time and confirms changes mid-test don't take effect (or by adding a function that explicitly reloads the config). 
4 is verified by an integration test against the upload endpoint asserting on response shape (which currently isn't tested — see report 2).
