"""Unit tests for the M17 3/8 beat-coordinate conversion (Component 12 Step 20).

Covers the pure logic of ``backend/data_migrations/fix_38_beat_coordinates.py``:
the grid check that decides whether a stored value could have come from the
compound reading, the conversion itself, and the per-movement classification the
script's idempotence rests on.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

_PATH = (
    Path(__file__).resolve().parents[2]
    / "data_migrations"
    / "fix_38_beat_coordinates.py"
)

_THIRD = 1.0 / 3.0


def _load() -> ModuleType:
    """Import the migration script by path (data_migrations is not a package)."""
    spec = importlib.util.spec_from_file_location("fix_38_beat_coordinates", _PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


mod = _load()
convert = mod.convert
is_old_encoding_value = mod.is_old_encoding_value
classify_movement = mod.classify_movement


class TestIsOldEncodingValue:
    """Which stored values the compound reading of 3/8 could have written."""

    @pytest.mark.parametrize(
        "beat", [1.0, 1 + _THIRD, 1 + 2 * _THIRD, 2.0, 1.33333333333333]
    )
    def test_points_on_the_eighth_grid(self, beat: float) -> None:
        # Including the rounded value as PostgreSQL hands it back: the stored
        # float is not bit-identical to 1 + 1/3 computed here.
        assert is_old_encoding_value(beat) is True

    @pytest.mark.parametrize("beat", [1.5, 2.5, 3.0, 4.0, 0.5, 2.25])
    def test_points_off_it(self, beat: float) -> None:
        assert is_old_encoding_value(beat) is False


class TestConvert:
    """The map from the compound reading to the corrected one."""

    @pytest.mark.parametrize(
        ("old", "new"),
        [
            (1.0, 1.0),  # the downbeat is the downbeat under either rule
            (1 + _THIRD, 2.0),  # second eighth
            (1 + 2 * _THIRD, 3.0),  # third eighth
            (2.0, 4.0),  # the bar's exclusive end
            (1.33333333333333, 2.0),  # as stored, not as recomputed
            (1.66666666666667, 3.0),
        ],
    )
    def test_each_grid_point(self, old: float, new: float) -> None:
        assert convert(old) == new

    def test_the_map_is_increasing(self) -> None:
        # Which is why the ADR-005 ordering invariant survives the conversion:
        # a pair ordered before it is ordered after it.
        grid = [1.0, 1 + _THIRD, 1 + 2 * _THIRD, 2.0]
        converted = [convert(v) for v in grid]
        assert converted == sorted(converted)
        assert len(set(converted)) == len(grid)

    def test_it_returns_exact_integers(self) -> None:
        # The new grid is whole beats; a value carrying float dust would fail
        # the is-it-already-converted check on the next run.
        for value in (1 + _THIRD, 1 + 2 * _THIRD, 2.0):
            assert convert(value).is_integer()


class TestClassifyMovement:
    """The per-movement decision the script's idempotence rests on."""

    def test_a_third_means_the_old_encoding(self) -> None:
        assert classify_movement([1.0, 1 + _THIRD], [2.0]) == "old"

    def test_a_value_past_the_old_bar_end_means_the_new_one(self) -> None:
        # 3.0 and 4.0 are unreachable under a reading whose bar ends at 2.0.
        assert classify_movement([1.0, 3.0], [4.0]) == "new"

    def test_a_start_of_two_means_the_new_one(self) -> None:
        # The old reading ended the bar at 2.0, so nothing could start there —
        # while a *end* of 2.0 is exactly the old bar end and proves nothing.
        assert classify_movement([2.0], [4.0]) == "new"
        assert classify_movement([1.0], [2.0]) == "ambiguous"

    def test_no_coordinates_at_all(self) -> None:
        assert classify_movement([], []) == "empty"

    def test_the_overlap_is_reported_not_guessed(self) -> None:
        # Beat 1 and an end of 2.0 are legal in both encodings. Converting such
        # a movement twice would send its 2.0 to 4.0 and then off the grid, so
        # the script refuses rather than guess.
        assert classify_movement([1.0, 1.0], [2.0, 2.0]) == "ambiguous"

    def test_converting_an_old_movement_makes_it_classify_as_new(self) -> None:
        # The idempotence claim itself, end to end over the pure functions: a
        # second run of the script must find nothing to do.
        starts = [1.0, 1 + _THIRD, 1 + 2 * _THIRD]
        ends = [1 + _THIRD, 2.0, 2.0]
        assert classify_movement(starts, ends) == "old"
        assert (
            classify_movement(
                [convert(v) for v in starts],
                [convert(v) for v in ends],
            )
            == "new"
        )
