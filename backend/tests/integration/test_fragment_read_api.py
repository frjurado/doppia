"""Integration tests for the fragment read API (Component 7 Step 7).

Tests the two read endpoints against a real PostgreSQL instance:
    GET  /api/v1/fragments/{id}                   — full detail (concept hydration,
                                                      harmony slice, sub-parts)
    GET  /api/v1/movements/{movement_id}/fragments — cursor-paginated movement list

Neo4j is mocked for all three query shapes it receives:
    1. concept_id existence check   → single()  → {"exists": 1}
    2. harmony-gate check           → single()  → {"has_harmony_gate": False}
    3. get_concepts_by_ids hydration → data()   → [{id, name, aliases, hierarchy_path}]

Requires ``docker compose up`` (PostgreSQL) before the test session.

Verification cases from the roadmap (Step 7):
    1. GET /fragments/{id} returns parent + nested sub-parts, concept tags hydrated
       with alias from Neo4j, and harmony events sliced from movement_analysis.
    2. Draft visibility: creator reads own draft (200); non-creator editor gets 404.
    3. Admin reads any draft regardless of creator (200).
    4. Non-existent fragment returns 404.
    5. Unauthenticated request returns 401.
    6. GET /movements/{id}/fragments returns top-level fragments with nested sub-parts;
       another annotator's draft is invisible to an editor.
    7. Admin sees all fragments regardless of status.
    8. Cursor pagination advances to the next page correctly.
    9. A movement with no fragments returns an empty list.
"""

from __future__ import annotations

import json
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
# Dev user IDs (seeded by the session-scoped _seed_dev_users fixture)
# ---------------------------------------------------------------------------

_DEV_USER_ID = "00000000-0000-0000-0000-000000000001"  # role: editor
_ADMIN_USER_ID = "00000000-0000-0000-0000-000000000002"  # role: admin

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _min_summary(**overrides: Any) -> dict[str, Any]:
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


