"""Integration tests for the harmony event correction API (Step 7 — Component 5).

Tests the six analysis endpoints against a real PostgreSQL instance:
    GET    /api/v1/movements/{id}/analysis/events           — read / slice
    POST   /api/v1/movements/{id}/analysis/events           — insert event
    POST   /api/v1/movements/{id}/analysis/events/delete    — delete event
    PATCH  /api/v1/movements/{id}/analysis/events/boundary  — move boundary
    PATCH  /api/v1/movements/{id}/analysis/events/chord     — edit chord
    POST   /api/v1/movements/{id}/analysis/events/confirm   — confirm/review

Verification points from the roadmap:
- Each primitive mutates events correctly and sets provenance flags.
- move_boundary does not alter chord identity fields.
- edit_chord does not alter beat position.
- confirm_event flips only reviewed=True; source and auto are unchanged.
- A range slice via GET returns the corrected event after each mutation.
- Movement with no analysis record returns 404.
- An unknown event identity returns 404.
- Unauthenticated requests return 401.

Requires ``docker compose up`` (PostgreSQL) before the test session.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# Shared test data helpers
# ---------------------------------------------------------------------------

_DCML_EVENT: dict[str, Any] = {
    "mc": 1,
    "mn": 1,
    "volta": None,
    "beat": 1.0,
    "local_key": "G major",
    "root": 5,
    "quality": "major",
    "inversion": 0,
    "numeral": "V",
    "root_accidental": None,
    "applied_to": None,
    "extensions": [],
    "bass_pitch": None,
    "soprano_pitch": None,
    "source": "DCML",
    "auto": False,
    "reviewed": False,
}

_TONIC_EVENT: dict[str, Any] = {
    "mc": 2,
    "mn": 2,
    "volta": None,
    "beat": 1.0,
    "local_key": "G major",
    "root": 1,
    "quality": "major",
    "inversion": 0,
    "numeral": "I",
    "root_accidental": None,
    "applied_to": None,
    "extensions": [],
    "bass_pitch": None,
    "soprano_pitch": None,
    "source": "DCML",
    "auto": False,
    "reviewed": True,
}

_AUTH = {"Authorization": "Bearer dev-token"}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def seeded_movement(db_session: AsyncSession) -> AsyncGenerator[str, None]:
    """Insert a composer → corpus → work → movement chain; yield movement UUID."""
    suffix = uuid.uuid4().hex[:8]
    composer_id = str(uuid.uuid4())
    corpus_id = str(uuid.uuid4())
    work_id = str(uuid.uuid4())
    movement_id = str(uuid.uuid4())

    await db_session.execute(
        text(
            "INSERT INTO composer (id, slug, name, sort_name) "
            "VALUES (:id, :slug, :name, :sort_name)"
        ),
        {
            "id": composer_id,
            "slug": f"analysis-test-mozart-{suffix}",
            "name": "Wolfgang Amadeus Mozart",
            "sort_name": "Mozart, Wolfgang Amadeus",
        },
    )
    await db_session.execute(
        text(
            "INSERT INTO corpus (id, composer_id, slug, title, analysis_source, licence) "
            "VALUES (:id, :composer_id, :slug, :title, :source, :licence)"
        ),
        {
            "id": corpus_id,
            "composer_id": composer_id,
            "slug": f"piano-sonatas-{suffix}",
            "title": "Piano Sonatas",
            "source": "DCML",
            "licence": "CC-BY-SA-4.0",
        },
    )
    await db_session.execute(
        text(
            "INSERT INTO work (id, corpus_id, slug, title, catalogue_number) "
            "VALUES (:id, :corpus_id, :slug, :title, :cat)"
        ),
        {
            "id": work_id,
            "corpus_id": corpus_id,
            "slug": f"k331-{suffix}",
            "title": "Piano Sonata No. 11",
            "cat": "K. 331",
        },
    )
    await db_session.execute(
        text(
            "INSERT INTO movement "
            "(id, work_id, slug, movement_number, key_signature, meter, mei_object_key) "
            "VALUES (:id, :work_id, :slug, :num, :key, :meter, :mei_key)"
        ),
        {
            "id": movement_id,
            "work_id": work_id,
            "slug": f"movement-1-{suffix}",
            "num": 1,
            "key": "G major",
            "meter": "4/4",
            "mei_key": f"test/{suffix}/movement-1.mei",
        },
    )
    await db_session.commit()

    yield movement_id

    await db_session.execute(
        text("DELETE FROM movement WHERE id = :mid"), {"mid": movement_id}
    )
    await db_session.execute(text("DELETE FROM work WHERE id = :wid"), {"wid": work_id})
    await db_session.execute(
        text("DELETE FROM corpus WHERE id = :cid"), {"cid": corpus_id}
    )
    await db_session.execute(
        text("DELETE FROM composer WHERE id = :cid"), {"cid": composer_id}
    )
    await db_session.commit()


@pytest_asyncio.fixture
async def seeded_analysis(
    db_session: AsyncSession,
    seeded_movement: str,
) -> AsyncGenerator[str, None]:
    """Insert a movement_analysis row with two sample events; yield movement UUID."""
    events = [_DCML_EVENT, _TONIC_EVENT]
    await db_session.execute(
        text(
            "INSERT INTO movement_analysis (movement_id, events, music21_version) "
            "VALUES (:mid, :events::jsonb, :ver)"
        ),
        {
            "mid": seeded_movement,
            "events": json.dumps(events),
            "ver": "none",
        },
    )
    await db_session.commit()

    yield seeded_movement

    await db_session.execute(
        text("DELETE FROM movement_analysis WHERE movement_id = :mid"),
        {"mid": seeded_movement},
    )
    await db_session.commit()


# ---------------------------------------------------------------------------
# Tests: GET events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestGetEvents:
    """GET /api/v1/movements/{id}/analysis/events"""

    async def test_returns_all_events(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events",
            headers=_AUTH,
        )
        assert resp.status_code == 200, resp.text
        events = resp.json()
        assert len(events) == 2
        mns = {ev["mn"] for ev in events}
        assert mns == {1, 2}

    async def test_bar_start_filter(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_start=2",
            headers=_AUTH,
        )
        assert resp.status_code == 200, resp.text
        events = resp.json()
        assert len(events) == 1
        assert events[0]["mn"] == 2

    async def test_bar_end_filter(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_end=1",
            headers=_AUTH,
        )
        assert resp.status_code == 200, resp.text
        events = resp.json()
        assert len(events) == 1
        assert events[0]["mn"] == 1

    async def test_unknown_movement_returns_404(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        resp = await integration_test_client.get(
            f"/api/v1/movements/{uuid.uuid4()}/analysis/events",
            headers=_AUTH,
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "MOVEMENT_NOT_FOUND"

    async def test_requires_auth(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events",
        )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Tests: insert event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestInsertEvent:
    """POST /api/v1/movements/{id}/analysis/events"""

    async def test_insert_adds_event_with_manual_provenance(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        payload = {
            "mn": 3,
            "volta": None,
            "beat": 2.0,
            "mc": 3,
            "local_key": "G major",
            "root": 4,
            "quality": "major",
            "inversion": 1,
            "numeral": "IV6",
        }
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events",
            headers=_AUTH,
            json=payload,
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["mn"] == 3
        assert body["beat"] == 2.0
        assert body["root"] == 4
        assert body["source"] == "manual"
        assert body["auto"] is False
        assert body["reviewed"] is True

    async def test_insert_appears_in_subsequent_get(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        payload = {
            "mn": 4,
            "volta": None,
            "beat": 1.0,
            "root": 2,
            "quality": "minor",
            "inversion": 0,
            "numeral": "ii",
        }
        await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events",
            headers=_AUTH,
            json=payload,
        )

        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_start=4&bar_end=4",
            headers=_AUTH,
        )
        assert resp.status_code == 200, resp.text
        events = resp.json()
        assert len(events) == 1
        assert events[0]["mn"] == 4
        assert events[0]["numeral"] == "ii"

    async def test_insert_unknown_movement_returns_404(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{uuid.uuid4()}/analysis/events",
            headers=_AUTH,
            json={
                "mn": 1,
                "beat": 1.0,
                "root": 1,
                "quality": "major",
                "inversion": 0,
                "numeral": "I",
            },
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: delete event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestDeleteEvent:
    """POST /api/v1/movements/{id}/analysis/events/delete"""

    async def test_delete_removes_event(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/delete",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 204, resp.text

        # Verify the event is gone.
        get_resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_start=1&bar_end=1",
            headers=_AUTH,
        )
        assert get_resp.status_code == 200
        assert get_resp.json() == []

    async def test_delete_unknown_event_returns_404(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/delete",
            headers=_AUTH,
            json={"mn": 99, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "HARMONY_EVENT_NOT_FOUND"

    async def test_delete_unknown_movement_returns_404(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{uuid.uuid4()}/analysis/events/delete",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Tests: move boundary
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestMoveBoundary:
    """PATCH /api/v1/movements/{id}/analysis/events/boundary"""

    async def test_move_changes_beat_not_chord(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/boundary",
            headers=_AUTH,
            json={"mn": 2, "volta": None, "beat": 1.0, "new_beat": 3.0},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["beat"] == 3.0
        # Chord identity fields must be unchanged.
        assert body["root"] == 1
        assert body["quality"] == "major"
        assert body["numeral"] == "I"
        # Provenance flags set.
        assert body["source"] == "manual"
        assert body["auto"] is False
        assert body["reviewed"] is True

    async def test_move_same_beat_returns_422(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/boundary",
            headers=_AUTH,
            json={"mn": 2, "volta": None, "beat": 1.0, "new_beat": 1.0},
        )
        assert resp.status_code == 422

    async def test_move_unknown_event_returns_404(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/boundary",
            headers=_AUTH,
            json={"mn": 99, "volta": None, "beat": 1.0, "new_beat": 2.0},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "HARMONY_EVENT_NOT_FOUND"

    async def test_move_persists_on_next_read(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/boundary",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0, "new_beat": 2.0},
        )
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_start=1&bar_end=1",
            headers=_AUTH,
        )
        assert resp.status_code == 200
        events = resp.json()
        assert len(events) == 1
        assert events[0]["beat"] == 2.0


# ---------------------------------------------------------------------------
# Tests: edit chord
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestEditChord:
    """PATCH /api/v1/movements/{id}/analysis/events/chord"""

    async def test_edit_changes_chord_not_beat(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/chord",
            headers=_AUTH,
            json={
                "mn": 1,
                "volta": None,
                "beat": 1.0,
                "quality": "minor",
                "numeral": "v",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Beat must not change.
        assert body["beat"] == 1.0
        assert body["mn"] == 1
        # Changed fields.
        assert body["quality"] == "minor"
        assert body["numeral"] == "v"
        # Unchanged field (root was 5 in the original).
        assert body["root"] == 5
        # Provenance flags set.
        assert body["source"] == "manual"
        assert body["auto"] is False
        assert body["reviewed"] is True

    async def test_edit_no_chord_field_returns_422(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        # Payload has only identity fields, no chord fields.
        resp = await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/chord",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 422

    async def test_edit_unknown_event_returns_404(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/chord",
            headers=_AUTH,
            json={"mn": 99, "volta": None, "beat": 1.0, "quality": "minor"},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "HARMONY_EVENT_NOT_FOUND"

    async def test_edit_persists_on_next_read(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        await integration_test_client.patch(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/chord",
            headers=_AUTH,
            json={
                "mn": 2,
                "volta": None,
                "beat": 1.0,
                "root": 3,
                "quality": "minor",
                "numeral": "iii",
            },
        )
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_start=2&bar_end=2",
            headers=_AUTH,
        )
        assert resp.status_code == 200
        events = resp.json()
        assert events[0]["root"] == 3
        assert events[0]["quality"] == "minor"


# ---------------------------------------------------------------------------
# Tests: confirm event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestConfirmEvent:
    """POST /api/v1/movements/{id}/analysis/events/confirm"""

    async def test_confirm_flips_only_reviewed(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        # _DCML_EVENT has reviewed=False and source="DCML".
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Only reviewed changes.
        assert body["reviewed"] is True
        # source and auto must be unchanged.
        assert body["source"] == "DCML"
        assert body["auto"] is False
        # Chord fields must be unchanged.
        assert body["root"] == 5
        assert body["quality"] == "major"
        assert body["beat"] == 1.0

    async def test_confirm_already_reviewed_is_idempotent(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        # _TONIC_EVENT has reviewed=True already.
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 2, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["reviewed"] is True

    async def test_confirm_unknown_event_returns_404(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 99, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "HARMONY_EVENT_NOT_FOUND"

    async def test_confirm_unknown_movement_returns_404(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{uuid.uuid4()}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0},
        )
        assert resp.status_code == 404

    async def test_confirm_persists_on_next_read(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0},
        )
        resp = await integration_test_client.get(
            f"/api/v1/movements/{seeded_analysis}/analysis/events?bar_start=1&bar_end=1",
            headers=_AUTH,
        )
        assert resp.status_code == 200
        events = resp.json()
        assert events[0]["reviewed"] is True
        # source unchanged
        assert events[0]["source"] == "DCML"


# ---------------------------------------------------------------------------
# Tests: mc cross-check
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestMcCrossCheck:
    """Optional mc cross-check: mismatched mc skips the candidate event."""

    async def test_correct_mc_finds_event(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0, "mc": 1},
        )
        assert resp.status_code == 200, resp.text

    async def test_mismatched_mc_returns_404(
        self,
        integration_test_client: AsyncClient,
        seeded_analysis: str,
    ) -> None:
        # mc=99 does not match the stored mc=1, so the event is skipped.
        resp = await integration_test_client.post(
            f"/api/v1/movements/{seeded_analysis}/analysis/events/confirm",
            headers=_AUTH,
            json={"mn": 1, "volta": None, "beat": 1.0, "mc": 99},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "HARMONY_EVENT_NOT_FOUND"
