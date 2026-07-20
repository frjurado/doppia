"""Route-level unit tests for backend/api/routes/public.py (Component 10 Step 3).

Exercises the anonymous public read path through the full FastAPI stack —
middleware, dependency injection, route handler, response serialisation, and
exception handling — with the fragment service mocked.

Verification cases from the Component 10 plan (Step 3):
    1. An unauthenticated request to public browse succeeds and the service is
       called with the status hard-pinned to ``approved``.
    2. A spoofed ``?status=`` query on the public route has no effect.
    3. Public detail of an approved fragment succeeds.
    4. Public detail of a non-``approved`` fragment returns the same 404 as a
       nonexistent id (no existence/status leak).
    5. The editor routes are unchanged: still 401 without authentication.
    6. The public prefix takes the wildcard no-credentials CORS policy; the
       editor prefix keeps the credentialed allowlist — and the two postures
       never combine on one response.

Test structure
--------------
TestPublicBrowse       — /api/v1/public/fragments
TestPublicDetail       — /api/v1/public/fragments/{id}
TestEditorUnchanged    — editor routes still require auth
TestPathScopedCORS     — per-prefix CORS dispatch
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
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
    """Build a fresh test app with the production middleware topology:
    exception handlers, ``AuthMiddleware``, and ``PathScopedCORSMiddleware``
    (the same class ``main.create_app`` registers)."""
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
async def public_client() -> AsyncGenerator[tuple[AsyncClient, AsyncMock], None]:
    """Anonymous async client with the fragment service mocked.

    No ``get_current_user`` override — requests carry no ``Authorization``
    header, exactly like a real anonymous caller, so ``AuthMiddleware`` sets
    ``request.state.user = None`` and the editor routes 401 while the public
    routes serve.

    Yields:
        ``(client, mock_service)`` — the HTTP client and the mocked
        :class:`~services.fragments.FragmentService`.
    """
    from api.routes.fragments import get_fragment_service
    from models.base import get_db
    from services.fragments import FragmentService
    from sqlalchemy.ext.asyncio import AsyncSession

    app = _build_app()
    mock_service = AsyncMock(spec=FragmentService)
    mock_db = AsyncMock(spec=AsyncSession)

    async def _get_db() -> AsyncGenerator[AsyncSession, None]:
        yield mock_db  # type: ignore[misc]

    app.dependency_overrides[get_fragment_service] = lambda: mock_service
    app.dependency_overrides[get_db] = _get_db

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, mock_service


# ---------------------------------------------------------------------------
# Response-model factories
# ---------------------------------------------------------------------------


def _browse_response(**overrides: Any) -> Any:
    from models.fragment import ConceptBrowseResponse

    base: dict[str, Any] = {
        "items": [],
        "next_cursor": None,
        "concept_id": "AuthenticCadence",
        "include_subtypes": True,
    }
    base.update(overrides)
    return ConceptBrowseResponse(**base)


def _detail_response(status: str = "approved", **overrides: Any) -> Any:
    from models.fragment import FragmentDetailResponse

    now = datetime(2026, 7, 20, 12, 0, 0, tzinfo=timezone.utc)
    base: dict[str, Any] = {
        "id": uuid.uuid4(),
        "movement_id": uuid.uuid4(),
        "parent_fragment_id": None,
        "bar_start": 1,
        "bar_end": 4,
        "mc_start": 1,
        "mc_end": 4,
        "beat_start": None,
        "beat_end": None,
        "repeat_context": None,
        "summary": {"version": 1},
        "prose_annotation": None,
        "data_licence": "CC BY-SA 4.0",
        "data_licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "harmony_sources": ["DCML"],
        "status": status,
        "created_by": uuid.uuid4(),
        "created_at": now,
        "updated_at": now,
        "concept_tags": [],
        "harmony_events": [],
        "sub_parts": [],
    }
    base.update(overrides)
    return FragmentDetailResponse(**base)


# ---------------------------------------------------------------------------
# Public browse
# ---------------------------------------------------------------------------


class TestPublicBrowse:
    """GET /api/v1/public/fragments — anonymous concept-scoped browse."""

    @pytest.mark.asyncio
    async def test_anonymous_browse_succeeds_with_status_pinned(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = public_client
        service.list_by_concept.return_value = _browse_response()

        resp = await client.get(
            "/api/v1/public/fragments", params={"concept_id": "AuthenticCadence"}
        )

        assert resp.status_code == 200
        assert resp.json()["concept_id"] == "AuthenticCadence"
        service.list_by_concept.assert_awaited_once_with(
            concept_id="AuthenticCadence",
            include_subtypes=True,
            status_filter="approved",
            caller_id=None,
            caller_role="anonymous",
            cursor=None,
            page_size=50,
        )

    @pytest.mark.asyncio
    async def test_spoofed_status_query_has_no_effect(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        """The public route has no ``status`` parameter — a spoofed value is
        ignored and the service is still called with ``approved``."""
        client, service = public_client
        service.list_by_concept.return_value = _browse_response()

        resp = await client.get(
            "/api/v1/public/fragments",
            params={"concept_id": "AuthenticCadence", "status": "draft"},
        )

        assert resp.status_code == 200
        assert service.list_by_concept.await_args.kwargs["status_filter"] == "approved"

    @pytest.mark.asyncio
    async def test_pagination_params_pass_through(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = public_client
        service.list_by_concept.return_value = _browse_response(
            include_subtypes=False, next_cursor="abc"
        )

        resp = await client.get(
            "/api/v1/public/fragments",
            params={
                "concept_id": "AuthenticCadence",
                "include_subtypes": "false",
                "cursor": "opaque-cursor",
                "page_size": 10,
            },
        )

        assert resp.status_code == 200
        assert resp.json()["next_cursor"] == "abc"
        kwargs = service.list_by_concept.await_args.kwargs
        assert kwargs["include_subtypes"] is False
        assert kwargs["cursor"] == "opaque-cursor"
        assert kwargs["page_size"] == 10

    @pytest.mark.asyncio
    async def test_missing_concept_id_is_422(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, _ = public_client
        resp = await client.get("/api/v1/public/fragments")
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Public detail
# ---------------------------------------------------------------------------


class TestPublicDetail:
    """GET /api/v1/public/fragments/{id} — anonymous fragment detail."""

    @pytest.mark.asyncio
    async def test_approved_fragment_is_served(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = public_client
        detail = _detail_response(status="approved")
        service.get.return_value = detail

        resp = await client.get(f"/api/v1/public/fragments/{detail.id}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(detail.id)
        assert body["status"] == "approved"
        assert body["data_licence"] == "CC BY-SA 4.0"
        service.get.assert_awaited_once_with(
            detail.id, caller_id=None, caller_role="anonymous"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["submitted", "rejected"])
    async def test_non_approved_fragment_is_404(
        self, public_client: tuple[AsyncClient, AsyncMock], status: str
    ) -> None:
        client, service = public_client
        detail = _detail_response(status=status)
        service.get.return_value = detail

        resp = await client.get(f"/api/v1/public/fragments/{detail.id}")

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "FRAGMENT_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_non_approved_404_matches_nonexistent_404(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        """The 404 for an existing non-approved fragment must be byte-identical
        to the 404 for a nonexistent id — no existence leak."""
        from errors import FragmentNotFoundError

        client, service = public_client
        frag_id = uuid.uuid4()

        service.get.return_value = _detail_response(status="submitted", id=frag_id)
        resp_hidden = await client.get(f"/api/v1/public/fragments/{frag_id}")

        service.get.side_effect = FragmentNotFoundError(
            f"No fragment with id '{frag_id}' exists.",
            detail={"fragment_id": str(frag_id)},
        )
        resp_missing = await client.get(f"/api/v1/public/fragments/{frag_id}")

        assert resp_hidden.status_code == resp_missing.status_code == 404
        assert resp_hidden.json() == resp_missing.json()


# ---------------------------------------------------------------------------
# Editor routes unchanged
# ---------------------------------------------------------------------------


class TestEditorUnchanged:
    """The editor read routes still require authentication."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "path",
        [
            "/api/v1/fragments?concept_id=AuthenticCadence",
            f"/api/v1/fragments/{uuid.uuid4()}",
            "/api/v1/composers",
        ],
    )
    async def test_editor_route_is_401_without_token(
        self, public_client: tuple[AsyncClient, AsyncMock], path: str
    ) -> None:
        client, _ = public_client
        resp = await client.get(path)
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Path-scoped CORS
# ---------------------------------------------------------------------------


