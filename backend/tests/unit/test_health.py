"""Tests for the health check endpoints.

``/health`` — smoke test that the harness is wired and the liveness probe
returns 200. ``/health/deep`` — per-store status with mocked PostgreSQL and
Neo4j dependencies. No external services (Docker, databases) are required.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

from api.dependencies import get_neo4j
from api.routes.health import router as health_router
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from models.base import get_db


async def test_health_returns_ok(test_client: AsyncClient) -> None:
    """GET /api/v1/health returns 200 with body {"status": "ok"}.

    Args:
        test_client: Unit-test async HTTP client (no Docker required).
    """
    response = await test_client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# /health/deep
# ---------------------------------------------------------------------------


def _mock_driver(run_side_effect: object = None) -> MagicMock:
    """Return a mock Neo4j driver whose session().run() behaves as given."""
    session = AsyncMock()
    session.run = AsyncMock(side_effect=run_side_effect)

    @asynccontextmanager
    async def _session() -> AsyncGenerator[AsyncMock, None]:
        yield session

    driver = MagicMock()
    driver.session = _session
    return driver


def _build_deep_health_client(db: AsyncMock, driver: MagicMock) -> AsyncClient:
    """Build a minimal app with the health router and overridden stores."""
    app = FastAPI()
    app.include_router(health_router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_neo4j] = lambda: driver
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_deep_health_ok_when_both_stores_respond() -> None:
    db = AsyncMock()
    driver = _mock_driver()

    async with _build_deep_health_client(db, driver) as client:
        response = await client.get("/api/v1/health/deep")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "postgres": "ok", "neo4j": "ok"}
    db.execute.assert_awaited_once()


async def test_deep_health_503_when_postgres_fails() -> None:
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=ConnectionError("supabase paused"))
    driver = _mock_driver()

    async with _build_deep_health_client(db, driver) as client:
        response = await client.get("/api/v1/health/deep")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["postgres"] == "error"
    assert body["neo4j"] == "ok"


async def test_deep_health_503_when_neo4j_fails() -> None:
    db = AsyncMock()
    driver = _mock_driver(run_side_effect=ConnectionError("aura paused"))

    async with _build_deep_health_client(db, driver) as client:
        response = await client.get("/api/v1/health/deep")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["postgres"] == "ok"
    assert body["neo4j"] == "error"
