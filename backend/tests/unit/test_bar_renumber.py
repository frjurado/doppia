"""Unit tests for editorial bar renumbering (§ 9G — K282/ii).

The fixture reproduces K282/ii's real shape, because that shape is the whole
difficulty: an anacrusis numbered 0, and bars split across repeat barlines whose
second half is an ``X``-labelled complement carrying its partner's ``mn``.
"""

from __future__ import annotations

from services.bar_renumber import (
    RESTARTS,
    Restart,
    apply_to_events,
    apply_to_harmonies_tsv,
    apply_to_mei,
    renumber_plan,
)

_NS = 'xmlns="http://www.music-encoding.org/ns/mei"'

# K282/ii, abridged but structurally faithful:
#   mc 1      @n 0    anacrusis (beat 3)
#   mc 2-3    @n 1-2
#   mc 4      @n 3    ┐ split bar 3 …
#   mc 5      @n X1   ┘ … its complement
#   mc 6      @n 4    "Fine" — end of Menuetto I
#   mc 7      @n X2   "Menuetto II" begins on the upbeat
#   mc 8-9    @n 5-6
#   mc 10     @n 7    ┐ split bar 7 …
#   mc 11     @n X3   ┘ … its complement
#   mc 12     @n 8
_NS_LIST = ["0", "1", "2", "3", "X1", "4", "X2", "5", "6", "7", "X3", "8"]


def _mei(ns: list[str] | None = None) -> str:
    measures = "".join(
        f'<measure n="{n}"><staff n="1"><layer n="1"/></staff></measure>'
        for n in (ns if ns is not None else _NS_LIST)
    )
    return (
        f'<mei {_NS} meiversion="5.0"><music><body><mdiv><score>'
        f"<scoreDef/><section>{measures}</section>"
        f"</score></mdiv></body></music></mei>"
    )


def _labels(xml: bytes | str) -> list[str]:
    import lxml.etree

    data = xml.encode("utf-8") if isinstance(xml, str) else xml
    root = lxml.etree.fromstring(data)
    return [
        el.get("n") or ""
        for el in root.iter()
        if isinstance(el.tag, str) and el.tag.endswith("}measure")
    ]


# The decision: Menuetto II starts at mc 7 and its upbeat is bar 0.
_RESTART = (Restart(at_mc=7, first_number=0),)


