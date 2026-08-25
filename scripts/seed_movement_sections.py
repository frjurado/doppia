"""Seed the editorial ``movement_section`` rows (ADR-036).

Some movements restart their notated bar numbers partway through, so
``fragment.bar_start``/``bar_end`` alone cannot say which "m. 12" a fragment
means. This script populates the editorial section spans a display label is
qualified with ("Trio, mm. 12-15").

The spans below are **editorial data confirmed against the score**, not derived
at runtime. They come from the Step 9A survey
(``docs/reports/component-11-reports/step-9a-duplicate-bar-number-survey.md``),
which located each boundary from the ``<dir>`` text in the movement's own MEI —
so the names are confirmed and cased, not invented. Bounds are 1-based inclusive
``mc`` (document-order position index, ADR-015) and **span ``<ending>``
measures**: K331/ii's Trio ends at mc 101, not 99, because its last two measures
sit inside a volta ending.

Idempotent: rows are upserted on ``(movement_id, ordinal)``, so re-running
converges rather than duplicating — the same contract the knowledge-graph seed
script holds to.

Usage::

    # From the repo root, with the venv active and the stack running:
    DATABASE_URL="postgresql+asyncpg://doppia:doppia@localhost:5432/doppia" \\
        python scripts/seed_movement_sections.py

    # Print what would change without writing:
    DATABASE_URL="..." python scripts/seed_movement_sections.py --dry-run

To validate the result — that every movement whose numbering restarts has
sections recorded — run ``scripts/validate_movement_sections.py``.

See ADR-036 and docs/roadmap/component-11-concept-glossary.md § Step 9C.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402

# ---------------------------------------------------------------------------
# The editorial data
# ---------------------------------------------------------------------------

# (work slug, movement slug) -> ordered list of (name, mc_start, mc_end).
#
# Only movements that genuinely need disambiguation appear here. A movement with
# no entry has no rows, which is how the read path tells "unsectioned" from
# "sectioned" (ADR-036).
_SECTIONS: dict[tuple[str, str], list[tuple[str, int, int]]] = {
    # Menuetto 1-48 (@n 1-48), then the Trio restarts at @n 1 and runs to 52
    # plus an X1 volta complement. dir:MENUETTO at mc 1, dir:Fine at mc 48,
    # dir:TRIO at mc 49, dir:"Menuetto da capo" at mc 101 — the reprise is an
    # instruction, not written-out bars.
    ("k331", "movement-2"): [
        ("Menuetto", 1, 48),
        ("Trio", 49, 101),
    ],
    # Menuetto I & II. The DCML encoding numbered these continuously (0-72) where
    # the NMA restarts at Menuetto II; that source erratum was repaired in
    # Component 11 Step 13B (`services.bar_renumber`), so Menuetto II now counts
    # 0-40 from its own upbeat. These sections are therefore load-bearing, not
    # merely editorial: bars 0-32 exist twice in the movement and the label is
    # what tells a reader which one is meant. mc is untouched by the repair, so
    # the bounds below are unchanged by it.
    # dir:"Menuetto I" at mc 1, dir:Fine at mc 34, dir:"Menuetto II" at mc 35,
    # dir:"Menuetto I da capo" at mc 76.
    ("k282", "movement-2"): [
        ("Menuetto I", 1, 34),
        ("Menuetto II", 35, 76),
    ],
}


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------


async def _seed(dry_run: bool) -> int:
    """Upsert every section span in ``_SECTIONS``.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code: 0 on success, 1 when a configured movement is missing
        from the database (a real problem — the editorial data names a movement
        that was never ingested).
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    missing: list[str] = []
    written = 0
    try:
        async with AsyncSession(engine) as session:
            for (work, movement), sections in _SECTIONS.items():
                slug = f"{work}/{movement}"
                movement_id = await session.scalar(
                    text(
                        """
                        SELECT m.id FROM movement m JOIN work w ON w.id = m.work_id
                         WHERE w.slug = :work AND m.slug = :movement
                        """
                    ),
                    {"work": work, "movement": movement},
                )
                if movement_id is None:
                    missing.append(slug)
                    print(f"  !! {slug}: not in the database")
                    continue

                existing = {
                    row.ordinal: (row.name, row.mc_start, row.mc_end)
                    for row in (
                        await session.execute(
                            text(
                                "SELECT ordinal, name, mc_start, mc_end "
                                "FROM movement_section WHERE movement_id = :mid"
                            ),
                            {"mid": movement_id},
                        )
                    ).all()
                }

                for ordinal, (name, mc_start, mc_end) in enumerate(sections, start=1):
                    desired = (name, mc_start, mc_end)
                    if existing.get(ordinal) == desired:
                        print(f"  =  {slug} [{ordinal}] {name} mc {mc_start}-{mc_end}")
                        continue
                    verb = "~" if ordinal in existing else "+"
                    print(f"  {verb}  {slug} [{ordinal}] {name} mc {mc_start}-{mc_end}")
                    if dry_run:
                        continue
                    await session.execute(
                        text(
                            """
                            INSERT INTO movement_section
                                   (movement_id, ordinal, name, mc_start, mc_end)
                            VALUES (:mid, :ordinal, :name, :mc_start, :mc_end)
                            ON CONFLICT (movement_id, ordinal) DO UPDATE
                                SET name = EXCLUDED.name,
                                    mc_start = EXCLUDED.mc_start,
                                    mc_end = EXCLUDED.mc_end,
                                    updated_at = now()
                            """
                        ),
                        {
                            "mid": movement_id,
                            "ordinal": ordinal,
                            "name": name,
                            "mc_start": mc_start,
                            "mc_end": mc_end,
                        },
                    )
                    written += 1

                # Drop any stale rows beyond the configured section count, so a
                # shortened list converges instead of leaving orphans behind.
                if not dry_run:
                    await session.execute(
                        text(
                            "DELETE FROM movement_section "
                            " WHERE movement_id = :mid AND ordinal > :count"
                        ),
                        {"mid": movement_id, "count": len(sections)},
                    )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    if dry_run:
        print("\n[dry-run] nothing written.")
    else:
        print(f"\n{written} section row(s) written.")
    if missing:
        print(f"Missing movements: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    """Parse arguments and run the seed."""
    parser = argparse.ArgumentParser(
        description="Seed editorial movement_section spans (ADR-036)."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing.",
    )
    args = parser.parse_args()

    if "DATABASE_URL" not in os.environ:
        print(
            "Error: DATABASE_URL environment variable is not set.\n"
            "Example: DATABASE_URL='postgresql+asyncpg://doppia:doppia"
            "@localhost:5432/doppia' python scripts/seed_movement_sections.py",
            file=sys.stderr,
        )
        sys.exit(1)

    sys.exit(asyncio.run(_seed(args.dry_run)))


if __name__ == "__main__":
    main()
