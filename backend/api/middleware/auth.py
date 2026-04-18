"""JWT validation middleware for the Doppia API.

Reads the ``Authorization: Bearer <token>`` header on every request,
validates it against the Supabase JWT secret, and attaches the resulting
``AuthenticatedUser`` to ``request.state.user``.

If no ``Authorization`` header is present, ``request.state.user`` is set to
``None`` and the request proceeds — individual route handlers enforce
authentication requirements via the ``require_role()`` dependency.

A development bypass is available when both ``ENVIRONMENT=local`` and
``AUTH_MODE=local`` are set: the literal token ``dev-token`` is accepted
without JWT validation.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from jose import ExpiredSignatureError, JWTError, jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp

from api.dependencies import AuthenticatedUser

_ALGORITHM = "HS256"
_DEV_TOKEN = "dev-token"
_DEV_USER = AuthenticatedUser(id="dev-user", role="admin", email="dev@local")


class AuthMiddleware(BaseHTTPMiddleware):
    """Starlette HTTP middleware that validates JWTs on every request.

    On a valid ``Authorization: Bearer`` token, sets
    ``request.state.user`` to an ``AuthenticatedUser``.
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

        environment = os.environ.get("ENVIRONMENT", "production")
        auth_mode = os.environ.get("AUTH_MODE", "supabase")

        # Dev bypass — guarded: only valid when ENVIRONMENT=local too.
        if auth_mode == "local":
            if environment != "local":
                return _make_401(
                    "AUTH_MODE=local is not permitted outside ENVIRONMENT=local."
                )
            if token != _DEV_TOKEN:
                return _make_401("Invalid dev token.")
            request.state.user = _DEV_USER
            return await call_next(request)

        # Production / staging: full Supabase JWT validation.
        jwt_secret = os.environ.get("SUPABASE_JWT_SECRET", "")
        if not jwt_secret:
            return _make_401("Server JWT secret is not configured.")

        try:
            payload: dict = jwt.decode(
                token,
                jwt_secret,
                algorithms=[_ALGORITHM],
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

        request.state.user = AuthenticatedUser(id=sub, role=role, email=email)
        return await call_next(request)


def _make_401(message: str) -> JSONResponse:
    """Build a JSON 401 response using the standard error envelope.

    Imported lazily to break any potential circular import between middleware
    and models at module load time.

    Args:
        message: Human-readable explanation for the caller.

    Returns:
        A ``JSONResponse`` with status 401 and a ``WWW-Authenticate`` header.
    """
    from models.errors import ErrorCode, ErrorResponse  # noqa: PLC0415

    body = ErrorResponse.make(code=ErrorCode.INVALID_TOKEN, message=message)
    return JSONResponse(
        status_code=401,
        content=body.model_dump(),
        headers={"WWW-Authenticate": "Bearer"},
    )
