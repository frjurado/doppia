# Doppia Code Review — Report 2: Service Layer and Ingestion

## Summary

**Scope.** This report covers `backend/services/`: the browse service, the corpus-ingestion service, the MEI validator, the MEI normalizer, the object storage client, the Celery app, and the two background tasks (`generate_incipit` and `ingest_analysis`). It also touches the model file `models/normalization.py` and the ingestion-related route in `routes/corpora.py` where it connects to the service layer. It does not cover the wider models, the test suite proper, the scripts, or the frontend — those are addressed elsewhere.

**General view.** This is the most thoughtful piece of code I've reviewed in the repo. The ingestion pipeline (`services/ingestion.py`) has a clear seven-step structure, separates "data collected during validation" from "data needed after the transaction commits" via small private dataclasses, and correctly dispatches Celery tasks **after** the DB transaction commits rather than inside it. The MEI validator and normalizer are well-structured, with each pass isolated in its own private function and the public surface limited to a single `validate_mei` / `normalize_mei` call. The object-storage abstraction is small, well-documented, and correctly environment-agnostic.

The problems cluster around two themes. First, a **direct contradiction between the two Celery tasks** about how to handle SQLAlchemy engine lifecycle under `asyncio.run()` — one task explicitly avoids module-level engine caching with a long justification, the other does exactly what the first says is wrong. Second, the **error-envelope wiring at the service↔route boundary is broken in two distinct ways**: route-layer 404s carry the wrong `code` (compounding the bug from Report 1), and service-layer 422s are double-wrapped by `_raise_422`. Beyond those, there are smaller issues — an unused import, a stale top-level docstring, a route-handler dependency that should be injected — but the codebase fundamentally has the right shape.

---

## Issue 1: Conflicting engine-caching strategies between the two Celery tasks

**[SOLVED]**

**Issue.** `backend/services/tasks/generate_incipit.py` lines 67–73 documents an explicit decision to **avoid** module-level engine caching:

> A fresh SQLAlchemy engine is created and disposed within this coroutine. This is intentional: Celery tasks run inside `asyncio.run()`, which creates and closes a new event loop per invocation. A module-level cached engine holds asyncpg connections bound to the *previous* (closed) loop and raises `RuntimeError: Event loop is closed` on reuse.

`backend/services/tasks/ingest_analysis.py` lines 47–64 does **exactly that** — caches the engine via `_get_session_factory()`. Both tasks run in the same Celery worker process, both invoke their inner coroutines via `asyncio.run()` (incipit line 192, analysis line 807), and both use asyncpg. One of these two implementations is wrong.

If the comment in `generate_incipit` is correct (and it matches the documented behavior of asyncpg + SQLAlchemy + `asyncio.run()`), the second task invocation in `ingest_analysis` will crash with `RuntimeError: Event loop is closed`. The integration test at `backend/tests/integration/test_corpus_ingestion.py` line 8 explicitly says it calls `_dcml_branch()` directly, bypassing Celery — so it cannot catch this bug.

**Solution.** Pick the right strategy and apply it to both tasks:

1. **Recommended: per-invocation engine** (the `generate_incipit` pattern). Refactor `ingest_analysis._get_session_factory()` away. The task creates an engine inside `_dcml_branch`, uses it for both reads and writes, and disposes it in a `finally`. The overhead is small and the model is robust.

2. **Alternative: replace `asyncio.run()` with a Celery worker that runs a single persistent event loop.** This is more efficient but requires more setup (e.g. `celery-pool-asyncio` or a custom worker). Probably overkill for Phase 1.

3. **Alternative: keep the cached engine but use a sync driver in Celery.** Tasks don't have to be async. Convert the DB calls in `_dcml_branch` to sync `psycopg`, keep aioboto3 calls async via `asyncio.run()` only for those. More invasive.

**Verification.** Add an integration test that runs `ingest_movement_analysis` **at least twice in the same Python process**:

```python
async def test_ingest_analysis_runs_twice_in_same_process(...):
    # First call — creates the cached engine bound to loop A.
    ingest_movement_analysis("uuid-1", "DCML", harmonies_tsv_content=tsv1)
    # Second call — would hit "Event loop is closed" with the cached engine.
    ingest_movement_analysis("uuid-2", "DCML", harmonies_tsv_content=tsv2)
    # Both rows present.
```