class TestRenumberPlan:
    """Building the new numbering."""

    def test_leaves_everything_before_the_restart_alone(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        assert all(mc >= 7 for mc in plan)

    def test_the_restart_measure_takes_first_number_even_though_it_is_a_complement(
        self,
    ) -> None:
        # mc 7 is currently X2. An editorial restart is precisely the claim that
        # this measure begins a count of its own, so it becomes bar 0 outright.
        plan = renumber_plan(_mei(), _RESTART)
        assert plan[7] == ("0", 0)

    def test_bars_after_it_count_from_one(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        assert plan[8] == ("1", 1)
        assert plan[9] == ("2", 2)
        assert plan[10] == ("3", 3)

    def test_the_complement_counter_restarts_too(self) -> None:
        # mc 11 was X3 — the third complement of the movement. Inside a section
        # numbered from scratch it is that section's first.
        plan = renumber_plan(_mei(), _RESTART)
        assert plan[11] == ("X1", 3)

    def test_a_complement_reports_the_bar_it_completes(self) -> None:
        # mc 11 completes bar 3 (mc 10), so a harmony row there carries mn 3 —
        # the DCML convention, preserved across the renumbering.
        plan = renumber_plan(_mei(), _RESTART)
        assert plan[11][1] == plan[10][1] == 3

    def test_counting_resumes_after_a_complement(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        assert plan[12] == ("4", 4)

    def test_no_restarts_is_an_empty_plan(self) -> None:
        assert renumber_plan(_mei(), ()) == {}

    def test_malformed_xml_is_an_empty_plan_not_an_exception(self) -> None:
        assert renumber_plan("<mei><unclosed>", _RESTART) == {}

    def test_a_restart_on_a_complete_bar_needs_no_special_case(self) -> None:
        plan = renumber_plan(_mei(), (Restart(at_mc=8, first_number=1),))
        assert plan[8] == ("1", 1)
        assert plan[9] == ("2", 2)

    def test_two_restarts_partition_the_movement(self) -> None:
        plan = renumber_plan(
            _mei(),
            (Restart(at_mc=7, first_number=0), Restart(at_mc=10, first_number=1)),
        )
        assert plan[7] == ("0", 0)
        assert plan[9] == ("2", 2)
        assert plan[10] == ("1", 1)  # the second restart takes over here
        assert plan[11] == ("X1", 1)

    def test_the_real_k282_declaration_is_the_agreed_mapping(self) -> None:
        # Guards the editorial decision itself: mc 35 -> 0, and the section's
        # first complete bar -> 1. Uses a 76-measure stand-in with K282/ii's
        # complement positions (mc 14, 35, 52).
        ns = []
        number = 0
        for mc in range(1, 77):
            if mc in (14, 35, 52):
                ns.append("X")
            else:
                ns.append(str(number))
                number += 1
        plan = renumber_plan(_mei(ns), RESTARTS["k282/movement-2"])
        assert plan[35] == ("0", 0)
        assert plan[36] == ("1", 1)
        assert plan[51] == ("16", 16)
        assert plan[52] == ("X1", 16)
        assert plan[53] == ("17", 17)
        assert plan[76] == ("40", 40)
        assert 34 not in plan  # Menuetto I untouched


class TestApplyToMei:
    """Rewriting @n."""

    def test_rewrites_only_the_planned_measures(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        out = _labels(apply_to_mei(_mei(), plan))
        assert out[:6] == ["0", "1", "2", "3", "X1", "4"]  # Menuetto I unchanged
        assert out[6:] == ["0", "1", "2", "3", "X1", "4"]  # Menuetto II renumbered

    def test_measure_count_is_unchanged_so_mc_cannot_move(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        assert len(_labels(apply_to_mei(_mei(), plan))) == len(_NS_LIST)

    def test_is_idempotent(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        once = apply_to_mei(_mei(), plan)
        # The plan is keyed on mc, which does not move, so re-applying is a no-op.
        twice = apply_to_mei(once, renumber_plan(once, _RESTART))
        assert _labels(once) == _labels(twice)


class TestApplyToEvents:
    """Rewriting harmony mn."""

    def test_moves_mn_for_planned_measures_only(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        events = [
            {"mc": 6, "mn": 4, "beat": 1.0},
            {"mc": 7, "mn": 4, "beat": 3.0},
            {"mc": 8, "mn": 5, "beat": 1.0},
        ]
        out, changed = apply_to_events(events, plan)
        assert changed == 2
        assert out[0]["mn"] == 4  # before the restart
        assert out[1]["mn"] == 0  # the upbeat becomes bar 0
        assert out[2]["mn"] == 1

    def test_events_without_mc_pass_through(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        out, changed = apply_to_events([{"mn": 5}], plan)
        assert changed == 0 and out == [{"mn": 5}]

    def test_is_idempotent(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        once, first = apply_to_events([{"mc": 8, "mn": 5}], plan)
        twice, second = apply_to_events(once, plan)
        assert (first, second) == (1, 0)
        assert once == twice

    def test_does_not_mutate_its_input(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        events = [{"mc": 8, "mn": 5}]
        apply_to_events(events, plan)
        assert events == [{"mc": 8, "mn": 5}]


class TestApplyToHarmoniesTsv:
    """Rewriting the mn column of a DCML harmonies TSV."""

    TSV = "mc\tmn\tmn_onset\tnumeral\n6\t4\t0\tI\n7\t4\t1/2\tV\n8\t5\t0\tI\n"

    def test_rewrites_mn_and_preserves_every_other_column(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        out = apply_to_harmonies_tsv(self.TSV, plan)
        lines = out.strip().split("\n")
        assert lines[0] == "mc\tmn\tmn_onset\tnumeral"
        assert lines[1] == "6\t4\t0\tI"  # before the restart
        assert lines[2] == "7\t0\t1/2\tV"  # upbeat -> bar 0, onset intact
        assert lines[3] == "8\t1\t0\tI"

    def test_a_tsv_with_no_rows_survives(self) -> None:
        plan = renumber_plan(_mei(), _RESTART)
        assert apply_to_harmonies_tsv("mc\tmn\n", plan).strip() == "mc\tmn"

    def test_empty_input_is_returned_unchanged(self) -> None:
        assert apply_to_harmonies_tsv("", renumber_plan(_mei(), _RESTART)) == ""
