"""Backfill incipit generation for movements missing incipit_object_key.

Queries all ``movement`` rows where ``incipit_object_key IS NULL`` and enqueues
``generate_incipit`` for each.  Requires the Celery worker and Redis to be
running (start with ``docker compose up`` or ``celery -A services.celery_app
worker``).

Usage::

    # From the repo root, with the venv active and Docker stack running:
    DATABASE_URL="postgresql+asyncpg://doppia:doppia@localhost:5432/doppia" \\
        python scripts/backfill_incipits.py

    # Dry-run — print movement IDs without dispatching:
    DATABASE_URL="..." python scripts/backfill_incipits.py --dry-run

Environment variables:

- ``DATABASE_URL`` — async-compatible PostgreSQL URL
  (``postgresql+asyncpg://user:pass@host:port/db``).
- ``CELERY_BROKER_URL`` — Redis broker URL; defaults to
  ``redis://localhost:6379/0`` (matches docker-compose.yml).

This is a one-time ops script, not part of the normal ingestion pipeline.
See docs/roadmap/component-2-corpus-browsing.md §Step 4.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Bootstrap sys.path so backend packages are importable when running directly
# from the repo root.  When pytest imports this module (scripts/ is already on
# pythonpath), the insert is a harmless no-op.
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402

from services.tasks.generate_incipit import generate_incipit  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Parsed namespace with ``dry_run``.
    """
    parser = argparse.ArgumentParser(
        description=(
            "Enqueue generate_incipit for every movement missing incipit_object_key."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print movement IDs without dispatching any tasks.",
    )
    return parser.parse_args()


async def _fetch_pending_ids() -> list[str]:
    """Return UUIDs of movements where incipit_object_key IS NULL.

    Returns:
        List of movement ID strings (UUID format).

    Raises:
        KeyError: If ``DATABASE_URL`` is not set in the environment.
    """
    database_url = os.environ["DATABASE_URL"]
    engine = create_async_engine(database_url, pool_pre_ping=True)
    try:
        async with AsyncSession(engine) as session:
            result = await session.execute(
                text("SELECT id FROM movement WHERE incipit_object_key IS NULL")
            )
            return [str(row.id) for row in result.all()]
    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Query pending movements and enqueue generate_incipit for each."""
    args = _parse_args()

    try:
        pending_ids = asyncio.run(_fetch_pending_ids())
    except KeyError:
        print(
            "Error: DATABASE_URL environment variable is not set.\n"
            "Example: DATABASE_URL='postgresql+asyncpg://doppia:doppia@localhost:5432/doppia'"
            " python scripts/backfill_incipits.py",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Found {len(pending_ids)} movement(s) without incipits.")

    if not pending_ids:
        return

    if args.dry_run:
        for movement_id in pending_ids:
            print(f"  [dry-run] {movement_id}")
        return

    for movement_id in pending_ids:
        generate_incipit.delay(movement_id=movement_id)
        print(f"  Enqueued {movement_id}")

    print("Done. Monitor the Celery worker for task progress.")


if __name__ == "__main__":
    main()
