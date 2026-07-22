"""Unit tests for JWT authentication middleware and require_role dependency.

Verifies that ``AuthMiddleware`` correctly validates Supabase JWTs on both
signing paths — HS256 via a synthetic ``SUPABASE_JWT_SECRET`` and ES256 via a
synthetic JWKS on ``app.state.jwks`` — with no live Supabase instance required.

All tests run without Docker.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import jwt
import pytest
import pytest_asyncio
from fastapi import APIRouter, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException

_TEST_SECRET = "test-jwt-secret-for-unit-tests"
_ALGORITHM = "HS256"
_TEST_SUPABASE_URL = "https://test-project.supabase.co"
_TEST_ISSUER = f"{_TEST_SUPABASE_URL}/auth/v1"


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
    iss: str | None = _TEST_ISSUER,
) -> str:
    """Mint a synthetic JWT signed with the test secret.

    Args:
        sub: The ``sub`` claim (user ID).
        role: Placed in ``app_metadata.role`` as Supabase does.
        email: The ``email`` claim.
        secret: Signing secret; override to produce a wrong-secret token.
        exp_offset: Seconds added to ``now()`` for the ``exp`` claim.
            Pass a negative value to produce an already-expired token.
        iss: The ``iss`` claim (Supabase sets ``<SUPABASE_URL>/auth/v1``).
            Pass ``None`` to omit the claim entirely.

    Returns:
        A signed JWT string.
    """
    payload: dict = {
        "sub": sub,
        "email": email,
        "app_metadata": {"role": role},
        "exp": int(time.time()) + exp_offset,
    }
    if iss is not None:
        payload["iss"] = iss
    return jwt.encode(payload, secret, algorithm=_ALGORITHM)


def _make_es256_jwks(kid: str = "test-es256-kid") -> tuple[object, dict, str]:
    """Generate an EC P-256 keypair and the single-key JWKS for its public key.

    Mirrors the shape of a real Supabase JWKS so the middleware's ``kid``
    matching (``_resolve_jwk`` → ``PyJWKSet``) is exercised end to end.

    Args:
        kid: The key id stamped on the JWK (and required on the token header).

    Returns:
        A tuple of ``(private_key, jwks_dict, kid)``.
    """
    from cryptography.hazmat.primitives.asymmetric import ec
    from jwt.algorithms import ECAlgorithm

    private_key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(ECAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": kid, "use": "sig", "alg": "ES256"})
    return private_key, {"keys": [jwk]}, kid


def _make_es256_token(
    private_key: object,
    kid: str,
    *,
    sub: str = "user-uuid-es256",
    role: str = "editor",
    email: str = "editor-es256@test.com",
    exp_offset: int = 3600,
    iss: str | None = _TEST_ISSUER,
) -> str:
    """Mint an ES256 JWT signed with ``private_key`` and carrying ``kid``.

    Args:
        private_key: The EC private key from :func:`_make_es256_jwks`.
        kid: The key id to place in the JWT header (must match the JWKS entry).
        sub: The ``sub`` claim.
        role: Placed in ``app_metadata.role`` as Supabase does.
        email: The ``email`` claim.
        exp_offset: Seconds added to ``now()`` for the ``exp`` claim.
        iss: The ``iss`` claim; pass ``None`` to omit.

    Returns:
        A signed ES256 JWT string.
    """
    payload: dict = {
        "sub": sub,
        "email": email,
        "app_metadata": {"role": role},
        "exp": int(time.time()) + exp_offset,
    }
    if iss is not None:
        payload["iss"] = iss
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": kid})


# ---------------------------------------------------------------------------
# Fixture — app with Supabase JWT validation enabled
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _build_app() -> FastAPI:
    """Build the test FastAPI app: AuthMiddleware, the API router, and a
    test-only editor-protected route, with ``get_db`` overridden to a no-op.

    Shared by the HS256 (``supabase_client``) and ES256 (``es256_client``)
    fixtures; the only difference between them is how the verification key is
    supplied (``SUPABASE_JWT_SECRET`` env var vs. ``app.state.jwks``).

    Returns:
        The configured ``FastAPI`` application (not yet wrapped in a client).
    """
    from api.dependencies import AppUser, require_role
    from api.middleware.auth import AuthMiddleware
    from api.middleware.errors import (
        http_exception_handler,
        unhandled_exception_handler,
        validation_exception_handler,
    )
    from api.router import router as api_router
    from models.base import get_db

    # Test-only protected route — not part of the production router.
    # Use the classic `= Depends(...)` syntax; AppUser is a dataclass
    # and FastAPI would otherwise parse it from the request body.
    _test_router = APIRouter()

    @_test_router.get("/api/v1/protected")
    async def _protected(
        user: AppUser = require_role("editor"),
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

    # get_current_user now upserts the Supabase user into app_user. Auth
    # unit tests don't run a database, so override get_db with a no-op mock
    # session so the upsert path is exercised without a real engine.
    async def _mock_db():
        mock_session = AsyncMock(spec=AsyncSession)
        yield mock_session

    app.dependency_overrides[get_db] = _mock_db
    return app


@pytest_asyncio.fixture
async def supabase_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client with Supabase JWT validation active.

    Sets ``AUTH_MODE=supabase`` and ``SUPABASE_JWT_SECRET=<test-secret>``
    so the full HS256 validation path runs without a live Supabase project.

    Includes a ``GET /api/v1/protected`` route (editor-only) to exercise
    ``require_role``.

    Yields:
        An ``httpx.AsyncClient`` pointed at ``http://test``.
    """
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", _TEST_SECRET)
    monkeypatch.setenv("SUPABASE_URL", _TEST_SUPABASE_URL)

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


