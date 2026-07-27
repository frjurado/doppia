"""Unit tests for the M7 sub-part bound clamp (Component 11 Step 11).

Covers the pure coordinate logic of
``backend/data_migrations/clamp_subpart_bounds.py``: the clamp itself, the
ADR-005 beat-pair normalisation that follows it, and the refusal to guess when a
sub-part lies outside its parent altogether.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

_PATH = (
    Path(__file__).resolve().parents[2] / "data_migrations" / "clamp_subpart_bounds.py"
)


def _load() -> ModuleType:
    """Import the migration script by path (data_migrations is not a package)."""
    spec = importlib.util.spec_from_file_location("clamp_subpart_bounds", _PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before exec: @dataclass resolves annotations through
    # sys.modules[cls.__module__], which is None for an unregistered module.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


mod = _load()
Bounds = mod.Bounds
clamp_to_parent = mod.clamp_to_parent
measure_end_beat = mod.measure_end_beat
meter_is_disputed = mod.meter_is_disputed


class TestMeterIsDisputed:
    """The M17 guard: which meters have no agreed beat count."""

    def test_three_eight_is_disputed(self) -> None:
        # The ghost layer reads one dotted-quarter beat, ingest_analysis three
        # eighth-note beats. A beat number there denotes no fixed position.
        assert meter_is_disputed("3/8") is True

    @pytest.mark.parametrize("meter", ["6/8", "9/8", "12/8"])
    def test_larger_compound_meters_agree(self, meter: str) -> None:
        # Both rules call these compound, so the clamp is sound in them.
        assert meter_is_disputed(meter) is False

    @pytest.mark.parametrize("meter", ["4/4", "3/4", "2/4", "2/2", "6/4", "5/8", "7/8"])
    def test_simple_meters_agree(self, meter: str) -> None:
        assert meter_is_disputed(meter) is False

    @pytest.mark.parametrize("meter", [None, "", "common", "x/y"])
    def test_unparseable_is_not_disputed(self, meter: str | None) -> None:
        # Falls back to 4/4, on which the two rules agree.
        assert meter_is_disputed(meter) is False


class TestMeasureEndBeat:
    """Exclusive measure end from the movement meter."""

    @pytest.mark.parametrize(
        ("meter", "expected"),
        [
            ("4/4", 5.0),
            ("3/4", 4.0),
            ("2/4", 3.0),
            ("2/2", 3.0),
            ("6/8", 3.0),  # compound: two dotted-quarter beats
            ("9/8", 4.0),
            ("12/8", 5.0),
            # 3/8 counts as one dotted-quarter beat here, following the ghost
            # layer's isCompoundMeter (unit 8 and count divisible by 3). The
            # analysis ingest additionally requires count >= 6 and so reads 3/8 as
            # three beats — a real divergence, but the values this script repairs
            # were written by the ghost layer, so the ghost layer is the rule to
            # match. Recorded as a follow-up, not resolved here.
            ("3/8", 2.0),
        ],
    )
    def test_meters(self, meter: str, expected: float) -> None:
        assert measure_end_beat(meter) == expected

    @pytest.mark.parametrize("meter", [None, "", "common", "4", "x/y"])
    def test_unparseable_falls_back_to_4_4(self, meter: str | None) -> None:
        assert measure_end_beat(meter) == 5.0


class TestClampToParent:
    """The clamp: a sub-part is a part of its parent, never bigger."""

    # The 279/ii mm. 8-10 fragment: "m. 8 beat 3 - m. 10 beat 1" (exclusive 2.0),
    # mc 8-10, in 3/4 (so a full measure ends at beat 4.0).
    PARENT = Bounds(
        mc_start=8, mc_end=10, bar_start=8, bar_end=10, beat_start=3.0, beat_end=2.0
    )
    MEASURE_END = 4.0

    def test_first_stage_start_is_pulled_in_to_the_fragment_start(self) -> None:
        # Stored as a whole measure 8 — it began a beat and a half too early.
        child = Bounds(8, 8, 8, 8, None, None)
        out = clamp_to_parent(child, self.PARENT, self.MEASURE_END)
        assert out == Bounds(8, 8, 8, 8, 3.0, 4.0)

    def test_last_stage_end_is_pulled_in_to_the_fragment_end(self) -> None:
        # Stored as a whole measure 10 — it ran to the end of the bar.
        child = Bounds(10, 10, 10, 10, None, None)
        out = clamp_to_parent(child, self.PARENT, self.MEASURE_END)
        assert out == Bounds(10, 10, 10, 10, 1.0, 2.0)

    def test_interior_stage_is_left_alone(self) -> None:
        child = Bounds(9, 9, 9, 9, None, None)
        assert clamp_to_parent(child, self.PARENT, self.MEASURE_END) == child

    def test_a_stage_spanning_both_edges_is_clamped_on_both(self) -> None:
        child = Bounds(8, 10, 8, 10, None, None)
        out = clamp_to_parent(child, self.PARENT, self.MEASURE_END)
        assert out == Bounds(8, 10, 8, 10, 3.0, 2.0)

    def test_already_correct_bounds_are_untouched(self) -> None:
        # Idempotence: the output of a clamp is a fixed point of the clamp.
        child = Bounds(8, 8, 8, 8, 3.0, 4.0)
        assert clamp_to_parent(child, self.PARENT, self.MEASURE_END) == child

    def test_measure_level_stage_in_a_measure_level_parent_stays_null(self) -> None:
        # Nothing to clamp, so no gratuitous rewrite into beat coordinates.
        parent = Bounds(8, 10, 8, 10, None, None)
        child = Bounds(8, 9, 8, 9, None, None)
        assert clamp_to_parent(child, parent, self.MEASURE_END) == child

    def test_mc_is_clamped_not_only_the_beat(self) -> None:
        # A stage reaching a measure beyond the parent: mc and bar both come back.
        child = Bounds(8, 12, 8, 12, None, None)
        out = clamp_to_parent(child, self.PARENT, self.MEASURE_END)
        assert (out.mc_end, out.bar_end, out.beat_end) == (10, 10, 2.0)

    def test_bar_numbers_travel_with_mc_when_they_disagree(self) -> None:
        # K331/ii shape: the Trio restarts @n, so bar and mc are unrelated
        # numbers. The clamp must take both from the parent, never recompute one.
        parent = Bounds(
            mc_start=49, mc_end=52, bar_start=1, bar_end=4, beat_start=2.0, beat_end=3.0
        )
        child = Bounds(49, 52, 1, 4, None, None)
        out = clamp_to_parent(child, parent, self.MEASURE_END)
        assert (out.mc_start, out.bar_start) == (49, 1)
        assert (out.mc_end, out.bar_end) == (52, 4)

    def test_a_subpart_entirely_outside_its_parent_is_refused(self) -> None:
        child = Bounds(20, 22, 20, 22, None, None)
        assert clamp_to_parent(child, self.PARENT, self.MEASURE_END) is None

    def test_a_subpart_collapsing_to_zero_width_is_refused(self) -> None:
        # Ends exactly where the parent begins: nothing of it is inside.
        child = Bounds(6, 8, 6, 8, None, 3.0)
        assert clamp_to_parent(child, self.PARENT, self.MEASURE_END) is None

    def test_the_result_always_satisfies_the_wire_invariant(self) -> None:
        parent = self.PARENT
        candidates = [
            Bounds(8, 8, 8, 8, None, None),
            Bounds(8, 10, 8, 10, None, None),
            Bounds(10, 10, 10, 10, None, None),
            Bounds(9, 10, 9, 10, 1.0, 4.0),
            Bounds(8, 9, 8, 9, 1.0, None),
        ]
        for child in candidates:
            out = clamp_to_parent(child, parent, self.MEASURE_END)
            assert out is not None, child
            both_null = out.beat_start is None and out.beat_end is None
            both_set = out.beat_start is not None and out.beat_end is not None
            assert both_null or both_set, out
            if both_set and out.bar_start == out.bar_end:
                assert out.beat_start < out.beat_end, out
