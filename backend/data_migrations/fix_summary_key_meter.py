"""Backfill fragment.summary.key / summary.meter from the movement record.

**Not a schema-version migration.** ``summary`` stays at version 1: this repairs
*values* that were written wrong, it does not change the field structure, so no
``version`` bump is warranted (see fragment-schema.md § versioning policy).

The defect (M6, Component 11 Step 10): the tagging tool derived these two fields
by parsing the MEI, reading ``key.sig`` / ``meter.count`` attributes off the
first ``<scoreDef>``. The corpus MEI carries no attributes there at all — key and
meter live in ``<keySig>`` / ``<meterSig>`` children of ``<staffDef>`` — so every
parse fell through to its defaults and stamped **every fragment in the corpus**
with ``"C major"`` / ``"4/4"``. Six of the eight movements carrying fragments are
neither.

**Key and meter come from different places, and that is the point.** ``key`` comes
from the movement record: the MEI encodes ``<keySig sig="4f"/>`` with no mode,
which is A-flat major and F minor alike, so it *cannot* be derived and has to be
curated. ``meter`` is fully derivable, and curating it went badly — 21 of 54
movements carried a meter their own notation contradicted (Track M18), and an
earlier run of this script copied those into 76 fragments. It now reads the meter
from the MEI, at the fragment's **own** measure rather than the movement's first:
a fragment sits at one place, and two movements in the corpus change meter
mid-piece. The movement record is the fallback for an unreadable MEI.

Only rows that actually disagree are touched, and only when the value is known; a
movement with a null ``key_signature``, or with no meter anywhere, leaves its
fragments alone rather than writing a null into ``summary``.

Idempotent: re-running after a successful run reports zero changes.

Usage::

    DATABASE_URL="postgresql+asyncpg://doppia:doppia@localhost:5432/doppia" \\
        python backend/data_migrations/fix_summary_key_meter.py --dry-run
    DATABASE_URL="..." python backend/data_migrations/fix_summary_key_meter.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.mei_meter import meter_at_mc  # noqa: E402
from services.object_storage import make_storage_client  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402


async def _run(dry_run: bool) -> int:
    """Repair every fragment whose summary key/meter disagrees with its movement.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code (always 0; a failure raises).
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    changed = 0
    checked = 0
    mei_cache: dict[str, str | None] = {}
    try:
        storage = make_storage_client()
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT f.id, f.summary, f.mc_start, m.key_signature, m.meter,
                               m.mei_object_key,
                               w.slug || '/' || m.slug AS slug
                          FROM fragment f
                          JOIN movement m ON m.id = f.movement_id
                          JOIN work w ON w.id = m.work_id
                         ORDER BY slug, f.mc_start
                        """
                    )
                )
            ).all()

            async def _mei(key: str) -> str | None:
                """Fetch and cache a movement's MEI; None when unreadable."""
                if key not in mei_cache:
                    try:
                        raw = await storage.get_mei(key)
                        mei_cache[key] = (
                            raw.decode("utf-8") if isinstance(raw, bytes) else raw
                        )
                    except Exception:  # noqa: BLE001 — fall back to movement.meter
                        mei_cache[key] = None
                return mei_cache[key]

            for row in rows:
                checked += 1
                summary = row.summary
                if isinstance(summary, str):
                    summary = json.loads(summary)
                if not isinstance(summary, dict):
                    continue

                # A fragment sits at one place in the movement, so it takes the
                # meter in force *there* — which differs from the movement's
                # opening meter only in the two movements that change mid-piece
                # (M18, and Francisco's point when it was found). Falls back to
                # the movement record when the MEI cannot be read.
                xml = await _mei(row.mei_object_key)
                local_meter = meter_at_mc(xml, row.mc_start) if xml else None
                meter = local_meter or row.meter

                updates: dict[str, str] = {}
                if row.key_signature and summary.get("key") != row.key_signature:
                    updates["key"] = row.key_signature
                if meter and summary.get("meter") != meter:
                    updates["meter"] = meter
                if not updates:
                    continue

                changed += 1
                before = f"{summary.get('key')!r}/{summary.get('meter')!r}"
                after = (
                    f"{updates.get('key', summary.get('key'))!r}/"
                    f"{updates.get('meter', summary.get('meter'))!r}"
                )
                print(f"  {row.slug:20} {row.id}  {before} -> {after}")

                if dry_run:
                    continue
                # Merge into the existing JSONB rather than replacing it, so no
                # other summary field can be lost by this repair.
                await session.execute(
                    text(
                        "UPDATE fragment SET summary = summary || CAST(:patch AS jsonb),"
                        "       updated_at = now()"
                        " WHERE id = :id"
                    ),
                    {"patch": json.dumps(updates), "id": row.id},
                )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    print(f"\n{checked} fragment(s) checked; {changed} needed repair.")
    if dry_run:
        print("[dry-run] nothing written.")
    return 0


def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Repair fragment.summary key/meter from the movement record (M6)."
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Report without writing."
    )
    args = parser.parse_args()

    if "DATABASE_URL" not in os.environ:
        print("Error: DATABASE_URL environment variable is not set.", file=sys.stderr)
        sys.exit(1)
    sys.exit(asyncio.run(_run(args.dry_run)))


if __name__ == "__main__":
    main()
