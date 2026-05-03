"""Route-level unit tests for backend/api/routes/browse.py.

Exercises the four browse endpoints through the full FastAPI stack — middleware,
dependency injection, route handler, response serialisation, and exception
handling — without any running database or object-storage service.

Two fixtures are provided:

- ``browse_client``: authenticated client; ``get_current_user`` is overridden
  to return a dev editor user.  Database and storage dependencies are mocked.
  All service functions are patched per-test via ``monkeypatch``.

- ``anon_browse_client``: same mock stack, but ``get_current_user`` raises
  HTTP 401, simulating a request that carries no ``Authorization`` header.

Test structure
--------------
TestGetComposers        — /composers
TestGetCorpora          — /composers/{slug}/corpora
TestGetWorks            — /composers/{slug}/corpora/{slug}/works
TestGetMovements        — /works/{id}/movements
TestErrorEnvelope       — envelope shape for 401, 404, and DoppiaError payloads
"""

from __future__ import annotations

import uuid
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
# Shared fixtures
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app() -> FastAPI:
    """Build a fresh FastAPI test app wired with the full exception-handler
    stack (including ``doppia_error_handler``) and a no-op lifespan."""
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
    # DoppiaError handler must be registered before the generic Exception handler
    # so that typed domain exceptions produce the correct 404/422 response rather
    # than a catch-all 500.
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


@pytest_asyncio.fixture
async def browse_client() -> AsyncGenerator[tuple[AsyncClient, Any, Any], None]:
    """Authenticated async client for browse route unit tests.

    - ``get_current_user`` is overridden to return a dev editor.
    - ``get_db`` is overridden to yield an ``AsyncMock`` session.
    - ``get_storage`` is overridden to return an ``AsyncMock`` storage client.
    - Service functions must be patched per-test via ``monkeypatch``.

    Yields:
        ``(client, mock_db, mock_storage)`` — the HTTP client and the two
        injected mocks, so tests can inspect calls made to them.
    """
    from api.dependencies import AppUser, get_current_user, get_storage
    from models.base import get_db
    from services.object_storage import StorageClient
    from sqlalchemy.ext.asyncio import AsyncSession

    app = _build_app()
    mock_db = AsyncMock(spec=AsyncSession)
    mock_storage = AsyncMock(spec=StorageClient)
    dev_user = AppUser(id="test-user", role="editor", email="test@test.com")

    async def _get_db() -> AsyncGenerator[AsyncSession, None]:
        yield mock_db  # type: ignore[misc]

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_storage] = lambda: mock_storage
    app.dependency_overrides[get_current_user] = lambda: dev_user

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, mock_db, mock_storage


@pytest_asyncio.fixture
async def anon_browse_client() -> AsyncGenerator[AsyncClient, None]:
    """Anonymous async client that returns HTTP 401 on every authenticated route.

    Identical infrastructure to ``browse_client``, but ``get_current_user`` is
    overridden to raise ``HTTP 401`` rather than returning a user.  Used to
    verify that browse endpoints correctly enforce authentication.

    Yields:
        An ``httpx.AsyncClient`` pointed at ``http://test``.
    """
    from api.dependencies import get_current_user, get_storage
    from models.base import get_db
    from services.object_storage import StorageClient
    from sqlalchemy.ext.asyncio import AsyncSession

    app = _build_app()
    mock_db = AsyncMock(spec=AsyncSession)
    mock_storage = AsyncMock(spec=StorageClient)

    async def _get_db() -> AsyncGenerator[AsyncSession, None]:
        yield mock_db  # type: ignore[misc]

    def _raise_401() -> None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_storage] = lambda: mock_storage
    app.dependency_overrides[get_current_user] = _raise_401

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Helpers — build Pydantic response objects for patching return values
# ---------------------------------------------------------------------------


def _composer_response(**kwargs: Any) -> Any:
    from models.browse import ComposerResponse

    return ComposerResponse(
        id=kwargs.get("id", uuid.uuid4()),
        slug=kwargs.get("slug", "mozart"),
        name=kwargs.get("name", "Wolfgang Amadeus Mozart"),
        sort_name=kwargs.get("sort_name", "Mozart, Wolfgang Amadeus"),
        birth_year=kwargs.get("birth_year", 1756),
        death_year=kwargs.get("death_year", 1791),
    )


def _corpus_response(**kwargs: Any) -> Any:
    from models.browse import CorpusResponse

    return CorpusResponse(
        id=kwargs.get("id", uuid.uuid4()),
        slug=kwargs.get("slug", "piano-sonatas"),
        title=kwargs.get("title", "Piano Sonatas"),
        source_repository=kwargs.get(
            "source_repository", "DCMLab/mozart_piano_sonatas"
        ),
        licence=kwargs.get("licence", "CC-BY-SA-4.0"),
        work_count=kwargs.get("work_count", 3),
    )


