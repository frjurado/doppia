"""Validate that every movement needing section labels has them (ADR-036 § 3).

A movement whose notated bar numbers restart partway through cannot be labelled
unambiguously from ``@n`` alone: "m. 12" names two different bars. ADR-036
resolves that with editorial ``movement_section`` rows. This script is the guard
that stops a future corpus from silently regressing to unqualified duplicate
labels: it walks every movement's normalised MEI, detects restarts structurally,
and **fails when a restarting movement has no sections recorded**.

It deliberately persists nothing and reads no cached advisory. The obvious
source, ``movement.normalization_warnings``, is null for almost every movement
because the ingest path drops normalizer advisories (Track M M15) — so this
recomputes from the MEI, which is authoritative regardless.

Checks:

1. **Restart coverage** — a movement with more than one increasing run of ``@n``
   must have ``movement_section`` rows. Failure.
2. **Bounds sanity** — recorded sections must be ordered, non-overlapping, start
   at mc 1, and end at the movement's last measure. Failure. Section bounds span
   ``<ending>`` measures, so the last section ends at the true final ``mc``
   (K331/ii's Trio ends at 101, not 99).
3. **Unnecessary sections** — sections on a movement whose numbering does not
   restart. Reported as a warning, not a failure: sectioning a movement for
   editorial reasons is legitimate (K282/ii is sectioned though its numbering is
   continuous, pending the Step 13 repair).

Usage::

    DATABASE_URL="postgresql+asyncpg://doppia:doppia@localhost:5432/doppia" \\
        python scripts/validate_movement_sections.py

Exit code 0 when every check passes, 1 otherwise.

See ADR-036 and docs/roadmap/component-11-concept-glossary.md § Step 9B.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import lxml.etree as ET  # noqa: E402
from services.object_storage import make_storage_client  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402

_MEI_NS = "http://www.music-encoding.org/ns/mei"


def measure_profile(xml: bytes) -> tuple[int, list[tuple[int, int]]]:
    """Return the measure count and the increasing runs of ``@n`` in an MEI.

    Args:
        xml: Raw MEI document bytes.

    Returns:
        ``(total_measures, runs)`` where ``total_measures`` counts every
        ``<measure>`` in document order (``<ending>`` measures included, since
        section bounds span them) and ``runs`` is a list of ``(mc_start, mc_end)``
        pairs, one per increasing run of integer ``@n`` on measures **outside**
        ``<ending>``. More than one run means the numbering restarts.

        Measures inside ``<ending>`` and non-integer ``@n`` (DCML X-prefixed
        split-measure complements) take no part in run detection — they are not
        part of the numbering sequence — but they do count toward
        ``total_measures``.
    """
    root = ET.fromstring(xml)
    measures = root.findall(f".//{{{_MEI_NS}}}measure")

    runs: list[tuple[int, int]] = []
    run_start: int | None = None
    run_end: int | None = None
    prev: int | None = None

    for mc, measure in enumerate(measures, start=1):
        if any(a.tag == f"{{{_MEI_NS}}}ending" for a in measure.iterancestors()):
            continue
        raw = measure.get("n")
        if raw is None:
            continue
        try:
            n = int(raw)
        except ValueError:
            continue  # X-prefixed complement; outside the numbering sequence
        if prev is not None and n <= prev and run_start is not None:
            runs.append((run_start, run_end or run_start))
            run_start = None
        if run_start is None:
            run_start = mc
        run_end = mc
        prev = n

    if run_start is not None:
        runs.append((run_start, run_end or run_start))

    return len(measures), runs


async def validate() -> int:
    """Run every check across the corpus.

    Returns:
        ``0`` when all checks pass, ``1`` when any failure was reported.
    """
    engine = create_async_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    failures: list[str] = []
    warnings: list[str] = []
    checked = 0
    try:
        async with AsyncSession(engine) as session:
            movements = (
                await session.execute(
                    text(
                        """
                        SELECT m.id, w.slug || '/' || m.slug AS slug,
                               m.mei_object_key
                          FROM movement m JOIN work w ON w.id = m.work_id
                         ORDER BY w.slug, m.movement_number
                        """
                    )
                )
            ).all()

            storage = make_storage_client()
            for mv in movements:
                try:
                    xml = await storage.get_mei(mv.mei_object_key)
                except Exception as exc:  # noqa: BLE001 — one bad object is not fatal
                    warnings.append(f"{mv.slug}: MEI unreadable ({exc})")
                    continue
                checked += 1
                total, runs = measure_profile(xml)

                sections = (
                    await session.execute(
                        text(
                            "SELECT ordinal, name, mc_start, mc_end "
                            "  FROM movement_section WHERE movement_id = :mid"
                            " ORDER BY ordinal"
                        ),
                        {"mid": mv.id},
                    )
                ).all()

                # 1 — restart coverage
                if len(runs) > 1 and not sections:
                    detail = ", ".join(f"mc {a}-{b}" for a, b in runs)
                    failures.append(
                        f"{mv.slug}: bar numbers restart ({len(runs)} runs: "
                        f"{detail}) but no movement_section rows exist. "
                        f"Add them (scripts/seed_movement_sections.py) or bar "
                        f"labels on this movement are ambiguous."
                    )
                    continue

                if not sections:
                    continue

                # 2 — bounds sanity
                if sections[0].mc_start != 1:
                    failures.append(
                        f"{mv.slug}: first section starts at mc "
                        f"{sections[0].mc_start}, not 1 — measures before it "
                        f"resolve to no section."
                    )
                if sections[-1].mc_end != total:
                    failures.append(
                        f"{mv.slug}: last section ends at mc "
                        f"{sections[-1].mc_end}, but the movement has {total} "
                        f"measures — bounds must span <ending> measures too."
                    )
                for prev_s, next_s in zip(sections, sections[1:]):
                    if next_s.mc_start != prev_s.mc_end + 1:
                        failures.append(
                            f"{mv.slug}: sections {prev_s.ordinal}/"
                            f"{next_s.ordinal} are not contiguous "
                            f"({prev_s.mc_end} → {next_s.mc_start})."
                        )

                # 3 — sections on a movement that does not restart
                if len(runs) <= 1:
                    warnings.append(
                        f"{mv.slug}: has {len(sections)} sections but its "
                        f"numbering does not restart (editorial sectioning; "
                        f"fine, but not required for disambiguation)."
                    )
    finally:
        await engine.dispose()

    print(f"movements checked: {checked}")
    for w in warnings:
        print(f"  warning: {w}")
    for f in failures:
        print(f"  FAIL: {f}")
    if failures:
        print(f"\n{len(failures)} failure(s).")
        return 1
    print("\nAll movement-section checks passed.")
    return 0


def main() -> None:
    """Entry point."""
    if "DATABASE_URL" not in os.environ:
        print(
            "Error: DATABASE_URL environment variable is not set.",
            file=sys.stderr,
        )
        sys.exit(1)
    sys.exit(asyncio.run(validate()))


if __name__ == "__main__":
    main()
