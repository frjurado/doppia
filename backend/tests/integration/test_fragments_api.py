"""Integration tests for the fragment write API (Step 6 — Component 5).

Tests the three producer endpoints against a real PostgreSQL instance:
    POST  /api/v1/fragments              — create a draft (atomic parent+child)
    PATCH /api/v1/fragments/{id}         — update a draft
    POST  /api/v1/fragments/{id}/submit  — transition draft → submitted

Neo4j concept-existence checks are replaced by a mock driver that reports
every concept_id as existing, because no Neo4j instance is available in the
integration test environment.

Requires ``docker compose up`` (PostgreSQL) before the test session.

Four cases from the roadmap verification spec:
    1. create with two sub-parts writes three rows atomically
    2. a forced child failure (invalid payload) leaves zero rows
    3. submit is rejected if concept_id vanished from graph (mocked to fail)
    4. a non-creator editing a draft is rejected
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _min_summary(**overrides: Any) -> dict[str, Any]:
    """Minimal valid version-1 summary dict."""
    base: dict[str, Any] = {
        "version": 1,
        "key": "G major",
        "meter": "4/4",
        "concepts": ["PerfectAuthenticCadence"],
    }
    base.update(overrides)
    return base


def _min_tag(concept_id: str = "PerfectAuthenticCadence") -> dict[str, Any]:
    return {"concept_id": concept_id, "is_primary": True}


def _fragment_payload(movement_id: str, **overrides: Any) -> dict[str, Any]:
    """Minimal valid FragmentCreate payload dict."""
    base: dict[str, Any] = {
        "movement_id": movement_id,
        "bar_start": 1,
        "bar_end": 4,
        "mc_start": 1,
        "mc_end": 4,
        "summary": _min_summary(),
        "concept_tags": [_min_tag()],
        "sub_parts": [],
    }
    base.update(overrides)
    return base


def _make_mock_neo4j_driver(concepts_exist: bool = True) -> MagicMock:
    """Neo4j driver mock that reports all concept lookups as existing (or not).

    Args:
        concepts_exist: If ``True``, ``check_concept_exists`` returns a
            non-None row (concept found).  If ``False``, it returns ``None``
            (concept not found), causing ``validate_concept_existence`` to raise.
    """
    row = {"exists": 1} if concepts_exist else None
    mock_result = AsyncMock()
    mock_result.single = AsyncMock(return_value=row)

    mock_session = AsyncMock()
    mock_session.run = AsyncMock(return_value=mock_result)

    driver = MagicMock()
    driver.session.return_value.__aenter__ = AsyncMock(return_value=mock_session)
    driver.session.return_value.__aexit__ = AsyncMock(return_value=False)
    return driver


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app(neo4j_driver: MagicMock) -> FastAPI:
    """Create a test FastAPI app with the given Neo4j driver on app state."""
    import os

    from api.middleware.auth import AuthMiddleware
    from api.middleware.errors import (
        doppia_error_handler,
        http_exception_handler,
        unhandled_exception_handler,
        validation_exception_handler,
    )
    from api.router import router as api_router
    from errors import DoppiaError
    from models.base import init_db

    database_url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:localpassword@localhost/doppia",
    )
    init_db(database_url)

    app = FastAPI(lifespan=_noop_lifespan)
    app.state.neo4j_driver = neo4j_driver
    app.add_exception_handler(DoppiaError, doppia_error_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(api_router)
    return app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def fragments_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client with real Postgres and mocked Neo4j (concepts exist)."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")

    app = _build_app(_make_mock_neo4j_driver(concepts_exist=True))
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


@pytest_asyncio.fixture
async def fragments_client_bad_neo4j(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client where Neo4j reports every concept as missing."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")

    app = _build_app(_make_mock_neo4j_driver(concepts_exist=False))
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


@pytest_asyncio.fixture
async def seeded_movement(db_session: AsyncSession) -> AsyncGenerator[str, None]:
    """Insert a minimal movement row and yield its UUID string.

    Inserts a composer → corpus → work → movement chain via raw SQL so
    the fragment tests have a real movement_id to reference.  Cleans up
    all rows on teardown.
    """
    composer_id = str(uuid.uuid4())
    corpus_id = str(uuid.uuid4())
    work_id = str(uuid.uuid4())
    movement_id = str(uuid.uuid4())
    slug_suffix = uuid.uuid4().hex[:8]

    await db_session.execute(
        text(
            "INSERT INTO composer (id, slug, name, sort_name) "
            "VALUES (:id, :slug, :name, :sort_name)"
        ),
        {
            "id": composer_id,
            "slug": f"frag-test-mozart-{slug_suffix}",
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
            "slug": "piano-sonatas",
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
            "slug": "k331",
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
            "slug": "movement-1",
            "num": 1,
            "key": "G major",
            "meter": "4/4",
            "mei_key": f"test/{slug_suffix}/movement-1.mei",
        },
    )
    await db_session.commit()

    yield movement_id

    # Teardown: cascade from fragment → fragment_concept_tag handled by DB.
    await db_session.execute(
        text("DELETE FROM fragment WHERE movement_id = :mid"), {"mid": movement_id}
    )
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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestCreateFragment:
    """POST /api/v1/fragments — create a draft fragment."""

    async def test_create_minimal_fragment_returns_201(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """A minimal valid payload creates a draft and returns 201."""
        resp = await fragments_client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(seeded_movement),
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["status"] == "draft"
        assert body["movement_id"] == seeded_movement
        assert body["bar_start"] == 1
        assert body["bar_end"] == 4
        assert "id" in body

    async def test_create_with_two_sub_parts_writes_three_rows(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Create with two sub-parts writes exactly three rows atomically."""
        sub_parts = [
            {
                "bar_start": 1,
                "bar_end": 2,
                "mc_start": 1,
                "mc_end": 2,
                "summary": _min_summary(concepts=["CadentialDominant"]),
                "concept_tags": [_min_tag("CadentialDominant")],
            },
            {
                "bar_start": 3,
                "bar_end": 4,
                "mc_start": 3,
                "mc_end": 4,
                "summary": _min_summary(concepts=["TonicChord"]),
                "concept_tags": [_min_tag("TonicChord")],
            },
        ]
        payload = _fragment_payload(seeded_movement, sub_parts=sub_parts)

        resp = await fragments_client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=payload,
        )
        assert resp.status_code == 201, resp.text
        parent_id = resp.json()["id"]

        # Verify: parent + 2 children = 3 rows in the DB.
        result = await db_session.execute(
            text(
                "SELECT COUNT(*) FROM fragment "
                "WHERE id = :pid OR parent_fragment_id = :pid"
            ),
            {"pid": parent_id},
        )
        count = result.scalar_one()
        assert count == 3

    async def test_missing_concept_in_graph_returns_422(
        self,
        fragments_client_bad_neo4j: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """When concept_id is not in Neo4j, the create returns 422."""
        resp = await fragments_client_bad_neo4j.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(seeded_movement),
        )
        assert resp.status_code == 422
        body = resp.json()
        assert body["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"

    async def test_child_out_of_parent_range_returns_422(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """A sub-part whose bar range exceeds the parent's is rejected (422)."""
        sub_parts = [
            {
                "bar_start": 1,
                "bar_end": 10,  # exceeds parent bar_end=4
                "mc_start": 1,
                "mc_end": 10,
                "summary": _min_summary(),
                "concept_tags": [_min_tag()],
            }
        ]
        resp = await fragments_client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(seeded_movement, sub_parts=sub_parts),
        )
        assert resp.status_code == 422
        body = resp.json()
        assert body["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"

    async def test_requires_auth(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Unauthenticated request returns 401."""
        resp = await fragments_client.post(
            "/api/v1/fragments",
            json=_fragment_payload(seeded_movement),
        )
        assert resp.status_code == 401

    async def test_invalid_beat_range_returns_422(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """beat_start >= beat_end fails Pydantic validation (422)."""
        resp = await fragments_client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(seeded_movement, beat_start=3.0, beat_end=1.0),
        )
        assert resp.status_code == 422


@pytest.mark.asyncio(loop_scope="session")
class TestUpdateFragment:
    """PATCH /api/v1/fragments/{id} — update a draft fragment."""

    async def _create_draft(self, client: AsyncClient, movement_id: str) -> str:
        """Helper: create a draft and return its id."""
        resp = await client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(movement_id),
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    async def test_update_draft_returns_updated_fields(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """PATCH replaces the mutable fields and returns 200."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)

        update_payload = {
            "bar_start": 5,
            "bar_end": 8,
            "mc_start": 5,
            "mc_end": 8,
            "summary": _min_summary(key="D major"),
            "concept_tags": [_min_tag()],
            "sub_parts": [],
        }
        resp = await fragments_client.patch(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
            json=update_payload,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["bar_start"] == 5
        assert body["bar_end"] == 8
        assert body["summary"]["key"] == "D major"

    async def test_update_submitted_stays_submitted(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Editing a submitted fragment keeps it submitted (Step 8 revision semantics)."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)

        await fragments_client.post(
            f"/api/v1/fragments/{fragment_id}/submit",
            headers={"Authorization": "Bearer dev-token"},
        )

        update_payload = {
            "bar_start": 1,
            "bar_end": 4,
            "mc_start": 1,
            "mc_end": 4,
            "summary": _min_summary(),
            "concept_tags": [_min_tag()],
            "sub_parts": [],
        }
        resp = await fragments_client.patch(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
            json=update_payload,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "submitted"
        assert body["previous_status"] == "submitted"
        assert body["status_changed"] is False

    async def test_update_unknown_fragment_returns_404(
        self,
        fragments_client: AsyncClient,
    ) -> None:
        """Patching a non-existent fragment_id returns 404."""
        update_payload = {
            "bar_start": 1,
            "bar_end": 4,
            "mc_start": 1,
            "mc_end": 4,
            "summary": _min_summary(),
            "concept_tags": [_min_tag()],
            "sub_parts": [],
        }
        resp = await fragments_client.patch(
            f"/api/v1/fragments/{uuid.uuid4()}",
            headers={"Authorization": "Bearer dev-token"},
            json=update_payload,
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

    async def test_non_creator_edit_draft_returns_422(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """A non-creator editor cannot update another user's draft (Step 6 spec).

        The admin user (00...0002) owns the draft; the dev-token user (00...0001)
        is an editor who is neither the creator nor an admin, so their PATCH must
        be rejected with FRAGMENT_VALIDATION_ERROR.
        """
        import json as _json

        # The admin user id seeded by the integration conftest.
        admin_user_id = "00000000-0000-0000-0000-000000000002"
        fragment_id = str(uuid.uuid4())

        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, created_by) "
                "VALUES (:id, :mid, 1, 4, 1, 4, CAST(:summary AS jsonb), "
                "'draft', :creator)"
            ),
            {
                "id": fragment_id,
                "mid": seeded_movement,
                "summary": _json.dumps(_min_summary()),
                "creator": admin_user_id,
            },
        )
        await db_session.execute(
            text(
                "INSERT INTO fragment_concept_tag (fragment_id, concept_id, is_primary) "
                "VALUES (:fid, 'PerfectAuthenticCadence', true)"
            ),
            {"fid": fragment_id},
        )
        await db_session.commit()

        # dev-token user (editor, not admin, not the creator) tries to edit.
        resp = await fragments_client.patch(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
            json={
                "bar_start": 5,
                "bar_end": 8,
                "mc_start": 5,
                "mc_end": 8,
                "summary": _min_summary(),
                "concept_tags": [_min_tag()],
                "sub_parts": [],
            },
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"

        # Cleanup.
        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": fragment_id}
        )
        await db_session.commit()


@pytest.mark.asyncio(loop_scope="session")
class TestSubmitFragment:
    """POST /api/v1/fragments/{id}/submit — transition draft → submitted."""

    async def _create_draft(self, client: AsyncClient, movement_id: str) -> str:
        resp = await client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(movement_id),
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    async def test_submit_transitions_status(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Submitting a draft returns 200 with status = 'submitted'."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)

        resp = await fragments_client.post(
            f"/api/v1/fragments/{fragment_id}/submit",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "submitted"

    async def test_submit_already_submitted_returns_422(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Submitting a fragment that is already submitted returns 422."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)

        await fragments_client.post(
            f"/api/v1/fragments/{fragment_id}/submit",
            headers={"Authorization": "Bearer dev-token"},
        )
        # Submit again.
        resp = await fragments_client.post(
            f"/api/v1/fragments/{fragment_id}/submit",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"

    async def test_submit_with_missing_concept_in_graph_returns_422(
        self,
        fragments_client: AsyncClient,
        fragments_client_bad_neo4j: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Submit is rejected when server re-validation finds a missing concept_id."""
        # Create the draft while concepts are "valid".
        fragment_id = await self._create_draft(fragments_client, seeded_movement)

        # Now submit via the bad-neo4j client (concepts no longer exist).
        resp = await fragments_client_bad_neo4j.post(
            f"/api/v1/fragments/{fragment_id}/submit",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"

        # Fragment must still be in 'draft' status.
        result = await db_session.execute(
            text("SELECT status FROM fragment WHERE id = :fid"),
            {"fid": fragment_id},
        )
        status = result.scalar_one()
        assert status == "draft"

    async def test_submit_unknown_fragment_returns_404(
        self,
        fragments_client: AsyncClient,
    ) -> None:
        """Submitting a non-existent fragment_id returns 404."""
        resp = await fragments_client.post(
            f"/api/v1/fragments/{uuid.uuid4()}/submit",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"


@pytest.mark.asyncio(loop_scope="session")
class TestDeleteFragment:
    """DELETE /api/v1/fragments/{id} — delete with permission checks and cascade.

    Verification spec (Step 9):
    - Creator deletes their own draft → 200
    - Creator cannot delete an approved fragment → 422
    - Admin can delete an approved fragment → 200
    - Non-creator cannot delete → 422
    - Parent with sub-parts without confirm_cascade is refused + reports child count
    - dry_run=true returns child count without deleting
    - Deleting with confirm_cascade removes parent + children
    - movement_analysis is untouched after delete
    """

    async def _create_draft(self, client: AsyncClient, movement_id: str) -> str:
        """Helper: create a draft and return its UUID string."""
        resp = await client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(movement_id),
        )
        assert resp.status_code == 201
        return resp.json()["id"]

    async def _insert_fragment_with_status(
        self,
        db_session: AsyncSession,
        movement_id: str,
        status: str,
        creator_id: str,
    ) -> str:
        """Insert a fragment row directly with a given status and creator."""
        import json as _json

        fragment_id = str(uuid.uuid4())
        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, created_by) "
                "VALUES (:id, :mid, 1, 4, 1, 4, CAST(:summary AS jsonb), "
                ":status, :creator)"
            ),
            {
                "id": fragment_id,
                "mid": movement_id,
                "summary": _json.dumps(_min_summary()),
                "status": status,
                "creator": creator_id,
            },
        )
        await db_session.execute(
            text(
                "INSERT INTO fragment_concept_tag (fragment_id, concept_id, is_primary) "
                "VALUES (:fid, 'PerfectAuthenticCadence', true)"
            ),
            {"fid": fragment_id},
        )
        await db_session.commit()
        return fragment_id

    async def _insert_child_fragment(
        self,
        db_session: AsyncSession,
        movement_id: str,
        parent_id: str,
    ) -> str:
        """Insert a sub-part child fragment row."""
        import json as _json

        child_id = str(uuid.uuid4())
        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, parent_fragment_id) "
                "VALUES (:id, :mid, 1, 2, 1, 2, CAST(:summary AS jsonb), "
                "'draft', :parent)"
            ),
            {
                "id": child_id,
                "mid": movement_id,
                "summary": _json.dumps(_min_summary(concepts=["CadentialDominant"])),
                "parent": parent_id,
            },
        )
        await db_session.execute(
            text(
                "INSERT INTO fragment_concept_tag (fragment_id, concept_id, is_primary) "
                "VALUES (:fid, 'CadentialDominant', true)"
            ),
            {"fid": child_id},
        )
        await db_session.commit()
        return child_id

    async def test_creator_deletes_own_draft(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """The creating annotator can delete their own draft fragment."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["fragment_id"] == fragment_id
        assert body["child_count"] == 0
        assert body["dry_run"] is False

        # Row must be gone.
        result = await db_session.execute(
            text("SELECT COUNT(*) FROM fragment WHERE id = :fid"),
            {"fid": fragment_id},
        )
        assert result.scalar_one() == 0

    async def test_creator_cannot_delete_approved_fragment(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """The creator may not delete an approved fragment (admin-only)."""
        # The dev-token user is the creator.
        dev_user_id = "00000000-0000-0000-0000-000000000001"
        fragment_id = await self._insert_fragment_with_status(
            db_session, seeded_movement, "approved", dev_user_id
        )

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422, resp.text
        body = resp.json()
        assert body["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"
        assert "approved" in body["error"]["message"]

        # Fragment must still exist.
        result = await db_session.execute(
            text("SELECT COUNT(*) FROM fragment WHERE id = :fid"),
            {"fid": fragment_id},
        )
        assert result.scalar_one() == 1

        # Cleanup.
        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": fragment_id}
        )
        await db_session.commit()

    async def test_admin_can_delete_approved_fragment(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """An admin can delete an approved fragment."""
        # Approved fragment owned by the dev user.
        dev_user_id = "00000000-0000-0000-0000-000000000001"
        fragment_id = await self._insert_fragment_with_status(
            db_session, seeded_movement, "approved", dev_user_id
        )

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer admin-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["fragment_id"] == fragment_id
        assert body["dry_run"] is False

        # Row must be gone.
        result = await db_session.execute(
            text("SELECT COUNT(*) FROM fragment WHERE id = :fid"),
            {"fid": fragment_id},
        )
        assert result.scalar_one() == 0

    async def test_non_creator_cannot_delete(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """A non-creator editor cannot delete another annotator's fragment."""
        # admin user owns the draft; dev-token user tries to delete it.
        admin_user_id = "00000000-0000-0000-0000-000000000002"
        fragment_id = await self._insert_fragment_with_status(
            db_session, seeded_movement, "draft", admin_user_id
        )

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"

        # Cleanup.
        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": fragment_id}
        )
        await db_session.commit()

    async def test_delete_parent_without_confirm_cascade_refused(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Deleting a parent with sub-parts without confirm_cascade returns 422."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)
        await self._insert_child_fragment(db_session, seeded_movement, fragment_id)

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422, resp.text
        body = resp.json()
        assert body["error"]["code"] == "FRAGMENT_VALIDATION_ERROR"
        assert body["error"]["detail"]["child_count"] == 1
        assert body["error"]["detail"]["requires_confirm_cascade"] is True

        # Parent must still exist.
        result = await db_session.execute(
            text("SELECT COUNT(*) FROM fragment WHERE id = :fid"),
            {"fid": fragment_id},
        )
        assert result.scalar_one() == 1

        # Cleanup.
        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid OR parent_fragment_id = :fid"),
            {"fid": fragment_id},
        )
        await db_session.commit()

    async def test_dry_run_returns_child_count_without_deleting(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """dry_run=true returns child_count and does not delete anything."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)
        await self._insert_child_fragment(db_session, seeded_movement, fragment_id)

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}?dry_run=true",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["child_count"] == 1
        assert body["dry_run"] is True

        # Rows must still exist.
        result = await db_session.execute(
            text(
                "SELECT COUNT(*) FROM fragment "
                "WHERE id = :fid OR parent_fragment_id = :fid"
            ),
            {"fid": fragment_id},
        )
        assert result.scalar_one() == 2

        # Cleanup.
        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid OR parent_fragment_id = :fid"),
            {"fid": fragment_id},
        )
        await db_session.commit()

    async def test_confirm_cascade_deletes_parent_and_children(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """confirm_cascade=true deletes the parent and all sub-part children."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)
        child_id = await self._insert_child_fragment(
            db_session, seeded_movement, fragment_id
        )

        resp = await fragments_client.delete(
            f"/api/v1/fragments/{fragment_id}?confirm_cascade=true",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["child_count"] == 1
        assert body["dry_run"] is False

        # Both parent and child must be gone.
        result = await db_session.execute(
            text("SELECT COUNT(*) FROM fragment WHERE id IN (:pid, :cid)"),
            {"pid": fragment_id, "cid": child_id},
        )
        assert result.scalar_one() == 0

    async def test_delete_unknown_fragment_returns_404(
        self,
        fragments_client: AsyncClient,
    ) -> None:
        """Deleting a non-existent fragment_id returns 404."""
        resp = await fragments_client.delete(
            f"/api/v1/fragments/{uuid.uuid4()}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

    async def test_delete_requires_auth(
        self,
        fragments_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Unauthenticated delete request returns 401."""
        fragment_id = await self._create_draft(fragments_client, seeded_movement)
        resp = await fragments_client.delete(f"/api/v1/fragments/{fragment_id}")
        assert resp.status_code == 401
