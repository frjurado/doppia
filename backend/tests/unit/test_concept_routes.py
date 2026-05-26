"""Unit tests for backend/api/routes/concepts.py.

Exercises the concept search endpoint through the full FastAPI stack —
middleware, dependency injection, route handler, response serialisation —
without any running Neo4j instance.

The ``ConceptService`` is stubbed by overriding the ``get_concept_service``
dependency so tests control the data returned without touching the graph.

Test structure
--------------
TestConceptSearch        — GET /api/v1/concepts/search
TestConceptSearchAuth    — 401/403 enforcement
TestConceptSearchCursor  — cursor pagination behaviour
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

# ---------------------------------------------------------------------------
# Shared test app builder
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app() -> FastAPI:
    """Build a minimal FastAPI test app with the full exception-handler stack."""
    from api.middleware.auth import AuthMiddleware
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
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(api_router)
    return app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def concept_client() -> AsyncGenerator[tuple[AsyncClient, Any], None]:
    """Authenticated async client with the ConceptService stubbed.

    Yields:
        ``(client, mock_service)`` where ``mock_service`` is an ``AsyncMock``
        whose ``search`` return value can be set per-test.
    """
    from api.dependencies import get_current_user
    from api.routes.concepts import get_concept_service
    from models.concepts import ConceptSearchResponse
    from services.concepts import ConceptService

    app = _build_app()
    mock_service = AsyncMock(spec=ConceptService)
    mock_service.search.return_value = ConceptSearchResponse(items=[], next_cursor=None)

    dev_user_obj = __import__("api.dependencies", fromlist=["AppUser"]).AppUser(
        id="test-user", role="editor", email="test@example.com"
    )

    app.dependency_overrides[get_concept_service] = lambda: mock_service
    app.dependency_overrides[get_current_user] = lambda: dev_user_obj

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, mock_service


@pytest_asyncio.fixture
async def anon_concept_client() -> AsyncGenerator[AsyncClient, None]:
    """Anonymous async client — every authenticated route returns 401."""
    from api.dependencies import get_current_user
    from api.routes.concepts import get_concept_service
    from services.concepts import ConceptService

    app = _build_app()
    mock_service = AsyncMock(spec=ConceptService)

    def _raise_401() -> None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    app.dependency_overrides[get_concept_service] = lambda: mock_service
    app.dependency_overrides[get_current_user] = _raise_401

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pac_item(**overrides: Any) -> dict[str, Any]:
    """A PAC-shaped ConceptSearchItem dict."""
    return {
        "id": overrides.get("id", "PerfectAuthenticCadence"),
        "name": overrides.get("name", "Perfect Authentic Cadence"),
        "aliases": overrides.get("aliases", ["PAC"]),
        "hierarchy_path": overrides.get(
            "hierarchy_path",
            ["Cadence", "Authentic Cadence", "Perfect Authentic Cadence"],
        ),
        "definition": overrides.get(
            "definition", "A cadence ending on root-position tonic."
        ),
    }


# ---------------------------------------------------------------------------
# TestConceptSearch
# ---------------------------------------------------------------------------


class TestConceptSearch:
    """GET /api/v1/concepts/search — happy-path and filter behaviour."""

    @pytest.mark.asyncio
    async def test_returns_200_with_items(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A well-formed search query returns HTTP 200 with an ``items`` list."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[ConceptSearchItem(**_pac_item())],
            next_cursor=None,
        )

        resp = await client.get("/api/v1/concepts/search?q=perfect+authentic")

        assert resp.status_code == 200
        body = resp.json()
        assert body["items"][0]["id"] == "PerfectAuthenticCadence"
        assert body["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_pac_ranked_first(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """When multiple hits are returned, the highest-score item is first."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        iac_item = _pac_item(
            id="ImperfectAuthenticCadence",
            name="Imperfect Authentic Cadence",
            aliases=["IAC"],
            hierarchy_path=[
                "Cadence",
                "Authentic Cadence",
                "Imperfect Authentic Cadence",
            ],
        )
        mock_service.search.return_value = ConceptSearchResponse(
            items=[
                ConceptSearchItem(**_pac_item()),
                ConceptSearchItem(**iac_item),
            ],
            next_cursor=None,
        )

        resp = await client.get("/api/v1/concepts/search?q=authentic")

        assert resp.status_code == 200
        items = resp.json()["items"]
        assert items[0]["id"] == "PerfectAuthenticCadence"

    @pytest.mark.asyncio
    async def test_service_called_with_correct_params(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """Route passes q, domain, and cursor through to the service unchanged."""
        client, mock_service = concept_client

        await client.get("/api/v1/concepts/search?q=PAC&domain=cadences&cursor=abc123")

        mock_service.search.assert_awaited_once_with(
            q="PAC", domain="cadences", cursor="abc123"
        )

    @pytest.mark.asyncio
    async def test_domain_filter_forwarded(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """``domain=cadences`` is forwarded to the service; no items means empty list."""
        client, mock_service = concept_client

        resp = await client.get("/api/v1/concepts/search?q=cadence&domain=cadences")

        assert resp.status_code == 200
        _, kwargs = mock_service.search.call_args
        assert kwargs["domain"] == "cadences"

    @pytest.mark.asyncio
    async def test_empty_result_returns_empty_items(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A search with no matches returns ``items: []`` and ``next_cursor: null``."""
        from models.concepts import ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[], next_cursor=None
        )

        resp = await client.get("/api/v1/concepts/search?q=xyzzyfoobarbaz")

        assert resp.status_code == 200
        body = resp.json()
        assert body["items"] == []
        assert body["next_cursor"] is None

    @pytest.mark.asyncio
    async def test_missing_q_returns_422(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """``q`` is required; omitting it returns 422."""
        client, _ = concept_client

        resp = await client.get("/api/v1/concepts/search")

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_q_returns_422(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """An empty ``q`` violates the ``min_length=1`` constraint → 422."""
        client, _ = concept_client

        resp = await client.get("/api/v1/concepts/search?q=")

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_response_includes_hierarchy_path(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """The ``hierarchy_path`` field is present in each item."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[ConceptSearchItem(**_pac_item())],
            next_cursor=None,
        )

        resp = await client.get("/api/v1/concepts/search?q=PAC")

        item = resp.json()["items"][0]
        assert item["hierarchy_path"] == [
            "Cadence",
            "Authentic Cadence",
            "Perfect Authentic Cadence",
        ]
        assert item["aliases"] == ["PAC"]


# ---------------------------------------------------------------------------
# TestConceptSearchAuth
# ---------------------------------------------------------------------------


class TestConceptSearchAuth:
    """Authentication and authorisation enforcement."""

    @pytest.mark.asyncio
    async def test_anonymous_returns_401(
        self, anon_concept_client: AsyncClient
    ) -> None:
        """An unauthenticated request returns HTTP 401."""
        resp = await anon_concept_client.get("/api/v1/concepts/search?q=cadence")

        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_editor_role_is_accepted(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """A user with the ``editor`` role can access the endpoint."""
        client, _ = concept_client

        resp = await client.get("/api/v1/concepts/search?q=cadence")

        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# TestConceptSearchCursor
# ---------------------------------------------------------------------------


class TestConceptSearchCursor:
    """Cursor pagination: ``next_cursor`` presence and forwarding."""

    @pytest.mark.asyncio
    async def test_next_cursor_present_when_more_results(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """When the service returns a ``next_cursor`` the route includes it."""
        from models.concepts import ConceptSearchItem, ConceptSearchResponse

        client, mock_service = concept_client
        mock_service.search.return_value = ConceptSearchResponse(
            items=[ConceptSearchItem(**_pac_item())],
            next_cursor="eyJza2lwIjogMjB9",
        )

        resp = await client.get("/api/v1/concepts/search?q=cadence")

        assert resp.json()["next_cursor"] == "eyJza2lwIjogMjB9"

    @pytest.mark.asyncio
    async def test_cursor_forwarded_to_service(
        self, concept_client: tuple[AsyncClient, Any]
    ) -> None:
        """The ``cursor`` query param is forwarded to the service as-is."""
        client, mock_service = concept_client

        await client.get("/api/v1/concepts/search?q=cadence&cursor=eyJza2lwIjogMjB9")

        _, kwargs = mock_service.search.call_args
        assert kwargs["cursor"] == "eyJza2lwIjogMjB9"


# ---------------------------------------------------------------------------
# TestConceptServiceCursor (service-layer unit tests, no HTTP)
# ---------------------------------------------------------------------------


class TestConceptServiceCursor:
    """Cursor encode/decode round-trips (pure unit, no HTTP stack needed)."""

    def test_encode_decode_round_trip(self) -> None:
        """Encoding an offset and decoding it returns the original offset."""
        from services.concepts import _decode_cursor, _encode_cursor

        for skip in (0, 20, 100, 999):
            assert _decode_cursor(_encode_cursor(skip)) == skip

    def test_decode_none_returns_zero(self) -> None:
        """Passing ``None`` as a cursor returns skip=0 (first page)."""
        from services.concepts import _decode_cursor

        assert _decode_cursor(None) == 0

    def test_decode_malformed_cursor_returns_zero(self) -> None:
        """A malformed cursor token silently falls back to skip=0."""
        from services.concepts import _decode_cursor

        assert _decode_cursor("not-valid-base64!!!") == 0
        assert _decode_cursor("e30=") == 0  # valid base64 but missing "skip" key

    def test_negative_skip_clamped_to_zero(self) -> None:
        """A cursor encoding a negative skip is clamped to 0."""
        import base64
        import json

        from services.concepts import _decode_cursor

        bad_cursor = base64.urlsafe_b64encode(
            json.dumps({"skip": -5}).encode()
        ).decode()
        assert _decode_cursor(bad_cursor) == 0