def _make_read_neo4j_driver() -> MagicMock:
    """Neo4j driver mock that handles all three query shapes the read path uses.

    Routing by query content:
    - "hierarchy_path" in query → get_concepts_by_ids → .data() → concept stubs
    - "has_harmony_gate" in query → gate check         → .single() → {has_harmony_gate: False}
    - otherwise                   → existence check    → .single() → {exists: 1}
    """
    existence_result = AsyncMock()
    existence_result.single = AsyncMock(return_value={"exists": 1})

    gate_result = AsyncMock()
    gate_result.single = AsyncMock(return_value={"has_harmony_gate": False})

    hydration_result = AsyncMock()
    hydration_result.data = AsyncMock(
        return_value=[
            {
                "id": "PerfectAuthenticCadence",
                "name": "Perfect Authentic Cadence",
                "aliases": ["PAC"],
                "hierarchy_path": [
                    "Cadential Motion",
                    "Authentic Cadence",
                    "Perfect Authentic Cadence",
                ],
            },
            {
                "id": "CadentialDominant",
                "name": "Cadential Dominant",
                "aliases": ["CD"],
                "hierarchy_path": [
                    "Cadential Motion",
                    "Cadential Dominant",
                ],
            },
        ]
    )

    async def _run(query: str, **kwargs: Any) -> Any:
        if "hierarchy_path" in query:
            return hydration_result
        if "has_harmony_gate" in query:
            return gate_result
        return existence_result

    mock_session = AsyncMock()
    mock_session.run = _run

    driver = MagicMock()
    driver.session.return_value.__aenter__ = AsyncMock(return_value=mock_session)
    driver.session.return_value.__aexit__ = AsyncMock(return_value=False)
    return driver


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app(neo4j_driver: MagicMock) -> FastAPI:
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
async def read_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client with real Postgres and a full-featured Neo4j mock."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")
    app = _build_app(_make_read_neo4j_driver())
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def seeded_movement(db_session: AsyncSession) -> AsyncGenerator[str, None]:
    """Insert a minimal movement row and yield its UUID string."""
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
            "slug": f"read-test-mozart-{slug_suffix}",
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
            "slug": f"piano-sonatas-{slug_suffix}",
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
            "slug": f"k331-{slug_suffix}",
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

    await db_session.execute(
        text("DELETE FROM fragment WHERE movement_id = :mid"), {"mid": movement_id}
    )
    await db_session.execute(
        text("DELETE FROM movement_analysis WHERE movement_id = :mid"),
        {"mid": movement_id},
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
# TestGetFragment
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestGetFragment:
    """GET /api/v1/fragments/{id} — full detail read."""

    async def _create(self, client: AsyncClient, movement_id: str, **kw: Any) -> str:
        resp = await client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(movement_id, **kw),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    async def test_returns_full_detail_with_sub_parts(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """GET returns the parent with sub-parts nested and concept tags hydrated."""
        sub_parts = [
            {
                "bar_start": 1,
                "bar_end": 2,
                "mc_start": 1,
                "mc_end": 2,
                "summary": _min_summary(concepts=["CadentialDominant"]),
                "concept_tags": [_min_tag("CadentialDominant")],
            }
        ]
        fragment_id = await self._create(
            read_client, seeded_movement, sub_parts=sub_parts
        )

        resp = await read_client.get(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()

        # Parent fields.
        assert body["id"] == fragment_id
        assert body["bar_start"] == 1
        assert body["bar_end"] == 4
        assert body["status"] == "draft"

        # Concept tag hydrated with Neo4j alias.
        assert len(body["concept_tags"]) == 1
        tag = body["concept_tags"][0]
        assert tag["concept_id"] == "PerfectAuthenticCadence"
        assert tag["alias"] == "PAC"
        assert tag["name"] == "Perfect Authentic Cadence"
        assert len(tag["hierarchy_path"]) > 0

        # Sub-part nested.
        assert len(body["sub_parts"]) == 1
        child = body["sub_parts"][0]
        assert child["bar_start"] == 1
        assert child["bar_end"] == 2
        assert child["concept_tags"][0]["concept_id"] == "CadentialDominant"
        assert child["concept_tags"][0]["alias"] == "CD"

        # No harmony events (no movement_analysis seeded).
        assert body["harmony_events"] == []

    async def test_returns_harmony_events_in_range(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """harmony_events contains events within the fragment's bar range only."""
        fragment_id = await self._create(read_client, seeded_movement)

        # Seed three events: two in range (mn=1,2), one outside (mn=10).
        events = [
            {
                "mn": 1,
                "volta": None,
                "beat": 1.0,
                "local_key": "G major",
                "root": 1,
                "quality": "major",
                "inversion": 0,
                "numeral": "I",
                "source": "DCML",
                "auto": False,
                "reviewed": True,
            },
            {
                "mn": 2,
                "volta": None,
                "beat": 1.0,
                "local_key": "G major",
                "root": 5,
                "quality": "major",
                "inversion": 0,
                "numeral": "V",
                "source": "DCML",
                "auto": False,
                "reviewed": False,
            },
            {
                "mn": 10,
                "volta": None,
                "beat": 1.0,
                "local_key": "G major",
                "root": 1,
                "quality": "major",
                "inversion": 0,
                "numeral": "I",
                "source": "DCML",
                "auto": False,
                "reviewed": True,
            },
        ]
        await db_session.execute(
            text(
                "INSERT INTO movement_analysis (id, movement_id, events, music21_version) "
                "VALUES (:id, :mid, CAST(:events AS jsonb), :ver)"
            ),
            {
                "id": str(uuid.uuid4()),
                "mid": seeded_movement,
                "events": json.dumps(events),
                "ver": "none",
            },
        )
        await db_session.commit()

        resp = await read_client.get(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        harmony = resp.json()["harmony_events"]
        # Only mn=1 and mn=2 are within bars 1–4.
        assert len(harmony) == 2
        returned_mns = {ev["mn"] for ev in harmony}
        assert returned_mns == {1, 2}

    async def test_creator_reads_own_draft(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """The creating annotator can read their own draft."""
        fragment_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "draft"

    async def test_non_creator_draft_returns_404(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """An editor who is not the creator gets 404 for another annotator's draft."""
        # Insert a draft owned by the admin user.
        fragment_id = str(uuid.uuid4())
        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, created_by) "
                "VALUES (:id, :mid, 1, 4, 1, 4, CAST(:summary AS jsonb), 'draft', :creator)"
            ),
            {
                "id": fragment_id,
                "mid": seeded_movement,
                "summary": json.dumps(_min_summary()),
                "creator": _ADMIN_USER_ID,
            },
        )
        await db_session.commit()

        # dev-token user (editor, not the creator) cannot see this draft.
        resp = await read_client.get(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": fragment_id}
        )
        await db_session.commit()

    async def test_admin_reads_any_draft(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """An admin can read any fragment regardless of who created it."""
        # Insert a draft owned by the dev user.
        fragment_id = str(uuid.uuid4())
        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, created_by) "
                "VALUES (:id, :mid, 1, 4, 1, 4, CAST(:summary AS jsonb), 'draft', :creator)"
            ),
            {
                "id": fragment_id,
                "mid": seeded_movement,
                "summary": json.dumps(_min_summary()),
                "creator": _DEV_USER_ID,
            },
        )
        await db_session.commit()

        resp = await read_client.get(
            f"/api/v1/fragments/{fragment_id}",
            headers={"Authorization": "Bearer admin-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == fragment_id

        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": fragment_id}
        )
        await db_session.commit()

    async def test_unknown_fragment_returns_404(
        self,
        read_client: AsyncClient,
    ) -> None:
        """A non-existent fragment_id returns 404."""
        resp = await read_client.get(
            f"/api/v1/fragments/{uuid.uuid4()}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

    async def test_requires_auth(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Unauthenticated GET returns 401."""
        fragment_id = await self._create(read_client, seeded_movement)
        resp = await read_client.get(f"/api/v1/fragments/{fragment_id}")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# TestListMovementFragments
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestListMovementFragments:
    """GET /api/v1/movements/{id}/fragments — cursor-paginated list."""

    async def _create(self, client: AsyncClient, movement_id: str, **kw: Any) -> str:
        resp = await client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(movement_id, **kw),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    async def test_returns_fragments_with_nested_sub_parts(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """The list returns top-level fragments with their sub-parts nested."""
        sub_parts = [
            {
                "bar_start": 1,
                "bar_end": 2,
                "mc_start": 1,
                "mc_end": 2,
                "summary": _min_summary(concepts=["CadentialDominant"]),
                "concept_tags": [_min_tag("CadentialDominant")],
            }
        ]
        parent_id = await self._create(
            read_client, seeded_movement, sub_parts=sub_parts
        )

        resp = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        items = body["items"]
        assert len(items) >= 1

        # Find the parent we just created.
        parent_item = next((i for i in items if i["id"] == parent_id), None)
        assert parent_item is not None, "Parent fragment not in list"
        assert parent_item["primary_concept_id"] == "PerfectAuthenticCadence"
        assert parent_item["primary_concept_alias"] == "PAC"
        assert len(parent_item["sub_parts"]) == 1
        assert parent_item["sub_parts"][0]["primary_concept_id"] == "CadentialDominant"

    async def test_editor_excludes_other_users_draft(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """An editor does not see a draft fragment created by another annotator."""
        other_fragment_id = str(uuid.uuid4())
        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, created_by) "
                "VALUES (:id, :mid, 5, 8, 5, 8, CAST(:summary AS jsonb), 'draft', :creator)"
            ),
            {
                "id": other_fragment_id,
                "mid": seeded_movement,
                "summary": json.dumps(_min_summary()),
                "creator": _ADMIN_USER_ID,
            },
        )
        await db_session.commit()

        resp = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {i["id"] for i in resp.json()["items"]}
        assert other_fragment_id not in ids, "Non-creator draft must not be visible"

        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": other_fragment_id}
        )
        await db_session.commit()

    async def test_editor_sees_own_draft(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """An editor sees their own draft in the movement list."""
        fragment_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {i["id"] for i in resp.json()["items"]}
        assert fragment_id in ids, "Creator must see their own draft"

    async def test_admin_sees_all_fragments(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """An admin sees all fragments on a movement including other annotators' drafts."""
        other_fragment_id = str(uuid.uuid4())
        await db_session.execute(
            text(
                "INSERT INTO fragment "
                "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                "summary, status, created_by) "
                "VALUES (:id, :mid, 9, 12, 9, 12, CAST(:summary AS jsonb), 'draft', :creator)"
            ),
            {
                "id": other_fragment_id,
                "mid": seeded_movement,
                "summary": json.dumps(_min_summary()),
                "creator": _DEV_USER_ID,
            },
        )
        await db_session.commit()

        resp = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments",
            headers={"Authorization": "Bearer admin-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {i["id"] for i in resp.json()["items"]}
        assert other_fragment_id in ids, "Admin must see all drafts"

        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": other_fragment_id}
        )
        await db_session.commit()

    async def test_empty_movement_returns_empty_list(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """A movement with no fragments returns items=[] and next_cursor=null."""
        # Ensure the movement is clean.
        await db_session.execute(
            text("DELETE FROM fragment WHERE movement_id = :mid"),
            {"mid": seeded_movement},
        )
        await db_session.commit()

        resp = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["items"] == []
        assert body["next_cursor"] is None

    async def test_cursor_pagination_advances_page(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Cursor pagination returns a stable second page of remaining fragments."""
        # Ensure the movement is clean before seeding.
        await db_session.execute(
            text("DELETE FROM fragment WHERE movement_id = :mid"),
            {"mid": seeded_movement},
        )
        await db_session.commit()

        # Create 3 fragments at distinct mc_start values (mc-ordered pagination).
        for mc in (1, 5, 9):
            await db_session.execute(
                text(
                    "INSERT INTO fragment "
                    "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
                    "summary, status, created_by) "
                    "VALUES (:id, :mid, :bs, :be, :mcs, :mce, "
                    "CAST(:summary AS jsonb), 'draft', :creator)"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "mid": seeded_movement,
                    "bs": mc,
                    "be": mc + 2,
                    "mcs": mc,
                    "mce": mc + 2,
                    "summary": json.dumps(_min_summary()),
                    "creator": _DEV_USER_ID,
                },
            )
        await db_session.commit()

        # First page: 2 items, expect a next_cursor.
        resp1 = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments?page_size=2",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp1.status_code == 200, resp1.text
        page1 = resp1.json()
        assert len(page1["items"]) == 2
        assert page1["next_cursor"] is not None

        # Second page: 1 remaining item, no further cursor.
        resp2 = await read_client.get(
            f"/api/v1/movements/{seeded_movement}/fragments"
            f"?page_size=2&cursor={page1['next_cursor']}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp2.status_code == 200, resp2.text
        page2 = resp2.json()
        assert len(page2["items"]) == 1
        assert page2["next_cursor"] is None

        # The two pages together must cover all 3 fragments with no overlap.
        ids_p1 = {i["id"] for i in page1["items"]}
        ids_p2 = {i["id"] for i in page2["items"]}
        assert len(ids_p1 & ids_p2) == 0, "Pages must not overlap"
        assert len(ids_p1 | ids_p2) == 3


# ---------------------------------------------------------------------------
# TestRenderingContextParameter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestRenderingContextParameter:
    """GET /api/v1/fragments/{id}?context.mode=... — ADR-024 contract.

    Phase 1 implements only ``mode=none`` (containing measures only).
    All other modes (``bars``, ``enclosing_fragment``, ``previous_same_domain``)
    are accepted and validated (not a 422) but produce the same containing-
    measures-only response.  An unknown mode value is a 422.
    """

    async def _create(self, client: AsyncClient, movement_id: str) -> str:
        resp = await client.post(
            "/api/v1/fragments",
            headers={"Authorization": "Bearer dev-token"},
            json=_fragment_payload(movement_id),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    async def test_default_mode_none_returns_fragment(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """No context.mode param → same response as mode=none."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == frag_id

    async def test_mode_none_explicit_returns_fragment(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Explicit context.mode=none returns the containing-measures-only fragment."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=none",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == frag_id

    async def test_mode_bars_accepted_and_ignored(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """context.mode=bars with before/after is accepted (200) and Phase-1 ignored."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=bars&before=2&after=3",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == frag_id

    async def test_mode_enclosing_fragment_accepted_and_ignored(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """context.mode=enclosing_fragment is accepted (200) and Phase-1 ignored."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=enclosing_fragment",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == frag_id

    async def test_mode_previous_same_domain_accepted_and_ignored(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """context.mode=previous_same_domain is accepted (200) and Phase-1 ignored."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=previous_same_domain",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == frag_id

    async def test_invalid_mode_returns_422(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """An unknown context.mode value is rejected with 422 Unprocessable Entity."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=unknown_mode",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422

    async def test_negative_before_returns_422(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """before < 0 is rejected with 422 (validated even when mode is bars)."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=bars&before=-1&after=0",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422

    async def test_negative_after_returns_422(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """after < 0 is rejected with 422 (validated even when mode is bars)."""
        frag_id = await self._create(read_client, seeded_movement)

        resp = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=bars&before=0&after=-2",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 422

    async def test_non_default_mode_response_matches_mode_none(
        self,
        read_client: AsyncClient,
        seeded_movement: str,
    ) -> None:
        """Phase 1: non-default modes return the same fragment body as mode=none."""
        frag_id = await self._create(read_client, seeded_movement)

        resp_none = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=none",
            headers={"Authorization": "Bearer dev-token"},
        )
        resp_bars = await read_client.get(
            f"/api/v1/fragments/{frag_id}?context.mode=bars&before=2&after=2",
            headers={"Authorization": "Bearer dev-token"},
        )

        assert resp_none.status_code == 200
        assert resp_bars.status_code == 200
        # Both responses must return the same fragment record.
        assert resp_none.json()["id"] == resp_bars.json()["id"] == frag_id
        assert resp_none.json()["bar_start"] == resp_bars.json()["bar_start"]
        assert resp_none.json()["bar_end"] == resp_bars.json()["bar_end"]
