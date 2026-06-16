"""Re-dispatch fragment-preview renders after a corpus re-ingestion.

Component 9, Step 9: re-ingesting a movement replaces its normalized MEI, which
invalidates the cached SVG previews of any fragment over that movement (ADR-008's
MEI-correction trigger).  The bulk upload path re-dispatches ``generate_incipit``
and ``ingest_movement_analysis`` but not ``render_fragment_preview`` — previews
are normally re-rendered only on a per-fragment submit/range-edit.  This script
closes that gap for a re-ingestion: it enqueues ``render_fragment_preview`` for
every fragment whose status warrants a preview.

Only ``submitted`` and ``approved`` fragments carry previews; the task itself
discards anything else, so enqueuing drafts is harmless but pointless — the
default query already filters to the two active statuses.

Run this **after** re-ingestion and **after** ``verify_reingest_mc_stability.py``
reports the corpus mc-stable (a preview rendered against drifted coordinates
would only cache the wrong excerpt).  A Celery worker and the Redis broker must
be running.

Usage (local)::

    python scripts/regenerate_fragment_previews.py            # all corpora
    python scripts/regenerate_fragment_previews.py --dry-run  # list, enqueue nothing

Environment variables:

    DATABASE_URL    asyncpg URL (default: the backend's local default).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Ensure backend package is importable when run from project root.
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from models.base import close_db, get_db, init_db  # noqa: E402
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


async def _run(dry_run: bool) -> int:
    """Collect eligible fragments and enqueue preview renders.

    Args:
        dry_run: When true, list the fragments without enqueuing tasks.

    Returns:
        Process exit code (0 on success).
    """
    init_db(os.getenv("DATABASE_URL", _DEFAULT_DB_URL))
    try:
        fragment_ids = await _collect_fragment_ids()
    finally:
        await close_db()

    if not fragment_ids:
        print("No submitted/approved fragments found — nothing to re-render.")
        return 0

    print(f"{len(fragment_ids)} fragment(s) eligible for preview re-render:")
    for fid in fragment_ids:
        print(f"  {fid}")

    if dry_run:
        print("\n[DRY RUN] no tasks enqueued.")
        return 0

    enqueued = 0
    for fid in fragment_ids:
        try:
            render_fragment_preview.delay(fid)
            enqueued += 1
        except Exception as exc:  # broker unreachable
            print(f"  ! could not enqueue {fid}: {exc}", file=sys.stderr)
    print(f"\nEnqueued {enqueued}/{len(fragment_ids)} preview render task(s).")
    return 0 if enqueued == len(fragment_ids) else 1


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List eligible fragments without enqueuing render tasks.",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(_run(args.dry_run)))


if __name__ == "__main__":
    main()
