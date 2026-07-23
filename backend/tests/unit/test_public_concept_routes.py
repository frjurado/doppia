"""Unit tests for the public concept glossary route (Component 11 Step 1).

Two layers, neither needs a running Neo4j:

* ``TestPublicConceptDetail`` / ``TestPublicConceptCORS`` exercise
  ``GET /api/v1/public/concepts/{id}`` through the full FastAPI stack —
  middleware, DI, handler, serialisation, error envelope — with the
  ``ConceptService`` stubbed via the ``get_public_concept_service`` override.
* ``TestGetPublicDetailAssembly`` exercises
  ``ConceptService.get_public_detail`` directly with the two graph-query
  functions mocked, verifying payload assembly (parent/children/relationship
  mapping and the deterministic relationship sort).

Verification cases from the Component 11 plan (Step 1):
    1. An anonymous request for an existing concept returns the full payload
       (definition, hierarchy, typed relationships) with ``definition_reviewed``
       surfaced.
    2. A stub concept returns a valid payload flagged ``stub: true``.
    3. An unknown concept id returns 404 ``CONCEPT_NOT_FOUND``.
    4. The route needs no authentication and takes the public wildcard CORS
       posture.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

# ---------------------------------------------------------------------------
# App and client fixtures
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


_EDITOR_ORIGIN = "http://localhost:5173"


def _build_app() -> FastAPI:
    """Build a test app with the production middleware topology (auth + CORS)."""
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

    app = FastAPI(lifespan=_noop_lifespan)
    app.add_exception_handler(DoppiaError, doppia_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(PathScopedCORSMiddleware, allowed_origins=[_EDITOR_ORIGIN])
    app.include_router(api_router)
    return app


@pytest_asyncio.fixture
async def concept_client() -> AsyncGenerator[tuple[AsyncClient, AsyncMock], None]:
    """Anonymous async client with the public ConceptService stubbed.

    No ``get_current_user`` override — requests carry no ``Authorization``
    header, exactly like a real anonymous caller.

    Yields:
        ``(client, mock_service)`` — the HTTP client and the mocked
        :class:`~services.concepts.ConceptService`.
    """
    from api.routes.public_concepts import get_public_concept_service
    from services.concepts import ConceptService

    app = _build_app()
    mock_service = AsyncMock(spec=ConceptService)
    app.dependency_overrides[get_public_concept_service] = lambda: mock_service

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, mock_service


@pytest_asyncio.fixture
async def examples_client() -> AsyncGenerator[tuple[AsyncClient, AsyncMock], None]:
    """Anonymous async client with the FragmentService stubbed for examples.

    Yields:
        ``(client, mock_service)`` — the HTTP client and the mocked
        :class:`~services.fragments.FragmentService`.
    """
    from api.routes.fragments import get_fragment_service
    from services.fragments import FragmentService

    app = _build_app()
    mock_service = AsyncMock(spec=FragmentService)
    app.dependency_overrides[get_fragment_service] = lambda: mock_service

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, mock_service


# ---------------------------------------------------------------------------
# Response-model factory
# ---------------------------------------------------------------------------


def _detail_response(**overrides: Any) -> Any:
    from models.concepts import ConceptDetailResponse, ConceptRef, ConceptRelationship

    base: dict[str, Any] = {
        "id": "PerfectAuthenticCadence",
        "name": "Perfect Authentic Cadence",
        "aliases": ["PAC"],
        "definition": "An authentic cadence with root-position chords and 1 in the soprano.",
        "domain": "cadences",
        "complexity": "intermediate",
        "stub": False,
        "definition_reviewed": True,
        "top_level_taggable": True,
        "hierarchy_path": ["Cadence", "Authentic Cadence", "Perfect Authentic Cadence"],
        "parent": ConceptRef(id="AuthenticCadence", name="Authentic Cadence"),
        "children": [],
        "relationships": [
            ConceptRelationship(
                type="CONTRASTS_WITH",
                direction="outgoing",
                target=ConceptRef(id="ImperfectAuthenticCadence", name="IAC"),
            )
        ],
    }
    base.update(overrides)
    return ConceptDetailResponse(**base)


# ---------------------------------------------------------------------------
# Public concept detail
# ---------------------------------------------------------------------------


class TestPublicConceptDetail:
    """GET /api/v1/public/concepts/{id} — anonymous glossary page payload."""

    @pytest.mark.asyncio
    async def test_existing_concept_is_served(
        self, concept_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = concept_client
        service.get_public_detail.return_value = _detail_response()

        resp = await client.get("/api/v1/public/concepts/PerfectAuthenticCadence")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == "PerfectAuthenticCadence"
        assert body["definition_reviewed"] is True
        assert body["hierarchy_path"][0] == "Cadence"
        assert body["parent"]["id"] == "AuthenticCadence"
        assert body["relationships"][0]["type"] == "CONTRASTS_WITH"
        service.get_public_detail.assert_awaited_once_with("PerfectAuthenticCadence")

    @pytest.mark.asyncio
    async def test_unreviewed_definition_flag_is_surfaced(
        self, concept_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        """The raw prose is still returned; the flag tells the frontend to
        substitute a placeholder (Step 2)."""
        client, service = concept_client
        service.get_public_detail.return_value = _detail_response(
            definition_reviewed=False
        )

        resp = await client.get("/api/v1/public/concepts/PerfectAuthenticCadence")

        assert resp.status_code == 200
        body = resp.json()
        assert body["definition_reviewed"] is False
        assert body["definition"] is not None

    @pytest.mark.asyncio
    async def test_stub_concept_is_served_flagged(
        self, concept_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = concept_client
        service.get_public_detail.return_value = _detail_response(
            id="FormalFunction",
            name="Formal Function",
            stub=True,
            definition=None,
            parent=None,
            relationships=[],
        )

        resp = await client.get("/api/v1/public/concepts/FormalFunction")

        assert resp.status_code == 200
        assert resp.json()["stub"] is True

    @pytest.mark.asyncio
    async def test_unknown_concept_is_404(
        self, concept_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        from errors import ConceptNotFoundError

        client, service = concept_client
        service.get_public_detail.side_effect = ConceptNotFoundError(
            "Concept 'Nope' not found.", detail={"concept_id": "Nope"}
        )

        resp = await client.get("/api/v1/public/concepts/Nope")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "CONCEPT_NOT_FOUND"


# ---------------------------------------------------------------------------
# Public concept examples
# ---------------------------------------------------------------------------


def _examples_response(n: int = 2, **overrides: Any) -> Any:
    import uuid
    from datetime import datetime, timezone

    from models.fragment import ConceptBrowseItem, ConceptExamplesResponse

    now = datetime(2026, 7, 22, 12, 0, 0, tzinfo=timezone.utc)
    items = [
        ConceptBrowseItem(
            id=uuid.uuid4(),
            movement_id=uuid.uuid4(),
            bar_start=1,
            bar_end=4,
            beat_start=None,
            beat_end=None,
            repeat_context=None,
            status="approved",
            primary_concept_id="PerfectAuthenticCadence",
            primary_concept_alias="PAC",
            primary_concept_name="Perfect Authentic Cadence",
            data_licence="CC BY-SA 4.0",
            data_licence_url="https://creativecommons.org/licenses/by-sa/4.0/",
            harmony_sources=["DCML"],
            preview_url="https://signed.example/preview.svg",
            created_by=uuid.uuid4(),
            updated_at=now,
            composer_name="Mozart",
            work_title="Piano Sonata",
            work_catalogue_number="K.331",
            movement_number=1,
            movement_title=None,
        )
        for _ in range(n)
    ]
    base: dict[str, Any] = {
        "examples": items,
        "concept_id": "PerfectAuthenticCadence",
        "include_subtypes": True,
    }
    base.update(overrides)
    return ConceptExamplesResponse(**base)


class TestPublicConceptExamples:
    """GET /api/v1/public/concepts/{id}/examples — random approved example draw."""

    @pytest.mark.asyncio
    async def test_defaults_pass_through(
        self, examples_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = examples_client
        service.list_examples_by_concept.return_value = _examples_response(n=2)

        resp = await client.get(
            "/api/v1/public/concepts/PerfectAuthenticCadence/examples"
        )

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["examples"]) == 2
        assert body["examples"][0]["preview_url"].endswith(".svg")
        service.list_examples_by_concept.assert_awaited_once_with(
            "PerfectAuthenticCadence",
            include_subtypes=True,
            limit=3,
            seed=None,
        )

    @pytest.mark.asyncio
    async def test_query_params_pass_through(
        self, examples_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = examples_client
        service.list_examples_by_concept.return_value = _examples_response(
            n=1, include_subtypes=False
        )

        resp = await client.get(
            "/api/v1/public/concepts/PerfectAuthenticCadence/examples",
            params={"include_subtypes": "false", "limit": 5, "seed": 42},
        )

        assert resp.status_code == 200
        service.list_examples_by_concept.assert_awaited_once_with(
            "PerfectAuthenticCadence",
            include_subtypes=False,
            limit=5,
            seed=42,
        )

    @pytest.mark.asyncio
    async def test_empty_pool_returns_empty_list(
        self, examples_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        """An unknown/untagged concept is not an error — it draws no examples."""
        client, service = examples_client
        service.list_examples_by_concept.return_value = _examples_response(
            n=0, concept_id="Nope"
        )

        resp = await client.get("/api/v1/public/concepts/Nope/examples")

        assert resp.status_code == 200
        assert resp.json()["examples"] == []

    @pytest.mark.asyncio
    async def test_limit_out_of_range_is_422(
        self, examples_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, _ = examples_client
        resp = await client.get(
            "/api/v1/public/concepts/PerfectAuthenticCadence/examples",
            params={"limit": 99},
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Public CORS posture
# ---------------------------------------------------------------------------


class TestPublicConceptCORS:
    """The public concepts prefix takes the wildcard, no-credentials policy."""

    @pytest.mark.asyncio
    async def test_response_carries_wildcard_origin(
        self, concept_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = concept_client
        service.get_public_detail.return_value = _detail_response()

        resp = await client.get(
            "/api/v1/public/concepts/PerfectAuthenticCadence",
            headers={"Origin": "https://third-party.example"},
        )

        assert resp.status_code == 200
        assert resp.headers["access-control-allow-origin"] == "*"
        assert "access-control-allow-credentials" not in resp.headers


# ---------------------------------------------------------------------------
# Service-layer assembly (graph queries mocked)
# ---------------------------------------------------------------------------


class _FakeSession:
    """Async context manager standing in for ``driver.session()``."""

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None


class _FakeDriver:
    def session(self) -> _FakeSession:
        return _FakeSession()


class TestGetPublicDetailAssembly:
    """ConceptService.get_public_detail — payload assembly and relationship sort."""

    @pytest.mark.asyncio
    async def test_assembles_and_sorts_relationships(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from services import concepts as svc
        from services.concepts import ConceptService

        detail_row = {
            "id": "AuthenticCadence",
            "name": "Authentic Cadence",
            "aliases": ["AC"],
            "definition": "A cadence whose dominant resolves to tonic.",
            "domain": "cadences",
            "complexity": "foundational",
            "stub": False,
            "definition_reviewed": False,
            "top_level_taggable": True,
            "hierarchy_path": ["Cadence", "Authentic Cadence"],
            "parent": {"id": "Cadence", "name": "Cadence", "stub": False},
            "children": [
                {"id": "PerfectAuthenticCadence", "name": "PAC", "stub": False},
                {"id": "ImperfectAuthenticCadence", "name": "IAC", "stub": False},
            ],
        }
        # Deliberately out of display order to prove the sort:
        # (rel_type asc, outgoing before incoming, target_name asc).
        rel_rows = [
            {
                "rel_type": "PREREQUISITE_FOR",
                "direction": "outgoing",
                "target_id": "DeceptiveCadence",
                "target_name": "Deceptive Cadence",
                "target_stub": False,
            },
            {
                "rel_type": "CONTRASTS_WITH",
                "direction": "incoming",
                "target_id": "HalfCadence",
                "target_name": "Half Cadence",
                "target_stub": False,
            },
            {
                "rel_type": "CONTRASTS_WITH",
                "direction": "outgoing",
                "target_id": "Zebra",
                "target_name": "Zebra Cadence",
                "target_stub": True,
            },
            {
                "rel_type": "CONTRASTS_WITH",
                "direction": "outgoing",
                "target_id": "Alpha",
                "target_name": "Alpha Cadence",
                "target_stub": False,
            },
        ]

        async def _fake_detail(session: object, concept_id: str) -> dict[str, Any]:
            return detail_row

        async def _fake_rels(session: object, concept_id: str) -> list[dict[str, Any]]:
            return rel_rows

        monkeypatch.setattr(svc, "get_concept_detail", _fake_detail)
        monkeypatch.setattr(svc, "get_concept_relationships", _fake_rels)

        service = ConceptService(_FakeDriver())  # type: ignore[arg-type]
        result = await service.get_public_detail("AuthenticCadence")

        assert result.parent is not None and result.parent.id == "Cadence"
        assert [c.id for c in result.children] == [
            "PerfectAuthenticCadence",
            "ImperfectAuthenticCadence",
        ]
        # CONTRASTS_WITH before PREREQUISITE_FOR; within CONTRASTS_WITH,
        # outgoing (Alpha, Zebra by name) before incoming (Half Cadence).
        assert [(r.type, r.direction, r.target.name) for r in result.relationships] == [
            ("CONTRASTS_WITH", "outgoing", "Alpha Cadence"),
            ("CONTRASTS_WITH", "outgoing", "Zebra Cadence"),
            ("CONTRASTS_WITH", "incoming", "Half Cadence"),
            ("PREREQUISITE_FOR", "outgoing", "Deceptive Cadence"),
        ]
        assert result.relationships[1].target.stub is True

    @pytest.mark.asyncio
    async def test_unknown_concept_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from errors import ConceptNotFoundError
        from services import concepts as svc
        from services.concepts import ConceptService

        async def _fake_detail(session: object, concept_id: str) -> None:
            return None

        monkeypatch.setattr(svc, "get_concept_detail", _fake_detail)

        service = ConceptService(_FakeDriver())  # type: ignore[arg-type]
        with pytest.raises(ConceptNotFoundError):
            await service.get_public_detail("Nope")
