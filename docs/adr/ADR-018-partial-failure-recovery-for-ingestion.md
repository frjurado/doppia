# ADR-018 — Partial-failure recovery for ingestion: `pending_analysis` flag

**Status:** Accepted  
**Date:** 2026-05-10  

> **Note (2026-07-07, ADR-034):** the premise "no worker is deployed, so all dispatch
> calls fail silently" no longer holds — ADR-034's inline mode executes dispatched
> tasks in the API process by default, so uploads normally complete their analysis
> without a worker. The `pending_analysis` flag and the admin re-dispatch endpoint
> remain the recovery surface for the failure modes that survive (inline task failure,
> crash between response and task completion, celery-mode broker outages).

**Refs:** Report 2 Issue 12; `docs/roadmap/component-4-knowledge-graph.md` § Step 3

---

## Context

The corpus upload pipeline (Step 7 of `component-1-mei-corpus-ingestion.md`) is structured as:

1. DB transaction commits: composer, corpus, work, and movement rows are upserted; MEI files are written to R2 inside the transaction so that any storage failure rolls back the DB writes.
2. Outside the transaction, two Celery tasks are dispatched per movement:
   - `ingest_movement_analysis` — DCML/WhenInRome harmony parsing
   - `generate_incipit` — Verovio first-page SVG render

Step 2 can fail silently. `services/ingestion.py` catches dispatch exceptions and logs a warning so that storage and DB rows are preserved even when the broker is unavailable. However, this means a movement row can exist with its MEI in R2 but with no `movement_analysis` row and no incipit — permanently, unless the operator re-uploads the ZIP or the tasks are re-dispatched manually.

In Phase 1 staging, **every uploaded movement is in this state**: no Celery worker is deployed (ADR-017 §2; `deployment.md`), so all dispatch calls fail silently. Once a worker comes online, the same failure mode applies to any upload that races a broker restart.

The inverse case — storage write succeeds but DB commit fails — is impossible by construction: storage writes happen *inside* the DB transaction, so a DB rollback guarantees R2 objects are orphaned (known acceptable by ADR-002), never the reverse.

### Options considered

**Option A — `pending_analysis` boolean flag on `movement`.**
Set `TRUE` on every INSERT and every re-ingest (on_conflict_do_update). Cleared to `FALSE` only when `ingest_movement_analysis` completes successfully. A `POST /api/v1/admin/dispatch-pending-analysis` endpoint re-enqueues tasks for all `pending_analysis = TRUE` rows.

*Pros:* Flag is the canonical "needs analysis" signal across all failure modes. Partial index keeps query cost negligible at corpus scale. Admin can retry without re-uploading ZIPs (for non-DCML corpora). Natural extension point for a periodic Celery Beat re-dispatch in Phase 2.

*Cons:* Does not address the missing harmonies problem for DCML corpora (see Consequences). Re-dispatch endpoint is a manual trigger, not automated.

**Option B — Transactional outbox pattern.**
Store a `pending_task` row in the same DB transaction as the movement upsert; a background poller drains the table and dispatches tasks, then deletes the row.

*Pros:* Fully automatic; no operator action required.
*Cons:* Significant complexity for Phase 1 traffic volumes. Requires a persistent poller process that doesn't exist in the current architecture. Out of scope until Phase 3+.

**Option C — Store harmonies in R2 alongside MEI.**
Write the harmonies TSV to R2 at upload time so that re-dispatch can re-read it.

*Pros:* Enables fully automated re-dispatch for DCML corpora.
*Cons:* Not explicitly modelled in ADR-002's key convention. Phase 1 has one DCML corpus; the benefit is low now. Can be added independently later; the `pending_analysis` flag is still useful regardless.

---

## Decision

**Option A** is adopted for Phase 1.

- `pending_analysis BOOLEAN NOT NULL DEFAULT TRUE` is added to `movement` (migration 0007).
- `_upsert_movement` in `services/ingestion.py` sets `pending_analysis = TRUE` on every INSERT and every re-ingest.
- `_dcml_branch` in `services/tasks/ingest_analysis.py` sets `pending_analysis = FALSE` in the same transaction that writes `movement_analysis`. If the task fails at any point before that write, the flag stays `TRUE`.
- `POST /api/v1/admin/dispatch-pending-analysis` (admin role) queries `movement WHERE pending_analysis = TRUE`, dispatches `ingest_movement_analysis.delay(...)` for each, and returns `{dispatched: N, failed_to_dispatch: [...]}`.

Option B (transactional outbox) is noted as the natural evolution once the corpus grows and periodic re-dispatch becomes load-bearing. It is not implemented now.

Option C (store harmonies in R2) is deferred. The DCML harmonies TSV is not available at re-dispatch time; the re-dispatch endpoint will succeed in enqueuing the task but the task will fail with `ValueError: harmonies_tsv_content is required`. The proper recovery path for DCML movements in Phase 1 is to re-upload the corpus ZIP.

---

## Consequences

**What becomes true:**

- Every movement row has a `pending_analysis` flag that truthfully answers "does this movement need analysis?"
- After a broker restart or worker deploy, the operator runs `POST /admin/dispatch-pending-analysis` once to backfill all outstanding movements.
- Re-ingest (re-uploading a corpus ZIP) resets `pending_analysis = TRUE`, ensuring the analysis re-runs against the fresh MEI.
- A partial index (`WHERE pending_analysis = TRUE`) keeps the query cheap as the corpus grows toward its steady-state where nearly all rows are `FALSE`.

**Limitations:**

- DCML corpora: re-dispatch without re-upload does not produce a successful analysis, because `harmonies_tsv_content` is not stored outside the ZIP. The task is dispatched, fails at the worker, and `pending_analysis` stays `TRUE`. This is acceptable in Phase 1; the operator re-uploads.
- No automatic periodic re-dispatch in Phase 1. The flag is purely a signal; acting on it requires the operator to call the endpoint. Periodic Celery Beat dispatch is noted as a Phase 2+ extension.
- `generate_incipit` does not have an equivalent flag. Incipits are generated independently of analysis; a missing incipit does not set `pending_analysis`. A separate `pending_incipit` flag or a similar re-dispatch endpoint for incipits may be added when Phase 2 requires it.
