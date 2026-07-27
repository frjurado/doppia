"""Unit tests for MEI meter extraction (Track M18).

Covers `starting_meter` (what the movement is in) and `meter_at_mc` (what is in
force where a fragment sits), including the two spellings the corpus uses and the
mid-piece change that makes the two questions differ.
"""

from __future__ import annotations

import pytest
from services.mei_meter import meter_at_mc, meter_timeline, starting_meter

_NS = 'xmlns="http://www.music-encoding.org/ns/mei"'


def _doc(head: str, measures: str) -> str:
    """Wrap a scoreDef body and measure list in a minimal MEI document."""
    return (
        f'<mei {_NS} meiversion="5.0"><music><body><mdiv><score>'
        f"{head}<section>{measures}</section>"
        f"</score></mdiv></body></music></mei>"
    )


def _measures(n: int, inserts: dict[int, str] | None = None) -> str:
    """`n` numbered measures, with optional extra markup inside chosen ones."""
    inserts = inserts or {}
    return "".join(
        f'<measure n="{i}">{inserts.get(i, "")}<staff n="1"><layer n="1"/></staff></measure>'
        for i in range(1, n + 1)
    )


SCOREDEF_ATTRS = _doc('<scoreDef meter.count="3" meter.unit="4"/>', _measures(4))
STAFFDEF_CHILD = _doc(
    '<scoreDef><staffGrp><staffDef n="1" meter.count="6" meter.unit="8"/>'
    "</staffGrp></scoreDef>",
    _measures(4),
)
METERSIG_CHILD = _doc(
    '<scoreDef><staffGrp><staffDef n="1"><meterSig count="2" unit="4"/>'
    "</staffDef></staffGrp></scoreDef>",
    _measures(4),
)
# The K331/i shape: opens 6/8, changes to 4/4 at a measure partway through.
MID_PIECE_CHANGE = _doc(
    '<scoreDef meter.count="6" meter.unit="8"/>',
    _measures(6, {4: '<meterSig count="4" unit="4"/>'}),
)
# A section-level scoreDef between measures — takes effect at the *next* measure.
BETWEEN_MEASURES = _doc(
    '<scoreDef meter.count="3" meter.unit="4"/>',
    '<measure n="1"><staff n="1"><layer n="1"/></staff></measure>'
    '<measure n="2"><staff n="1"><layer n="1"/></staff></measure>'
    '<scoreDef meter.count="2" meter.unit="2"/>'
    '<measure n="3"><staff n="1"><layer n="1"/></staff></measure>'
    '<measure n="4"><staff n="1"><layer n="1"/></staff></measure>',
)


class TestStartingMeter:
    """The opening meter — the value that belongs on the movement record."""

    @pytest.mark.parametrize(
        ("doc", "expected"),
        [
            (SCOREDEF_ATTRS, "3/4"),
            (STAFFDEF_CHILD, "6/8"),
            (METERSIG_CHILD, "2/4"),
            (MID_PIECE_CHANGE, "6/8"),
            (BETWEEN_MEASURES, "3/4"),
        ],
    )
    def test_reads_every_spelling(self, doc: str, expected: str) -> None:
        assert starting_meter(doc) == expected

    def test_a_mid_piece_change_does_not_move_it(self) -> None:
        # "What is this piece in?" is answered by the opening, not the last change.
        assert starting_meter(MID_PIECE_CHANGE) == "6/8"

    def test_no_declaration_is_none(self) -> None:
        assert starting_meter(_doc("<scoreDef/>", _measures(2))) is None

    def test_malformed_xml_is_none_not_an_exception(self) -> None:
        assert starting_meter("<mei><unclosed>") is None

    def test_accepts_bytes(self) -> None:
        assert starting_meter(SCOREDEF_ATTRS.encode("utf-8")) == "3/4"


class TestMeterAtMc:
    """The meter in force at one measure — the value that belongs on a fragment."""

    def test_constant_meter_is_the_same_everywhere(self) -> None:
        for mc in (1, 2, 3, 4):
            assert meter_at_mc(SCOREDEF_ATTRS, mc) == "3/4"

    def test_an_in_measure_change_takes_effect_at_that_measure(self) -> None:
        assert meter_at_mc(MID_PIECE_CHANGE, 3) == "6/8"
        assert meter_at_mc(MID_PIECE_CHANGE, 4) == "4/4"  # not 5
        assert meter_at_mc(MID_PIECE_CHANGE, 6) == "4/4"

    def test_a_change_between_measures_takes_effect_at_the_next(self) -> None:
        assert meter_at_mc(BETWEEN_MEASURES, 2) == "3/4"
        assert meter_at_mc(BETWEEN_MEASURES, 3) == "2/2"

    def test_before_the_first_measure_gives_the_opening_meter(self) -> None:
        assert meter_at_mc(MID_PIECE_CHANGE, 1) == "6/8"

    def test_past_the_end_gives_the_last_meter_in_force(self) -> None:
        assert meter_at_mc(MID_PIECE_CHANGE, 999) == "4/4"

    def test_no_declaration_is_none(self) -> None:
        assert meter_at_mc(_doc("<scoreDef/>", _measures(2)), 1) is None


class TestMeterTimeline:
    """The underlying timeline both questions read from."""

    def test_a_constant_meter_yields_one_entry(self) -> None:
        assert meter_timeline(SCOREDEF_ATTRS) == [(1, "3/4")]

    def test_a_change_yields_two_entries_with_its_mc(self) -> None:
        assert meter_timeline(MID_PIECE_CHANGE) == [(1, "6/8"), (4, "4/4")]

    def test_restating_the_same_meter_collapses(self) -> None:
        # The normalizer restates meterSig freely; that is not a change.
        doc = _doc(
            '<scoreDef meter.count="3" meter.unit="4"/>',
            _measures(4, {2: '<meterSig count="3" unit="4"/>'}),
        )
        assert meter_timeline(doc) == [(1, "3/4")]

    def test_a_declaration_with_junk_values_is_ignored(self) -> None:
        doc = _doc('<scoreDef meter.count="0" meter.unit="4"/>', _measures(2))
        assert meter_timeline(doc) == []