Without this test the bug only surfaces on the second corpus ingestion, by which point the production logs are the canary.

---

## Issue 2: Service-layer `_raise_422` produces a double-wrapped error envelope

**[SOLVED]**

**Issue.** `backend/services/ingestion.py` lines 533–549:

```python
def _raise_422(code, message, detail=None):
    raise HTTPException(
        status_code=422,
        detail=ErrorResponse.make(code=code, message=message, detail=detail).model_dump(),
    )
```

The `detail` argument to `HTTPException` is a dict that already represents the full `{"error": {"code": ..., ...}}` envelope. Then `http_exception_handler` (the global middleware) takes `exc.detail`, sees it's not a string, falls through to `message = str(exc.detail)`, builds a *new* `ErrorResponse` with `code=INTERNAL_SERVER_ERROR` (per the status-code mapping fallback) and the stringified dict as the message, and returns:

```json
{"error": {"code": "INTERNAL_SERVER_ERROR", "message": "{'error': {'code': 'INVALID_ZIP', ...}}", "detail": {}}}
```

Three things wrong: (a) the status code 422 isn't in `_HTTP_STATUS_TO_ERROR_CODE` for the right reason — it maps 422 to `VALIDATION_ERROR`, but the *actual* error code (`INVALID_ZIP`, `METADATA_PARSE_ERROR`, etc.) is buried in the stringified message; (b) the message field is a Python dict-repr, unreadable; (c) the typed code the service tried to send is dropped on the floor.

**Solution.** Replace `_raise_422()` with a typed-exception pattern, mirroring the recommendation in Report 1 Issue 9. Define a `DomainError(HTTPException)` class that carries the `ErrorCode` directly:

```python
class DomainError(HTTPException):
    def __init__(self, code: ErrorCode, message: str, status_code: int = 422,
                 detail: dict | None = None):
        self.error_code = code
        self.error_detail = detail or {}
        super().__init__(status_code=status_code, detail=message)
```

Update `http_exception_handler` to detect a `DomainError` and read `exc.error_code` / `exc.error_detail` directly. The status-code-based fallback applies only to non-domain `HTTPException`s.

Then in `services/ingestion.py`:

```python
raise DomainError(
    code=ErrorCode.INVALID_ZIP,
    message=f"Archive is not a valid ZIP file: {exc}",
    status_code=422,
)
```

**Verification.** Integration test against the upload endpoint with a malformed ZIP body:

```python
async def test_invalid_zip_returns_proper_envelope(client):
    r = await client.post(
        "/api/v1/composers/test/corpora/test/upload",
        files={"archive": ("bad.zip", b"not a zip", "application/zip")},
    )
    assert r.status_code == 422
    body = r.json()
    assert body["error"]["code"] == "INVALID_ZIP"
    assert "ZIP file" in body["error"]["message"]
    assert body["error"].get("detail") == {} or "errors" not in body["error"]["detail"]
```

This test will fail today and reveals the double-wrap. Fixing it confirms the issue is resolved.

---

## Issue 3: Unused import in `services/ingestion.py`

**[SOLVED]**

**Issue.** Line 37: `from models.analysis import MovementAnalysis`. Never referenced in the file. Ruff (`F401`) would catch this. Either Ruff isn't running over this file in CI, or the rule is disabled.

**Solution.** Delete the import. Verify Ruff config (`pyproject.toml`) includes `F401` and runs over `backend/services/`.

**Verification.** `ruff check backend/services/ingestion.py` reports zero errors. Add a CI step that fails on unused imports.

---

## Issue 4: Top-level docstring in `services/ingestion.py` lists six pipeline steps; code does seven

**[SOLVED]**

**Issue.** The module docstring (lines 1–18) describes the pipeline as ending with: *"7. Dispatch one Celery analysis-ingestion task per accepted movement."* But the actual code (lines 315–323) dispatches **two** tasks per movement: `ingest_movement_analysis` and `generate_incipit`. The docstring predates the Component 2 incipit work and was never updated. New readers will assume only one task is dispatched and miss the incipit pipeline entirely.

**Solution.** Update the docstring:

```
7. Dispatch two Celery tasks per accepted movement:
   - ingest_movement_analysis (DCML harmony parsing)
   - generate_incipit (Verovio first-page SVG render)
```

**Verification.** Doc review against `for entry in dispatch_entries: ...` block. Add a comment at the dispatch site referencing the docstring step number.

---

## Issue 5: Top-level docstring in `services/mei_validator.py` mis-describes check 5

**[SOLVED]**

**Issue.** Lines 4–6:

> Hard failures (checks 1, 2, 5) short-circuit immediately; advisory checks (3, 4) collect all findings before returning.

Check 5 (lines 263–272) does **not** short-circuit. It appends to `errors` and the function returns normally. The implementation comment at line 119 even acknowledges this: *"Check 5 appends to the error list without short-circuiting so that check 4 still runs."* So check 5 is a hard failure (because empty notes/rests means an unusable MEI) but it doesn't short-circuit — these are independent properties.

**Solution.** Rephrase the docstring:

> Checks 1 and 2 short-circuit on failure (no further checks run). Checks 3, 4, and 5 are non-short-circuiting: they all run regardless. Check 5 produces an error (not a warning) if no notes or rests exist; the file is still considered invalid.

**Verification.** Doc review. Optional: add a unit test that confirms checks 3 and 4 still run when check 5 is going to fail (e.g. a file with measure-number gaps AND no notes), and that the report contains issues from all three.

---

## Issue 6: `_dcml_branch` holds an open Postgres transaction across an S3 read

**[SOLVED]**

**Issue.** `services/tasks/ingest_analysis.py` lines 636–751 wrap the entire branch in `async with session.begin():`. Inside that transaction, line 657 does:

```python
mei_bytes = await storage.get_mei(mei_object_key)
```

This is a network round-trip to S3/MinIO held inside an open Postgres transaction. If MinIO is slow, the Postgres transaction stays open, holding row locks longer than necessary and tying up a connection pool slot. For a single-tenant Phase 1 worker this is inert; under any concurrency it becomes a real problem.

**Solution.** Two-phase approach:

```python
# Phase 1: read what we need from Postgres, exit transaction.
async with factory() as session:
    row = (await session.execute(...)).one_or_none()
    if row is None: ...
    mei_object_key = row.mei_object_key
    existing_key_sig = row.key_signature

# Phase 2: external I/O + parsing, no DB transaction.
mei_bytes = await storage.get_mei(mei_object_key)
events, _phrase, alignment_warnings = _parse_dcml_harmonies(...)
# ... key resolution ...

# Phase 3: writes, in a fresh transaction.
async with factory() as session:
    async with session.begin():
        # backfill key_signature, upsert movement_analysis, store warnings
```

**Verification.** Hard to test directly (requires concurrent ingestion), but a logging-based check works: log the duration between transaction begin and commit. After the fix, the duration should be milliseconds; before, it scales with S3 latency. Worth adding a structured-log field `dcml_branch.transaction_ms`.

---

## Issue 7: `make_storage_client()` is constructed at the route layer, not injected

**[SOLVED]**

**Issue.** CONTRIBUTING.md says route handlers should be thin and delegate to services. But two routes construct service dependencies in the handler:

- `routes/browse.py` line 154: `storage = make_storage_client()`
- `routes/corpora.py` line 59: `storage = make_storage_client()`

Inside the routes, `storage` sits next to `db: AsyncSession = Depends(get_db)` — one is injected via `Depends`, the other isn't. This makes integration tests harder (can't override `make_storage_client` via FastAPI's dependency-override system), is inconsistent with the surrounding `Depends(...)` style, and bloats the handler.

**Solution.** Add a dependency function:

```python
# api/dependencies.py
def get_storage() -> StorageClient:
    return make_storage_client()
```

Update the routes:

```python
async def get_movements(
    work_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    storage: StorageClient = Depends(get_storage),
) -> list[MovementResponse]:
    ...
```

Tests can then override `app.dependency_overrides[get_storage] = lambda: fake_storage`.

**Verification.** Integration test uses `app.dependency_overrides[get_storage]` to inject a `MagicMock` storage. Existing test in `tests/integration/test_browse_api.py` should still pass after the refactor — if it doesn't, the dependency wiring needs review.

---

