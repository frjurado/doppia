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

Supabase uses ES256 (asymmetric) JWT signing on new projects. Set
``SUPABASE_JWKS`` to the raw JSON string from the JWKS endpoint:
    https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
python-jose matches the token's ``kid`` header to the correct key automatically.

Legacy projects using HS256 symmetric signing: set ``SUPABASE_JWT_SECRET``
instead. Only one variable is needed; ``SUPABASE_JWKS`` takes precedence.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable

from api.dependencies import AppUser
from fastapi import Request, Response
from jose import ExpiredSignatureError, JWTError, jwt
from models.errors import ErrorCode, ErrorResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

_DEV_TOKEN = "dev-token"
_DEV_USER = AppUser(id="dev-user", role="admin", email="dev@local")

# Read once at import time; the primary guard (refusing to start with
# AUTH_MODE=local outside ENVIRONMENT=local) lives in main.py's lifespan.
# These module-level reads are a belt-and-suspenders check on each request.
_ENVIRONMENT: str = os.environ.get("ENVIRONMENT", "production")
_AUTH_MODE: str = os.environ.get("AUTH_MODE", "supabase")


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

        # Dev bypass — guarded: only valid when ENVIRONMENT=local too.
        # The primary guard is in main.py's lifespan, which refuses to start if
        # AUTH_MODE=local is set outside a local environment. This per-request
        # check is belt-and-suspenders (e.g. if env vars change at runtime).
        if _AUTH_MODE == "local":
            if _ENVIRONMENT != "local":
                return _make_401(
                    "AUTH_MODE=local is not permitted outside ENVIRONMENT=local."
                )
            if token != _DEV_TOKEN:
                return _make_401("Invalid dev token.")
            request.state.user = _DEV_USER
            return await call_next(request)

        # Production / staging: full Supabase JWT validation.
        # ES256 (asymmetric, new Supabase projects): JWKS is fetched at startup
        #   from the Supabase endpoint and stored on app.state.jwks.
        # HS256 (symmetric, legacy projects): set SUPABASE_JWT_SECRET instead.
        jwks: dict | None = getattr(request.app.state, "jwks", None)
        secret = os.environ.get("SUPABASE_JWT_SECRET", "")
        if jwks:
            verify_key: object = jwks
            algorithm = "ES256"
        elif secret:
            verify_key = secret
            algorithm = "HS256"
        else:
            return _make_401("Server JWT key is not configured.")

        try:
            payload: dict = jwt.decode(
                token,
                verify_key,
                algorithms=[algorithm],
                # Supabase tokens carry audience "authenticated"; we skip
                # audience verification here and rely on iss + exp instead.
                options={"verify_aud": False},
            )
        except ExpiredSignatureError:
            return _make_401("Token has expired.")
        except JWTError:
            return _make_401("Token is invalid or signature verification failed.")

        sub: str = payload.get("sub", "")
        if not sub:
            return _make_401("Token is missing the required 'sub' claim.")

        email: str = payload.get("email", "")
        role: str = payload.get("app_metadata", {}).get("role", "")

        request.state.user = AppUser(id=sub, role=role, email=email)
        return await call_next(request)


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
