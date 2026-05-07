"""Celery application instance for Doppia background tasks.

All task modules import ``celery_app`` from here.  The broker is configured via
environment variables so that local dev (Redis in Docker), CI, and production
(Upstash Redis) all use the same code path.

Both current tasks (``generate_incipit``, ``ingest_analysis``) are fire-and-forget:
no caller ever reads their results.  The result backend is therefore disabled
(``task_ignore_result = True``) to avoid unnecessary Redis commands.  See
ADR-017 for the full rationale.

Override with:

- ``CELERY_BROKER_URL`` — broker URL (default: ``redis://localhost:6379/0``)
  - Local / CI: local Redis container (no quota cost)
  - Production only: ``rediss://<upstash-url>`` (TLS, Upstash)
- ``CELERY_RESULT_BACKEND`` — set to ``cache+memory://`` in all non-production
  environments; only enable a real Redis backend if a monitoring tool requires it.
"""

from __future__ import annotations

import os
import ssl
from pathlib import Path

from celery import Celery
from dotenv import load_dotenv

# Load .env from repo root so worker processes have DATABASE_URL, R2_*, etc.
# No-op if variables are already set in the environment (e.g. in production).
load_dotenv(Path(__file__).parent.parent.parent / ".env")

celery_app = Celery(
    "doppia",
    broker=os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("CELERY_RESULT_BACKEND", "cache+memory://"),
    include=[
        "services.tasks.generate_incipit",
        "services.tasks.ingest_analysis",
    ],
)

# Tasks are fire-and-forget; no caller ever reads results back (ADR-017).
celery_app.conf.task_ignore_result = True

celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
# Prevent tasks from being acknowledged before they finish, so a worker crash
# does not silently lose the task.
celery_app.conf.task_acks_late = True
celery_app.conf.broker_connection_retry_on_startup = True

# When the broker URL uses TLS (rediss://), disable strict certificate
# verification. Upstash uses SNI-based certificates that fail Python's default
# strict check, causing "Connection closed by server" errors on the worker.
# This only applies in production; local dev uses plain redis://.
_broker_url = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
if _broker_url.startswith("rediss://"):
    _ssl_opts = {"ssl_cert_reqs": ssl.CERT_NONE}
    celery_app.conf.broker_use_ssl = _ssl_opts
