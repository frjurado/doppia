"""Re-dispatch fragment-preview renders after a corpus re-ingestion.

Component 9, Step 9: re-ingesting a movement replaces its normalized MEI, which
invalidates the cached SVG previews of any fragment over that movement (ADR-008's
MEI-correction trigger).  Since 2026-07-07 the bulk upload path re-dispatches
``render_fragment_preview`` itself (``enqueue_preview_regeneration_for_movement``,
ADR-008 implementation note), so this script is the **ad-hoc recovery path**:
previews stranded by a pre-automation ingest, a dispatch failure, or any other
reason to force a corpus-wide re-render.

Only ``submitted`` and ``approved`` fragments carry previews; the task itself
discards anything else, so enqueuing drafts is harmless but pointless — the
default query already filters to the two active statuses.

Run this **after** re-ingestion and **after** ``verify_reingest_mc_stability.py``
reports the corpus mc-stable (a preview rendered against drifted coordinates
would only cache the wrong excerpt).

Dispatch follows ``TASK_EXECUTION_MODE`` (ADR-034).  In ``inline`` mode (the
default) each render runs **synchronously in this process** — no worker, no
broker; expect roughly a second per fragment, with progress in the log output.
In ``celery`` mode the tasks are enqueued to the broker as before, and a worker
must be running to consume them.

Usage (local, or on the Fly machine via ``fly ssh console``)::

    python scripts/regenerate_fragment_previews.py            # all corpora
    python scripts/regenerate_fragment_previews.py --dry-run  # list, render nothing

Environment variables:

    DATABASE_URL         asyncpg URL (default: the backend's local default).
    TASK_EXECUTION_MODE  inline (default) | celery — see ADR-034.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

# Ensure backend package is importable when run from project root.
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from models.base import close_db, get_db, init_db  # noqa: E402
from services.task_dispatch import dispatch_task  # noqa: E402
from services.tasks.render_fragment_preview import render_fragment_preview  # noqa: E402
from sqlalchemy import text  # noqa: E402

_DEFAULT_DB_URL = "postgresql+asyncpg://postgres:localpassword@localhost/doppia"


async def _collect_fragment_ids() -> list[str]:
    """Return the ids of all fragments eligible for a preview render.

    Returns:
        Fragment UUID strings with status ``submitted`` or ``approved``.
    """
    async for db in get_db():
        rows = (
            await db.execute(
                text(
                    "SELECT id FROM fragment "
                    "WHERE status IN ('submitted', 'approved') "
                    "ORDER BY id"
                )
            )
        ).fetchall()
        return [str(r.id) for r in rows]
    return []


async def _collect() -> list[str]:
    """Open the DB, collect eligible fragment ids, and close the DB.

    Returns:
        Fragment UUID strings eligible for a preview render.
    """
    init_db(os.getenv("DATABASE_URL", _DEFAULT_DB_URL))
    try:
        return await _collect_fragment_ids()
    finally:
        await close_db()


def _dispatch(fragment_ids: list[str]) -> int:
    """Dispatch a preview render per fragment, per TASK_EXECUTION_MODE.

    Runs in sync context deliberately: with no running event loop, inline
    dispatch executes each render in place, one at a time, so the script only
    returns when every render has actually completed (ADR-034's no-loop
    fallback). In celery mode this enqueues to the broker exactly as before.

    Args:
        fragment_ids: Fragment UUID strings to re-render.

    Returns:
        Number of fragments successfully dispatched. Inline render failures
        are logged by the dispatcher (and the task itself) rather than
        counted here — grep the output for ``ERROR``.
    """
    dispatched = 0
    for fid in fragment_ids:
        try:
            dispatch_task(render_fragment_preview, fragment_id=fid)
            dispatched += 1
        except Exception as exc:  # celery mode: broker unreachable
            print(f"  ! could not dispatch {fid}: {exc}", file=sys.stderr)
    return dispatched


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List eligible fragments without dispatching render tasks.",
    )
    args = parser.parse_args()

    # Surface the dispatcher's and the render task's INFO/ERROR lines —
    # in inline mode they are the per-fragment progress report.
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )

    fragment_ids = asyncio.run(_collect())

    if not fragment_ids:
        print("No submitted/approved fragments found — nothing to re-render.")
        sys.exit(0)

    print(f"{len(fragment_ids)} fragment(s) eligible for preview re-render:")
    for fid in fragment_ids:
        print(f"  {fid}")

    if args.dry_run:
        print("\n[DRY RUN] nothing dispatched.")
        sys.exit(0)

    dispatched = _dispatch(fragment_ids)
    print(f"\nDispatched {dispatched}/{len(fragment_ids)} preview render(s).")
    sys.exit(0 if dispatched == len(fragment_ids) else 1)


if __name__ == "__main__":
    main()