class TestPathScopedCORS:
    """Per-prefix CORS dispatch: wildcard/no-credentials on /api/v1/public/,
    credentialed allowlist everywhere else."""

    @pytest.mark.asyncio
    async def test_public_preflight_allows_any_origin(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, _ = public_client
        resp = await client.options(
            "/api/v1/public/fragments",
            headers={
                "Origin": "https://third-party.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert resp.headers["access-control-allow-origin"] == "*"
        assert "access-control-allow-credentials" not in resp.headers

    @pytest.mark.asyncio
    async def test_public_response_carries_wildcard_origin(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, service = public_client
        service.list_by_concept.return_value = _browse_response()
        resp = await client.get(
            "/api/v1/public/fragments",
            params={"concept_id": "AuthenticCadence"},
            headers={"Origin": "https://third-party.example"},
        )
        assert resp.status_code == 200
        assert resp.headers["access-control-allow-origin"] == "*"
        assert "access-control-allow-credentials" not in resp.headers

    @pytest.mark.asyncio
    async def test_editor_preflight_rejects_unknown_origin(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, _ = public_client
        resp = await client.options(
            "/api/v1/fragments",
            headers={
                "Origin": "https://third-party.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        # Starlette's CORSMiddleware answers a disallowed preflight with 400
        # and no allow-origin header.
        assert resp.status_code == 400
        assert "access-control-allow-origin" not in resp.headers

    @pytest.mark.asyncio
    async def test_editor_preflight_allows_allowlisted_origin_with_credentials(
        self, public_client: tuple[AsyncClient, AsyncMock]
    ) -> None:
        client, _ = public_client
        resp = await client.options(
            "/api/v1/fragments",
            headers={
                "Origin": _EDITOR_ORIGIN,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            },
        )
        assert resp.status_code == 200
        assert resp.headers["access-control-allow-origin"] == _EDITOR_ORIGIN
        assert resp.headers["access-control-allow-credentials"] == "true"
