"""Unit tests for JWT authentication middleware and require_role dependency.

Verifies that ``AuthMiddleware`` correctly validates Supabase JWTs using a
synthetic secret — no live Supabase instance required.

All tests run without Docker.
"""

from __future__ import annotations

import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from fastapi import APIRouter, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from jose import jwt
from starlette.exceptions import HTTPException

_TEST_SECRET = "test-jwt-secret-for-unit-tests"
_ALGORITHM = "HS256"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_token(
    sub: str = "user-uuid-1",
    role: str = "editor",
    email: str = "editor@test.com",
    *,
    secret: str = _TEST_SECRET,
    exp_offset: int = 3600,
) -> str:
    """Mint a synthetic JWT signed with the test secret.

    Args:
        sub: The ``sub`` claim (user ID).
        role: Placed in ``app_metadata.role`` as Supabase does.
        email: The ``email`` claim.
        secret: Signing secret; override to produce a wrong-secret token.
        exp_offset: Seconds added to ``now()`` for the ``exp`` claim.
            Pass a negative value to produce an already-expired token.

    Returns:
        A signed JWT string.
    """
    payload: dict = {
        "sub": sub,
        "email": email,
        "app_metadata": {"role": role},
        "exp": int(time.time()) + exp_offset,
    }
    return jwt.encode(payload, secret, algorithm=_ALGORITHM)


# ---------------------------------------------------------------------------
# Fixture — app with Supabase JWT validation enabled
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


@pytest_asyncio.fixture
async def supabase_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client with Supabase JWT validation active.

    Sets ``AUTH_MODE=supabase`` and ``SUPABASE_JWT_SECRET=<test-secret>``
    so the full validation path runs without a live Supabase project.

    Includes a ``GET /api/v1/protected`` route (editor-only) to exercise
    ``require_role``.

    Yields:
        An ``httpx.AsyncClient`` pointed at ``http://test``.
    """
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", _TEST_SECRET)

    from api.dependencies import AuthenticatedUser, require_role
    from api.middleware.auth import AuthMiddleware
    from api.middleware.errors import (
        http_exception_handler,
        unhandled_exception_handler,
        validation_exception_handler,
    )
    from api.router import router as api_router

    # Test-only protected route — not part of the production router.
    # Use the classic `= Depends(...)` syntax; AuthenticatedUser is a dataclass
    # and FastAPI would otherwise parse it from the request body.
    _test_router = APIRouter()

    @_test_router.get("/api/v1/protected")
    async def _protected(
        user: AuthenticatedUser = require_role("editor"),
    ) -> dict:
        return {"user_id": user.id, "role": user.role}

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
    app.include_router(_test_router)

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Middleware tests — unauthenticated and invalid tokens
# ---------------------------------------------------------------------------


async def test_no_auth_header_passes_through(supabase_client: AsyncClient) -> None:
    """Requests without an Authorization header reach the handler (user is None).

    The health endpoint has no auth requirement, so it returns 200.
    """
    response = await supabase_client.get("/api/v1/health")
    assert response.status_code == 200


async def test_non_bearer_scheme_rejected(supabase_client: AsyncClient) -> None:
    """Authorization header with a non-Bearer scheme returns 401."""
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": "Basic dXNlcjpwYXNz"},
    )
    assert response.status_code == 401


async def test_valid_token_accepted(supabase_client: AsyncClient) -> None:
    """A valid JWT signed with the correct secret passes through to the handler."""
    token = _make_token()
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200


async def test_expired_token_rejected(supabase_client: AsyncClient) -> None:
    """An already-expired JWT returns 401 with the expired-token message."""
    token = _make_token(exp_offset=-3600)
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    body = response.json()
    assert "expired" in body["error"]["message"].lower()


async def test_wrong_secret_rejected(supabase_client: AsyncClient) -> None:
    """A JWT signed with a different secret returns 401."""
    token = _make_token(secret="wrong-secret")
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


async def test_missing_sub_claim_rejected(supabase_client: AsyncClient) -> None:
    """A JWT with no 'sub' claim returns 401."""
    payload = {
        "email": "nosub@test.com",
        "app_metadata": {"role": "editor"},
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(payload, _TEST_SECRET, algorithm=_ALGORITHM)
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    body = response.json()
    assert "sub" in body["error"]["message"].lower()


async def test_malformed_token_rejected(supabase_client: AsyncClient) -> None:
    """A completely malformed token string returns 401."""
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": "Bearer this.is.not.a.jwt"},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# require_role tests
# ---------------------------------------------------------------------------


async def test_require_role_editor_with_editor_token(
    supabase_client: AsyncClient,
) -> None:
    """An editor-role token satisfies require_role("editor")."""
    token = _make_token(sub="editor-uuid", role="editor")
    response = await supabase_client.get(
        "/api/v1/protected",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "editor-uuid"
    assert body["role"] == "editor"


async def test_require_role_editor_with_admin_token(
    supabase_client: AsyncClient,
) -> None:
    """An admin-role token also satisfies require_role("editor") (higher rank)."""
    token = _make_token(role="admin")
    response = await supabase_client.get(
        "/api/v1/protected",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200


async def test_require_role_editor_with_insufficient_role(
    supabase_client: AsyncClient,
) -> None:
    """A token with an unrecognised/low role is rejected with 403."""
    token = _make_token(role="viewer")
    response = await supabase_client.get(
        "/api/v1/protected",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


async def test_require_role_editor_with_no_token(supabase_client: AsyncClient) -> None:
    """An unauthenticated request to a protected route returns 401."""
    response = await supabase_client.get("/api/v1/protected")
    assert response.status_code == 401


async def test_dev_token_rejected_in_supabase_mode(
    supabase_client: AsyncClient,
) -> None:
    """The 'dev-token' bypass must not work when AUTH_MODE=supabase."""
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": "Bearer dev-token"},
    )
    assert response.status_code == 401
