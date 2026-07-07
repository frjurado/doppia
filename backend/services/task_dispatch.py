"""Fire-and-forget background task dispatch — inline or Celery (ADR-034).

Phase 1 runs no Celery worker in staging (the worker's broker polling would
saturate the metered Upstash free tier — see ``docs/deployment.md``), so tasks
enqueued with ``.delay()`` were never consumed and user-visible artefacts
(fragment previews, incipits) silently never materialised. This module is the
single dispatch point that fixes that: callers hand it the Celery task object
and its kwargs, and the execution mode decides where the work runs.

Modes (``TASK_EXECUTION_MODE`` environment variable):

- ``inline`` (default) — run the task's function in the API process, on a
  single-worker thread pool, fire-and-forget. The thread runs the task
  callable directly (Celery executes bound tasks with ``called_directly``
  semantics: ``self.retry`` re-raises instead of retrying). One worker thread
  bounds memory (one Verovio toolkit at a time) and preserves enqueue order.
- ``celery`` — classic broker dispatch via ``task.delay()``. Used for bulk
  ingest windows where a worker is deliberately brought up (see
  ``docs/deployment.md`` § "Running the analysis pipeline on staging").

Inline failures are logged and dropped — no retry. The interactive paths that
dispatch here are all re-triggerable (a fragment edit or resubmit re-enqueues
its preview; ``scripts/regenerate_fragment_previews.py`` recovers in bulk), so
a lost render is an inconvenience, not data loss. ADR-034 records the
trade-off.
"""

from __future__ import annotations

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from celery import Task
from celery.exceptions import Ignore

logger = logging.getLogger(__name__)

# Single worker: background renders run one at a time, in dispatch order,
# bounding memory (one Verovio toolkit) on the 512 MB staging machine.
# Threads are non-daemon, so an in-flight task delays interpreter shutdown
# until it finishes rather than being killed mid-write.
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="task-dispatch")

_VALID_MODES = frozenset({"inline", "celery"})


def task_execution_mode() -> str:
    """Return the active task execution mode (``inline`` or ``celery``).

    Read from the ``TASK_EXECUTION_MODE`` environment variable on every call
    (not cached) so tests and ops toggles take effect immediately. Unknown
    values fall back to ``inline`` with a warning rather than failing the
    request that triggered the dispatch.
    """
    mode = os.environ.get("TASK_EXECUTION_MODE", "inline")
    if mode not in _VALID_MODES:
        logger.warning(
            "task_dispatch: unknown TASK_EXECUTION_MODE %r — falling back to 'inline'",
            mode,
        )
        return "inline"
    return mode


def dispatch_task(task: Task, **kwargs: Any) -> asyncio.Future | None:
    """Dispatch a fire-and-forget background task per the execution mode.

    Args:
        task: The Celery task object (e.g. ``render_fragment_preview``).
        kwargs: Keyword arguments for the task. Keyword-only by design so the
            two modes (``task.delay(**kwargs)`` / ``task(**kwargs)``) receive
            identical call shapes.

    Returns:
        The ``asyncio.Future`` tracking the inline execution (useful in
        tests to await completion), or ``None`` in ``celery`` mode and in the
        no-running-loop synchronous fallback.

    Raises:
        Exception: In ``celery`` mode only, broker errors propagate from
            ``task.delay()`` (callers on the ingest path already guard this).
            Inline mode never raises — failures are logged in the worker
            thread.
    """
    if task_execution_mode() == "celery":
        task.delay(**kwargs)
        return None

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No event loop (sync script context): run in place, still swallowing
        # task errors — dispatch is fire-and-forget in every mode.
        _run_task_sync(task, kwargs)
        return None

    return loop.run_in_executor(_EXECUTOR, _run_task_sync, task, kwargs)


def _run_task_sync(task: Task, kwargs: dict[str, Any]) -> None:
    """Execute a Celery task callable in place, containing every failure.

    Runs on the dispatch executor thread (or synchronously in the no-loop
    fallback). The task bodies call ``asyncio.run()`` internally, which is
    safe here because this thread has no running event loop.
    """
    try:
        task(**kwargs)
    except Ignore:
        # The task discarded itself (row missing / wrong status) — expected.
        logger.info("task_dispatch: %s ignored its input %r", task.name, kwargs)
    except Exception:
        logger.exception(
            "task_dispatch: inline %s failed for %r — dropped (no inline retry; "
            "re-trigger via the originating action or the recovery script)",
            task.name,
            kwargs,
        )
