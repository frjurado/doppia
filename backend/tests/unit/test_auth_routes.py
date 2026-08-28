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
from urllib.parse import quote

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from services.supabase_auth import SupabaseAuthError, SupabaseSession
from starlette.exceptions import HTTPException as StarletteHTTPException

_REFRESH_COOKIE = "doppia_refresh"
_USER_SUB = "11111111-1111-4111-8111-111111111111"
_PKCE_COOKIE = "doppia_pkce"


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
    from models.base import get_db
    from sqlalchemy.ext.asyncio import AsyncSession

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

    # Login and refresh resolve the caller's roles from PostgreSQL (ADR-037);
    # these tests run without a database, so the session is a mock and the two
    # user-service calls are stubbed in the fixture.
    async def _mock_db() -> AsyncGenerator[AsyncMock, None]:
        yield AsyncMock(spec=AsyncSession)

    app.dependency_overrides[get_db] = _mock_db
    return app


def _session(
    refresh_token: str = "refresh-1", access_token: str = "access-1"
) -> SupabaseSession:
    """Build a synthetic Supabase session for the mocked grants."""
    return SupabaseSession(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=3600,
        user_id=_USER_SUB,
        email="editor@test.com",
        email_verified=True,
    )


@pytest_asyncio.fixture
async def auth_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async client over the auth router. ``ENVIRONMENT=local`` so the refresh
    cookie is set without the ``Secure`` flag (the test transport is plain HTTP)."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    monkeypatch.setattr("api.routes.auth.ensure_app_user", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "api.routes.auth.load_roles", AsyncMock(return_value=frozenset({"editor"}))
    )
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


def _pkce_set_cookie(response) -> str | None:
    """The Set-Cookie header for the PKCE cookie, if present."""
    for header in _set_cookie_headers(response):
        if header.startswith(f"{_PKCE_COOKIE}="):
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
            "id": _USER_SUB,
            "email": "editor@test.com",
            # Roles come from user_role, not from the Supabase grant (ADR-037).
            "roles": ["editor"],
            "email_verified": True,
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


# ---------------------------------------------------------------------------
# OAuth — Component 12 Step 4
# ---------------------------------------------------------------------------