## Issue 8: `_normalize_pickup_bar` keeps an unused `_warnings` parameter "for signature uniformity" that the other passes don't follow

**[SOLVED]**

**Issue.** `services/mei_normalizer.py` line 161 docstring says `_warnings: Not used by this pass; kept for signature uniformity.` But the other passes have varying signatures: some take `(root, changes_applied)`, some `(root, warnings)`, some `(root, changes_applied, warnings)`. There is no signature uniformity to preserve.

**Solution.** Either:

1. Drop the unused `_warnings` parameter from `_normalize_pickup_bar`. Each pass declares only what it uses. Cleanest.
2. Genuinely make all seven passes have the same `(root, changes_applied, warnings)` signature, and rename the parameter without the leading underscore. More verbose but lets you treat the passes uniformly (e.g. a list of pass functions iterated by `normalize_mei`).

Option 2 is nicer if you ever want to make the pass list configurable; option 1 is a one-line fix.

**Verification.** Either way, `pytest tests/unit/test_mei_normalizer.py` (assuming such a file exists) still passes.

---

## Issue 9: `make_storage_client()` raises `KeyError` from `os.environ[...]`, but no surrounding code catches it

**[SOLVED]**

**Issue.** `services/object_storage.py` line 212–217 reads four required env vars via `os.environ[...]`. If any are missing, a `KeyError` propagates upward. At the route-handler layer, this becomes an unhandled exception → the global handler returns 500 with `INTERNAL_SERVER_ERROR`. The actual cause (missing env var) is buried in logs.

**Solution.** At application startup (in `main.py` `lifespan`), eagerly verify required env vars are set:

```python
_REQUIRED_ENV_VARS = [
    "DATABASE_URL", "NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD",
    "R2_ENDPOINT_URL", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
]
async def lifespan(app):
    missing = [v for v in _REQUIRED_ENV_VARS if not os.environ.get(v)]
    if missing:
        raise RuntimeError(f"Missing required env vars: {missing}")
    ...
```

Then `make_storage_client()` is a safe internal helper.

**Verification.** Start the app with `R2_BUCKET_NAME` unset. Before fix: app starts, first request to a route using storage returns 500. After fix: app refuses to start with a clear error. Add a unit test that uses `monkeypatch.delenv("R2_BUCKET_NAME")` and asserts the lifespan raises.

---

## Issue 10: In-function `import re as _re` inside `generate_incipit`

**[SOLVED]**

**Issue.** `services/tasks/generate_incipit.py` line 136:

```python
import re as _re
mei_text = _re.sub(r"<!--.*?-->", "", mei_bytes.decode("utf-8"), flags=_re.DOTALL)
```

`re` is a stdlib module, fast to import — but the in-function pattern, plus the `_re` alias, suggests this was hot-patched in to fix a Verovio comment-handling bug without touching the imports block. Cosmetic but distracting.

**Solution.** Move `import re` to the top of the file. Drop the `_re` alias. Add a comment near the call site explaining *why* comments are stripped (the Verovio parser bug), which is currently in an inline comment but worth promoting to a module-level note since this is unusual code.

**Verification.** Test that an MEI file with comments between the XML declaration and the root element renders successfully. The integration test for incipit generation (`tests/integration/test_generate_incipit.py`, if it exercises this path) should already cover it.

---

## Issue 11: `NormalizationReport.changes_applied` is captured by the normalizer but never persisted

**[SOLVED]**

**Issue.** `services/mei_normalizer.py` produces `NormalizationReport(changes_applied=..., warnings=..., duration_bars=...)`. In `services/ingestion.py` line 491–494:

```python
normalization_warnings: dict[str, Any] | None = (
    {"warnings": norm_report.warnings} if norm_report.warnings else None
)
```

Only `warnings` is stored. `changes_applied` is dropped on the floor. Whether this is intentional depends on intent — if `changes_applied` is meant to be silent normalization audit data, fine; but if it's meant to be visible to editorial reviewers ("this pickup bar was renumbered from 1 to 0"), it's currently invisible.

The model's docstring says `changes_applied` is "Human-readable descriptions of each auto-correction" — that wording implies a human should see it, but no human does in the current implementation.

**Solution.** Decide explicitly:

