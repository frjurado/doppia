"""Unit tests for the _sources_in_range helper (Component 8 Step 3 / ADR-009).

``_sources_in_range`` collects distinct source strings from harmony events
that fall within a fragment's bar range, applying the same volta filtering
as ``_slice_harmony_events``.  The result populates ``harmony_sources`` on
both the browse-list and detail-read responses.

These tests exercise the pure function directly; no database or mock required.

Verification cases from the roadmap (Step 3 / Step 13):
    - DCML vs unrestricted mixes → ``harmony_sources`` set
    - Events outside the bar range are excluded
    - Volta filtering mirrors ``_slice_harmony_events`` behaviour
    - Duplicate sources are deduplicated; result is sorted
    - Events with no ``source`` field are excluded
"""

from __future__ import annotations

from services.fragments import _sources_in_range

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ev(
    mn: int,
    source: str | None = "DCML",
    volta: int | None = None,
) -> dict:
    """Minimal harmony event dict."""
    ev: dict = {"mn": mn}
    if source is not None:
        ev["source"] = source
    if volta is not None:
        ev["volta"] = volta
    return ev


# ---------------------------------------------------------------------------
# TestSourcesInRange
# ---------------------------------------------------------------------------


class TestSourcesInRange:
    """_sources_in_range — source collection and range filtering."""

    def test_empty_events_returns_empty_list(self) -> None:
        """No events → empty list."""
        assert _sources_in_range([], 1, 4, None) == []

    def test_single_dcml_event_in_range(self) -> None:
        """A single DCML event within the range → [\"DCML\"]."""
        events = [_ev(mn=2, source="DCML")]
        assert _sources_in_range(events, 1, 4, None) == ["DCML"]

    def test_multiple_distinct_sources_sorted(self) -> None:
        """Multiple distinct sources are returned in sorted order."""
        events = [
            _ev(mn=1, source="manual"),
            _ev(mn=2, source="DCML"),
            _ev(mn=3, source="abc"),
        ]
        result = _sources_in_range(events, 1, 4, None)
        assert result == sorted(result)
        assert set(result) == {"DCML", "manual", "abc"}

    def test_duplicate_sources_deduplicated(self) -> None:
        """Two events with the same source appear once in the result."""
        events = [_ev(mn=1, source="DCML"), _ev(mn=2, source="DCML")]
        assert _sources_in_range(events, 1, 4, None) == ["DCML"]

    def test_event_before_bar_start_excluded(self) -> None:
        """An event with mn < bar_start is excluded."""
        events = [_ev(mn=0, source="DCML")]
        assert _sources_in_range(events, 1, 4, None) == []

    def test_event_after_bar_end_excluded(self) -> None:
        """An event with mn > bar_end is excluded."""
        events = [_ev(mn=10, source="DCML")]
        assert _sources_in_range(events, 1, 4, None) == []

    def test_event_at_bar_start_included(self) -> None:
        """An event exactly at bar_start is included (inclusive lower bound)."""
        events = [_ev(mn=1, source="DCML")]
        assert _sources_in_range(events, 1, 4, None) == ["DCML"]

    def test_event_at_bar_end_included(self) -> None:
        """An event exactly at bar_end is included (inclusive upper bound)."""
        events = [_ev(mn=4, source="DCML")]
        assert _sources_in_range(events, 1, 4, None) == ["DCML"]

    def test_event_with_no_source_field_excluded(self) -> None:
        """An event missing the ``source`` key is not counted."""
        events = [{"mn": 2}]  # no 'source' key
        assert _sources_in_range(events, 1, 4, None) == []

    def test_event_with_none_source_excluded(self) -> None:
        """An event whose source value is None is not counted."""
        events = [_ev(mn=2, source=None)]
        assert _sources_in_range(events, 1, 4, None) == []

    def test_event_with_missing_mn_excluded(self) -> None:
        """An event with no ``mn`` key is skipped entirely."""
        events = [{"source": "DCML"}]  # no 'mn' key
        assert _sources_in_range(events, 1, 4, None) == []

    def test_mixed_in_range_and_out_of_range(self) -> None:
        """Only in-range events contribute to the result set."""
        events = [
            _ev(mn=2, source="DCML"),  # in range
            _ev(mn=10, source="manual"),  # out of range
        ]
        assert _sources_in_range(events, 1, 4, None) == ["DCML"]

    def test_dcml_and_manual_mix_includes_both(self) -> None:
        """A DCML + manual mix reports both sources (and DCML triggers CC BY-SA)."""
        events = [
            _ev(mn=1, source="manual"),
            _ev(mn=2, source="DCML"),
        ]
        result = _sources_in_range(events, 1, 4, None)
        assert set(result) == {"DCML", "manual"}

    def test_only_manual_events_returns_manual_only(self) -> None:
        """Fragments with no DCML events report only the non-DCML sources."""
        events = [
            _ev(mn=1, source="manual"),
            _ev(mn=2, source="manual"),
        ]
        assert _sources_in_range(events, 1, 4, None) == ["manual"]


# ---------------------------------------------------------------------------
# TestSourcesInRangeVoltaFiltering
# ---------------------------------------------------------------------------


class TestSourcesInRangeVoltaFiltering:
    """Volta filtering behaviour when repeat_context is set."""

    def test_first_ending_excludes_second_ending_events(self) -> None:
        """Events in the second volta are excluded when fragment is in the first."""
        events = [_ev(mn=2, source="DCML", volta=2)]
        result = _sources_in_range(events, 1, 4, "first_ending")
        assert result == []

    def test_first_ending_includes_matching_volta(self) -> None:
        """Events in volta=1 are included when repeat_context is first_ending."""
        events = [_ev(mn=2, source="DCML", volta=1)]
        result = _sources_in_range(events, 1, 4, "first_ending")
        assert result == ["DCML"]

    def test_no_repeat_context_includes_all_volta_values(self) -> None:
        """Without repeat_context all events in range are collected regardless of volta."""
        events = [
            _ev(mn=2, source="DCML", volta=1),
            _ev(mn=2, source="manual", volta=2),
        ]
        result = _sources_in_range(events, 1, 4, None)
        assert set(result) == {"DCML", "manual"}

    def test_second_ending_includes_volta_2_only(self) -> None:
        """second_ending context excludes volta=1 events."""
        events = [
            _ev(mn=2, source="manual", volta=1),  # excluded
            _ev(mn=2, source="DCML", volta=2),  # included
        ]
        result = _sources_in_range(events, 1, 4, "second_ending")
        assert result == ["DCML"]

    def test_no_volta_on_event_included_when_no_filter(self) -> None:
        """An event with no volta field is included when repeat_context is None."""
        events = [{"mn": 2, "source": "DCML"}]  # no volta field
        result = _sources_in_range(events, 1, 4, None)
        assert result == ["DCML"]

    def test_no_volta_on_event_excluded_when_filter_active(self) -> None:
        """An event with no volta field is excluded when a volta filter is active.

        ``_REPEAT_CONTEXT_TO_VOLTA`` maps ``first_ending`` to volta 1.  An
        event without a ``volta`` key returns ``None`` for ``ev.get('volta')``,
        which does not equal 1, so it is filtered out.
        """
        events = [{"mn": 2, "source": "DCML"}]  # no volta field → volta=None
        result = _sources_in_range(events, 1, 4, "first_ending")
        assert result == []
