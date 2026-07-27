"""Clamp stored sub-part bounds to their parent fragment's sub-beat bounds.

**Not a schema-version migration.** No ``summary`` field changes; this repairs
*coordinates* on rows that were written wrong (fragment-schema.md § versioning).

The defect (M7, Component 11 Step 11): the stage layout frame chose its grid from
the stage count alone, so a beat-precise fragment whose stages fit at measure
granularity got measure-granular stage bounds — and the first and last stage then
inherited their *measure's* edges instead of the fragment's. On 279/ii mm. 8-10
("m. 8 beat 3 - m. 10 beat 1") the outer stages covered whole measures and spilled
out of the fragment they belong to, visible in the stage brackets and in the
sidebar. Fixed at the source in ``buildStageSlots`` / ``prePopulateStages``; this
script repairs the rows written before that.

The repair is deterministic, not editorial: a sub-part is a *part of* its parent,
so a bound outside the parent's is wrong by definition and its correct value is
the parent's own. Nothing else is touched — an interior boundary between two
stages carries real editorial intent and is left exactly where it is.

Sub-parts that lie *entirely* outside their parent are reported and skipped:
there is no defensible automatic value for those, and none exist in the corpus.
Beat pairs are re-normalised after clamping so the ADR-005 wire invariant (both
null or both set, ordered within a bar) still holds.

Sub-parts in a **3/8** movement are reported and deferred, not repaired: the
corpus has two disagreeing readings of that meter's beat count (Track M17), so a
beat number there does not yet denote a fixed position and the clamp would
destroy real extent. See :func:`meter_is_disputed`.

Idempotent: re-running after a successful run reports zero changes.

Usage::

    DATABASE_URL="postgresql+asyncpg://doppia:doppia@localhost:5432/doppia" \\
        python backend/data_migrations/clamp_subpart_bounds.py --dry-run
    DATABASE_URL="..." python backend/data_migrations/clamp_subpart_bounds.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402


@dataclass(frozen=True)
class Bounds:
    """A fragment's position: the mc interval plus optional beat precision.

    ``mc`` is the ADR-015 document-order index — the only unambiguous measure
    coordinate — and ``bar`` the notated ``@n`` carried alongside it for display.
    A null beat means the bound sits at its measure's edge.
    """

    mc_start: int
    mc_end: int
    bar_start: int
    bar_end: int
    beat_start: float | None
    beat_end: float | None


def _parse_meter(meter: str | None) -> tuple[int, int]:
    """Split a stored meter into (count, unit); 4/4 for missing or unparseable."""
    if meter and "/" in meter:
        head, _, tail = meter.partition("/")
        try:
            return int(head), int(tail)
        except ValueError:
            return 4, 4
    return 4, 4


def meter_is_disputed(meter: str | None) -> bool:
    """True when the corpus has no agreed beat count for this meter (Track M17).

    The frontend ghost layer reads a meter as compound when ``unit == 8`` and
    ``count % 3 == 0``; ``ingest_analysis`` additionally requires ``count >= 6``.
    They therefore disagree on **3/8** and nothing else: one dotted-quarter beat
    per bar (measure ends at 2.0) against three eighth-note beats (ends at 4.0).

    A beat number in such a movement does not denote a fixed position until that
    is settled, so this script refuses to adjudicate: it reports those sub-parts
    and leaves them alone. Two things go wrong if it does not. A legitimate
    ``beat_end`` of 3.0 looks out of bounds under the one-beat reading and gets
    truncated — real extent destroyed on the strength of the disputed rule. And
    rewriting a measure-level ``(null, null)`` into explicit beats freezes the
    current reading into data that reads as "whole measure" under either rule
    while the explicit pair would not survive the flip.

    Both hazards are real on staging: K279/iii and K280/iii are 3/8, and K280/iii
    is where Francisco first saw M17 (harmony labels for beats 1 and 3 both
    drawing on beat 1).
    """
    count, unit = _parse_meter(meter)
    return unit == 8 and count % 3 == 0 and count < 6


def measure_end_beat(meter: str | None) -> float:
    """Exclusive beat upper bound of a full measure in the given meter (ADR-005).

    ``numBeats + 1``: the value ``beat_end`` takes for a bound at the end of its
    measure. Compound meters count the dotted beat (6/8 has two), matching
    ``beatSlotCount`` / ``isCompoundMeter`` in the frontend ghost layer — the code
    that wrote the values this script repairs, so the rule to follow. Where the
    two readings of "compound" disagree the caller must not reach this function
    at all: see :func:`meter_is_disputed`.

    Args:
        meter: Meter as stored on the movement, e.g. ``"3/4"``. Unparseable or
            missing meters fall back to 4/4, the commonest case.

    Returns:
        The exclusive upper bound, e.g. 4.0 for 3/4 and 3.0 for 6/8.
    """
    count, unit = _parse_meter(meter)
    beats = count // 3 if (unit == 8 and count % 3 == 0) else count
    return float(max(1, beats) + 1)


def _start_key(b: Bounds) -> tuple[int, float]:
    """Sort key for a start bound; a null beat means the measure's first beat."""
    return (b.mc_start, b.beat_start if b.beat_start is not None else 1.0)


