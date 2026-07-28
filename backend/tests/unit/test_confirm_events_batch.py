"""Unit tests for batch harmony confirmation (Component 11 Step 13 follow-up).

Every harmony write is a read-modify-write of the movement's whole ``events``
array. "Confirm all" used to send one request per event, in parallel, so each
writer read the same array, flipped its own event, and wrote the lot back — last
commit wins, the rest silently lost. Francisco saw it as "it confirms, then only
one is confirmed", and the corpus bore it out: 102 of 163 events inside 279/i's
fragments were reviewed after a full pass.

``confirm_events`` does the batch in one transaction, which makes the loss
impossible rather than unlikely.

No database: ``_load`` is stubbed with an in-memory record.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from models.analysis import HarmonyEventConfirm
from services.analysis import MovementAnalysisService


def _events() -> list[dict]:
    return [
        {"mc": 9, "mn": 9, "beat": 1.0, "numeral": "I6", "reviewed": False},
        {"mc": 9, "mn": 9, "beat": 3.0, "numeral": "IV", "reviewed": False},
        {"mc": 10, "mn": 10, "beat": 1.0, "numeral": "V", "reviewed": False},
        {"mc": 10, "mn": 10, "beat": 3.0, "numeral": "V7", "reviewed": True},
    ]


@pytest.fixture()
def service(monkeypatch: pytest.MonkeyPatch) -> MovementAnalysisService:
    """A service backed by an in-memory record, with a no-op transaction."""
    record = SimpleNamespace(events=_events(), updated_at=None)
    svc = MovementAnalysisService(db=None)  # type: ignore[arg-type]

    @asynccontextmanager
    async def _fake_begin():
        yield None

    async def _fake_load(movement_id: uuid.UUID) -> SimpleNamespace:
        return record

    def _fake_persist(analysis: SimpleNamespace, events: list[dict]) -> None:
        analysis.events = events

    monkeypatch.setattr(
        svc, "_db", SimpleNamespace(begin=_fake_begin, add=lambda _: None)
    )
    monkeypatch.setattr(svc, "_load", _fake_load)
    monkeypatch.setattr(svc, "_persist", _fake_persist)
    svc._record = record  # type: ignore[attr-defined]
    return svc


def _confirm(mn: int, beat: float, mc: int | None = None) -> HarmonyEventConfirm:
    return HarmonyEventConfirm(mn=mn, beat=beat, mc=mc, volta=None)


class TestConfirmEvents:
    """The batch path."""

    @pytest.mark.asyncio
    async def test_confirms_every_event_in_one_pass(
        self, service: MovementAnalysisService
    ) -> None:
        # The regression in one assertion: all three land, not just the last.
        updated = await service.confirm_events(
            uuid.uuid4(),
            [_confirm(9, 1.0, 9), _confirm(9, 3.0, 9), _confirm(10, 1.0, 10)],
        )
        assert len(updated) == 3
        stored = service._record.events  # type: ignore[attr-defined]
        assert [e["reviewed"] for e in stored] == [True, True, True, True]

    @pytest.mark.asyncio
    async def test_writes_the_array_once_for_the_whole_batch(
        self, service: MovementAnalysisService, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # One write is what removes the race; N writes is what caused it.
        calls = 0
        original = service._persist

        def _counting(analysis, events):  # type: ignore[no-untyped-def]
            nonlocal calls
            calls += 1
            original(analysis, events)

        monkeypatch.setattr(service, "_persist", _counting)
        await service.confirm_events(
            uuid.uuid4(), [_confirm(9, 1.0, 9), _confirm(9, 3.0, 9)]
        )
        assert calls == 1

    @pytest.mark.asyncio
    async def test_an_already_reviewed_event_stays_reviewed(
        self, service: MovementAnalysisService
    ) -> None:
        await service.confirm_events(uuid.uuid4(), [_confirm(10, 3.0, 10)])
        stored = service._record.events  # type: ignore[attr-defined]
        assert stored[3]["reviewed"] is True

    @pytest.mark.asyncio
    async def test_an_unmatched_entry_is_skipped_not_fatal(
        self, service: MovementAnalysisService
    ) -> None:
        """Losing twenty confirmations to one stale entry would be worse.

        The panel's list can be a moment out of date — an event may have been
        edited or deleted between the last fetch and the click.
        """
        updated = await service.confirm_events(
            uuid.uuid4(), [_confirm(9, 1.0, 9), _confirm(99, 1.0, 99)]
        )
        assert len(updated) == 1
        assert service._record.events[0]["reviewed"] is True  # type: ignore[attr-defined]

    @pytest.mark.asyncio
    async def test_nothing_matched_writes_nothing(
        self, service: MovementAnalysisService, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = 0

        def _counting(analysis, events):  # type: ignore[no-untyped-def]
            nonlocal calls
            calls += 1

        monkeypatch.setattr(service, "_persist", _counting)
        updated = await service.confirm_events(uuid.uuid4(), [_confirm(99, 1.0, 99)])
        assert updated == []
        assert calls == 0

    @pytest.mark.asyncio
    async def test_no_other_field_is_touched(
        self, service: MovementAnalysisService
    ) -> None:
        """Confirm means reviewed=True and nothing else — not even provenance."""
        before = {k: v for k, v in _events()[0].items() if k != "reviewed"}
        await service.confirm_events(uuid.uuid4(), [_confirm(9, 1.0, 9)])
        after = service._record.events[0]  # type: ignore[attr-defined]
        assert {k: after[k] for k in before} == before
        assert "source" not in after
