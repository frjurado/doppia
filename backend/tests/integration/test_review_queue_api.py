"""Integration tests for the review queue API (Component 7 Step 13).

Tests the discovery endpoint against a real PostgreSQL instance:
    GET  /api/v1/reviews/queue — submitted fragments awaiting review

Neo4j is mocked to handle concept hydration (get_concepts_by_ids), harmony-gate
checks, and concept-existence lookups.

Requires ``docker compose up`` (PostgreSQL) before the test session.

Verification cases from the roadmap (Step 13):
    1. Queue returns submitted top-level fragments with movement context
       (composer_name, work_title).
    2. Creator exclusion: editors do not see their own submissions.
    3. Admins see all submitted fragments regardless of creator.
    4. Only 'submitted' status appears — drafts, approved, and rejected are excluded.
    5. Cursor pagination advances to the next page correctly.
    6. Unauthenticated request returns 401.
    7. The status filter and creator exclusion are enforced at the service layer
       (the queue endpoint has no bypass path).
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


def _make_queue_neo4j_driver() -> MagicMock:
    """Neo4j mock that handles concept existence, gate, and hydration queries."""
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
                "hierarchy_path": ["Cadential Motion", "Perfect Authentic Cadence"],
            }
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
async def queue_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client with real Postgres and a full-featured Neo4j mock."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")
    app = _build_app(_make_queue_neo4j_driver())
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def seeded_movement(db_session: AsyncSession) -> AsyncGenerator[str, None]:
    """Insert a minimal movement row with composer/work context and yield its UUID."""
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
            "slug": f"queue-test-mozart-{slug_suffix}",
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
# Helpers for inserting fragments directly
# ---------------------------------------------------------------------------


async def _insert_fragment(
    db_session: AsyncSession,
    movement_id: str,
    status: str,
    creator_id: str | None,
    mc_start: int = 1,
) -> str:
    """Insert a fragment row with the given status and creator; return its UUID."""
    fragment_id = str(uuid.uuid4())
    await db_session.execute(
        text(
            "INSERT INTO fragment "
            "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
            "summary, status, created_by) "
            "VALUES (:id, :mid, :bs, :be, :mcs, :mce, "
            "CAST(:summary AS jsonb), :status, :creator)"
        ),
        {
            "id": fragment_id,
            "mid": movement_id,
            "bs": mc_start,
            "be": mc_start + 3,
            "mcs": mc_start,
            "mce": mc_start + 3,
            "summary": json.dumps(_min_summary()),
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


async def _collect_queue_items(
    client: AsyncClient,
    token: str,
    page_size: int = 50,
) -> list[dict[str, Any]]:
    """Walk the review queue through all cursor pages and return every item.

    The queue lists *all* submitted fragments in the database, so a DB that
    carries real campaign data has entries beyond what a test inserts.
    Membership assertions must therefore scope to inserted ids over the full
    walk, never to the contents or size of a single page.
    """
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(200):  # hard stop if a cursor ever loops
        url = f"/api/v1/reviews/queue?page_size={page_size}"
        if cursor is not None:
            url += f"&cursor={cursor}"
        resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        page = resp.json()
        items.extend(page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            return items
    raise AssertionError("Queue cursor did not terminate within 200 pages")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestReviewQueue:
    """GET /api/v1/reviews/queue — submitted fragments awaiting review."""

    async def test_returns_submitted_fragments_with_movement_context(
        self,
        queue_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Queue lists submitted fragments with composer/work/movement labels."""
        # Use the admin user as creator so the dev-token editor (different user) can see it.
        frag_id = await _insert_fragment(
            db_session, seeded_movement, "submitted", _ADMIN_USER_ID
        )

        items = await _collect_queue_items(queue_client, "dev-token")
        item = next((i for i in items if i["id"] == frag_id), None)
        assert (
            item is not None
        ), "Submitted fragment (NULL creator) must appear in queue"

        # Movement context fields must be populated.
        assert item["composer_name"] == "Wolfgang Amadeus Mozart"
        assert item["work_title"] == "Piano Sonata No. 11"
        assert item["primary_concept_alias"] == "PAC"

        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": frag_id}
        )
        await db_session.commit()

    async def test_editor_excludes_own_submissions(
        self,
        queue_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """An editor does not see submitted fragments they created themselves."""
        # Fragment created by the dev user — should be invisible to that same user.
        own_frag_id = await _insert_fragment(
            db_session, seeded_movement, "submitted", _DEV_USER_ID
        )
        # Fragment created by the admin user — visible to dev-token editor.
        other_frag_id = await _insert_fragment(
            db_session, seeded_movement, "submitted", _ADMIN_USER_ID, mc_start=5
        )

        ids = {i["id"] for i in await _collect_queue_items(queue_client, "dev-token")}

        assert own_frag_id not in ids, "Creator must not see own submission in queue"
        assert other_frag_id in ids, "Other annotator's submission must be visible"

        for fid in (own_frag_id, other_frag_id):
            await db_session.execute(
                text("DELETE FROM fragment WHERE id = :fid"), {"fid": fid}
            )
        await db_session.commit()

    async def test_admin_sees_own_submissions(
        self,
        queue_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Admins bypass the creator-exclusion rule and see all submitted fragments."""
        # Fragment created by the admin user.
        admin_frag_id = await _insert_fragment(
            db_session, seeded_movement, "submitted", _ADMIN_USER_ID
        )

        ids = {i["id"] for i in await _collect_queue_items(queue_client, "admin-token")}
        assert admin_frag_id in ids, "Admin must see their own submission in queue"

        await db_session.execute(
            text("DELETE FROM fragment WHERE id = :fid"), {"fid": admin_frag_id}
        )
        await db_session.commit()

    async def test_excludes_non_submitted_statuses(
        self,
        queue_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Draft, approved, and rejected fragments do not appear in the queue.

        The status filter is enforced at the service layer and cannot be bypassed
        via the API (fragment-schema.md § status visibility rules).
        """
        inserted: list[str] = []
        for mc, status in [(1, "draft"), (5, "approved"), (9, "rejected")]:
            fid = await _insert_fragment(
                db_session, seeded_movement, status, None, mc_start=mc
            )
            inserted.append(fid)

        ids = {i["id"] for i in await _collect_queue_items(queue_client, "dev-token")}
        for fid in inserted:
            assert (
                fid not in ids
            ), f"Non-submitted fragment must not appear in queue: {fid}"

        for fid in inserted:
            await db_session.execute(
                text("DELETE FROM fragment WHERE id = :fid"), {"fid": fid}
            )
        await db_session.commit()

    async def test_cursor_pagination(
        self,
        queue_client: AsyncClient,
        seeded_movement: str,
        db_session: AsyncSession,
    ) -> None:
        """Cursor pagination walks the full queue without loss or duplication.

        Assertions are scoped to the inserted ids and to structural pagination
        properties, never to absolute page contents: the DB may carry real
        submitted fragments alongside what this test inserts.
        """
        # Insert 3 submitted fragments owned by the admin user (visible to dev-token).
        inserted: list[str] = []
        for mc in (1, 5, 9):
            fid = await _insert_fragment(
                db_session, seeded_movement, "submitted", _ADMIN_USER_ID, mc_start=mc
            )
            inserted.append(fid)

        # Walk with page_size=2; with >= 3 items the walk spans >= 2 pages.
        all_ids = [
            i["id"]
            for i in await _collect_queue_items(queue_client, "dev-token", page_size=2)
        ]

        # No id is lost or duplicated across page boundaries.
        assert len(all_ids) == len(set(all_ids)), "Pages must not overlap"
        for fid in inserted:
            assert fid in all_ids, f"Inserted fragment missing from walk: {fid}"

        # Every page before the last is full (page_size honoured).
        resp1 = await queue_client.get(
            "/api/v1/reviews/queue?page_size=2",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp1.status_code == 200, resp1.text
        page1 = resp1.json()
        assert len(page1["items"]) == 2
        assert page1["next_cursor"] is not None

        for fid in inserted:
            await db_session.execute(
                text("DELETE FROM fragment WHERE id = :fid"), {"fid": fid}
            )
        await db_session.commit()

    async def test_requires_auth(
        self,
        queue_client: AsyncClient,
    ) -> None:
        """Unauthenticated request returns 401."""
        resp = await queue_client.get("/api/v1/reviews/queue")
        assert resp.status_code == 401