class TestOAuthStart:
    async def test_start_returns_authorize_url_and_stores_the_verifier(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The URL is returned to navigate to; the verifier stays server-side."""
        monkeypatch.setenv("PUBLIC_APP_URL", "http://localhost:5173")
        monkeypatch.setenv("SUPABASE_URL", "https://test-project.supabase.co")
        monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")

        response = await auth_client.post("/api/v1/auth/oauth/google/start")
        assert response.status_code == 200

        url = response.json()["authorize_url"]
        assert url.startswith("https://test-project.supabase.co/auth/v1/authorize?")
        assert "provider=google" in url
        assert "code_challenge_method=s256" in url
        assert quote("http://localhost:5173/auth/callback", safe="") in url

        cookie = _pkce_set_cookie(response)
        assert cookie is not None
        assert "HttpOnly" in cookie
        assert "Path=/api/v1/auth" in cookie
        # The verifier itself must not be discoverable from the returned URL —
        # only its SHA-256 challenge travels to the provider.
        verifier = cookie.split("=", 1)[1].split(";", 1)[0]
        assert verifier not in url

    async def test_unsupported_provider_returns_404(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("PUBLIC_APP_URL", "http://localhost:5173")
        response = await auth_client.post("/api/v1/auth/oauth/github/start")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
        assert _pkce_set_cookie(response) is None

    async def test_unconfigured_public_url_returns_503(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Staging without PUBLIC_APP_URL must not send users to localhost."""
        monkeypatch.delenv("PUBLIC_APP_URL", raising=False)
        monkeypatch.setenv("ENVIRONMENT", "staging")
        monkeypatch.setenv("SUPABASE_URL", "https://test-project.supabase.co")
        monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")

        response = await auth_client.post("/api/v1/auth/oauth/google/start")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "AUTH_SERVICE_UNAVAILABLE"


class TestOAuthCallback:
    async def test_callback_exchanges_the_code_and_swaps_the_cookies(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The tokens never touch JavaScript: the exchange happens here."""
        grant = AsyncMock(return_value=_session(refresh_token="rt-oauth"))
        monkeypatch.setattr("services.supabase_auth.pkce_grant", grant)

        auth_client.cookies.set(_PKCE_COOKIE, "verifier-1", path="/api/v1/auth")
        response = await auth_client.post(
            "/api/v1/auth/oauth/callback", json={"code": "auth-code-1"}
        )
        assert response.status_code == 200
        grant.assert_awaited_once_with("auth-code-1", "verifier-1")

        body = response.json()
        assert body["access_token"] == "access-1"
        assert body["user"]["roles"] == ["editor"]
        assert "refresh_token" not in body

        refresh = _refresh_set_cookie(response)
        assert refresh is not None and "rt-oauth" in refresh and "HttpOnly" in refresh
        # The verifier is single-use and is cleared on the way out.
        pkce = _pkce_set_cookie(response)
        assert pkce is not None and ("Max-Age=0" in pkce or 'doppia_pkce=""' in pkce)

    async def test_callback_without_a_verifier_returns_401(
        self, auth_client: AsyncClient
    ) -> None:
        """A code arriving with no flow in progress is refused, not exchanged."""
        response = await auth_client.post(
            "/api/v1/auth/oauth/callback", json={"code": "auth-code-1"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"
        assert _refresh_set_cookie(response) is None

    async def test_failed_exchange_clears_the_verifier_and_sets_no_session(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A stale or replayed code cannot be retried with the same verifier."""
        monkeypatch.setattr(
            "services.supabase_auth.pkce_grant",
            AsyncMock(side_effect=SupabaseAuthError(401, "invalid_grant", "bad code")),
        )
        auth_client.cookies.set(_PKCE_COOKIE, "verifier-1", path="/api/v1/auth")
        response = await auth_client.post(
            "/api/v1/auth/oauth/callback", json={"code": "stale-code"}
        )
        assert response.status_code == 401
        assert _refresh_set_cookie(response) is None
        pkce = _pkce_set_cookie(response)
        assert pkce is not None and ("Max-Age=0" in pkce or 'doppia_pkce=""' in pkce)

    async def test_auth_unreachable_returns_503(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.pkce_grant",
            AsyncMock(side_effect=SupabaseAuthError(503, "unavailable", "down")),
        )
        auth_client.cookies.set(_PKCE_COOKIE, "verifier-1", path="/api/v1/auth")
        response = await auth_client.post(
            "/api/v1/auth/oauth/callback", json={"code": "auth-code-1"}
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "AUTH_SERVICE_UNAVAILABLE"


# ---------------------------------------------------------------------------
# Registration, verification, password reset — Component 12 Step 4
# ---------------------------------------------------------------------------


class TestSignUp:
    async def test_invite_only_refuses_sign_up(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """At launch there is no self-service path; accounts come from invites."""
        monkeypatch.setenv("REGISTRATION_MODE", "invite")
        sign_up = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.sign_up", sign_up)

        response = await auth_client.post(
            "/api/v1/auth/signup",
            json={"email": "new@test.com", "password": "pw12345678"},
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "REGISTRATION_CLOSED"
        # The gate is a refusal, not a silent no-op: Supabase is never called.
        sign_up.assert_not_awaited()

    async def test_unset_mode_defaults_to_closed(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A missing or misspelt flag must not accidentally open registration."""
        monkeypatch.delenv("REGISTRATION_MODE", raising=False)
        response = await auth_client.post(
            "/api/v1/auth/signup",
            json={"email": "new@test.com", "password": "pw12345678"},
        )
        assert response.status_code == 403

        monkeypatch.setenv("REGISTRATION_MODE", "Open ")  # tolerated
        monkeypatch.setattr("services.supabase_auth.sign_up", AsyncMock())
        response = await auth_client.post(
            "/api/v1/auth/signup",
            json={"email": "new@test.com", "password": "pw12345678"},
        )
        assert response.status_code == 202

        monkeypatch.setenv("REGISTRATION_MODE", "opne")  # typo → still closed
        response = await auth_client.post(
            "/api/v1/auth/signup",
            json={"email": "new@test.com", "password": "pw12345678"},
        )
        assert response.status_code == 403

    async def test_open_mode_registers_and_returns_202(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No session is issued: the account is unverified until the email lands."""
        monkeypatch.setenv("REGISTRATION_MODE", "open")
        sign_up = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.sign_up", sign_up)

        response = await auth_client.post(
            "/api/v1/auth/signup",
            json={"email": "new@test.com", "password": "pw12345678"},
        )
        assert response.status_code == 202
        assert not response.content
        sign_up.assert_awaited_once_with("new@test.com", "pw12345678")
        assert _refresh_set_cookie(response) is None

    async def test_malformed_email_is_rejected_before_supabase(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("REGISTRATION_MODE", "open")
        sign_up = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.sign_up", sign_up)
        response = await auth_client.post(
            "/api/v1/auth/signup",
            json={"email": "not-an-email", "password": "pw12345678"},
        )
        assert response.status_code == 422
        sign_up.assert_not_awaited()


class TestResendAndReset:
    @pytest.mark.parametrize(
        ("path", "target"),
        [
            (
                "/api/v1/auth/resend-verification",
                "services.supabase_auth.resend_verification",
            ),
            (
                "/api/v1/auth/password-reset",
                "services.supabase_auth.request_password_reset",
            ),
        ],
    )
    async def test_reports_202_for_an_unknown_address(
        self,
        auth_client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        path: str,
        target: str,
    ) -> None:
        """These endpoints must not reveal which addresses hold accounts.

        A 404 here would let anyone enumerate the user base one request at a
        time, so an upstream rejection is swallowed and the answer is always the
        same.
        """
        monkeypatch.setattr(
            target,
            AsyncMock(side_effect=SupabaseAuthError(400, "invalid_request", "no user")),
        )
        response = await auth_client.post(path, json={"email": "ghost@test.com"})
        assert response.status_code == 202
        assert not response.content

    @pytest.mark.parametrize(
        ("path", "target"),
        [
            (
                "/api/v1/auth/resend-verification",
                "services.supabase_auth.resend_verification",
            ),
            (
                "/api/v1/auth/password-reset",
                "services.supabase_auth.request_password_reset",
            ),
        ],
    )
    async def test_service_unavailable_still_surfaces(
        self,
        auth_client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        path: str,
        target: str,
    ) -> None:
        """Hiding the address is not a reason to hide that Auth is down."""
        monkeypatch.setattr(
            target, AsyncMock(side_effect=SupabaseAuthError(503, "unavailable", "down"))
        )
        response = await auth_client.post(path, json={"email": "someone@test.com"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "AUTH_SERVICE_UNAVAILABLE"


class TestUpdatePassword:
    async def test_requires_a_bearer_token(self, auth_client: AsyncClient) -> None:
        response = await auth_client.post(
            "/api/v1/auth/password", json={"password": "new-pw-12345"}
        )
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "UNAUTHORIZED"

    async def test_forwards_the_callers_own_token(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Supabase authorises with the user's token — no admin credential."""
        update = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.update_password", update)
        monkeypatch.setenv("AUTH_MODE", "local")
        monkeypatch.setenv("ENVIRONMENT", "local")

        response = await auth_client.post(
            "/api/v1/auth/password",
            json={"password": "new-pw-12345"},
            headers={"Authorization": "Bearer dev-token"},
        )
        assert response.status_code == 204
        update.assert_awaited_once_with("dev-token", "new-pw-12345")

    async def test_rejected_token_surfaces_as_401(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A recovery link that was already used must not appear to succeed."""
        monkeypatch.setattr(
            "services.supabase_auth.update_password",
            AsyncMock(side_effect=SupabaseAuthError(401, "invalid_request", "expired")),
        )
        monkeypatch.setenv("AUTH_MODE", "local")
        monkeypatch.setenv("ENVIRONMENT", "local")
        response = await auth_client.post(
            "/api/v1/auth/password",
            json={"password": "new-pw-12345"},
            headers={"Authorization": "Bearer dev-token"},
        )
        assert response.status_code == 401


class TestVerifyLink:
    async def test_redeems_a_link_and_sets_the_session_cookie(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An invite or recovery link ends in a session, cookie and all."""
        verify = AsyncMock(return_value=_session(refresh_token="rt-invite"))
        monkeypatch.setattr("services.supabase_auth.verify_email_link", verify)

        response = await auth_client.post(
            "/api/v1/auth/verify-link",
            json={"token_hash": "hash-abc", "type": "invite"},
        )
        assert response.status_code == 200
        verify.assert_awaited_once_with("hash-abc", "invite")

        body = response.json()
        assert body["access_token"] == "access-1"
        assert "refresh_token" not in body
        cookie = _refresh_set_cookie(response)
        assert cookie is not None and "rt-invite" in cookie and "HttpOnly" in cookie

    async def test_unknown_link_type_returns_404(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        verify = AsyncMock()
        monkeypatch.setattr("services.supabase_auth.verify_email_link", verify)
        response = await auth_client.post(
            "/api/v1/auth/verify-link",
            json={"token_hash": "hash-abc", "type": "magiclink"},
        )
        assert response.status_code == 404
        verify.assert_not_awaited()

    async def test_expired_link_returns_401_without_a_session(
        self, auth_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "services.supabase_auth.verify_email_link",
            AsyncMock(side_effect=SupabaseAuthError(401, "invalid_grant", "used")),
        )
        response = await auth_client.post(
            "/api/v1/auth/verify-link",
            json={"token_hash": "stale", "type": "recovery"},
        )
        assert response.status_code == 401
        assert _refresh_set_cookie(response) is None