1. **Drop `changes_applied`** from `NormalizationReport` if it's not used anywhere. Less code.
2. **Persist `changes_applied`** alongside warnings:

```python
normalization_warnings = {}
if norm_report.warnings:
    normalization_warnings["warnings"] = norm_report.warnings
if norm_report.changes_applied:
    normalization_warnings["changes_applied"] = norm_report.changes_applied
normalization_warnings = normalization_warnings or None
```

3. **Surface `changes_applied`** in the `IngestionReport` returned to the uploader: make it part of `MovementAccepted`. The uploader can then verify nothing unexpected was auto-corrected.

Recommendation: option 3 — the uploader is the audience for this data.

**Verification.** Upload a fixture with a pickup bar at `@n="1"`. After ingestion, the response body should include `changes_applied: ["Pickup bar renumbered from @n='1' to @n='0'; ..."]` for that movement.

---

## Issue 12: `ingest_corpus` rolls back DB on storage failure but leaves no recovery for the inverse

**Issue.** `services/ingestion.py` lines 273–310 perform `await storage.put_mei_original(...)` and `await storage.put_mei(...)` **inside** the DB transaction. The comment (line 281) says: *"write MEI to storage inside the transaction so that any storage failure rolls back the DB writes."* This is correct.

But the inverse failure mode is unhandled. If the DB transaction commits successfully and then the **Celery dispatch** (lines 315–323) crashes — broker unreachable, Redis OOM, process kill mid-loop — the DB has rows pointing to MEI files that exist, but no `movement_analysis` row will ever be created and no incipit will ever be generated. There's no retry path; the only fix is a fresh upload.

This is a partial-failure mode that gets steadily more annoying as the corpus grows: on a re-upload the upserts happily replace the existing rows, but the analysis ingestion is no longer triggered for the *old* movements.

**Solution.** Two options, in increasing cost:

1. **Add a `pending_analysis: bool` flag to `movement`.** Set to `true` on upsert, set to `false` at the end of `ingest_movement_analysis`. A periodic worker (or admin endpoint) re-dispatches Celery tasks for any movement still flagged after N minutes. Simple and self-healing.
2. **Use a transactional outbox.** Insert a `pending_task` row into Postgres in the same transaction as the movement upsert. A Celery beat task drains the outbox. More robust, more code.

For Phase 1, option 1 is right-sized. Worth an ADR documenting the choice.

**Verification.** Manual fault injection: kill the worker between transaction commit and Celery dispatch. After the fix, the periodic worker should pick up the orphaned movement and dispatch its analysis task within N minutes.

---

## Issue 13: `_VOLTA_TSV` test fixture has no docstring explaining what it tests

**[SOLVED]**

**Issue.** `backend/tests/integration/test_corpus_ingestion.py` lines 43–56 hardcode a TSV fixture for a volta scenario. The fixture has `mc=3, mn=2, volta=2` — same `mn` as the previous row — which is correct DCML for first/second-time endings, but completely opaque to anyone who doesn't already know DCML conventions.

**Solution.** Add a comment block above `_VOLTA_TSV`:

```
# DCML synthetic fixture covering volta (first/second-time ending) handling:
# - mc 1: V chord in measure 1 (no volta)
# - mc 2: V chord in measure 2, first-time ending (volta=1)
# - mc 3: IV chord, also "measure 2" by score numbering (mn=2), second-time ending (volta=2)
# - mc 4: I chord in measure 3 (no volta)
# Tests that the parser produces both volta=1 and volta=2 events for mn=2.
```

**Verification.** Doc review.

---

## Code-quality patterns worth keeping

For balance, four patterns the service layer gets right and worth preserving as the codebase grows:

- **Per-step structured comments** in `ingest_corpus` (numbered headers `# 1. Unpack ZIP`, `# 2. Parse metadata.yaml`, etc.). Makes the function navigable despite its length.
- **Internal dataclasses for cross-step data** (`_AcceptedMovement`, `_DispatchEntry`). These are not part of the public API but make the data flow explicit.
- **Dispatch-after-commit pattern.** Celery tasks are queued *outside* the DB transaction, after commit. This is correct and not always obvious.
- **Per-pass isolation in the normalizer.** Each pass is a private function with a docstring describing the rule it enforces. Adding a new pass is a localized change.
