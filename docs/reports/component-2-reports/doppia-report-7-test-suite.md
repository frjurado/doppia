# Doppia — Test Suite Analysis

## Summary

This report assesses the test suite of the [Doppia repo](https://github.com/frjurado/doppia) at the current `main`. It complements the previous analysis of code quality and documentation by focusing exclusively on what is tested, how it's tested, what's missing, and where the existing structure has friction or risk. It does not re-cover the doc/code drift issues already documented in the earlier review.

**General view.** For a Phase-1 project, the backend test suite is genuinely good in the places it covers. ~5,700 lines, ~105 tests, and a clean two-tier architecture (unit fixtures with no-op lifespan, integration fixtures requiring Docker) shows real care. Unit coverage of pure functions is excellent — `test_ingest_analysis.py` (85 tests for ten helper functions) and `test_ingestion_models.py` (33 tests covering valid paths, slug rules, cross-field validation, deny-lists, SPDX allowlist, and `extra="forbid"`) are exemplary. The MEI normalizer tests deserve a special mention: every transformation rule has both a "does it apply correctly" test and an idempotence test, and that pattern catches a class of bugs that's easy to ship.

The weaknesses are mostly structural and around the edges:

- **Frontend has zero tests.** No Vitest, no Jest, no test runner configured at all.
- **Several scaffolded test directories are empty** (`tests/snapshots/`, `tests/graph/`) but advertised in `CLAUDE.md` as runnable.
- **No CI.** `pytest-cov` is in dev requirements but is never invoked. There's no `.github/`, no Makefile, no coverage threshold, nothing automated.
- **The largest source file (`services/tasks/ingest_analysis.py`, 822 lines) is only ~50% covered at the unit level.** The orchestrator `_dcml_branch`, the MEI↔TSV alignment helper `_build_measure_map`, and the Celery task wrapper itself rely entirely on integration tests for coverage.
- **Integration tests have hardcoded slugs and a manual Docker dependency.** No `pytest -m integration` marker, no testcontainers, no skip-if-no-docker, and the test composer slug `test-mozart` is shared across runs which makes interrupted runs leak state.
- **A telling code smell in `test_corpus_ingestion.py`**: the cleanup fixture manually pokes `services.tasks.ingest_analysis._session_factory = None` and `_engine = None` to work around event-loop binding. That's testing infrastructure papering over a real architectural issue.
- **The model layer is unevenly covered.** `models/ingestion.py` is exhaustively tested (33 tests), but `models/fragment.py` (170 lines, three SQLAlchemy models for the central data type of Phase 2) has zero tests.

What follows is the per-issue breakdown. Items are roughly ordered from highest impact to lowest.

---

## Issue 1: Frontend test suite does not exist

**[SOLVED]**

**Issue.** `frontend/package.json` has `dev`, `build`, `preview`, `lint`, and `format` scripts — but no `test` script and no test runner in dependencies. `find frontend -name '*.test.*' -o -name '*.spec.*'` returns nothing. There are React components (`src/components/browse/`, `src/components/ui/`), a routing layer (`src/routes/`), and a service layer (`src/services/`) — and none of it has any test coverage. ESLint and Prettier are configured, so static checking is in place, but there is no behavioural test harness at all.

For Phase 1 this is defensible — the frontend is mostly thin UI on top of the four browse endpoints, and integration tests on the backend cover the contract. But it should be a deliberate choice, not an oversight, and it's worth recording as a known gap so that as the frontend grows (Phase 2 adds tagging, Phase 3 adds AI-assisted analysis) the absence is visible rather than incidental.

**Solution.** Two paths, depending on appetite:

1. **Minimum viable.** Add Vitest + `@testing-library/react` to `frontend/devDependencies`, configure a `test` script in `package.json`, and write one smoke test per route that asserts the page renders without throwing given a mocked service-layer response. This is roughly an afternoon of work and gives a place to add tests when bugs surface.
2. **Document the gap.** If you'd rather defer, add a short `frontend/TESTING.md` that explicitly states "no test framework is configured yet; planned for Phase 2 alongside the tagging UI." That way the absence is owned rather than forgotten.

**Verification.** After option 1, `cd frontend && npm test` should run and pass. After option 2, the doc should be findable from `README.md`'s contributing section.

---

## Issue 2: Empty test directories advertised as runnable

**[SOLVED]**

**Issue.** `backend/tests/snapshots/` and `backend/tests/graph/` each contain only `__init__.py`. The first commit history doesn't matter here — the point is that `CLAUDE.md` lists `pytest tests/snapshots/` and `pytest tests/graph/` as commands a contributor should be able to run. Today both commands collect zero tests and exit with `no tests ran` (which pytest actually treats as exit code 5 — failure — by default).

This was already noted in the earlier doc audit, but it has a specific test-suite implication: snapshot tests are exactly the kind of regression guard that would benefit the DCML → events JSON pipeline. Right now if a refactor of `_dcml_branch` silently changes the shape of the events list for some movement, you'll only catch it via the one integration test's spot-checks (`mc=2 → V7`, `mc=4 → root_accidental=flat`). A snapshot of the full events list per fixture would catch a much wider class of regressions.

**Solution.**

1. Either delete the empty directories or populate them. The cheapest population: write one snapshot test that runs `_dcml_branch` against `K331-1.tsv` + the matching MEI and asserts the events JSON matches a checked-in fixture file. Use `syrupy` or just `json.dumps(events, sort_keys=True, indent=2)` compared against `tests/snapshots/k331-movement-1-events.json`.
2. For `tests/graph/`, this only becomes relevant once Component 3 (knowledge graph seeding) is built. Until then, delete the directory and remove the `pytest tests/graph/` line from `CLAUDE.md`. Re-add it when there's something to test.

**Verification.** `pytest backend/tests/snapshots/` and `pytest backend/tests/graph/` should either run and pass, or not be advertised. Run `pytest --collect-only backend/tests/` and confirm every advertised path collects at least one test.

---

## Issue 3: No CI, no automated coverage measurement

**Issue.** `pytest-cov==6.0.0` is in `requirements-dev.txt`, but there is no script, Makefile target, GitHub Actions workflow, or pre-commit hook that invokes it. Looking at the repo: no `.github/`, no `Makefile`, no `tox.ini`, nothing. Tests pass or fail entirely on the contributor's local machine, and coverage is unmeasured.

This matters more than it sounds. The whole two-tier architecture (unit vs integration) is built around the idea that unit tests should pass without Docker — but nothing actually verifies that on every commit. A future test that accidentally imports a module that opens a DB connection at import time would pass on the contributor's machine (where Docker is up) and fail silently for everyone else. CI is the only way to enforce the unit/integration boundary.

**Solution.** Three things, in order of priority:

1. **Add a GitHub Actions workflow** (`.github/workflows/ci.yml`) that runs `pytest backend/tests/unit/` on every push. This alone catches the "did someone accidentally make a unit test require Docker" class of regressions and runs in under 30 seconds.
2. **Add a second job that runs integration tests** behind `services:` containers for PostgreSQL and MinIO. Use the existing Docker-Compose images. Mark integration tests with `@pytest.mark.integration` (see Issue 5) and run `pytest -m integration` in this job.
3. **Wire `pytest-cov`** into the unit job: `pytest --cov=backend --cov-report=term-missing --cov-fail-under=70 backend/tests/unit/`. Start with a low threshold (60–70%) and ratchet up. The unit fixtures already mock everything, so meaningful unit coverage of `services/` and `api/` should be achievable.

**Verification.** A push to a feature branch should turn the GitHub status check red on a deliberate test failure. `pytest --cov` output should show line-level coverage per module so you can see where it drops.

---

## Issue 4: `services/tasks/ingest_analysis.py` is mostly untested at the unit level

**Issue.** This file is 822 lines — the largest in the backend, and the heart of the DCML-to-events pipeline. `test_ingest_analysis.py` has 85 tests across ten classes — but every single one of them targets a *pure helper function* (`_is_nan`, `_compute_beat`, `_resolve_key`, `_parse_numeral`, `_map_figbass`, `_build_numeral`, `_map_form`, `_parse_changes`, `_parse_dcml_harmonies`, `_merge_events`).

What's *not* unit-tested:

- `_get_session_factory()` — the lazy session-factory cache (which is the source of the event-loop hack in Issue 6).
- `_parse_global_key()` — converts DCML globalkey strings to `(tonic_pc, is_major)`. This is non-trivial and has edge cases.
- `_build_measure_map()` — builds the `(mc, mn) → measure_id` map from MEI bytes. **This is the alignment core that determines whether harmonies map onto the right measures.** It's only exercised by integration tests, and only on K331 fixtures and one synthetic volta MEI.
- `_dcml_branch()` — the orchestrator (~130 lines). Reads MEI from MinIO, parses TSV, merges events, writes to DB.
- `_extract_first_globalkey()` — trivial but used to back-fill `movement.key_signature`.
- `ingest_movement_analysis()` — the actual Celery task. Routing logic between DCML and music21_auto branches lives here.

The integration tests do exercise `_dcml_branch` and `_build_measure_map` (the volta test in `test_corpus_ingestion.py` is good for the latter), but unit-level coverage for the alignment logic specifically would be valuable — it's exactly the kind of code where edge cases (split measures, unmatched volta, missing `mc`) are hard to set up integration fixtures for but easy to construct as inputs.

**Solution.** Add a `test_ingest_analysis_orchestration.py` (or extend `test_ingest_analysis.py` with new classes) covering:

1. `_build_measure_map`: feed it small synthetic MEI strings and assert the returned dict. Cover: pickup bar (`@n=0`), endings (multiple measures with the same `@mn` distinguished by volta), missing `@n`, split measures with `@metcon='false'`. About 10–15 tests.
2. `_parse_global_key`: feed it strings like `"A"`, `"a"`, `"F#"`, `"bb"`, `"Eb"`, `"unknown"`. Maybe 5–8 tests.
3. `_dcml_branch`: this is harder because it does I/O. Pattern: mock `make_storage_client().get_mei`, mock the session factory to return an in-memory session backed by SQLite (or just `AsyncMock` it). Test that it handles "TSV references measure not in MEI" by writing a `harmony_alignment_warnings` entry. Test that it handles "first row has globalkey" by setting `movement.key_signature`. Maybe 5 focused tests.
4. `ingest_movement_analysis`: test that it routes to `_dcml_branch` when `analysis_source="DCML"` and to the music21 branch otherwise. Two tests.

**Verification.** After this work, `pytest --cov=backend.services.tasks.ingest_analysis backend/tests/unit/` should show line coverage above 80% for that module specifically. The integration tests should still pass unchanged — these unit tests are *additive*, not a replacement.

---

## Issue 5: No `integration` pytest marker, no skip-if-no-docker

**[SOLVED]**

**Issue.** `pyproject.toml`'s pytest config does not declare any markers. The integration tests in `backend/tests/integration/` rely on Docker services being up, but if a contributor runs `pytest backend/tests/` (which is what `testpaths` configures as the default), the integration tests will be collected and will fail with cryptic asyncpg connection errors. There's no way to do `pytest -m "not integration"` to run only the unit tests, short of manually targeting `backend/tests/unit/`.

This makes the two-tier architecture less useful than it should be. The whole point of having unit fixtures with a no-op lifespan is that you can do `pytest` on a fresh checkout without any infrastructure. Right now you can — but only if you know to type `pytest backend/tests/unit/`.

**Solution.** Three small changes:

1. Add to `pyproject.toml`:
   ```toml
   [tool.pytest.ini_options]
   markers = [
       "integration: tests requiring docker compose up (postgres, minio, redis)",
   ]
   ```
2. Add an `integration` marker to every test class/function in `backend/tests/integration/`. Cleanest way: a `conftest.py` autouse decorator, or `pytestmark = pytest.mark.integration` at the top of each file.
3. Add a session-scoped autouse fixture in `backend/tests/integration/conftest.py` that attempts to connect to PostgreSQL once at session start, and calls `pytest.skip("Docker compose not running")` on every integration test if the connection fails. Or, less invasive: a `conftest.py` `pytest_collection_modifyitems` hook that adds a `skip` mark to integration tests when an env var like `DOPPIA_RUN_INTEGRATION` is unset.

**Verification.** `pytest backend/tests/` on a machine without Docker should run ~80 unit tests cleanly and skip the rest with a clear "Docker not running" message. `pytest -m "not integration"` should collect only unit tests. `pytest -m integration` should require Docker.

---

## Issue 6: Manual cache-poking in `test_corpus_ingestion.py` is a smell pointing at a real bug

**Issue.** In `backend/tests/integration/test_corpus_ingestion.py`, the cleanup fixture does this:

```python
@pytest_asyncio.fixture(autouse=True)
async def _cleanup(self, db_session: AsyncSession) -> None:
    import services.tasks.ingest_analysis as _ia_module

    yield

    # Reset the ingest_analysis session-factory cache so the next test
    # gets a fresh engine/session bound to the current event loop.
    _ia_module._session_factory = None
    _ia_module._engine = None
    ...
```

Reaching into a module's private globals to null them out between tests is a textbook test-infrastructure smell. It means `services/tasks/ingest_analysis.py` caches an `AsyncEngine` keyed implicitly to whatever event loop was active the first time `_get_session_factory()` was called. If pytest-asyncio creates a new event loop for the next test (which it can, depending on `asyncio_default_fixture_loop_scope`), the cached engine is bound to a dead loop and produces "attached to a different loop" errors.

The comment in `integration/conftest.py` confirms the fragility:

```python
# We do NOT call close_db() between tests because disposing the asyncpg
# engine after a test's event loop scope ends causes ProactorEventLoop
# errors on Windows — instead, init_db() on the next test overwrites the
# module-level singleton with a fresh engine.
```

There are two concerning things here:

1. The same workaround appears in two places (`integration/conftest.py` for `models.base.init_db`, and the cleanup fixture for `services.tasks.ingest_analysis._session_factory`). That suggests the pattern of "module-level engine singleton, mutate it between tests" is becoming a habit.
2. In production, this is fine — the engine is created once per Celery worker process. But the fact that it's painful to test in isolation means it's also painful to refactor, and it means the first time a real bug forces you to add a third caching service, you'll be patching three things in three places.

**Solution.** Two options, in order of effort:

1. **Minimum.** Extract a `reset_session_caches()` helper (in a `tests/_helpers.py` or in `services/tasks/ingest_analysis.py` itself, marked clearly as test-only) that nulls out all module-level caches. Call it from one place in the cleanup fixture. This doesn't fix the underlying issue but makes it visible and centralized.
2. **Better.** Refactor `_get_session_factory()` to accept the engine via dependency injection rather than caching at module level. The Celery task can construct one on first call and pass it around; the test can pass in its own. This is more work, but it eliminates the cache entirely and the test infrastructure becomes simpler.

Independently of which option you choose: write a test (or a comment block in the fixture) that explains *why* the cache exists and *why* the reset is needed. Right now a future contributor reading that fixture has no idea what `_session_factory` is or why it must be reset.

**Verification.** After option 2: search for `_session_factory` and `_engine` outside of test files — there should be no module-level globals matching those names. Run the full integration suite three times in a row in the same `pytest` invocation; if it's stable, the loop-binding issue is gone.

---

## Issue 7: Hardcoded test composer slug allows state leaks across runs

**Issue.** `test_corpus_ingestion.py` uses the composer slug `"test-mozart"` everywhere. `test_browse_api.py` uses `"browse-test-mozart"`. Both are constants — not generated per test run. `test_object_storage.py` correctly uses `f"test-{uuid.uuid4().hex[:8]}"` for bucket names, so the pattern exists in the codebase already.

What goes wrong:

- A test run interrupted by Ctrl-C between `yield` and cleanup leaves rows in the database. The next run hits `IntegrityError` on the `composer.slug` UNIQUE constraint when the upload tries to insert `"test-mozart"` again.
- Two contributors running tests against the same staging Postgres (which is rare but possible) clobber each other.
- A developer has to remember that a manual `psql` to `DELETE FROM composer WHERE slug LIKE 'test-%'` is part of the recovery procedure when something goes wrong.

The browse-test slug is *slightly* better-isolated from the ingestion-test slug, but they share the database and they share the deletion logic — duplicated in two `_delete_test_composer` helpers, which is the next concern.

**Solution.** Two changes:

1. **Generate a unique slug per test class run.** A class-scoped fixture: `composer_slug = f"test-mozart-{uuid.uuid4().hex[:8]}"`. Pass it to all metadata builders and cleanup helpers. This makes interrupted runs harmless — leaked rows are uniquely named and don't collide with the next run.
2. **Add a session-finalizer that deletes any composer whose slug matches `test-*-[0-9a-f]{8}$`**, as a safety net for the Ctrl-C case. Or, simpler: a `conftest.py` `pytest_sessionstart` that does the cleanup before the session begins.

While you're there: `_delete_test_composer` is duplicated almost identically in `test_browse_api.py` (line 120) and `test_corpus_ingestion.py` (line 157). Move it to `backend/tests/integration/conftest.py` as a fixture that takes a slug.

**Verification.** Run the integration suite, hit Ctrl-C halfway through, and run again. The second run should pass without manual database cleanup. Run `grep -rn "_delete_test_composer" backend/tests/` and verify there's only one definition.

---

## Issue 8: `models/fragment.py` and the fragment data layer have zero test coverage

**Issue.** `backend/models/fragment.py` is 170 lines and defines three SQLAlchemy ORM models: `Fragment`, `FragmentConceptTag`, `FragmentReview`. The docstring describes it as "the central record; one row per tagged musical excerpt" — i.e. this is the data type Phase 2 will be built on. The `summary` JSONB field is described as versioned, with the version field in `summary` requiring incrementation and a migration script for breaking changes. There is no test for any of this. `grep -rn "fragment" backend/tests/` returns zero results.

Compare with `models/ingestion.py` (471 lines, 33 tests, exhaustive coverage of every cross-field rule). The asymmetry is striking. Both files are Pydantic/SQLAlchemy schema definitions; one is rigorously locked in by tests and one is not.

This is partly explained by Phase 1 not yet writing fragments — there's no service or route that creates a `Fragment` row today. So in some sense there's nothing to test. But the *schema itself* is testable: constraints, defaults, relationship cascades, the `summary` version field. And the moment Phase 2 starts writing fragments, the schema will be locked in by data, not by tests, and any future migration becomes riskier.

**Solution.** Add a `tests/unit/test_fragment_models.py` with at minimum:

1. A test that constructs a `Fragment` ORM instance with all required fields and asserts default values.
2. A test that validates the `summary` JSONB schema — at minimum that `summary["version"]` is required and that an unknown version raises (if you have a Pydantic schema for it; if not, this test motivates adding one).
3. Tests for the cascade behaviour: deleting a `Fragment` should cascade to `FragmentConceptTag` and `FragmentReview` (or it should not — whichever the design intends, the test should pin it down).
4. A test covering the cross-system note in the docstring: "`fragment_concept_tag.concept_id` values are Neo4j Concept.id strings. There is no database-level foreign key across systems; referential integrity is enforced by the Pydantic validation layer at write time." If the validation layer doesn't exist yet, the test serves as a TODO marker. If it does, the test verifies it.

Roughly 5–10 tests, no Docker required (unit-level only).

**Verification.** Run `pytest backend/tests/unit/test_fragment_models.py` and confirm tests pass. Run `pytest --cov=backend.models.fragment` and confirm coverage above 80%.

---

## Issue 9: The four browse endpoints lack route-level unit tests

**Issue.** `backend/api/routes/browse.py` is 161 lines and defines four endpoints (`/composers`, `/composers/{slug}/corpora`, `/composers/{slug}/corpora/{slug}/works`, `/works/{id}/movements`). The browse *service layer* is well-tested at the unit level (`test_browse_service.py` mocks `db.execute` thoroughly). The browse *integration layer* exercises the whole path through Postgres (`test_browse_api.py`).

What's missing: route-level unit tests using the existing `test_client` fixture. These would cover the API contract — request validation, response serialization, status codes, auth boundaries, error envelopes — without needing Docker.

The only existing route-level unit test is `test_health.py` (1 test, 22 lines). Auth tests in `test_auth_middleware.py` use a custom `supabase_client` fixture and a synthetic `/api/v1/protected` route — they cover middleware behaviour but not the actual browse routes.

This is not strictly missing coverage — the integration tests do exercise the routes end-to-end. But there's a wide middle ground (e.g., "what happens when `list_composers` returns an empty list — does the route return `[]` with 200, or does it 404?") that's currently not tested at the unit level, and would be much faster than the integration variant.

**Solution.** Add `tests/unit/test_browse_routes.py` that uses the existing `test_client` fixture and patches the service-layer functions:

```python
async def test_list_composers_empty(test_client, monkeypatch):
    monkeypatch.setattr(
        "services.browse.list_composers", AsyncMock(return_value=[])
    )
    resp = await test_client.get("/api/v1/composers")
    assert resp.status_code == 200
    assert resp.json() == []
```

Roughly 1–2 tests per endpoint covering: success with empty data, success with one item, 404 for unknown parent. Also worth adding: tests for the JSON error envelope (`{"error": {"code": ..., "message": ...}}`) — this is the contract the frontend depends on, and it's not unit-tested anywhere.

**Verification.** `pytest --cov=backend.api.routes.browse backend/tests/unit/` should show above 90%. The integration tests should still pass — these are additive.

---

## Issue 10: Test fixture data is hand-written and fragile

**Issue.** Most fixtures are constructed inline as Python dicts (`_valid_ingest_dict()`, `_minimal_metadata()`, `_MAIN_METADATA`, `_METADATA`, etc.) — sometimes the same metadata block is rebuilt three or four times across files with minor variations. The `_HARMONIES_TSV` string in `test_browse_api.py` is hand-typed with 28 columns; the `_VOLTA_TSV` in `test_corpus_ingestion.py` is similar. The MEI fixtures in `tests/fixtures/mei/` are the genuine cleanly-shared resource (used by both unit and integration tests), but the metadata YAML and harmonies TSV side is duplicated.

The cost of this isn't just duplication — it's that when the schema legitimately changes (a new required field on `corpus`, a new column on the DCML harmonies TSV), every test file needs to be updated, and it's easy to miss one.

**Solution.** Two-step:

1. Move the canonical valid-metadata builder and the canonical harmonies-TSV string into `backend/tests/fixtures/__init__.py` or a `tests/fixtures/builders.py` module. Have all tests import from there. The pattern `_valid_ingest_dict()` in `test_ingestion_models.py` is the right shape — just lift it.
2. Move the volta TSV and the K331 TSV out of inline strings into `tests/fixtures/dcml-subset/harmonies/` (where `K331-1.tsv` and `K331-2.tsv` already live as real files). Read them with `Path.read_text()`. This is the same pattern the MEI fixtures already use.

While doing this: consider adding a `factory_boy` or `polyfactory` setup. Given how exhaustive `test_ingestion_models.py` is, you'd benefit from a builder that produces valid `IngestMetadata` payloads and lets each test mutate just the field under test. Right now every test does `d = _valid_ingest_dict(); d["..."] = ...`, which is fine but repetitive.

**Verification.** `grep -rn "mc\\\\tmn\\\\tquarterbeats" backend/tests/` should return one location, not three. Adding a new required field to `IngestMetadata` should require updating one builder, not three test files.

---

## Issue 11: No tests for Celery task wrappers themselves

**[SOLVED]**

**Issue.** The unit tests cover the inner async functions: `_dcml_branch`, `_generate_incipit_async`. The integration tests call those inner functions directly (`from services.tasks.ingest_analysis import _dcml_branch; await _dcml_branch(...)`). The actual Celery `@shared_task` wrappers — `ingest_movement_analysis` and `generate_incipit` — are never invoked end-to-end in the test suite.

What's not tested:

- Task signature: do the kwargs match what `services/ingestion.py` passes via `.delay()`?
- Retry behaviour (if any is configured).
- Error handling: what happens when the inner async raises?
- Logging / status reporting: does the task correctly mark itself as failed?

This matters because the only thing connecting `ingest_corpus` (which dispatches the task) and `_dcml_branch` (which executes it) is the Celery contract. If the kwargs drift — say, you rename `harmonies_tsv_content` to `tsv_content` in the task signature but forget to update `services/ingestion.py` — every unit test passes, every integration test passes (because they bypass Celery), and production breaks.

**Solution.** Add an integration test (or extended unit test using `celery.contrib.testing`) that runs the actual task wrapper, not just the inner function. Pattern:

```python
def test_ingest_movement_analysis_task_signature():
    # Use Celery's eager mode
    from services.tasks.ingest_analysis import ingest_movement_analysis
    result = ingest_movement_analysis.apply(
        kwargs={
            "movement_id": str(uuid.uuid4()),
            "harmonies_tsv_content": "...",
            "analysis_source": "DCML",
        }
    )
    assert result.successful() or result.failed()  # at least it routed
```

Even better: a test that calls `services.ingestion.ingest_corpus` with `CELERY_TASK_ALWAYS_EAGER=True` so the dispatched task actually runs in-process. That would close the contract gap entirely.

**Verification.** Manually rename a kwarg in the task signature and run the test suite. Without this fix, all tests pass. With this fix, the new test fails.

---

## Issue 12: Object storage test coverage is integration-only

**[SOLVED]**

**Issue.** `services/object_storage.py` is 217 lines. The only test file touching it is `tests/integration/test_object_storage.py` (164 lines, 7 tests), which spins up a real MinIO bucket and round-trips bytes. There are no unit tests — meaning no tests cover the cases where the boto3 client raises (network errors, auth errors, missing keys) or the cases where the object key construction has edge cases.

**Solution.** Add `tests/unit/test_object_storage.py`. Use `unittest.mock.AsyncMock` for the aioboto3 session and verify:

1. `make_storage_client()` reads the right env vars and constructs the client correctly.
2. `put_mei` builds the correct key with a prefix.
3. `put_mei_original` adds the `originals/` prefix.
4. `signed_url` is called with the right `expires_in` default (currently 900 seconds based on `test_browse_service.py`).
5. Error paths: client raises `ClientError`, `EndpointConnectionError`, etc.

About 8–12 tests. No Docker required.

**Verification.** `pytest --cov=backend.services.object_storage backend/tests/unit/` should show above 70% coverage from unit tests alone. The integration tests cover the real round-trip behaviour and remain unchanged.

---

## Issue 13: `pytest.mark.asyncio` usage is inconsistent

**[SOLVED]**

**Issue.** Some test classes use `@pytest.mark.asyncio(loop_scope="session")` (e.g., `test_browse_api.py:187`, `test_corpus_ingestion.py:230`); other test functions are plain `async def` and rely on `asyncio_mode = "auto"` from `pyproject.toml`; a few use `@pytest.mark.asyncio` without `loop_scope`. The classes with explicit `loop_scope="session"` are clearly chosen to deal with the session-scoped engine fixture, but the rationale isn't documented and the inconsistency suggests the convention was discovered iteratively.

This is minor — the tests work. But it's a footgun for new contributors who copy-paste a test from one file and find it behaves differently.

**Solution.** Add a short section to `backend/tests/conftest.py`'s docstring (or to a new `backend/tests/README.md`) explaining the convention:

- Default mode is `auto` — use plain `async def test_x` for unit tests.
- Integration tests that share a session-scoped fixture (the engine) need `@pytest.mark.asyncio(loop_scope="session")` at the class level.
- Don't mix loop scopes within a single class.

Then audit the test files and apply the convention consistently. It's a 30-minute pass.

**Verification.** `grep -rn "@pytest.mark.asyncio" backend/tests/` should show a consistent pattern: present only on integration test classes, absent on unit tests. New contributors should be able to look at one example file and know what to do.

---

## Issue 14: Defaults in conftest can silently mask environment misconfiguration

**[SOLVED]**

**Issue.** Both root `conftest.py` (lines 113–115, 150–152, 172–175) and `integration/conftest.py` (lines 62–73) read environment variables and fall back to hardcoded defaults that match `.env.example`. If a developer has a custom `DATABASE_URL` in their `.env` but a test process doesn't load `.env` (which is the default for `pytest`), the test silently uses `postgresql+asyncpg://postgres:localpassword@localhost/doppia` — which may or may not match what's running. The failure mode is a misleading error: tests fail with "auth failed" or "database doppia does not exist" without any hint that the env var fallback kicked in.

**Solution.** Either:

1. Remove the defaults entirely and require env vars to be set. Add a clear error message: `pytest.fail("DATABASE_URL is not set; run `set -a && source .env` first.")`.
2. Or, opposite direction: have `conftest.py` load `.env` automatically using `python-dotenv` (which is already in `requirements-dev.txt`). Then defaults become "what's in `.env`" rather than "what's hardcoded".

Option 2 is more contributor-friendly; option 1 is more explicit. Either is better than the current silent-fallback behaviour.

**Verification.** Unset `DATABASE_URL` and run `pytest backend/tests/integration/`. The error message should clearly point at the env var, not at PostgreSQL.

---

## Closing notes

Most of these issues are scaling concerns rather than current-state bugs. The test suite as it stands is good for Phase 1 and reflects deliberate engineering — the unit/integration separation, the idempotence pattern in the normalizer tests, and the per-rule organization of `test_ingestion_models.py` are all things you'd be glad to inherit. The gaps are mostly around: (1) automation that makes the tests actually run on every change, (2) coverage of code paths that haven't been written yet but will be soon (fragments, snapshot regression), and (3) the few places where test infrastructure is fighting an architectural choice rather than supporting it.

If you tackle Issues 1, 2, 3, and 5 first, the rest become much easier — CI surfaces problems automatically, the marker system makes "run the fast tests" a first-class operation, and the empty directories stop being an aspirational lie.