def _work_response(**kwargs: Any) -> Any:
    from models.browse import WorkResponse

    return WorkResponse(
        id=kwargs.get("id", uuid.uuid4()),
        slug=kwargs.get("slug", "k331"),
        title=kwargs.get("title", "Piano Sonata No. 11"),
        catalogue_number=kwargs.get("catalogue_number", "K. 331"),
        year_composed=kwargs.get("year_composed", 1783),
        movement_count=kwargs.get("movement_count", 3),
    )


def _movement_response(**kwargs: Any) -> Any:
    from models.browse import MovementResponse

    return MovementResponse(
        id=kwargs.get("id", uuid.uuid4()),
        slug=kwargs.get("slug", "movement-1"),
        movement_number=kwargs.get("movement_number", 1),
        title=kwargs.get("title", "Tema con Variazioni"),
        tempo_marking=kwargs.get("tempo_marking", "Andante grazioso"),
        key_signature=kwargs.get("key_signature", "A major"),
        meter=kwargs.get("meter", "6/8"),
        duration_bars=kwargs.get("duration_bars", 96),
        incipit_url=kwargs.get("incipit_url", None),
        incipit_ready=kwargs.get("incipit_ready", False),
    )


# ---------------------------------------------------------------------------
# TestGetComposers — GET /api/v1/composers
# ---------------------------------------------------------------------------


