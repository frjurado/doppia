"""Set ``movement.meter`` from each movement's own notation (Track M18).

**Not a schema migration.** It repairs *values*, so no ``summary`` version bump
(fragment-schema.md § versioning policy) — and it does not touch ``summary`` at
all. Run ``fix_summary_key_meter.py`` afterwards to carry the corrected meter into
the fragments that display it.

The defect: ``meter`` was hand-entered per movement in the corpus TOML manifests
(``scripts/dcml_corpora/*.toml``). An audit against the MEI found **21 of 54
movements disagreed with their own score** — K279/iii carried 3/8 for a movement
in 2/4, K281/iii carried 2/4 for one in alla breve, and so on. Every MEI value
checked against the repertoire was right and every disagreement was the manifest's
fault, which is what you would expect: the MEI is the notation, and the manifest
was a person typing.

Beat coordinates were never affected — the ghost layer parses the MEI, so tagging
always used the true meter — but anything reading ``movement.meter`` was misled,
including ``fix_summary_key_meter.py``, which faithfully copied the wrong value
into 76 fragments' summaries.

The movement record takes the meter the movement *opens* in; a fragment takes the
meter in force where it sits (see ``services.mei_meter``), which differs only in
the two movements that change meter mid-piece.

Idempotent: re-running after a successful run reports zero changes.

Usage::

    DATABASE_URL="postgresql+asyncpg://…" \\
        python backend/data_migrations/fix_movement_meter.py --dry-run
    DATABASE_URL="…" python backend/data_migrations/fix_movement_meter.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.mei_meter import meter_timeline, starting_meter  # noqa: E402
from services.object_storage import make_storage_client  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402


async def _run(dry_run: bool) -> int:
    """Reconcile every movement's stored meter with its MEI.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code: 0 on success, 1 when a movement's MEI was unreadable
        or declared no meter at all.
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    checked = 0
    changed = 0
    problems = 0
    changing_meters: list[str] = []
    try:
        storage = make_storage_client()
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT m.id, m.meter, m.mei_object_key,
                               w.slug || '/' || m.slug AS slug
                          FROM movement m
                          JOIN work w ON w.id = m.work_id
                         ORDER BY slug
                        """
                    )
                )
            ).all()

            for row in rows:
                try:
                    raw = await storage.get_mei(row.mei_object_key)
                except Exception as exc:  # noqa: BLE001 — one bad object is not fatal
                    problems += 1
                    print(f"  UNREADABLE {row.slug:22} {exc}")
                    continue

                checked += 1
                xml = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                actual = starting_meter(xml)
                if actual is None:
                    problems += 1
                    print(
                        f"  NO METER   {row.slug:22} MEI declares none; left as {row.meter!r}"
                    )
                    continue

                timeline = meter_timeline(xml)
                if len(timeline) > 1:
                    rest = ", ".join(f"{sig} from mc {mc}" for mc, sig in timeline[1:])
                    changing_meters.append(f"{row.slug}: opens {actual}, then {rest}")

                if actual == row.meter:
                    continue

                changed += 1
                print(f"  {row.slug:22} {str(row.meter):8} -> {actual}")
                if dry_run:
                    continue
                await session.execute(
                    text(
                        "UPDATE movement SET meter = :meter, updated_at = now()"
                        " WHERE id = :id"
                    ),
                    {"meter": actual, "id": row.id},
                )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    print(
        f"\n{checked} movement(s) checked; {changed} corrected; {problems} problem(s)."
    )
    if changing_meters:
        print(
            "\nMovements that change meter mid-piece (the stored value is the opening one;"
        )
        print("a fragment there takes the meter in force at its own measure):")
        for line in changing_meters:
            print(f"  {line}")
    if dry_run:
        print("\n[dry-run] nothing written.")
    elif changed:
        print(
            "\nNow run fix_summary_key_meter.py to carry this into fragment summaries."
        )
    return 1 if problems else 0


def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Set movement.meter from the movement's own MEI (M18)."
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