def _end_key(b: Bounds, measure_end: float) -> tuple[int, float]:
    """Sort key for an end bound; a null beat means the measure's exclusive end."""
    return (b.mc_end, b.beat_end if b.beat_end is not None else measure_end)


def clamp_to_parent(
    child: Bounds,
    parent: Bounds,
    measure_end: float,
) -> Bounds | None:
    """Clamp a sub-part's bounds into its parent's, returning the corrected bounds.

    A bound already inside the parent is returned untouched — including a null
    beat, which stays null so a measure-level stage in a measure-level fragment
    is not gratuitously rewritten into beat coordinates.

    Args:
        child: The sub-part's stored bounds.
        parent: The parent fragment's stored bounds.
        measure_end: Exclusive end beat of a full measure in this movement's
            meter (``measure_end_beat``).

    Returns:
        The clamped bounds, or None when the sub-part lies entirely outside its
        parent — an inconsistency this repair must not guess its way out of.
    """
    mc_start, bar_start, beat_start = child.mc_start, child.bar_start, child.beat_start
    mc_end, bar_end, beat_end = child.mc_end, child.bar_end, child.beat_end

    if _start_key(child) < _start_key(parent):
        mc_start, bar_start, beat_start = (
            parent.mc_start,
            parent.bar_start,
            parent.beat_start,
        )
    if _end_key(child, measure_end) > _end_key(parent, measure_end):
        mc_end, bar_end, beat_end = parent.mc_end, parent.bar_end, parent.beat_end

    clamped = Bounds(mc_start, mc_end, bar_start, bar_end, beat_start, beat_end)
    if _start_key(clamped) >= _end_key(clamped, measure_end):
        return None  # empty after clamping: the sub-part was outside its parent

    # ADR-005 wire invariant: both beats null, or both set. Clamping one side of a
    # measure-level bound leaves the pair asymmetric; fill the other side with its
    # own measure boundary, which is the extent that was tagged either way.
    if beat_start is None and beat_end is not None:
        beat_start = 1.0
    elif beat_end is None and beat_start is not None:
        beat_end = measure_end

    return Bounds(mc_start, mc_end, bar_start, bar_end, beat_start, beat_end)


def _fmt(b: Bounds) -> str:
    """One-line rendering of bounds for the change log."""
    start = f"mc{b.mc_start}(m{b.bar_start})"
    end = f"mc{b.mc_end}(m{b.bar_end})"
    beats = (
        "whole measures"
        if b.beat_start is None and b.beat_end is None
        else f"beats {b.beat_start}-{b.beat_end}"
    )
    return f"{start}..{end} {beats}"


