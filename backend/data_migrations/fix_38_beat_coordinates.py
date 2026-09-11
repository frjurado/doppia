"""Re-express 3/8 fragment beat coordinates under the corrected meter rule (M17).

**Not a schema migration**, and it does not touch ``summary``: the shape was
always right, the numbers meant something else (fragment-schema.md § versioning).

The defect (Track M17). The ghost layer read a meter as compound whenever
``unit == 8 and count % 3 == 0``, which made **3/8 a single dotted-quarter beat
covering the whole bar**. ``ingest_analysis`` had always required ``count >= 6``
and read the same signature as three eighth-note beats, so a beat coordinate
written by the tagging tool in a 3/8 movement denoted a different position from
the same number in that movement's harmony record. Francisco saw it from the
other end on K280/iii m. 15: the harmony events sit on beats 1 and 3 and both
labels drew on beat 1, because under the ghost layer's reading beat 3 did not
exist. Settled 2026-09-10 — 3/8 is simple, three beats — and fixed at the source
in ``ghosts.ts`` ``isCompoundMeter``. This script converts the rows written
before that.

**The conversion.** Under the old reading the bar's three eighths were the
subdivisions of one beat: eighth *k* encoded as ``1 + k/3``, and the exclusive
end of the bar as 2.0. Under the new one each eighth is a beat: eighth *k* is
``1 + k``, and the bar ends at 4.0. So::

    new = 3 * old - 2      1 -> 1,  1+1/3 -> 2,  1+2/3 -> 3,  2 -> 4

Nothing else changes: the position each number names in the score is the same
before and after. The map is affine and increasing, so the ADR-005 wire
invariant (both beats null or both set; ordered within a bar) survives it.

**Per measure, not per movement.** ``beat_start`` belongs to the measure at
``mc_start`` and ``beat_end`` to the one at ``mc_end``, so each endpoint is
converted only if *its own* measure is in 3/8 — read from the MEI through
``services.mei_meter.meter_at_mc``, which is the only authority on meter
(Track M18) and the only thing that gets a movement with a mid-piece meter
change right.

**Idempotence is decided per movement, from the values themselves.** There is no
external record of which encoding a row is in, and the two value spaces overlap:
``{1, 1+1/3, 1+2/3, 2}`` against ``{1, 1.5, 2, 2.5, 3, 3.5, 4}``. A third can
only be the old encoding; anything above 2.0 — or a ``beat_start`` of exactly
2.0, which the old reading could not produce because the bar ended there — can
only be the new one. A movement showing neither is *ambiguous*: it is reported
and skipped rather than converted twice, and the script exits non-zero. No
corpus movement is ambiguous (K280/iii is full of thirds; the other two 3/8
movements have no fragments at all), and one only could be if every coordinate
in it happened to be a bar edge or beat 1.

**Run this before ``clamp_subpart_bounds.py``.** That script's
``measure_end_beat`` now speaks the corrected rule; run against unconverted rows
it would read a legitimate 1+2/3 as comfortably inside a bar ending at 4.0 and
leave real overflows in place.

Usage::

    DATABASE_URL="postgresql+asyncpg://doppia:doppia@localhost:5432/doppia" \\
        python backend/data_migrations/fix_38_beat_coordinates.py --dry-run
    DATABASE_URL="..." python backend/data_migrations/fix_38_beat_coordinates.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.mei_meter import meter_at_mc, meter_timeline  # noqa: E402
from services.object_storage import make_storage_client  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402

#: Tolerance for recognising a stored float as a point on the eighth grid. The
#: grid's own spacing is 1/3, so anything this close to a grid point is that
#: point and anything further off was not written by the ghost layer.
GRID_EPS = 1e-6

#: The meter this script converts. The old and new readings differ on 3/8 and on
#: nothing else: every other ``unit == 8`` signature divisible by three has
#: ``count >= 6`` and was compound under both rules.
DISPUTED_METER = "3/8"


def is_old_encoding_value(beat: float) -> bool:
    """True when ``beat`` is a point on the old 3/8 grid: 1, 1+1/3, 1+2/3 or 2.

    Args:
        beat: A stored beat coordinate.

    Returns:
        Whether the compound reading of 3/8 could have produced it.
    """
    k = (beat - 1.0) * 3.0
    return -GRID_EPS <= k <= 3.0 + GRID_EPS and abs(k - round(k)) < GRID_EPS


def convert(beat: float) -> float:
    """Map one old-encoding 3/8 beat coordinate to its new-encoding value.

    Args:
        beat: A coordinate on the old grid — the caller must have checked it
            with :func:`is_old_encoding_value`.

    Returns:
        The same musical position under the corrected rule: ``3 * beat - 2``,
        snapped to the integer it lands on.
    """
    return float(round(beat * 3.0 - 2.0))


def classify_movement(
    starts: list[float],
    ends: list[float],
) -> str:
    """Decide which encoding a movement's 3/8 coordinates are already in.

    Starts and ends are passed separately because they carry different evidence.
    A ``beat_start`` of exactly 2.0 is impossible under the old reading — the bar
    ended there — so it settles the question on its own; a ``beat_end`` of 2.0 is
    the old bar end and settles nothing.

    Args:
        starts: Every non-null ``beat_start`` sitting in a 3/8 measure.
        ends: Every non-null ``beat_end`` sitting in a 3/8 measure.

    Returns:
        ``"old"``, ``"new"``, ``"empty"`` (no coordinates to look at) or
        ``"ambiguous"`` (values consistent with both encodings).
    """
    values = starts + ends
    if not values:
        return "empty"
    if any(abs(v - round(v)) > GRID_EPS for v in values):
        return "old"  # a third: only the compound reading produces one
    if any(v > 2.0 + GRID_EPS for v in values):
        return "new"  # past the old bar end: only the simple reading gets there
    if any(abs(v - 2.0) < GRID_EPS for v in starts):
        return "new"  # a start where the old reading had already ended the bar
    return "ambiguous"


def _fmt(beat: float | None) -> str:
    """Compact display for a beat coordinate."""
    return "-" if beat is None else f"{beat:g}"


async def _run(dry_run: bool) -> int:
    """Convert every 3/8 fragment coordinate still in the old encoding.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code: 0 on success, 1 when a movement was ambiguous, had a
        coordinate off the old grid, or had an unreadable MEI.
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    checked = 0
    changed = 0
    problems = 0
    try:
        storage = make_storage_client()
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT f.id, f.movement_id,
                               f.mc_start, f.mc_end,
                               f.bar_start, f.bar_end,
                               f.beat_start, f.beat_end,
                               f.parent_fragment_id,
                               m.mei_object_key,
                               w.slug || '/' || m.slug AS slug
                          FROM fragment f
                          JOIN movement m ON m.id = f.movement_id
                          JOIN work w ON w.id = m.work_id
                         ORDER BY slug, f.mc_start, f.bar_start
                        """
                    )
                )
            ).all()

            by_movement: dict[str, list[Any]] = defaultdict(list)
            for row in rows:
                by_movement[str(row.movement_id)].append(row)

            for frags in by_movement.values():
                slug = frags[0].slug
                try:
                    raw = await storage.get_mei(frags[0].mei_object_key)
                except Exception as exc:  # noqa: BLE001 — one bad object is not fatal
                    problems += 1
                    print(f"  UNREADABLE {slug:22} {exc}")
                    continue
                xml = raw.decode("utf-8") if isinstance(raw, bytes) else raw

                # Cheap gate: a movement whose notation never says 3/8 has
                # nothing here, and that is all but three of the corpus.
                if not any(sig == DISPUTED_METER for _, sig in meter_timeline(xml)):
                    continue

                # Which of this movement's coordinates actually sit in 3/8. Each
                # endpoint is judged by its own measure, so a fragment straddling
                # a meter change converts on one side only.
                in_scope: list[tuple[Any, str, float]] = []
                for row in frags:
                    if row.beat_start is not None and (
                        meter_at_mc(xml, row.mc_start) == DISPUTED_METER
                    ):
                        in_scope.append((row, "beat_start", row.beat_start))
                    if row.beat_end is not None and (
                        meter_at_mc(xml, row.mc_end) == DISPUTED_METER
                    ):
                        in_scope.append((row, "beat_end", row.beat_end))

                state = classify_movement(
                    [v for _, field, v in in_scope if field == "beat_start"],
                    [v for _, field, v in in_scope if field == "beat_end"],
                )
                if state == "empty":
                    continue
                if state == "new":
                    print(f"  {slug:22} already converted ({len(in_scope)} values)")
                    continue
                if state == "ambiguous":
                    problems += 1
                    print(
                        f"  AMBIGUOUS  {slug:22} every 3/8 coordinate is a bar edge "
                        f"or beat 1; the two encodings cannot be told apart here — "
                        f"inspect by hand"
                    )
                    continue

                off_grid = [
                    (row, field, v)
                    for row, field, v in in_scope
                    if not is_old_encoding_value(v)
                ]
                if off_grid:
                    problems += 1
                    for row, field, value in off_grid:
                        print(
                            f"  OFF GRID   {slug:22} {row.id} {field}={value!r} is "
                            f"not a point the compound 3/8 reading could produce"
                        )
                    continue

                updates: dict[Any, dict[str, float]] = defaultdict(dict)
                for row, field, value in in_scope:
                    updates[row.id][field] = convert(value)

                for row in frags:
                    if row.id not in updates:
                        continue
                    checked += 1
                    new_start = updates[row.id].get("beat_start", row.beat_start)
                    new_end = updates[row.id].get("beat_end", row.beat_end)
                    if new_start == row.beat_start and new_end == row.beat_end:
                        continue
                    changed += 1
                    kind = "stage" if row.parent_fragment_id else "frag "
                    print(
                        f"  {slug:22} {kind} {row.id}  "
                        f"mm. {row.bar_start}-{row.bar_end}  "
                        f"[{_fmt(row.beat_start)}, {_fmt(row.beat_end)}) -> "
                        f"[{_fmt(new_start)}, {_fmt(new_end)})"
                    )
                    if dry_run:
                        continue
                    await session.execute(
                        text(
                            """
                            UPDATE fragment
                               SET beat_start = :bs, beat_end = :be
                             WHERE id = :id
                            """
                        ),
                        {"bs": new_start, "be": new_end, "id": row.id},
                    )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    print(f"\n{checked} coordinate pair(s) in 3/8 measures; {changed} converted.")
    if dry_run:
        print("[dry-run] nothing written.")
    if problems:
        print(f"{problems} movement(s) need a look — see the lines above.")
    return 1 if problems else 0


def main() -> None:
    """Parse arguments and run the conversion."""
    parser = argparse.ArgumentParser(description="Convert 3/8 beat coordinates (M17).")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change and write nothing.",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(_run(args.dry_run)))


if __name__ == "__main__":
    main()
