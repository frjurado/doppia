"""Apply an editorial bar renumbering to an already-ingested movement (§ 9G).

**Not a schema migration**, and it does not touch ``summary``. It rewrites the
notated bar numbers of a movement whose edition numbers it in two independent
runs, in the two places they are stored: ``@n`` in the MEI object and ``mn`` in
``movement_analysis.events``. Both must move together or the sidebar prints bar
numbers the score does not show.

**``mc`` is never touched.** It is the document-order position index of ADR-015 and
the join key everything mechanical uses, so rendering, fragment ranges, previews,
and the mc-stability check are all unaffected. That is what makes an editorial
renumbering safe to perform at all.

The declaration lives in ``services.bar_renumber.RESTARTS``, shared with corpus
prep, which applies the same plan when a movement is prepared from source. Prep is
the durable path — a future re-ingest reproduces this result rather than reverting
it — and this script exists because the DCML harmonies TSV is not stored (see
deployment.md § DCML corpus re-ingestion), so re-ingesting requires the source
repository and a full re-upload. Running this achieves the same end state now; the
next re-ingest converges on it.

Only the *normalised* MEI object is rewritten. ``mei_original_object_key`` — the
pre-normalisation file as it arrived — is left alone on purpose: it records what we
received, which is still true. The two converge at the next re-ingest, when prep
applies the same renumbering before the ZIP is built.

**Refuses to run when the movement has fragments.** Their ``bar_start``/``bar_end``
are in the old numbering, and per ADR-015 moving ``@n`` under a stored fragment is
an editorial act that needs its own migration decision — not a silent side effect
of this one. K282/ii has none, which is why it can be done now.

Idempotent: the plan is keyed on ``mc``, which does not move, so re-running
recomputes the same labels and reports nothing to change.

Usage::

    DATABASE_URL="postgresql+asyncpg://…" \\
        python backend/data_migrations/renumber_movement_bars.py --dry-run
    DATABASE_URL="…" python backend/data_migrations/renumber_movement_bars.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.bar_renumber import (  # noqa: E402
    RESTARTS,
    apply_to_events,
    apply_to_mei,
    renumber_plan,
)
from services.object_storage import make_storage_client  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402


async def _run(dry_run: bool) -> int:
    """Renumber every movement declared in ``RESTARTS``.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code: 0 on success, 1 when a declared movement is missing,
        unreadable, or carries fragments (which blocks it).
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    problems = 0
    touched = 0
    try:
        storage = make_storage_client()
        async with AsyncSession(engine) as session:
            for slug, restarts in RESTARTS.items():
                work_slug, _, movement_slug = slug.partition("/")
                row = (
                    await session.execute(
                        text(
                            """
                            SELECT m.id, m.mei_object_key,
                                   (SELECT count(*) FROM fragment f
                                     WHERE f.movement_id = m.id) AS frags
                              FROM movement m JOIN work w ON w.id = m.work_id
                             WHERE w.slug = :work AND m.slug = :movement
                            """
                        ),
                        {"work": work_slug, "movement": movement_slug},
                    )
                ).one_or_none()

                if row is None:
                    problems += 1
                    print(f"  !! {slug}: not in the database")
                    continue
                if row.frags:
                    problems += 1
                    print(
                        f"  !! {slug}: has {row.frags} fragment(s) whose bar_start/"
                        f"bar_end are in the old numbering — renumbering them is a "
                        f"separate editorial decision (ADR-015). Refusing."
                    )
                    continue

                raw = await storage.get_mei(row.mei_object_key)
                mei = raw if isinstance(raw, bytes) else raw.encode("utf-8")
                plan = renumber_plan(mei, restarts)
                if not plan:
                    problems += 1
                    print(f"  !! {slug}: the restart produced no plan")
                    continue

                first_mc = min(plan)
                last_mc = max(plan)
                # ASCII only: these run over `fly ssh console` and a Windows
                # cp1252 terminal, which cannot encode arrows or en dashes.
                print(
                    f"  {slug}: mc {first_mc}..{last_mc} -> @n "
                    f"{plan[first_mc][0]}..{plan[last_mc][0]}  "
                    f"({len(plan)} measures)"
                )

                # 1. The MEI's @n.
                new_mei = apply_to_mei(mei, plan)
                changed_mei = new_mei != mei

                # 2. The harmony events' mn.
                events_row = (
                    await session.execute(
                        text(
                            "SELECT events FROM movement_analysis"
                            " WHERE movement_id = :mid"
                        ),
                        {"mid": row.id},
                    )
                ).one_or_none()
                changed_events = 0
                new_events: list[dict] | None = None
                if events_row is not None:
                    events = events_row.events
                    if isinstance(events, str):
                        events = json.loads(events)
                    new_events, changed_events = apply_to_events(events, plan)

                print(
                    f"      MEI @n: {'rewritten' if changed_mei else 'already correct'}"
                    f"; harmony mn: {changed_events} event(s) moved"
                )
                if not changed_mei and not changed_events:
                    continue
                touched += 1
                if dry_run:
                    continue

                if changed_mei:
                    await storage.put_mei(row.mei_object_key, new_mei)
                if changed_events and new_events is not None:
                    await session.execute(
                        text(
                            "UPDATE movement_analysis"
                            "   SET events = CAST(:events AS jsonb),"
                            "       updated_at = now()"
                            " WHERE movement_id = :mid"
                        ),
                        {"events": json.dumps(new_events), "mid": row.id},
                    )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    print(
        f"\n{len(RESTARTS)} declared movement(s); {touched} changed; {problems} problem(s)."
    )
    if dry_run:
        print("[dry-run] nothing written.")
    elif touched:
        print("Run seed_movement_sections.py next so the section labels still line up.")
    return 1 if problems else 0


def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Apply editorial bar renumbering to ingested movements (§ 9G)."
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
