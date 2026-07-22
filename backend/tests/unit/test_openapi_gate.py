"""Unit tests for the OpenAPI-docs production gate (Component 10 Step 10).

``/api/docs``, ``/api/redoc``, and ``/api/openapi.json`` enumerate the API
surface, so they are disabled in production and left reachable in local/staging
for development. FastAPI drops the routes entirely when the corresponding URL is
``None``, so asserting the constructed app's URL attributes is sufficient (and
avoids booting the lifespan, which would need live databases).
"""

from __future__ import annotations

import pytest
from main import create_app


def test_docs_disabled_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    """Production exposes none of the three OpenAPI endpoints."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    app = create_app()
    assert app.docs_url is None
    assert app.redoc_url is None
    assert app.openapi_url is None


@pytest.mark.parametrize("environment", ["staging", "local"])
def test_docs_enabled_outside_production(
    monkeypatch: pytest.MonkeyPatch, environment: str
) -> None:
    """Local and staging keep the OpenAPI endpoints for development."""
    monkeypatch.setenv("ENVIRONMENT", environment)
    app = create_app()
    assert app.docs_url == "/api/docs"
    assert app.redoc_url == "/api/redoc"
    assert app.openapi_url == "/api/openapi.json"
