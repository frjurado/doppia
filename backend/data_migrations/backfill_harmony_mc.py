"""Give every harmony event its machine measure coordinate (ADR-015).

**Not a schema migration**, and it does not touch ``summary``. It fills in ``mc``
on ``movement_analysis`` events that were written without one.

The defect: the tagging tool's harmony *insert* recorded only the notated bar
number, never ``mc``. That was invisible until the harmony panel began scoping its
query by ``mc`` (Component 11 Step 10, so a Trio fragment would stop being served
the Menuetto's harmony) — at which point a hand-added event became unreachable
*in the editor* while the fragment detail and the in-score overlay, which both
fall back to ``mn``, went on showing it. Visible everywhere except where it could
be corrected. Found on 279/i m. 10, whose two added harmonies could not be opened.

Fixed at the source: the panel now sends ``mc``, and ``get_events`` admits an
mc-less event within the bar span its mc window covers, so nothing is stranded
while this backfill has not run.

Resolution is by bar number, and **only where that is unambiguous**. A bar number
can name more than one measure — split measures share one ``mn`` across two ``mc``,
and a movement whose numbering restarts has two of every bar. Where an event's
``mn`` matches exactly one measure the answer is certain; where it matches several,
the event is reported and left alone rather than guessed at.

Idempotent: events that already have ``mc`` are skipped.

Usage::

    DATABASE_URL="postgresql+asyncpg://…" \\
        python backend/data_migrations/backfill_harmony_mc.py --dry-run
    DATABASE_URL="…" python backend/data_migrations/backfill_harmony_mc.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402


async def _run(dry_run: bool) -> int:
    """Fill in ``mc`` wherever the bar number resolves to exactly one measure.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code: 0 on success, 1 when some events could not be placed.
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    filled = 0
    ambiguous = 0
    try:
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT a.movement_id, a.events,
                               w.slug || '/' || m.slug AS slug
                          FROM movement_analysis a
                          JOIN movement m ON m.id = a.movement_id
                          JOIN work w ON w.id = m.work_id
                         ORDER BY slug
                        """
                    )
                )
            ).all()

            for row in rows:
                events = row.events
                if isinstance(events, str):
                    events = json.loads(events)
                if not any(e.get("mc") is None for e in events):
                    continue

                # Which mc values does each bar number name in this movement?
                by_mn: dict[int, set[int]] = defaultdict(set)
                for e in events:
                    if e.get("mc") is not None and e.get("mn") is not None:
                        by_mn[int(e["mn"])].add(int(e["mc"]))

                out: list[dict] = []
                changed = 0
                for e in events:
                    if e.get("mc") is not None or e.get("mn") is None:
                        out.append(e)
                        continue
                    candidates = by_mn.get(int(e["mn"]), set())
                    if len(candidates) == 1:
                        mc = next(iter(candidates))
                        print(
                            f"  {row.slug:22} mn={e['mn']} beat={e.get('beat')} "
                            f"{e.get('numeral')} -> mc {mc}"
                        )
                        out.append({**e, "mc": mc})
                        changed += 1
                        filled += 1
                    else:
                        ambiguous += 1
                        why = (
                            f"names {len(candidates)} measures ({sorted(candidates)})"
                            if candidates
                            else "names no measure that carries harmony"
                        )
                        print(
                            f"  AMBIGUOUS {row.slug:22} mn={e['mn']} "
                            f"beat={e.get('beat')} {e.get('numeral')} — {why}"
                        )
                        out.append(e)

                if changed and not dry_run:
                    await session.execute(
                        text(
                            "UPDATE movement_analysis"
                            "   SET events = CAST(:events AS jsonb),"
                            "       updated_at = now()"
                            " WHERE movement_id = :mid"
                        ),
                        {"events": json.dumps(out), "mid": row.movement_id},
                    )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    print(f"\n{filled} event(s) placed; {ambiguous} left for a human.")
    if dry_run:
        print("[dry-run] nothing written.")
    if ambiguous:
        print(
            "Ambiguous events keep mn only. They stay visible and editable "
            "(get_events admits them by bar span), so this is safe to leave."
        )
    return 1 if ambiguous else 0


def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Backfill mc on harmony events written without one."
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
