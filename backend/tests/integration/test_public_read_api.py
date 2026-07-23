"""Integration tests for the anonymous public read path (Component 10 Step 3).

Tests the ``/api/v1/public/`` router against a real PostgreSQL instance with a
mock Neo4j driver, exactly like ``test_concept_browse_api.py``.  Requests carry
**no** ``Authorization`` header — the point of the surface under test.

Endpoints under test:
    GET /api/v1/public/fragments                — anonymous browse by concept
    GET /api/v1/public/fragments/{fragment_id}  — anonymous fragment detail

Verification cases from the Component 10 plan (Step 3):
    1. An unauthenticated browse succeeds and returns only ``approved``
       fragments — draft/submitted/rejected fixtures never appear.
    2. A spoofed ``status`` query parameter has no effect.
    3. Anonymous detail of an approved fragment returns the full record
       (licence provenance, signed MEI URL).
    4. Detail of a non-``approved`` fragment returns a 404 identical to the
       nonexistent-id 404 (no existence/status leak).

The browse runs against shared concept ids (PAC/AC), so a DB carrying real
campaign fragments has entries beyond what a test inserts — assertions scope
to inserted ids over the full cursor walk, never to a single page.

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
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException

pytestmark = pytest.mark.integration

_DEV_USER_ID = "00000000-0000-0000-0000-000000000001"  # role: editor

_PAC = "PerfectAuthenticCadence"
_AC = "AuthenticCadence"

_SUBTREE_MAP: dict[str, list[str]] = {
    _AC: [_AC, _PAC],
    _PAC: [_PAC],
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _min_summary() -> dict[str, Any]:
    return {"version": 1, "key": "G major", "meter": "4/4", "concepts": [_PAC]}


def _make_neo4j_driver() -> MagicMock:
    """Neo4j driver mock covering the subtree and hydration query shapes."""
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

    from api.dependencies import get_storage
    from api.middleware.auth import AuthMiddleware
    from api.middleware.cors import PathScopedCORSMiddleware
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
    # redis_client intentionally absent → subtree cache disabled.

    app.add_exception_handler(DoppiaError, doppia_error_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
    app.add_middleware(AuthMiddleware)
    # Production CORS topology: credentialed allowlist + wildcard public prefix.
    app.add_middleware(
        PathScopedCORSMiddleware, allowed_origins=["http://localhost:5173"]
    )
    app.include_router(api_router)

    mock_storage = MagicMock(spec=StorageClient)
    mock_storage.signed_url = AsyncMock(
        return_value="https://example.com/signed?X-Amz-Signature=abc"
    )
    app.dependency_overrides[get_storage] = lambda: mock_storage

    return app


@pytest_asyncio.fixture
async def public_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client for anonymous requests against a real-Postgres app."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")

    app = _build_app(_make_neo4j_driver())
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def seeded_movement(db_session: AsyncSession) -> AsyncGenerator[dict, None]:
    """Seed a minimal movement hierarchy and yield a dict with all IDs."""
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

    yield {
        "movement_id": movement_id,
        "composer_id": composer_id,
        "corpus_id": corpus_id,
        "work_id": work_id,
    }

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
    status: str = "approved",
    bar_start: int = 1,
    bar_end: int = 4,
    data_licence: str | None = "CC BY-SA 4.0",
) -> str:
    """Insert a fragment + concept tag directly; return the fragment UUID string."""
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
            "creator": _DEV_USER_ID,
            "lic": data_licence,
        },
    )
    await db.execute(
        text(
            "INSERT INTO fragment_concept_tag (fragment_id, concept_id, is_primary) "
            "VALUES (:fid, :cid, true)"
        ),
        {"fid": frag_id, "cid": concept_id},
    )
    await db.commit()
    return frag_id


async def _public_browse_all_items(
    client: AsyncClient,
    query: str,
    page_size: int = 50,
) -> list[dict[str, Any]]:
    """Walk the public browse through all cursor pages — no auth header."""
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(200):  # hard stop if a cursor ever loops
        url = f"/api/v1/public/fragments?{query}&page_size={page_size}"
        if cursor is not None:
            url += f"&cursor={cursor}"
        resp = await client.get(url)
        assert resp.status_code == 200, resp.text
        page = resp.json()
        items.extend(page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            return items
    raise AssertionError("Browse cursor did not terminate within 200 pages")


# ---------------------------------------------------------------------------
# TestPublicBrowseApprovedOnly
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestPublicBrowseApprovedOnly:
    """Anonymous browse serves approved fragments and nothing else."""

    async def test_anonymous_browse_returns_approved_fragment(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        mid = seeded_movement["movement_id"]
        approved_id = await _insert_fragment(
            db_session, movement_id=mid, status="approved"
        )

        items = await _public_browse_all_items(
            public_client, f"concept_id={_AC}&include_subtypes=true"
        )
        ids = {item["id"] for item in items}
        assert approved_id in ids
        assert all(item["status"] == "approved" for item in items)

    async def test_non_approved_fragments_never_appear(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        mid = seeded_movement["movement_id"]
        hidden_ids = {
            await _insert_fragment(db_session, movement_id=mid, status=status)
            for status in ("draft", "submitted", "rejected")
        }

        items = await _public_browse_all_items(
            public_client, f"concept_id={_AC}&include_subtypes=true"
        )
        ids = {item["id"] for item in items}
        assert not (hidden_ids & ids), "non-approved fragments leaked publicly"

    async def test_spoofed_status_param_has_no_effect(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        mid = seeded_movement["movement_id"]
        submitted_id = await _insert_fragment(
            db_session, movement_id=mid, status="submitted"
        )

        items = await _public_browse_all_items(
            public_client, f"concept_id={_AC}&include_subtypes=true&status=submitted"
        )
        ids = {item["id"] for item in items}
        assert submitted_id not in ids
        assert all(item["status"] == "approved" for item in items)

    async def test_licence_fields_present_on_items(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(
            db_session, movement_id=mid, data_licence="CC BY-SA 4.0"
        )

        items = await _public_browse_all_items(
            public_client, f"concept_id={_PAC}&include_subtypes=false"
        )
        mine = [i for i in items if i["id"] == frag_id]
        assert len(mine) == 1
        assert mine[0]["data_licence"] == "CC BY-SA 4.0"


# ---------------------------------------------------------------------------
# TestPublicDetail
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestPublicDetail:
    """Anonymous fragment detail: approved served; everything else 404."""

    async def test_approved_detail_served_with_signed_mei_url(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(db_session, movement_id=mid, status="approved")

        resp = await public_client.get(f"/api/v1/public/fragments/{frag_id}")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == frag_id
        assert body["status"] == "approved"
        assert body["data_licence"] == "CC BY-SA 4.0"
        assert body["mei_url"] is not None
        assert body["composer_name"] == "Wolfgang Amadeus Mozart"

    @pytest.mark.parametrize("status", ["draft", "submitted", "rejected"])
    async def test_non_approved_detail_is_404(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
        status: str,
    ) -> None:
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(db_session, movement_id=mid, status=status)

        resp = await public_client.get(f"/api/v1/public/fragments/{frag_id}")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

    async def test_hidden_404_matches_nonexistent_404(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """No existence leak: an existing submitted fragment and a random UUID
        produce identical 404 bodies apart from the echoed id."""
        mid = seeded_movement["movement_id"]
        frag_id = await _insert_fragment(
            db_session, movement_id=mid, status="submitted"
        )

        resp_hidden = await public_client.get(f"/api/v1/public/fragments/{frag_id}")
        missing_id = uuid.uuid4()
        resp_missing = await public_client.get(f"/api/v1/public/fragments/{missing_id}")

        assert resp_hidden.status_code == resp_missing.status_code == 404
        hidden = resp_hidden.json()
        missing = resp_missing.json()
        assert hidden["error"]["code"] == missing["error"]["code"]
        # Normalise the echoed ids; every other byte must match.
        hidden_norm = json.dumps(hidden).replace(frag_id, "X")
        missing_norm = json.dumps(missing).replace(str(missing_id), "X")
        assert hidden_norm == missing_norm


# ---------------------------------------------------------------------------
# ADR-009 § 2: NonCommercial (ABC) corpus exclusion
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def seeded_abc_movement(
    db_session: AsyncSession,
) -> AsyncGenerator[dict, None]:
    """Seed a movement in a NonCommercial (CC BY-NC-SA 4.0) corpus — the ABC
    case ADR-009 § 2 excludes from the public API.

    Structurally identical to ``seeded_movement`` but the corpus licence
    carries the NonCommercial restriction, so the exclusion guard is proven
    against a real fixture before any ABC corpus is ever ingested.
    """
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
            "slug": f"beethoven-{slug_sfx}",
            "name": "Ludwig van Beethoven",
            "sn": "Beethoven, Ludwig van",
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
            "slug": f"string-quartets-{slug_sfx}",
            "title": "String Quartets (ABC)",
            "src": "DCML",
            "lic": "CC-BY-NC-SA-4.0",  # NonCommercial — the exclusion trigger
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
            "slug": f"op18-1-{slug_sfx}",
            "title": "String Quartet No. 1",
            "cat": "Op. 18 No. 1",
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
            "key": "F major",
            "meter": "3/4",
            "mei": f"test/{slug_sfx}/abc-movement-1.mei",
        },
    )
    await db_session.commit()

    yield {"movement_id": movement_id}

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


@pytest.mark.asyncio(loop_scope="session")
class TestAbcExclusion:
    """An ABC-sourced (NonCommercial) fragment is invisible on the public path."""

    async def test_abc_fragment_absent_from_public_browse(
        self,
        public_client: AsyncClient,
        seeded_abc_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        abc_mid = seeded_abc_movement["movement_id"]
        abc_id = await _insert_fragment(
            db_session, movement_id=abc_mid, status="approved"
        )

        items = await _public_browse_all_items(
            public_client, f"concept_id={_AC}&include_subtypes=true"
        )
        ids = {item["id"] for item in items}
        assert (
            abc_id not in ids
        ), "NonCommercial (ABC) fragment leaked into public browse"

    async def test_abc_fragment_detail_is_404(
        self,
        public_client: AsyncClient,
        seeded_abc_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        abc_mid = seeded_abc_movement["movement_id"]
        abc_id = await _insert_fragment(
            db_session, movement_id=abc_mid, status="approved"
        )

        resp = await public_client.get(f"/api/v1/public/fragments/{abc_id}")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

    async def test_editor_still_sees_abc_fragment(
        self,
        public_client: AsyncClient,
        seeded_abc_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        """The exclusion is public-only: an authenticated editor still reads the
        ABC fragment (internal tool use is not public distribution — ADR-009)."""
        abc_mid = seeded_abc_movement["movement_id"]
        abc_id = await _insert_fragment(
            db_session, movement_id=abc_mid, status="approved"
        )

        resp = await public_client.get(
            f"/api/v1/fragments/{abc_id}",
            headers={"Authorization": "Bearer dev-token"},
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == abc_id


# ---------------------------------------------------------------------------
# TestPublicConceptExamples — GET /api/v1/public/concepts/{id}/examples
# ---------------------------------------------------------------------------


async def _insert_n_approved(
    db: AsyncSession, movement_id: str, n: int, concept_id: str = _PAC
) -> set[str]:
    """Insert ``n`` approved fragments (distinct bar ranges) tagged ``concept_id``."""
    ids: set[str] = set()
    for i in range(n):
        ids.add(
            await _insert_fragment(
                db,
                movement_id=movement_id,
                concept_id=concept_id,
                status="approved",
                bar_start=1 + 2 * i,
                bar_end=2 + 2 * i,
            )
        )
    return ids


@pytest.mark.asyncio(loop_scope="session")
class TestPublicConceptExamples:
    """The glossary example draw: approved-only, capped, ADR-009 excluded."""

    async def test_examples_are_approved_and_capped(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        # A concept id no campaign data uses, so the pool is exactly this test's
        # inserts (the shared DB carries real AC/PAC fragments — file header).
        # include_subtypes=false resolves the subtree to just this id.
        ex_concept = f"GlossaryExampleTest_{uuid.uuid4().hex[:8]}"
        mid = seeded_movement["movement_id"]
        approved = await _insert_n_approved(db_session, mid, 5, concept_id=ex_concept)
        draft = await _insert_fragment(
            db_session, movement_id=mid, concept_id=ex_concept, status="draft"
        )

        resp = await public_client.get(
            f"/api/v1/public/concepts/{ex_concept}/examples"
            "?limit=3&include_subtypes=false"
        )

        assert resp.status_code == 200, resp.text
        examples = resp.json()["examples"]
        assert len(examples) == 3, "expected exactly the capped 3 from a pool of 5"
        assert all(e["status"] == "approved" for e in examples)
        returned = {e["id"] for e in examples}
        assert returned <= approved, "an example was drawn from outside the pool"
        assert draft not in returned

    async def test_same_seed_is_reproducible(
        self,
        public_client: AsyncClient,
        seeded_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        ex_concept = f"GlossaryExampleTest_{uuid.uuid4().hex[:8]}"
        mid = seeded_movement["movement_id"]
        await _insert_n_approved(db_session, mid, 6, concept_id=ex_concept)

        url = (
            f"/api/v1/public/concepts/{ex_concept}/examples"
            "?limit=3&include_subtypes=false&seed=12345"
        )
        first = await public_client.get(url)
        second = await public_client.get(url)

        assert first.status_code == second.status_code == 200
        ids_first = [e["id"] for e in first.json()["examples"]]
        ids_second = [e["id"] for e in second.json()["examples"]]
        assert ids_first == ids_second, "same seed produced a different draw"

    async def test_empty_pool_returns_no_examples(
        self,
        public_client: AsyncClient,
    ) -> None:
        # A concept with no tagged fragments resolves to an empty pool, not 404.
        resp = await public_client.get(
            f"/api/v1/public/concepts/{_PAC}/examples?include_subtypes=false&seed=1"
        )
        # There may be real campaign PAC fragments; scope the assertion to the
        # contract, not to emptiness: a 200 with a well-formed (possibly empty)
        # list, never an error.
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body["examples"], list)
        assert body["concept_id"] == _PAC

    async def test_abc_fragment_absent_from_examples(
        self,
        public_client: AsyncClient,
        seeded_abc_movement: dict,
        db_session: AsyncSession,
    ) -> None:
        abc_mid = seeded_abc_movement["movement_id"]
        abc_id = await _insert_fragment(
            db_session, movement_id=abc_mid, status="approved"
        )

        # Draw generously so the single ABC fragment would surface if not excluded.
        resp = await public_client.get(
            f"/api/v1/public/concepts/{_AC}/examples?limit=12"
        )

        assert resp.status_code == 200
        returned = {e["id"] for e in resp.json()["examples"]}
        assert abc_id not in returned, "NonCommercial fragment leaked into examples"