class TestGetComposers:
    """Route-level tests for GET /api/v1/composers."""

    async def test_empty_list_returns_200(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Empty composer list returns HTTP 200 and an empty JSON array."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_composers", AsyncMock(return_value=[])
        )
        resp = await client.get("/api/v1/composers")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_returns_serialised_composer(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A single composer is serialised with all required fields."""
        client, _, _ = browse_client
        composer = _composer_response()
        monkeypatch.setattr(
            "api.routes.browse.list_composers", AsyncMock(return_value=[composer])
        )
        resp = await client.get("/api/v1/composers")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        item = data[0]
        assert item["slug"] == "mozart"
        assert item["name"] == "Wolfgang Amadeus Mozart"
        assert item["birth_year"] == 1756
        assert item["death_year"] == 1791
        assert "id" in item

    async def test_unauthenticated_returns_401(
        self,
        anon_browse_client: AsyncClient,
    ) -> None:
        """Requests without authentication are rejected with HTTP 401."""
        resp = await anon_browse_client.get("/api/v1/composers")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# TestGetCorpora — GET /api/v1/composers/{slug}/corpora
# ---------------------------------------------------------------------------


class TestGetCorpora:
    """Route-level tests for GET /api/v1/composers/{slug}/corpora."""

    async def test_returns_serialised_corpus(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A known composer returns its corpora list with all required fields."""
        client, _, _ = browse_client
        corpus = _corpus_response()
        monkeypatch.setattr(
            "api.routes.browse.list_corpora", AsyncMock(return_value=[corpus])
        )
        resp = await client.get("/api/v1/composers/mozart/corpora")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["slug"] == "piano-sonatas"
        assert data[0]["work_count"] == 3
        assert data[0]["licence"] == "CC-BY-SA-4.0"

    async def test_empty_corpus_list_returns_200(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A composer with no corpora returns HTTP 200 and an empty array."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_corpora", AsyncMock(return_value=[])
        )
        resp = await client.get("/api/v1/composers/mozart/corpora")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_unknown_composer_returns_404(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Service returning None produces HTTP 404 with COMPOSER_NOT_FOUND code."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_corpora", AsyncMock(return_value=None)
        )
        resp = await client.get("/api/v1/composers/nonexistent/corpora")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "COMPOSER_NOT_FOUND"
        assert "not found" in body["error"]["message"].lower()


# ---------------------------------------------------------------------------
# TestGetWorks — GET /api/v1/composers/{slug}/corpora/{slug}/works
# ---------------------------------------------------------------------------


class TestGetWorks:
    """Route-level tests for GET /api/v1/composers/{slug}/corpora/{slug}/works."""

    async def test_returns_serialised_work(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A known corpus returns its works list with all required fields."""
        client, _, _ = browse_client
        work = _work_response()
        monkeypatch.setattr(
            "api.routes.browse.list_works", AsyncMock(return_value=[work])
        )
        resp = await client.get("/api/v1/composers/mozart/corpora/piano-sonatas/works")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["slug"] == "k331"
        assert data[0]["catalogue_number"] == "K. 331"
        assert data[0]["movement_count"] == 3

    async def test_unknown_corpus_returns_404(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Service returning None produces HTTP 404 with CORPUS_NOT_FOUND code."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_works", AsyncMock(return_value=None)
        )
        resp = await client.get("/api/v1/composers/mozart/corpora/nonexistent/works")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "CORPUS_NOT_FOUND"
        assert "not found" in body["error"]["message"].lower()


# ---------------------------------------------------------------------------
# TestGetMovements — GET /api/v1/works/{id}/movements
# ---------------------------------------------------------------------------


class TestGetMovements:
    """Route-level tests for GET /api/v1/works/{id}/movements."""

    async def test_returns_serialised_movements(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Known work returns its movements list with all required fields."""
        client, _, _ = browse_client
        m1 = _movement_response(movement_number=1)
        m2 = _movement_response(slug="movement-2", movement_number=2, title="Menuetto")
        monkeypatch.setattr(
            "api.routes.browse.list_movements", AsyncMock(return_value=[m1, m2])
        )
        work_id = uuid.uuid4()
        resp = await client.get(f"/api/v1/works/{work_id}/movements")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["movement_number"] == 1
        assert data[1]["slug"] == "movement-2"

    async def test_movement_has_all_required_fields(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Every movement item in the response contains all required schema fields."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_movements",
            AsyncMock(return_value=[_movement_response()]),
        )
        resp = await client.get(f"/api/v1/works/{uuid.uuid4()}/movements")
        assert resp.status_code == 200
        m = resp.json()[0]
        for field in (
            "id",
            "slug",
            "movement_number",
            "title",
            "tempo_marking",
            "key_signature",
            "meter",
            "duration_bars",
            "incipit_url",
            "incipit_ready",
        ):
            assert field in m, f"Missing field: {field}"

    async def test_incipit_ready_false_when_null(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Movements with no incipit set ``incipit_ready=false`` and ``incipit_url=null``."""
        client, _, _ = browse_client
        movement = _movement_response(incipit_url=None, incipit_ready=False)
        monkeypatch.setattr(
            "api.routes.browse.list_movements", AsyncMock(return_value=[movement])
        )
        resp = await client.get(f"/api/v1/works/{uuid.uuid4()}/movements")
        assert resp.status_code == 200
        m = resp.json()[0]
        assert m["incipit_ready"] is False
        assert m["incipit_url"] is None

    async def test_unknown_work_returns_404(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Service returning None produces HTTP 404 with WORK_NOT_FOUND code."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_movements", AsyncMock(return_value=None)
        )
        resp = await client.get(f"/api/v1/works/{uuid.uuid4()}/movements")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["code"] == "WORK_NOT_FOUND"
        assert "not found" in body["error"]["message"].lower()

    async def test_invalid_work_id_returns_422(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
    ) -> None:
        """A non-UUID ``work_id`` path parameter is rejected with HTTP 422."""
        client, _, _ = browse_client
        resp = await client.get("/api/v1/works/not-a-uuid/movements")
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# TestErrorEnvelope — contract tests for the ``{"error": {...}}`` shape
# ---------------------------------------------------------------------------


class TestErrorEnvelope:
    """Verify that every error path returns the standard envelope.

    The frontend depends on ``{"error": {"code": ..., "message": ...}}`` — this
    class pins the contract so a middleware regression is immediately visible.
    """

    async def test_404_envelope_has_code_message_detail(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A DoppiaError 404 response uses the full three-key error envelope."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_corpora", AsyncMock(return_value=None)
        )
        resp = await client.get("/api/v1/composers/x/corpora")
        assert resp.status_code == 404
        body = resp.json()
        assert set(body.keys()) == {"error"}
        assert set(body["error"].keys()) >= {"code", "message", "detail"}
        assert body["error"]["code"] == "COMPOSER_NOT_FOUND"
        assert isinstance(body["error"]["message"], str)
        assert len(body["error"]["message"]) > 0

    async def test_401_envelope_has_code_and_message(
        self,
        anon_browse_client: AsyncClient,
    ) -> None:
        """An unauthenticated request returns the standard error envelope with a code."""
        resp = await anon_browse_client.get("/api/v1/composers")
        assert resp.status_code == 401
        body = resp.json()
        assert "error" in body
        assert "code" in body["error"]
        assert "message" in body["error"]
        assert body["error"]["code"] == "UNAUTHORIZED"

    async def test_422_validation_error_envelope(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
    ) -> None:
        """An invalid path parameter returns a 422 VALIDATION_ERROR envelope."""
        client, _, _ = browse_client
        resp = await client.get("/api/v1/works/not-a-uuid/movements")
        assert resp.status_code == 422
        body = resp.json()
        assert "error" in body
        assert body["error"]["code"] == "VALIDATION_ERROR"
        assert isinstance(body["error"]["message"], str)

    async def test_work_404_detail_contains_work_id(
        self,
        browse_client: tuple[AsyncClient, Any, Any],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """WORK_NOT_FOUND detail includes the requested work_id."""
        client, _, _ = browse_client
        monkeypatch.setattr(
            "api.routes.browse.list_movements", AsyncMock(return_value=None)
        )
        work_id = uuid.uuid4()
        resp = await client.get(f"/api/v1/works/{work_id}/movements")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error"]["detail"]["work_id"] == str(work_id)
