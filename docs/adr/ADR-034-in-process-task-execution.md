# ADR-034: In-process background task execution (inline dispatch mode)

**Date:** 2026-07-07
**Status:** Accepted — implemented in `backend/services/task_dispatch.py`;
all dispatch sites (`services/fragments.py`, `services/ingestion.py`,
`api/routes/admin.py`) route through it. Decided with Francisco 2026-07-07
(`docs/reports/component-9-reports/part-8-campaign-triage.md` § item 1).

---

## Context

Phase 1 deliberately deploys **no Celery worker** on staging (`fly.toml` has
only the `app` process; see the 2026-07 `chore(deploy)` commit and
`docs/deployment.md`). The reason is economic, not architectural: an idle
Celery worker polls its Redis broker continuously, and the staging broker is
metered **Upstash** — a permanently-on worker saturates the free tier doing
nothing.

The consequence surfaced during the Part 8 tagging campaign: every
`render_fragment_preview` task enqueued by a fragment submit sat in Redis
forever, so **fragments tagged against staging silently never got previews**
(`preview-regeneration-gap.md` documents the sibling gap on the re-ingest
path). The manual workaround — temporarily adding a worker process per the
runbook — is acceptable for scheduled bulk ingests but not for interactive
tagging, which happens whenever an annotator sits down.

At Phase-1 scale (single-digit annotators, one preview render ≈ a sub-second
Verovio call), a distributed task queue is capacity we do not use, priced in
broker traffic we cannot afford.

## Decision

A single dispatch point, `services/task_dispatch.dispatch_task(task,
**kwargs)`, replaces all direct `task.delay(...)` calls. The execution mode is
selected by the `TASK_EXECUTION_MODE` environment variable:

- **`inline` (default)** — the task's function runs in the API process, on a
  **single-worker thread pool**, fire-and-forget. The thread invokes the
  Celery task object directly (Celery's `called_directly` semantics:
  `self.retry` re-raises instead of scheduling a retry). No broker traffic,
  no worker, no infrastructure.
- **`celery`** — classic `task.delay()` broker dispatch, preserved for bulk
  ingest windows where a worker is deliberately brought up (deployment.md
  § "DCML corpus re-ingestion"), and for any Phase-2 scale that outgrows
  inline execution.

Design points:

- **One worker thread.** Background renders run one at a time in dispatch
  order, bounding memory (one Verovio toolkit at a time) on the 512 MB
  staging machine. The thread is non-daemon, so an in-flight task delays
  process shutdown briefly rather than being killed mid-write.
- **No inline retry.** Failures are logged and dropped. Every dispatching
  action is re-triggerable (resubmit / bar-range edit re-enqueues a preview;
  `scripts/regenerate_fragment_previews.py` and
  `POST /api/v1/admin/dispatch-pending-analysis` recover in bulk), so a lost
  render is an inconvenience, not data loss.
- **The Celery task modules are unchanged.** They keep their broker
  registration, retry policy (meaningful in celery mode), and inner async
  implementations. Inline mode calls the same code the worker would run.
- **Mode is read per dispatch** (not cached at import), so an ops toggle or a
  test monkeypatch takes effect immediately.

## Consequences

- Fragment previews, incipits, and analysis ingestion work on staging with
  zero Upstash traffic — the tagging campaign's interactive path no longer
  depends on a worker that is never running.
- A crash or deploy between HTTP response and task completion loses the
  queued inline work (Celery's `task_acks_late` durability does not apply).
  Accepted at Phase-1 scale; the recovery surfaces above cover it. Fly's
  `auto_stop_machines` stops an idle machine on a timescale of minutes, far
  longer than a render.
- A large bulk ingest in inline mode serialises its background work through
  one thread (~2 s × movements, after each upload response). Fine for the
  54-movement corpus; for bulk windows the runbook's celery mode remains the
  documented path.
- Tests that assert on `.delay()` pin `TASK_EXECUTION_MODE=celery`; inline
  behaviour is unit-tested in `tests/unit/test_task_dispatch.py`.
- ADR-017 (fire-and-forget result policy) and ADR-018 (partial-failure
  recovery) are unaffected: dispatch remains fire-and-forget in both modes,
  and `pending_analysis` recovery now *executes* inline when no worker
  exists — strictly better than re-enqueuing into an unconsumed queue.

## Alternatives considered

- **Scheduled worker windows** (cron-started Fly machine): still leaves
  interactive submits stale for hours and adds moving parts.
- **Celery broker-poll tuning** (long BRPOP timeouts, low prefetch): reduces
  but does not eliminate idle Upstash traffic; the free tier remains at risk
  under a permanently-on worker.
- **FastAPI `BackgroundTasks`**: functionally equivalent for the interactive
  path, but threads the dispatch through route signatures; the service layer
  owns dispatch today, and a service-level helper keeps it that way.
