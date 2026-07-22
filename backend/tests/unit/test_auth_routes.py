"""Route-level unit tests for backend/api/routes/auth.py (Component 10 Step 7).

Exercises login / refresh / logout through the full FastAPI stack —
``AuthMiddleware``, dependency injection, cookie handling, and the error
envelope — with the Supabase Auth service (``services.supabase_auth``) mocked,
so no live Supabase project or network is required.

Verification cases from the Component 10 plan (Step 7):
    * Login sets an HttpOnly, path-scoped refresh cookie and returns only the
      access token (never the refresh token) in the body.
    * Bad credentials → 401 INVALID_CREDENTIALS with no cookie.
    * Auth service unreachable → 503 AUTH_SERVICE_UNAVAILABLE.
    * Refresh rotates the cookie and returns a fresh access token.
    * Refresh with no cookie / a bad token → 401 with the cookie cleared.
    * Refresh during a transient 503 leaves the cookie intact.
    * Logout clears the cookie and returns 204 (best-effort revocation).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from services.supabase_auth import SupabaseAuthError, SupabaseSession
from starlette.exceptions import HTTPException as StarletteHTTPException

_REFRESH_COOKIE = "doppia_refresh"


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app() -> FastAPI:
    """Build a fresh test app with the production middleware topology."""
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
    app.add_middleware(
        PathScopedCORSMiddleware, allowed_origins=["http://localhost:5173"]
    )
    app.include_router(api_router)
    return app


def _session(
    refresh_token: str = "refresh-1", access_token: str = "access-1"
) -> SupabaseSession:
    """Build a synthetic Supabase session for the mocked grants."""
    return SupabaseSession(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=3600,
        user_id="user-uuid-1",
        email="editor@test.com",
        role="editor",
    )


@pytest_asyncio.fixture
async def auth_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async client over the auth router. ``ENVIRONMENT=local`` so the refresh
    cookie is set without the ``Secure`` flag (the test transport is plain HTTP)."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


def _set_cookie_headers(response) -> list[str]:
    """All raw Set-Cookie header values on a response."""
    return response.headers.get_list("set-cookie")


def _refresh_set_cookie(response) -> str | None:
    """The Set-Cookie header for the refresh cookie, if present."""
    for header in _set_cookie_headers(response):
        if header.startswith(f"{_REFRESH_COOKIE}="):
            return header
    return None


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


class TestLogin:
    async def test_login_success_sets_cookie_and_returns_access_token(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.password_grant",
            AsyncMock(return_value=_session(refresh_token="rt-abc")),
        )
        response = await auth_client.post(
            "/api/v1/auth/login",
            json={"email": "editor@test.com", "password": "pw"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["access_token"] == "access-1"
        assert body["token_type"] == "bearer"
        assert body["expires_in"] == 3600
        assert body["user"] == {
            "id": "user-uuid-1",
            "email": "editor@test.com",
            "role": "editor",
        }
        # The refresh token is never in the body.
        assert "refresh_token" not in body
        # It is in an HttpOnly, path-scoped cookie.
        cookie = _refresh_set_cookie(response)
        assert cookie is not None
        assert "rt-abc" in cookie
        assert "HttpOnly" in cookie
        assert "Path=/api/v1/auth" in cookie
        assert "samesite=lax" in cookie.lower()

    async def test_login_bad_credentials_returns_401_no_cookie(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.password_grant",
            AsyncMock(side_effect=SupabaseAuthError(401, "invalid_credentials", "bad")),
        )
        response = await auth_client.post(
            "/api/v1/auth/login",
            json={"email": "editor@test.com", "password": "wrong"},
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"
        assert _refresh_set_cookie(response) is None

    async def test_login_service_unavailable_returns_503(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.password_grant",
            AsyncMock(side_effect=SupabaseAuthError(503, "unavailable", "down")),
        )
        response = await auth_client.post(
            "/api/v1/auth/login",
            json={"email": "editor@test.com", "password": "pw"},
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "AUTH_SERVICE_UNAVAILABLE"

    async def test_login_rejects_malformed_email(
        self, auth_client: AsyncClient
    ) -> None:
        response = await auth_client.post(
            "/api/v1/auth/login",
            json={"email": "not-an-email", "password": "pw"},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Refresh
# ---------------------------------------------------------------------------


class TestRefresh:
    async def test_refresh_success_rotates_cookie(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        grant = AsyncMock(
            return_value=_session(refresh_token="rt-rotated", access_token="access-2")
        )
        monkeypatch.setattr("services.supabase_auth.refresh_grant", grant)
        response = await auth_client.post(
            "/api/v1/auth/refresh",
            cookies={_REFRESH_COOKIE: "rt-old"},
        )
        assert response.status_code == 200
        assert response.json()["access_token"] == "access-2"
        grant.assert_awaited_once_with("rt-old")
        cookie = _refresh_set_cookie(response)
        assert cookie is not None and "rt-rotated" in cookie

    async def test_refresh_without_cookie_returns_401(
        self, auth_client: AsyncClient
    ) -> None:
        response = await auth_client.post("/api/v1/auth/refresh")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"

    async def test_refresh_invalid_token_clears_cookie(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.refresh_grant",
            AsyncMock(side_effect=SupabaseAuthError(401, "invalid_grant", "expired")),
        )
        response = await auth_client.post(
            "/api/v1/auth/refresh",
            cookies={_REFRESH_COOKIE: "rt-expired"},
        )
        assert response.status_code == 401
        cookie = _refresh_set_cookie(response)
        # Cleared → Set-Cookie with an immediate expiry / empty value.
        assert cookie is not None
        assert (
            'doppia_refresh=""' in cookie
            or "Max-Age=0" in cookie
            or ("expires=" in cookie.lower())
        )

    async def test_refresh_transient_503_keeps_cookie(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.refresh_grant",
            AsyncMock(side_effect=SupabaseAuthError(503, "unavailable", "down")),
        )
        response = await auth_client.post(
            "/api/v1/auth/refresh",
            cookies={_REFRESH_COOKIE: "rt-live"},
        )
        assert response.status_code == 503
        # No clearing Set-Cookie header — the cookie survives a transient outage.
        assert _refresh_set_cookie(response) is None


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------


class TestLogout:
    async def test_logout_with_cookie_revokes_and_clears(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        refresh_grant = AsyncMock(return_value=_session(access_token="access-live"))
        revoke = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.refresh_grant", refresh_grant)
        monkeypatch.setattr("services.supabase_auth.logout", revoke)
        response = await auth_client.post(
            "/api/v1/auth/logout",
            cookies={_REFRESH_COOKIE: "rt-live"},
        )
        assert response.status_code == 204
        refresh_grant.assert_awaited_once_with("rt-live")
        revoke.assert_awaited_once_with("access-live")
        assert _refresh_set_cookie(response) is not None  # clearing header present

    async def test_logout_without_cookie_still_204(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        revoke = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.logout", revoke)
        response = await auth_client.post("/api/v1/auth/logout")
        assert response.status_code == 204
        revoke.assert_not_awaited()

    async def test_logout_swallows_revocation_failure(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.refresh_grant",
            AsyncMock(side_effect=SupabaseAuthError(401, "invalid_grant", "expired")),
        )
        response = await auth_client.post(
            "/api/v1/auth/logout",
            cookies={_REFRESH_COOKIE: "rt-expired"},
        )
        # Best-effort revocation failed, but logout still succeeds and clears.
        assert response.status_code == 204
