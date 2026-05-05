# ADR-017: Celery broker and result-backend configuration

**Status:** Accepted  
**Date:** 2026-05-05

## Context

Doppia uses Celery for two fire-and-forget background tasks (`generate_incipit`, `ingest_analysis`). In staging, both `CELERY_BROKER_URL` and `CELERY_RESULT_BACKEND` were pointing at the Upstash Redis instance. This caused the free-tier monthly quota (500 000 commands) to be exhausted within a single month of light manual testing, because:

1. **Worker polling.** An idle Celery worker issues a `BRPOP` against the broker every 1–2 seconds waiting for new tasks. Upstash counts each poll as a command.
2. **Heartbeats.** Workers write a heartbeat to the broker every 2 seconds by default.
3. **Result backend writes.** Celery stores every task result in Redis even though no caller ever reads them back (the tasks are fire-and-forget). No `result_expires` was set, so results accumulated indefinitely.

## Decision

### 1. Disable the result backend

Neither task's result is ever read by the application. The result backend provides no value and generates unnecessary Redis traffic.

Add to `backend/services/celery_app.py`:

```python
celery_app.conf.task_ignore_result = True
```

Set `CELERY_RESULT_BACKEND` to `cache+memory://` in all non-production environments. In production, the same setting is correct unless a monitoring tool (e.g. Flower) requires result persistence — in which case use a short `result_expires` (e.g. 3600 seconds).

### 2. Use local Redis as the broker in development and staging

Upstash is pay-per-command. A local Redis container (already present in `docker-compose.yml`) has no such limit and is appropriate for all non-production traffic.

- **Local dev:** `CELERY_BROKER_URL=redis://localhost:6379/0` (the default in `celery_app.py` — no override needed).
- **Staging:** ensure `CELERY_BROKER_URL` points at a non-Upstash Redis instance. The simplest option is a dedicated free-tier Redis instance on Render or Railway, or a small persistent Redis on the same host.
- **Production only:** `CELERY_BROKER_URL=rediss://<upstash-url>` (TLS, Upstash).

### 3. Reduce heartbeat interval (optional, low priority)

If a worker must run against a metered Redis, add:

```python
celery_app.conf.broker_heartbeat = 30  # seconds (default is 2)
```

This is not needed once the broker is separated from Upstash, but is a useful guard if the environments ever converge again.

## Consequences

- Upstash command usage drops to near zero outside production.
- Task result history is no longer persisted, which is acceptable given the current fire-and-forget dispatch pattern.
- If a future feature needs to poll task status (e.g. a progress indicator in the UI), the result backend will need to be re-enabled with a short TTL — at that point, revisit this ADR.
