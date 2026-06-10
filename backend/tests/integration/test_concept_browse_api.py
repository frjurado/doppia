"""Integration tests for the concept-scoped fragment browse API (Component 8 Step 2).

Tests the browse endpoint against a real PostgreSQL instance with a mock Neo4j
driver.  Redis is absent (``app.state.redis_client`` is not set), so
``_resolve_subtree`` always falls back to the mocked Neo4j.  Object storage is
mocked so no MinIO bucket is required for the browse path.

Endpoints under test:
    GET /api/v1/fragments?concept_id=...   — concept-scoped browse list

Verification cases from the roadmap (Step 2 / Step 13):
    1. ``include_subtypes=True`` returns fragments tagged with any subtype.
    2. ``include_subtypes=False`` returns only exact-concept-tagged fragments.
    3. A fragment with multiple matching tags appears exactly once (DISTINCT).
    4. ``status=approved`` is the default; non-approved fragments are excluded.
    5. An editor cannot retrieve another annotator's draft via a spoofed ``status=draft``.
    6. An admin CAN retrieve any draft via ``status=draft``.
    7. Cursor pagination advances correctly and covers all items without overlap.
    8. ``preview_url=null`` for fragments without a stored preview key.
    9. ``data_licence`` and ``harmony_sources`` appear on list items.
    10. Unauthenticated request → 401.
    11. Concept with no matching fragments → empty items list.

Requires ``docker compose up`` (PostgreSQL) before the test session.
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
# Dev user IDs (seeded by _seed_dev_users in integration/conftest.py)
# ---------------------------------------------------------------------------

_DEV_USER_ID = "00000000-0000-0000-0000-000000000001"  # role: editor
_ADMIN_USER_ID = "00000000-0000-0000-0000-000000000002"  # role: admin

# ---------------------------------------------------------------------------
# Concept ID constants
# ---------------------------------------------------------------------------

_PAC = "PerfectAuthenticCadence"
_IAC = "ImperfectAuthenticCadence"
_AC = "AuthenticCadence"

# Simulated subtree map for the mock Neo4j driver.
_SUBTREE_MAP: dict[str, list[str]] = {
    _AC: [_AC, _PAC, _IAC],
    _PAC: [_PAC],
    _IAC: [_IAC],
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _min_summary(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "version": 1,
        "key": "G major",
        "meter": "4/4",
        "concepts": [_PAC],
    }
    base.update(overrides)
    return base


def _make_browse_neo4j_driver() -> MagicMock:
    """Neo4j driver mock that handles two query shapes used by the browse path.

    Routing by query content:
    - ``"IS_SUBTYPE_OF"`` in query  → ``get_subtype_ids_async``  → ``.single()``
    - ``"hierarchy_path"`` in query → ``get_concepts_by_ids``    → ``.data()``
    """

    _concepts = [
        {
            "id": _PAC,
            "name": "Perfect Authentic Cadence",
            "aliases": ["PAC"],
            "hierarchy_path": [
                "Cadence",
                "Authentic Cadence",
                "Perfect Authentic Cadence",
            ],
        },
        {
            "id": _IAC,
            "name": "Imperfect Authentic Cadence",
            "aliases": ["IAC"],
            "hierarchy_path": [
                "Cadence",
                "Authentic Cadence",
                "Imperfect Authentic Cadence",
            ],
        },
        {
            "id": _AC,
            "name": "Authentic Cadence",
            "aliases": ["AC"],
            "hierarchy_path": ["Cadence", "Authentic Cadence"],
        },
    ]

    hydration_result = AsyncMock()
    hydration_result.data = AsyncMock(return_value=_concepts)

    async def _run(query: str, **kwargs: Any) -> Any:
        if "IS_SUBTYPE_OF" in query:
            concept_id: str = kwargs.get("concept_id", "")
            ids = _SUBTREE_MAP.get(concept_id, [concept_id])
            sub_result = AsyncMock()
            sub_result.single = AsyncMock(return_value={"ids": ids})
            return sub_result
        if "hierarchy_path" in query:
            return hydration_result
        # Fallback (existence checks from other routes in the router)
        existence_result = AsyncMock()
        existence_result.single = AsyncMock(return_value={"exists": 1})
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
    from services.object_storage import StorageClient

    database_url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:localpassword@localhost/doppia",
    )
    init_db(database_url)

    app = FastAPI(lifespan=_noop_lifespan)
    app.state.neo4j_driver = neo4j_driver
    # redis_client is intentionally absent so get_redis returns None
    # (service falls back to Neo4j for subtree expansion).

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

    # Override get_storage so tests don't need real R2/MinIO credentials.
    # All test fragments have preview_object_key=None, so signed_url is never
    # called, but the StorageClient constructor still reads env vars on creation.
    # Injecting a mock avoids that env-var dependency entirely.
    from api.dependencies import get_storage

    mock_storage = MagicMock(spec=StorageClient)
    mock_storage.signed_url = AsyncMock(return_value="https://example.com/preview.svg")
    app.dependency_overrides[get_storage] = lambda: mock_storage

    return app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def browse_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client wired to a real FastAPI app with Postgres + mock Neo4j."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")

    app = _build_app(_make_browse_neo4j_driver())
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def seeded_movement(db_session: AsyncSession) -> AsyncGenerator[dict, None]:
    """Seed a minimal movement hierarchy and yield a dict with all IDs and slugs."""
    composer_id = str(uuid.uuid4())
    corpus_id = str(uuid.uuid4())
    work_id = str(uuid.uuid4())
    movement_id = str(uuid.uuid4())
    slug_sfx = uuid.uuid4().hex[:8]

    await db_session.execute(
        text(
            "INSERT INTO composer (id, slug, name, sort_name) "
            "VALUES (:id, :slug, :name, :sn)"
        ),
        {
            "id": composer_id,
            "slug": f"mozart-{slug_sfx}",
            "name": "Wolfgang Amadeus Mozart",
            "sn": "Mozart, Wolfgang Amadeus",
        },
    )
    await db_session.execute(
        text(
            "INSERT INTO corpus (id, composer_id, slug, title, analysis_source, licence) "
            "VALUES (:id, :cid, :slug, :title, :src, :lic)"
        ),
        {
            "id": corpus_id,
            "cid": composer_id,
            "slug": f"piano-sonatas-{slug_sfx}",
            "title": "Piano Sonatas",
            "src": "DCML",
            "lic": "CC-BY-SA-4.0",
        },
    )
    await db_session.execute(
        text(
            "INSERT INTO work (id, corpus_id, slug, title, catalogue_number) "
            "VALUES (:id, :cid, :slug, :title, :cat)"
        ),
        {
            "id": work_id,
            "cid": corpus_id,
            "slug": f"k331-{slug_sfx}",
            "title": "Piano Sonata No. 11",
            "cat": "K. 331",
        },
    )
    await db_session.execute(
        text(
            "INSERT INTO movement "
            "(id, work_id, slug, movement_number, key_signature, meter, mei_object_key) "
            "VALUES (:id, :wid, :slug, :num, :key, :meter, :mei)"
        ),
        {
            "id": movement_id,
            "wid": work_id,
            "slug": f"movement-1-{slug_sfx}",
            "num": 1,
            "key": "G major",
            "meter": "4/4",
            "mei": f"test/{slug_sfx}/movement-1.mei",
        },
    )
    await db_session.commit()

    ctx = {
        "movement_id": movement_id,
        "composer_id": composer_id,
        "corpus_id": corpus_id,
        "work_id": work_id,
        "slug_sfx": slug_sfx,
    }
    yield ctx

    # Tear-down: delete fragments first (fragment_movement_id_fkey prevents
    # deleting the movement while fragments still reference it).
    await db_session.execute(
        text("DELETE FROM fragment WHERE movement_id = :mid"),
        {"mid": movement_id},
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


async def _insert_fragment(
    db: AsyncSession,
    *,
    movement_id: str,
    concept_id: str = _PAC,
    is_primary: bool = True,
    status: str = "approved",
    bar_start: int = 1,
    bar_end: int = 4,
    created_by: str = _DEV_USER_ID,
    data_licence: str | None = None,
) -> str:
    """Insert a fragment + concept tag directly and return the fragment UUID string."""
    frag_id = str(uuid.uuid4())
    await db.execute(
        text(
            "INSERT INTO fragment "
            "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
            "summary, status, created_by, data_licence) "
            "VALUES (:id, :mid, :bs, :be, :mcs, :mce, "
            "CAST(:summary AS jsonb), :status, :creator, :lic)"
        ),
        {
            "id": frag_id,
            "mid": movement_id,
            "bs": bar_start,
            "be": bar_end,
            "mcs": bar_start,
            "mce": bar_end,
            "summary": json.dumps(_min_summary()),
            "status": status,
            "creator": created_by,
            "lic": data_licence,
        },
    )
    await db.execute(
        text(
            "INSERT INTO fragment_concept_tag (fragment_id, concept_id, is_primary) "
            "VALUES (:fid, :cid, :primary)"
        ),
        {"fid": frag_id, "cid": concept_id, "primary": is_primary},
    )
    await db.commit()
    return frag_id


# ---------------------------------------------------------------------------
# TestBrowseByConceptSubtypes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestBrowseByConceptSubtypes:
    """include_subtypes flag controls whether subtypes are included in results."""

    async def test_include_subtypes_true_returns_subtype_fragments(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """include_subtypes=True returns fragments tagged with any subtype of the root."""
        mid = seeded_movement["movement_id"]
        pac_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)
        iac_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_IAC)

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_AC}&include_subtypes=true&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        ids = {item["id"] for item in body["items"]}
        assert pac_id in ids, "PAC fragment must appear under AuthenticCadence subtree"
        assert iac_id in ids, "IAC fragment must appear under AuthenticCadence subtree"

    async def test_include_subtypes_false_excludes_subtype_fragments(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """include_subtypes=False returns only fragments tagged directly with the concept."""
        mid = seeded_movement["movement_id"]
        pac_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_AC}&include_subtypes=false&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {item["id"] for item in resp.json()["items"]}
        # PAC fragment is NOT tagged with _AC directly, so it must be absent.
        assert pac_id not in ids

    async def test_exact_concept_match_with_include_subtypes_true(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """A fragment tagged with the exact concept is returned in both modes."""
        mid = seeded_movement["movement_id"]
        pac_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)

        for flag in ("true", "false"):
            resp = await browse_client.get(
                f"/api/v1/fragments?concept_id={_PAC}&include_subtypes={flag}&status=approved",
                headers={"Authorization": "Bearer dev-token"},
            )
            assert resp.status_code == 200
            ids = {item["id"] for item in resp.json()["items"]}
            assert pac_id in ids, f"Fragment must appear with include_subtypes={flag}"

    async def test_fragment_with_multiple_matching_tags_appears_once(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """A fragment tagged with both PAC (primary) and AC (cross-ref) appears once."""
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)
        # Add a secondary tag pointing to the parent concept.
        await db_session.execute(
            text(
                "INSERT INTO fragment_concept_tag (fragment_id, concept_id, is_primary) "
                "VALUES (:fid, :cid, false)"
            ),
            {"fid": frag_id, "cid": _AC},
        )
        await db_session.commit()

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_AC}&include_subtypes=true&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        matching = [i for i in items if i["id"] == frag_id]
        assert (
            len(matching) == 1
        ), "Fragment with two matching tags must appear exactly once"


# ---------------------------------------------------------------------------
# TestBrowseStatusVisibility
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestBrowseStatusVisibility:
    """Service-layer status enforcement — spoofed filters cannot bypass visibility."""

    async def test_default_status_is_approved(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """status=approved is the default; draft fragments do not leak into results."""
        mid = seeded_movement["movement_id"]
        approved_id = await _insert_fragment(
            db_session, movement_id=mid, concept_id=_PAC, status="approved"
        )
        draft_id = await _insert_fragment(
            db_session,
            movement_id=mid,
            concept_id=_PAC,
            status="draft",
            bar_start=5,
            bar_end=8,
        )

        # No status param — defaults to approved.
        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {item["id"] for item in resp.json()["items"]}
        assert approved_id in ids
        assert draft_id not in ids, "Draft must not appear in default approved browse"

    async def test_editor_cannot_retrieve_other_users_draft_via_status_filter(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """An editor requesting status=draft only sees their own drafts."""
        mid = seeded_movement["movement_id"]
        # Draft created by the admin — editor cannot see this.
        other_draft_id = await _insert_fragment(
            db_session,
            movement_id=mid,
            concept_id=_PAC,
            status="draft",
            created_by=_ADMIN_USER_ID,
            bar_start=5,
            bar_end=8,
        )
        # Draft created by the editor — they can see this.
        own_draft_id = await _insert_fragment(
            db_session,
            movement_id=mid,
            concept_id=_PAC,
            status="draft",
            created_by=_DEV_USER_ID,
            bar_start=9,
            bar_end=12,
        )

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&status=draft",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {item["id"] for item in resp.json()["items"]}
        assert own_draft_id in ids, "Editor must see their own draft"
        assert other_draft_id not in ids, "Editor must NOT see another user's draft"

    async def test_admin_retrieves_any_draft_via_status_filter(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """An admin requesting status=draft sees all drafts regardless of creator."""
        mid = seeded_movement["movement_id"]
        editor_draft_id = await _insert_fragment(
            db_session,
            movement_id=mid,
            concept_id=_PAC,
            status="draft",
            created_by=_DEV_USER_ID,
        )

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&status=draft",
            headers={"Authorization": "Bearer admin-token"},
        )
        assert resp.status_code == 200, resp.text
        ids = {item["id"] for item in resp.json()["items"]}
        assert editor_draft_id in ids, "Admin must see editor's draft"

    async def test_requires_auth(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
    ) -> None:
        """Unauthenticated request returns 401."""
        resp = await browse_client.get(f"/api/v1/fragments?concept_id={_PAC}")
        assert resp.status_code == 401

    async def test_empty_concept_returns_empty_list(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
    ) -> None:
        """A concept with no matching fragments returns items=[] and next_cursor=null."""
        # Use a synthetic concept_id that is guaranteed to have no fragments in
        # the database.  The mock Neo4j driver returns any unknown concept as a
        # singleton subtree, so the browse query runs without error.
        empty_concept_id = f"TestNoConcept_{seeded_movement['slug_sfx']}"

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={empty_concept_id}&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["items"] == []
        assert body["next_cursor"] is None


# ---------------------------------------------------------------------------
# TestBrowsePagination
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestBrowsePagination:
    """Cursor pagination for the concept-scoped browse list."""

    async def test_cursor_pagination_covers_all_fragments(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """Cursor pagination returns all fragments without overlap."""
        mid = seeded_movement["movement_id"]
        # Use a unique concept_id so only the 3 fragments inserted here match.
        # Pre-existing PAC fragments from other tests or prior runs must not
        # contaminate the exact page-size counts.  The mock Neo4j driver returns
        # any unknown concept as a singleton subtree, so the query runs normally.
        pagination_concept = f"TestPAC_{seeded_movement['slug_sfx']}"

        inserted_ids: list[str] = []
        for i in range(3):
            fid = await _insert_fragment(
                db_session,
                movement_id=mid,
                concept_id=pagination_concept,
                bar_start=i * 4 + 1,
                bar_end=i * 4 + 4,
            )
            inserted_ids.append(fid)

        # Page 1: 2 items.
        resp1 = await browse_client.get(
            f"/api/v1/fragments?concept_id={pagination_concept}&status=approved&page_size=2",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp1.status_code == 200, resp1.text
        page1 = resp1.json()
        assert len(page1["items"]) == 2
        assert page1["next_cursor"] is not None

        # Page 2: remaining 1 item.
        resp2 = await browse_client.get(
            f"/api/v1/fragments?concept_id={pagination_concept}&status=approved"
            f"&page_size=2&cursor={page1['next_cursor']}",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp2.status_code == 200, resp2.text
        page2 = resp2.json()
        assert len(page2["items"]) == 1
        assert page2["next_cursor"] is None

        # No overlap; all inserted fragments covered.
        ids_p1 = {i["id"] for i in page1["items"]}
        ids_p2 = {i["id"] for i in page2["items"]}
        assert ids_p1.isdisjoint(ids_p2), "Pages must not overlap"
        assert (ids_p1 | ids_p2) >= set(inserted_ids)

    async def test_response_echoes_concept_id_and_include_subtypes(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """The response body echoes concept_id and include_subtypes from the request."""
        mid = seeded_movement["movement_id"]
        await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&include_subtypes=false&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["concept_id"] == _PAC
        assert body["include_subtypes"] is False


# ---------------------------------------------------------------------------
# TestBrowseListItemFields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestBrowseListItemFields:
    """Fields returned on each list item — movement label, licence, preview URL."""

    async def test_preview_url_is_null_without_stored_preview(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """A fragment without a stored preview_object_key has preview_url=null."""
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        item = next((i for i in items if i["id"] == frag_id), None)
        assert item is not None
        assert item["preview_url"] is None

    async def test_data_licence_and_harmony_sources_present(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """Each list item carries data_licence and harmony_sources fields (ADR-009)."""
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(
            db_session,
            movement_id=mid,
            concept_id=_PAC,
            data_licence="CC BY-SA 4.0",
        )

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        item = next((i for i in items if i["id"] == frag_id), None)
        assert item is not None
        assert "data_licence" in item
        assert "harmony_sources" in item
        assert isinstance(item["harmony_sources"], list)

    async def test_data_licence_from_dcml_events(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """A fragment whose movement has a DCML event in range reports CC BY-SA 4.0."""
        mid = seeded_movement["movement_id"]

        # Seed a DCML harmony event in range.
        events = [
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
                "reviewed": True,
            }
        ]
        await db_session.execute(
            text(
                "INSERT INTO movement_analysis (id, movement_id, events, music21_version) "
                "VALUES (:id, :mid, CAST(:events AS jsonb), :ver)"
            ),
            {
                "id": str(uuid.uuid4()),
                "mid": mid,
                "events": json.dumps(events),
                "ver": "none",
            },
        )
        await db_session.commit()

        frag_id = await _insert_fragment(
            db_session,
            movement_id=mid,
            concept_id=_PAC,
            data_licence="CC BY-SA 4.0",  # stored on the fragment row
            bar_start=1,
            bar_end=4,
        )

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        item = next((i for i in items if i["id"] == frag_id), None)
        assert item is not None
        assert item["data_licence"] == "CC BY-SA 4.0"
        assert "DCML" in item["harmony_sources"]

    async def test_movement_label_fields_present(
        self,
        browse_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """Each list item includes composer_name, work_title, and movement_number."""
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(db_session, movement_id=mid, concept_id=_PAC)

        resp = await browse_client.get(
            f"/api/v1/fragments?concept_id={_PAC}&status=approved",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        item = next((i for i in items if i["id"] == frag_id), None)
        assert item is not None
        assert item["composer_name"] == "Wolfgang Amadeus Mozart"
        assert "Piano Sonata" in item["work_title"]
        assert item["movement_number"] == 1
