"""Unit tests for movement-section resolution and the restart detector (ADR-036).

Two independent pieces are covered:

    * ``services.fragments._section_label`` — resolving which named section a
      fragment begins in, from the editorial ``mc`` spans.
    * ``scripts.validate_movement_sections.measure_profile`` — detecting, from an
      MEI document, that a movement's bar numbers restart. This is the guard that
      catches a future corpus needing sections that nobody recorded.

No database, object storage, or network is required.

See docs/roadmap/component-11-concept-glossary.md § Step 9B/9C.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

from services.fragments import _section_label  # noqa: E402
from validate_movement_sections import measure_profile  # noqa: E402

_MEI_NS = "http://www.music-encoding.org/ns/mei"

# K331/ii as ingested: Menuetto mc 1-48 (@n 1-48), Trio mc 49-101 (@n 1-52 then
# an X1 volta complement).
_K331_II = [(1, 48, "Menuetto"), (49, 101, "Trio")]


def _mei(measures: list[tuple[str, str | None]]) -> bytes:
    """Build a minimal MEI document from ``(@n, ending @n or None)`` pairs."""
    body: list[str] = []
    open_ending: str | None = None
    for n, ending in measures:
        if ending != open_ending:
            if open_ending is not None:
                body.append("</ending>")
            if ending is not None:
                body.append(f'<ending n="{ending}">')
            open_ending = ending
        body.append(f'<measure n="{n}"/>')
    if open_ending is not None:
        body.append("</ending>")
    inner = "".join(body)
    return (
        f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score><section>'
        f"{inner}"
        f"</section></score></mdiv></body></music></mei>"
    ).encode()


# ---------------------------------------------------------------------------
# TestSectionLabel
# ---------------------------------------------------------------------------


class TestSectionLabel:
    """_section_label — resolving a fragment's section by mc containment."""

    def test_unsectioned_movement_has_no_qualifier(self) -> None:
        """The ~52 movements with no sections render an unqualified label."""
        assert _section_label(None, 12) is None
        assert _section_label([], 12) is None

    def test_resolves_each_section(self) -> None:
        """A fragment resolves to the section containing its first measure."""
        assert _section_label(_K331_II, 1) == "Menuetto"
        assert _section_label(_K331_II, 48) == "Menuetto"
        assert _section_label(_K331_II, 49) == "Trio"
        assert _section_label(_K331_II, 101) == "Trio"

    def test_ambiguous_bar_numbers_resolve_apart(self) -> None:
        """The point of the whole exercise: two 'm. 12's, two different labels.

        K331/ii's Menuetto m. 12 is mc 12; the Trio's m. 12 is mc 60. Both are
        stored as ``bar_start = 12``.
        """
        assert _section_label(_K331_II, 12) == "Menuetto"
        assert _section_label(_K331_II, 60) == "Trio"

    def test_section_spans_ending_measures(self) -> None:
        """The Trio runs to mc 101 — its last measures sit inside a volta ending.

        Bounds computed over bare measures alone would stop at 99 and orphan a
        fragment tagged in the second ending.
        """
        assert _section_label(_K331_II, 100) == "Trio"
        assert _section_label(_K331_II, 101) == "Trio"

    def test_mc_outside_every_span_is_unlabelled(self) -> None:
        """Defensive: uncovered mc yields no qualifier rather than a wrong one."""
        assert _section_label(_K331_II, 102) is None
        assert _section_label([(49, 101, "Trio")], 12) is None


# ---------------------------------------------------------------------------
# TestMeasureProfile
# ---------------------------------------------------------------------------


class TestMeasureProfile:
    """measure_profile — structural detection of a bar-number restart."""

    def test_continuous_numbering_is_one_run(self) -> None:
        """An ordinary movement produces a single run and needs no sections."""
        total, runs = measure_profile(_mei([(str(n), None) for n in range(1, 21)]))
        assert total == 20
        assert runs == [(1, 20)]

    def test_restart_is_two_runs_with_mc_bounds(self) -> None:
        """A restart splits the runs, reported in mc terms (the K331/ii shape)."""
        measures = [(str(n), None) for n in range(1, 5)]
        measures += [(str(n), None) for n in range(1, 7)]
        total, runs = measure_profile(_mei(measures))
        assert total == 10
        assert runs == [(1, 4), (5, 10)]

    def test_ending_measures_count_toward_total_but_not_runs(self) -> None:
        """Endings are excluded from run detection and included in the total.

        This is what makes the validator's "last section ends at the final mc"
        check correct for K331/ii, whose Trio ends inside a volta ending.
        """
        measures: list[tuple[str, str | None]] = [(str(n), None) for n in range(1, 5)]
        measures += [("5", "1"), ("X1", "2")]
        total, runs = measure_profile(_mei(measures))
        assert total == 6
        assert runs == [(1, 4)]

    def test_x_prefixed_measures_do_not_break_a_run(self) -> None:
        """A split-measure complement is outside the numbering sequence.

        16 movements carry these; treating one as a restart would demand
        editorial sections for movements that do not need them.
        """
        measures: list[tuple[str, str | None]] = [
            ("1", None),
            ("2", None),
            ("X1", None),
            ("3", None),
            ("4", None),
        ]
        total, runs = measure_profile(_mei(measures))
        assert total == 5
        assert runs == [(1, 5)]

    def test_pickup_bar_zero_does_not_start_a_second_run(self) -> None:
        """`@n=0` opens the sequence; 0 < 1 must not read as a restart."""
        measures = [("0", None)] + [(str(n), None) for n in range(1, 6)]
        _total, runs = measure_profile(_mei(measures))
        assert runs == [(1, 6)]
