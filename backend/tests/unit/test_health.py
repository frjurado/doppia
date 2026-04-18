"""Smoke test for the health check endpoint.

Verifies that the test harness is correctly wired and that
``GET /api/v1/health`` returns a 200 response with the expected body.
No external services (Docker, databases) are required.
"""

from __future__ import annotations

from httpx import AsyncClient


async def test_health_returns_ok(test_client: AsyncClient) -> None:
    """GET /api/v1/health returns 200 with body {"status": "ok"}.

    Args:
        test_client: Unit-test async HTTP client (no Docker required).
    """
    response = await test_client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