async def _run(dry_run: bool) -> int:
    """Clamp every sub-part whose bounds fall outside its parent fragment.

    Args:
        dry_run: When true, report what would change and write nothing.

    Returns:
        Process exit code: 0 on success, 1 when a sub-part could not be repaired.
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    checked = 0
    changed = 0
    skipped = 0
    deferred = 0
    try:
        async with AsyncSession(engine) as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT c.id,
                               c.mc_start, c.mc_end, c.bar_start, c.bar_end,
                               c.beat_start, c.beat_end,
                               p.mc_start   AS p_mc_start,
                               p.mc_end     AS p_mc_end,
                               p.bar_start  AS p_bar_start,
                               p.bar_end    AS p_bar_end,
                               p.beat_start AS p_beat_start,
                               p.beat_end   AS p_beat_end,
                               m.meter,
                               w.slug || '/' || m.slug AS slug
                          FROM fragment c
                          JOIN fragment p ON p.id = c.parent_fragment_id
                          JOIN movement m ON m.id = c.movement_id
                          JOIN work w ON w.id = m.work_id
                         ORDER BY slug, c.mc_start, c.bar_start
                        """
                    )
                )
            ).all()

            for row in rows:
                checked += 1
                child = Bounds(
                    row.mc_start,
                    row.mc_end,
                    row.bar_start,
                    row.bar_end,
                    row.beat_start,
                    row.beat_end,
                )
                parent = Bounds(
                    row.p_mc_start,
                    row.p_mc_end,
                    row.p_bar_start,
                    row.p_bar_end,
                    row.p_beat_start,
                    row.p_beat_end,
                )
                if meter_is_disputed(row.meter):
                    # Not a repair decision this script is entitled to make; the
                    # beat scale itself is unsettled (M17).
                    deferred += 1
                    print(
                        f"  DEFER {row.slug:20} {row.id}  {_fmt(child)}"
                        f"  — {row.meter} beat count disputed (M17)"
                    )
                    continue

                measure_end = measure_end_beat(row.meter)
                clamped = clamp_to_parent(child, parent, measure_end)

                if clamped is None:
                    skipped += 1
                    print(
                        f"  SKIP {row.slug:20} {row.id}  {_fmt(child)}"
                        f"  lies outside parent {_fmt(parent)}"
                    )
                    continue
                if clamped == child:
                    continue

                changed += 1
                print(
                    f"  {row.slug:20} {row.id}\n"
                    f"      {_fmt(child)}\n"
                    f"   -> {_fmt(clamped)}   (parent {_fmt(parent)})"
                )

                if dry_run:
                    continue
                await session.execute(
                    text(
                        "UPDATE fragment"
                        "   SET mc_start = :mc_start, mc_end = :mc_end,"
                        "       bar_start = :bar_start, bar_end = :bar_end,"
                        "       beat_start = :beat_start, beat_end = :beat_end,"
                        "       updated_at = now()"
                        " WHERE id = :id"
                    ),
                    {
                        "id": row.id,
                        "mc_start": clamped.mc_start,
                        "mc_end": clamped.mc_end,
                        "bar_start": clamped.bar_start,
                        "bar_end": clamped.bar_end,
                        "beat_start": clamped.beat_start,
                        "beat_end": clamped.beat_end,
                    },
                )

            if not dry_run:
                await session.commit()
    finally:
        await engine.dispose()

    print(
        f"\n{checked} sub-part(s) checked; {changed} clamped; "
        f"{skipped} skipped; {deferred} deferred."
    )
    if dry_run:
        print("[dry-run] nothing written.")
    if skipped:
        print("Skipped sub-parts need an editorial decision — see the list above.")
    if deferred:
        print(
            "Deferred sub-parts are in a meter whose beat count is disputed "
            "(Track M17); re-run this script once that is settled."
        )
    return 1 if skipped else 0


def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Clamp sub-part bounds to their parent fragment's bounds (M7)."
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
