"""Route-level unit tests for backend/api/routes/admin.py.

Exercises POST /api/v1/admin/dispatch-pending-analysis through the full
FastAPI stack with mocked DB and Celery.  No running database or broker
is required.

Test structure
--------------
TestDispatchPendingAnalysis — success path, empty path, dispatch failure,
                              role enforcement
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

# ---------------------------------------------------------------------------
# App builder (identical pattern to test_browse_routes.py)
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app() -> FastAPI:
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
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(api_router)
    return app


def _make_admin_client(
    app: FastAPI,
    mock_db: AsyncMock,
    role: str = "admin",
) -> AsyncClient:
    from api.dependencies import AppUser, get_current_user, get_storage
    from models.base import get_db
    from services.object_storage import StorageClient

    dev_user = AppUser(id="admin-user", role=role, email="admin@test.com")

    async def _get_db() -> AsyncGenerator[Any, None]:
        yield mock_db  # type: ignore[misc]

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_storage] = lambda: AsyncMock(spec=StorageClient)
    app.dependency_overrides[get_current_user] = lambda: dev_user

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ENDPOINT = "/api/v1/admin/dispatch-pending-analysis"


def _make_row(movement_id: uuid.UUID, analysis_source: str = "DCML") -> MagicMock:
    """Return a mock DB row for a pending-analysis movement."""
    row = MagicMock()
    row.id = movement_id
    row.analysis_source = analysis_source
    return row


# ---------------------------------------------------------------------------
# Autouse: pin celery dispatch mode
# ---------------------------------------------------------------------------
# The route dispatches via services.task_dispatch (ADR-034). These tests
# assert on the patched task objects' .delay() calls, which is the celery-mode
# path; inline mode (the default) is covered by test_task_dispatch.py.


@pytest.fixture(autouse=True)
def _celery_dispatch_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TASK_EXECUTION_MODE", "celery")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestDispatchPendingAnalysis:
    async def test_dispatches_one_task_per_pending_movement(self) -> None:
        """Three pending movements → three ingest_movement_analysis.delay() calls."""
        ids = [uuid.uuid4() for _ in range(3)]
        rows = [_make_row(i) for i in ids]

        mock_db = AsyncMock()
        result = MagicMock()
        result.fetchall.return_value = rows
        mock_db.execute = AsyncMock(return_value=result)

        app = _build_app()
        mock_delay = MagicMock()

        async with _make_admin_client(app, mock_db) as client:
            with patch("api.routes.admin.ingest_movement_analysis") as mock_task:
                mock_task.delay = mock_delay
                resp = await client.post(_ENDPOINT)

        assert resp.status_code == 200
        body = resp.json()
        assert body["dispatched"] == 3
        assert body["failed_to_dispatch"] == []
        assert mock_delay.call_count == 3

    async def test_returns_empty_report_when_no_pending_movements(self) -> None:
        """No pending movements → dispatched=0, failed_to_dispatch=[]."""
        mock_db = AsyncMock()
        result = MagicMock()
        result.fetchall.return_value = []
        mock_db.execute = AsyncMock(return_value=result)

        app = _build_app()

        async with _make_admin_client(app, mock_db) as client:
            with patch("api.routes.admin.ingest_movement_analysis") as mock_task:
                mock_task.delay = MagicMock()
                resp = await client.post(_ENDPOINT)

        assert resp.status_code == 200
        body = resp.json()
        assert body["dispatched"] == 0
        assert body["failed_to_dispatch"] == []

    async def test_failed_dispatch_recorded_in_report(self) -> None:
        """A Celery broker error for one movement lands in failed_to_dispatch."""
        good_id = uuid.uuid4()
        bad_id = uuid.uuid4()
        rows = [_make_row(good_id), _make_row(bad_id)]

        mock_db = AsyncMock()
        result = MagicMock()
        result.fetchall.return_value = rows
        mock_db.execute = AsyncMock(return_value=result)

        dispatched_ids: list[str] = []

        def _delay_side_effect(**kwargs: Any) -> None:
            mid = kwargs["movement_id"]
            if mid == str(bad_id):
                raise ConnectionError("broker unreachable")
            dispatched_ids.append(mid)

        app = _build_app()

        async with _make_admin_client(app, mock_db) as client:
            with patch("api.routes.admin.ingest_movement_analysis") as mock_task:
                mock_task.delay = MagicMock(side_effect=_delay_side_effect)
                resp = await client.post(_ENDPOINT)

        assert resp.status_code == 200
        body = resp.json()
        assert body["dispatched"] == 1
        assert body["failed_to_dispatch"] == [str(bad_id)]

    async def test_editor_role_returns_403(self) -> None:
        """An editor-role caller must receive HTTP 403 Forbidden."""
        mock_db = AsyncMock()
        app = _build_app()

        async with _make_admin_client(app, mock_db, role="editor") as client:
            resp = await client.post(_ENDPOINT)

        assert resp.status_code == 403

    async def test_dispatch_passes_movement_id_and_analysis_source(self) -> None:
        """delay() is called with the movement's id and analysis_source."""
        mov_id = uuid.uuid4()
        rows = [_make_row(mov_id, analysis_source="none")]

        mock_db = AsyncMock()
        result = MagicMock()
        result.fetchall.return_value = rows
        mock_db.execute = AsyncMock(return_value=result)

        captured: list[dict[str, Any]] = []

        def _capture(**kwargs: Any) -> None:
            captured.append(kwargs)

        app = _build_app()

        async with _make_admin_client(app, mock_db) as client:
            with patch("api.routes.admin.ingest_movement_analysis") as mock_task:
                mock_task.delay = MagicMock(side_effect=_capture)
                await client.post(_ENDPOINT)

        assert len(captured) == 1
        assert captured[0]["movement_id"] == str(mov_id)
        assert captured[0]["analysis_source"] == "none"
        assert captured[0]["harmonies_tsv_content"] is None
