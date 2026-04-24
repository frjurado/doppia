"""Integration-test fixtures requiring Docker services.

Provides ``integration_test_client`` — an async HTTP client backed by a real
FastAPI app whose lifespan calls ``init_db()``.  This is distinct from the
root ``test_client`` fixture, which uses a no-op lifespan and therefore cannot
exercise endpoints that call ``get_db()``.

All integration tests in this directory require ``docker compose up`` (PostgreSQL,
MinIO, Redis) to be running before the test session starts.
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """No-op lifespan for the integration test app.

    ``init_db()`` is called directly in ``integration_test_client`` before
    the AsyncClient is created, because ``ASGITransport`` does not trigger
    ASGI lifespan events.
    """
    yield


@pytest_asyncio.fixture
async def integration_test_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client wired to a real FastAPI app with DB + storage.

    Sets ``ENVIRONMENT=local`` and ``AUTH_MODE=local`` so that requests with
    ``Authorization: Bearer dev-token`` are accepted as the built-in admin user.
    MinIO environment variables are set to the local Docker defaults if not
    already present in the environment.

    The app is rebuilt with ``_integration_lifespan`` so ``get_db()`` works.
    Unlike the root ``test_client`` fixture this client can exercise any
    endpoint that reads or writes PostgreSQL.

    Requires ``docker compose up`` (PostgreSQL + MinIO) before the test session.

    Yields:
        An ``httpx.AsyncClient`` pointed at ``http://test``.
    """
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")

    # DB + MinIO env vars — fall back to Docker Compose defaults if not set.
    for key, default in (
        # DATABASE_URL is read directly (no default) by _get_session_factory()
        # in the Celery task, so we must ensure it is present.
        (
            "DATABASE_URL",
            "postgresql+asyncpg://postgres:localpassword@localhost/doppia",
        ),
        ("R2_ENDPOINT_URL", "http://localhost:9000"),
        ("R2_BUCKET_NAME", "doppia-local"),
        ("R2_ACCESS_KEY_ID", "minioadmin"),
        ("R2_SECRET_ACCESS_KEY", "minioadmin"),
    ):
        if not os.environ.get(key):
            monkeypatch.setenv(key, default)

    # ASGITransport does not trigger ASGI lifespan events, so we initialise
    # the database directly here rather than relying on lifespan startup.
    # We do NOT call close_db() between tests because disposing the asyncpg
    # engine after a test's event loop scope ends causes ProactorEventLoop
    # errors on Windows — instead, init_db() on the next test overwrites the
    # module-level singleton with a fresh engine.
    from models.base import init_db

    database_url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:localpassword@localhost/doppia",
    )
    init_db(database_url)

    from api.middleware.auth import AuthMiddleware
    from api.middleware.errors import (
        http_exception_handler,
        unhandled_exception_handler,
        validation_exception_handler,
    )
    from api.router import router as api_router

    app = FastAPI(lifespan=_noop_lifespan)
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

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client
