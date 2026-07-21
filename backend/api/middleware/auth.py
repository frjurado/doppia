"""JWT validation middleware for the Doppia API.

Reads the ``Authorization: Bearer <token>`` header on every request,
validates it against the Supabase public key, and attaches the resulting
``AppUser`` to ``request.state.user``.

If no ``Authorization`` header is present, ``request.state.user`` is set to
``None`` and the request proceeds — individual route handlers enforce
authentication requirements via the ``require_role()`` dependency.

A development bypass is available when both ``ENVIRONMENT=local`` and
``AUTH_MODE=local`` are set: the literal token ``dev-token`` is accepted
without JWT validation.

Supabase uses ES256 (asymmetric) JWT signing on new projects. The JWKS is
fetched at startup (``main.py``) from the JWKS endpoint:
    https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
and stored on ``app.state.jwks``; this middleware matches the token's ``kid``
header to the correct key in that set (PyJWT's ``PyJWKSet``).

Legacy projects using HS256 symmetric signing: set ``SUPABASE_JWT_SECRET``
instead. Only one variable is needed; the ES256 JWKS path takes precedence.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable

import jwt
from api.dependencies import AppUser
from fastapi import Request, Response
from jwt import PyJWKSet
from jwt.exceptions import (
    ExpiredSignatureError,
    InvalidIssuerError,
    InvalidTokenError,
    MissingRequiredClaimError,
    PyJWTError,
)
from models.errors import ErrorCode, ErrorResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

_DEV_TOKENS: dict[str, AppUser] = {
    "dev-token": AppUser(
        id="00000000-0000-0000-0000-000000000001", role="editor", email="dev@local"
    ),
    "admin-token": AppUser(
        id="00000000-0000-0000-0000-000000000002", role="admin", email="admin@local"
    ),
}


class AuthMiddleware(BaseHTTPMiddleware):
    """Starlette HTTP middleware that validates JWTs on every request.

    On a valid ``Authorization: Bearer`` token, sets
    ``request.state.user`` to an ``AppUser``.
    On a missing header, sets ``request.state.user = None`` and continues.
    On a malformed or expired token, returns HTTP 401 immediately.

    Attributes:
        app: The inner ASGI application being wrapped.
    """

    def __init__(self, app: ASGIApp) -> None:
        """Initialise the middleware.

        Args:
            app: The inner ASGI application.
        """
        super().__init__(app)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        """Validate the bearer token and attach the user to request state.

        Args:
            request: The incoming Starlette request.
            call_next: Callable to invoke the next middleware or route handler.

        Returns:
            The HTTP response from downstream, or a 401 JSON error response
            if the token is present but invalid.
        """
        authorization = request.headers.get("Authorization", "")

        if not authorization:
            request.state.user = None
            return await call_next(request)

        if not authorization.startswith("Bearer "):
            return _make_401("Authorization header must use the Bearer scheme.")

        token = authorization.removeprefix("Bearer ").strip()

        # Read at request time so that test monkeypatching takes effect.
        # The primary guard is in main.py's lifespan, which refuses to start if
        # AUTH_MODE=local is set outside a local environment. This per-request
        # check is belt-and-suspenders (e.g. if env vars change at runtime).
        _auth_mode: str = os.environ.get("AUTH_MODE", "supabase")
        _environment: str = os.environ.get("ENVIRONMENT", "production")

        if _auth_mode == "local":
            if _environment != "local":
                return _make_401(
                    "AUTH_MODE=local is not permitted outside ENVIRONMENT=local."
                )
            user = _DEV_TOKENS.get(token)
            if user is None:
                return _make_401("Invalid dev token.")
            request.state.user = user
            return await call_next(request)

        # Production / staging: full Supabase JWT validation.
        # ES256 (asymmetric, new Supabase projects): JWKS is fetched at startup
        #   from the Supabase endpoint and stored on app.state.jwks.
        # HS256 (symmetric, legacy projects): set SUPABASE_JWT_SECRET instead.
        jwks: dict | None = getattr(request.app.state, "jwks", None)
        secret = os.environ.get("SUPABASE_JWT_SECRET", "")
        if jwks:
            algorithm = "ES256"
        elif secret:
            algorithm = "HS256"
        else:
            return _make_401("Server JWT key is not configured.")

        # Supabase issues tokens with iss = "<SUPABASE_URL>/auth/v1". Verified
        # whenever SUPABASE_URL is configured (always true when the JWKS path
        # is active — main.py fetches the JWKS from that same URL); an
        # HS256-only deployment without SUPABASE_URL falls back to signature
        # verification alone, which already scopes accepted tokens to this
        # project.
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        issuer: str | None = f"{supabase_url}/auth/v1" if supabase_url else None

        try:
            verify_key: object = (
                _resolve_jwk(jwks, token) if algorithm == "ES256" else secret
            )
            payload: dict = jwt.decode(
                token,
                verify_key,
                algorithms=[algorithm],
                issuer=issuer,
                # Supabase tokens carry audience "authenticated"; audience is
                # not verified — signature verification already scopes accepted
                # tokens to this Supabase project. exp is verified by default.
                options={"verify_aud": False, "verify_iss": issuer is not None},
            )
        except ExpiredSignatureError:
            return _make_401("Token has expired.")
        except (InvalidIssuerError, MissingRequiredClaimError):
            return _make_401("Token issuer does not match this Supabase project.")
        except (InvalidTokenError, PyJWTError):
            return _make_401("Token is invalid or signature verification failed.")

        sub: str = payload.get("sub", "")
        if not sub:
            return _make_401("Token is missing the required 'sub' claim.")

        email: str = payload.get("email", "")
        role: str = payload.get("app_metadata", {}).get("role", "")

        request.state.user = AppUser(id=sub, role=role, email=email)
        return await call_next(request)


def _resolve_jwk(jwks: dict, token: str) -> object:
    """Select the ES256 verification key whose ``kid`` matches the token header.

    python-jose accepted a raw JWKS dict directly in ``jwt.decode`` and matched
    the ``kid`` internally; PyJWT requires an explicit key, so we parse the JWKS
    into a ``PyJWKSet`` and pick the entry matching the token's ``kid``.

    Args:
        jwks: The raw JWKS JSON (as fetched at startup and stored on app state).
        token: The encoded JWT whose header carries the ``kid`` to match.

    Returns:
        The cryptographic key object for the matching JWK.

    Raises:
        InvalidTokenError: If the token header is malformed or no JWK matches
            the token's ``kid`` — surfaced to the caller as a 401.
    """
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")
    key_set = PyJWKSet.from_dict(jwks)
    for key in key_set.keys:
        if key.key_id == kid:
            return key.key
    raise InvalidTokenError("No matching JWK for the token's key id.")


def _make_401(message: str) -> JSONResponse:
    """Build a JSON 401 response using the standard error envelope.

    Args:
        message: Human-readable explanation for the caller.

    Returns:
        A ``JSONResponse`` with status 401 and a ``WWW-Authenticate`` header.
    """
    body = ErrorResponse.make(code=ErrorCode.INVALID_TOKEN, message=message)
    return JSONResponse(
        status_code=401,
        content=body.model_dump(),
        headers={"WWW-Authenticate": "Bearer"},
    )