@pytest_asyncio.fixture
async def es256_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client exercising the ES256 JWKS validation path.

    Unlike ``supabase_client`` (HS256 via ``SUPABASE_JWT_SECRET``), this sets
    ``app.state.jwks`` to a synthetic single-key JWKS so the middleware takes
    the ES256 branch — the ``kid``-matching that PyJWT does explicitly via
    ``PyJWKSet`` (python-jose did it implicitly). No ``SUPABASE_JWT_SECRET`` is
    set, so only the JWKS path can satisfy a token.

    The matching private key is exposed on ``client._es256_private_key`` so a
    test can mint a valid ES256 token; ``client._es256_kid`` carries the kid.

    Yields:
        An ``httpx.AsyncClient`` with the EC private key/kid attached.
    """
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_URL", _TEST_SUPABASE_URL)

    private_key, jwks, kid = _make_es256_jwks()

    app = _build_app()
    app.state.jwks = jwks

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        client._es256_private_key = private_key
        client._es256_kid = kid
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
        "iss": _TEST_ISSUER,
    }
    token = jwt.encode(payload, _TEST_SECRET, algorithm=_ALGORITHM)
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    body = response.json()
    assert "sub" in body["error"]["message"].lower()


async def test_wrong_issuer_rejected(supabase_client: AsyncClient) -> None:
    """A JWT issued by a different Supabase project returns 401 (Step 31 B4)."""
    token = _make_token(iss="https://other-project.supabase.co/auth/v1")
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    body = response.json()
    assert "issuer" in body["error"]["message"].lower()


async def test_missing_issuer_rejected(supabase_client: AsyncClient) -> None:
    """A JWT with no 'iss' claim returns 401 when SUPABASE_URL is configured."""
    token = _make_token(iss=None)
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


async def test_issuer_not_verified_without_supabase_url(
    supabase_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without SUPABASE_URL (HS256-only deployment), iss is not required."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    token = _make_token(iss=None)
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200


async def test_malformed_token_rejected(supabase_client: AsyncClient) -> None:
    """A completely malformed token string returns 401."""
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": "Bearer this.is.not.a.jwt"},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# ES256 / JWKS path — the kid-matching PyJWT does explicitly (was implicit
# in python-jose). No SUPABASE_JWT_SECRET is set in this fixture, so only the
# JWKS branch can satisfy a token.
# ---------------------------------------------------------------------------


async def test_es256_valid_token_accepted(es256_client: AsyncClient) -> None:
    """A valid ES256 token whose kid matches the JWKS passes through."""
    token = _make_es256_token(es256_client._es256_private_key, es256_client._es256_kid)
    response = await es256_client.get(
        "/api/v1/protected",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["role"] == "editor"


async def test_es256_unknown_kid_rejected(es256_client: AsyncClient) -> None:
    """An ES256 token whose kid is absent from the JWKS returns 401."""
    token = _make_es256_token(es256_client._es256_private_key, kid="no-such-kid")
    response = await es256_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


async def test_es256_wrong_key_rejected(es256_client: AsyncClient) -> None:
    """An ES256 token signed by a different key (same kid) fails verification."""
    from cryptography.hazmat.primitives.asymmetric import ec

    other_key = ec.generate_private_key(ec.SECP256R1())
    token = _make_es256_token(other_key, es256_client._es256_kid)
    response = await es256_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


async def test_es256_expired_token_rejected(es256_client: AsyncClient) -> None:
    """An expired ES256 token returns 401 with the expired-token message."""
    token = _make_es256_token(
        es256_client._es256_private_key,
        es256_client._es256_kid,
        exp_offset=-3600,
    )
    response = await es256_client.get(
        "/api/v1/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    assert "expired" in response.json()["error"]["message"].lower()


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
    """An unauthenticated request to a protected route returns 401.

    Also pins the error envelope (Component 9 item 6): get_current_user's bare
    HTTPException is wrapped by http_exception_handler into the standard
    envelope with the UNAUTHORIZED code — distinct from AuthMiddleware's
    INVALID_TOKEN (token present but bad). The frontend keys on the 401 status
    to substitute a translated message, so the raw English text is never shown.
    """
    response = await supabase_client.get("/api/v1/protected")
    assert response.status_code == 401
    body = response.json()
    assert body["error"]["code"] == "UNAUTHORIZED"
    assert body["error"]["message"]  # a human-readable message is present


async def test_dev_token_rejected_in_supabase_mode(
    supabase_client: AsyncClient,
) -> None:
    """The 'dev-token' bypass must not work when AUTH_MODE=supabase."""
    response = await supabase_client.get(
        "/api/v1/health",
        headers={"Authorization": "Bearer dev-token"},
    )
    assert response.status_code == 401
