"""Pytest configuration and shared fixtures.

Fixtures are split into two tiers:

- **Unit fixtures** (``test_client``): rebuild the FastAPI app with a no-op
  lifespan so they run without any external services.  These are used by
  ``tests/unit/`` and must pass even when Docker is not running.

- **Integration fixtures** (``db_session``, ``neo4j_session``,
  ``minio_bucket``): connect to the live Docker services.  They are used by
  ``tests/integration/`` and require ``docker compose up`` to be running
  beforehand.

All fixtures follow the pattern: set up → yield → tear down.
Do not assume a clean database between tests; do not leave test data behind.

asyncio marker convention
--------------------------
``pyproject.toml`` sets ``asyncio_mode = "auto"``, which means every
``async def test_*`` is automatically treated as an asyncio test.  Do **not**
add ``@pytest.mark.asyncio`` to unit tests — it is redundant and adds noise.

Integration test *classes* that share a session-scoped fixture (the
SQLAlchemy engine / connection pool) must declare::

    @pytest.mark.asyncio(loop_scope="session")
    class TestFoo:
        ...

This ensures the class's tests all run on the same event loop as the
session-scoped engine, avoiding "attached to a different loop" errors.
Do not mix ``loop_scope`` values within a single class.
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

import aioboto3
import pytest
import pytest_asyncio
from dotenv import load_dotenv

# Load .env from the project root so that DATABASE_URL and other required
# variables are always available when pytest is invoked.  If no .env file
# exists (e.g. in CI, where env vars are injected directly) this is a no-op.
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from neo4j import AsyncDriver, AsyncGraphDatabase
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from starlette.exceptions import HTTPException

# ---------------------------------------------------------------------------
# Integration-marker skip hook
# ---------------------------------------------------------------------------


def pytest_collection_modifyitems(
    config: pytest.Config,
    items: list[pytest.Item],
) -> None:
    """Skip integration tests unless DOPPIA_RUN_INTEGRATION is set.

    Integration tests are marked with ``@pytest.mark.integration`` (or via
    ``pytestmark = pytest.mark.integration`` at module level).  On a fresh
    checkout without Docker running, a contributor can do ``pytest`` and get
    only the fast unit tests.  Set ``DOPPIA_RUN_INTEGRATION=1`` (or any
    non-empty value) to include integration tests.
    """
    if os.environ.get("DOPPIA_RUN_INTEGRATION"):
        return
    skip = pytest.mark.skip(
        reason="Docker not running — set DOPPIA_RUN_INTEGRATION=1 to run integration tests"
    )
    for item in items:
        if item.get_closest_marker("integration"):
            item.add_marker(skip)


# ---------------------------------------------------------------------------
# Unit fixtures — no Docker required
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """No-op lifespan that skips all DB connection setup.

    Used in the ``test_client`` fixture so unit tests can run without a
    running PostgreSQL or Neo4j instance.
    """
    yield


@pytest_asyncio.fixture
async def test_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client wired to a unit-test FastAPI app.

    The app is rebuilt with a no-op lifespan and the dev auth bypass
    (``ENVIRONMENT=local``, ``AUTH_MODE=local``) so that:

    - No real database connections are opened.
    - Auth middleware accepts requests with the ``dev-token`` bearer token
      or passes unauthenticated requests through.

    Yields:
        An ``httpx.AsyncClient`` pointed at ``http://test``.
    """
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setenv("AUTH_MODE", "local")

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


# ---------------------------------------------------------------------------
# Integration fixtures — require ``docker compose up``
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="session")
async def _db_engine() -> AsyncGenerator[AsyncEngine, None]:
    """Session-scoped async SQLAlchemy engine.

    A single engine (and its connection pool) is shared across all tests that
    use ``db_session``. This avoids asyncpg connection-cleanup races that arise
    when a per-test engine is disposed while the event loop is still running
    other tests in the same session.

    Yields:
        The ``AsyncEngine`` instance.
    """
    database_url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:localpassword@localhost/doppia",
    )
    engine = create_async_engine(database_url, echo=False, pool_pre_ping=True)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(_db_engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """Async SQLAlchemy session connected to the local test PostgreSQL instance.

    Reads ``DATABASE_URL`` from the environment (defaults to the local Docker
    URL from ``.env.example``).  Each test gets a fresh session backed by the
    session-scoped engine so the connection pool is not recreated between tests.

    Yields:
        An ``AsyncSession`` bound to the test database engine.
    """
    factory = async_sessionmaker(
        _db_engine, class_=AsyncSession, expire_on_commit=False
    )

    async with factory() as session:
        yield session


@pytest_asyncio.fixture
async def neo4j_session() -> AsyncGenerator[AsyncDriver, None]:
    """Async Neo4j driver connected to the local Docker Neo4j instance.

    Reads ``NEO4J_URI``, ``NEO4J_USER``, and ``NEO4J_PASSWORD`` from the
    environment (defaults match ``.env.example``).

    Yields:
        A verified ``AsyncDriver`` instance.  The caller is responsible for
        opening sessions via ``driver.session()``.
    """
    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    driver: AsyncDriver = AsyncGraphDatabase.driver(uri, auth=(user, password))
    await driver.verify_connectivity()

    yield driver

    await driver.close()


@pytest_asyncio.fixture
async def minio_bucket() -> AsyncGenerator[object, None]:
    """aioboto3 S3 resource pointed at the local MinIO instance.

    Reads ``R2_ENDPOINT_URL``, ``R2_ACCESS_KEY_ID``, ``R2_SECRET_ACCESS_KEY``,
    and ``R2_BUCKET_NAME`` from the environment (defaults match ``.env.example``).

    Yields:
        An aioboto3 ``S3.Bucket`` resource for the configured bucket name.
    """
    endpoint_url = os.environ.get("R2_ENDPOINT_URL", "http://localhost:9000")
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "minioadmin")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "minioadmin")
    bucket_name = os.environ.get("R2_BUCKET_NAME", "doppia-local")

    session = aioboto3.Session()
    async with session.resource(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="us-east-1",
    ) as s3:
        bucket = await s3.Bucket(bucket_name)
        yield bucket
