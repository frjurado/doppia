"""Unit tests for harmony-event range slicing (Component 11 Step 10 / M6).

``MovementAnalysisService.get_events`` accepts two coordinate systems, and which
one it uses matters on any movement whose measure numbering is not a simple
1..N sequence:

* ``mc`` — document-order position index (ADR-015), unique by construction.
* ``mn`` — the notated bar number carried on the event.

On K331/ii the two disagree outright: the MEI's ``@n`` restarts at the Trio
(1-48 then 1-52) while the DCML annotation numbers straight through (1-101), so
the Trio's "m. 29" is ``mn=77``. Asking for bars 29-30 therefore served the
*Menuetto's* harmony to a Trio fragment — the bug these tests pin.

No database: the service's ``_load`` is stubbed with an in-memory record.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from services.analysis import MovementAnalysisService

# K331/ii in miniature. The Menuetto's bar 29 is mc 29; the Trio's notated bar
# 29 is mc 77 — and the DCML annotation calls it mn 77, not 29.
_EVENTS: list[dict] = [
    {"mc": 29, "mn": 29, "beat": 1.0, "numeral": "I", "source": "DCML"},
    {"mc": 30, "mn": 30, "beat": 1.0, "numeral": "V", "source": "DCML"},
    {"mc": 77, "mn": 77, "beat": 1.0, "numeral": "V2", "source": "DCML"},
    {"mc": 78, "mn": 78, "beat": 1.0, "numeral": "V7", "source": "DCML"},
    # A manually inserted event: mc is optional on the harmony API payloads.
    {"mn": 30, "beat": 3.0, "numeral": "ii", "source": "manual"},
]


@pytest.fixture()
def service(monkeypatch: pytest.MonkeyPatch) -> MovementAnalysisService:
    """A service whose _load returns the fixture events, no database involved."""
    svc = MovementAnalysisService(db=None)  # type: ignore[arg-type]

    async def _fake_load(movement_id: uuid.UUID) -> SimpleNamespace:
        return SimpleNamespace(events=list(_EVENTS))

    monkeypatch.setattr(svc, "_load", _fake_load)
    return svc


def _numerals(events: list[dict]) -> list[str]:
    return [e["numeral"] for e in events]


class TestGetEventsByMcRange:
    """get_events — the mc path, and its precedence over the bar bounds."""

    @pytest.mark.asyncio
    async def test_mc_range_selects_the_trio(
        self, service: MovementAnalysisService
    ) -> None:
        """The Trio's own measures, addressed by mc."""
        events = await service.get_events(uuid.uuid4(), mc_start=77, mc_end=78)
        assert _numerals(events) == ["V2", "V7"]

    @pytest.mark.asyncio
    async def test_mc_range_selects_the_menuetto(
        self, service: MovementAnalysisService
    ) -> None:
        """The Menuetto's measures, same notated bar numbers, different mc.

        The trailing "ii" is the fixture's manual insert at mn 30, which belongs
        to these bars — see ``test_an_mc_less_event_is_reachable_…`` below.
        """
        events = await service.get_events(uuid.uuid4(), mc_start=29, mc_end=30)
        assert _numerals(events) == ["I", "V", "ii"]

    @pytest.mark.asyncio
    async def test_mc_bounds_win_over_bar_bounds(
        self, service: MovementAnalysisService
    ) -> None:
        """Both supplied → mc decides.

        This is the fix in one assertion: the tagging tool sends the selection's
        bar range *and* its mc range, and the bar range for a Trio selection
        names the Menuetto's bars.
        """
        events = await service.get_events(
            uuid.uuid4(), bar_start=29, bar_end=30, mc_start=77, mc_end=78
        )
        assert _numerals(events) == ["V2", "V7"]

    @pytest.mark.asyncio
    async def test_an_mc_less_event_is_reachable_in_the_window_covering_its_bar(
        self, service: MovementAnalysisService
    ) -> None:
        """A manual insert has no mc, and must still be editable.

        Filtering on mc alone hid these from the harmony panel while the fragment
        detail and the in-score overlay — which both fall back to mn — went on
        showing them: visible everywhere except the one place they could be
        corrected. Found on 279/i m. 10, whose two hand-added harmonies could not
        be opened for editing.
        """
        events = await service.get_events(uuid.uuid4(), mc_start=29, mc_end=30)
        assert _numerals(events) == ["I", "V", "ii"]

    @pytest.mark.asyncio
    async def test_admitting_it_does_not_reopen_the_ambiguity(
        self, service: MovementAnalysisService
    ) -> None:
        """The Trio window must not pull in a Menuetto-bar manual event.

        The mn-30 insert belongs to the Menuetto. Asking for the Trio by mc must
        not serve it, or the mc path would be back to guessing — which is the
        whole reason it exists. Only mc-less events consult mn, and only within
        the bars the mc window itself covers.
        """
        events = await service.get_events(uuid.uuid4(), mc_start=77, mc_end=78)
        assert _numerals(events) == ["V2", "V7"]

    @pytest.mark.asyncio
    async def test_an_event_with_an_mc_is_still_judged_on_mc_alone(
        self, service: MovementAnalysisService
    ) -> None:
        """Placed events never fall back to mn, whatever their bar number."""
        events = await service.get_events(uuid.uuid4(), mc_start=77, mc_end=77)
        assert _numerals(events) == ["V2"]

    @pytest.mark.asyncio
    async def test_results_stay_in_musical_order_when_an_orphan_is_admitted(
        self, service: MovementAnalysisService
    ) -> None:
        """The mn-30 beat-3 insert sorts after the mn-30 beat-1 event."""
        events = await service.get_events(uuid.uuid4(), mc_start=29, mc_end=30)
        positions = [(e.get("mn"), e.get("beat")) for e in events]
        assert positions == sorted(positions)


class TestGetEventsByBarRange:
    """get_events — the mn path, unchanged for callers that mean notated bars."""

    @pytest.mark.asyncio
    async def test_bar_range_still_filters_on_mn(
        self, service: MovementAnalysisService
    ) -> None:
        """Without mc bounds the bar range applies, including mc-less events."""
        events = await service.get_events(uuid.uuid4(), bar_start=29, bar_end=30)
        assert _numerals(events) == ["I", "V", "ii"]

    @pytest.mark.asyncio
    async def test_bar_range_on_a_restarting_movement_is_wrong(
        self, service: MovementAnalysisService
    ) -> None:
        """The defect, pinned: bars 29-30 of the Trio return the Menuetto's.

        Not a bug in this function — mn simply cannot express the question. It is
        why the caller must send mc.
        """
        events = await service.get_events(uuid.uuid4(), bar_start=29, bar_end=30)
        assert "V2" not in _numerals(events)

    @pytest.mark.asyncio
    async def test_no_bounds_returns_everything(
        self, service: MovementAnalysisService
    ) -> None:
        """Omitting every bound returns the full event list."""
        events = await service.get_events(uuid.uuid4())
        assert len(events) == len(_EVENTS)
