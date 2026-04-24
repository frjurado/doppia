"""Celery application instance for Doppia background tasks.

All task modules import ``celery_app`` from here.  The broker and result
backend are configured via environment variables so that local dev (Redis in
Docker), CI (Redis in Docker), and production (Upstash Redis or similar) all
use the same code path.

The default values point at the Redis container defined in ``docker-compose.yml``.
Override with:

- ``CELERY_BROKER_URL`` — e.g. ``redis://localhost:6379/0``
- ``CELERY_RESULT_BACKEND`` — e.g. ``redis://localhost:6379/0``
"""

from __future__ import annotations

import os
from pathlib import Path

from celery import Celery
from dotenv import load_dotenv

# Load .env from repo root so worker processes have DATABASE_URL, R2_*, etc.
# No-op if variables are already set in the environment (e.g. in production).
load_dotenv(Path(__file__).parent.parent.parent / ".env")

celery_app = Celery(
    "doppia",
    broker=os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("CELERY_RESULT_BACKEND", "redis://localhost:6379/0"),
    include=[
        "services.tasks.generate_incipit",
        "services.tasks.ingest_analysis",
    ],
)

celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
# Prevent tasks from being acknowledged before they finish, so a worker crash
# does not silently lose the task.
celery_app.conf.task_acks_late = True
