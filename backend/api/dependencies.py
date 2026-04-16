"""FastAPI dependency functions for authentication and authorisation.

The sole permitted role enforcement mechanism is ``require_role()``.
No inline role checks in route handlers or service functions.
See CONTRIBUTING.md § Invariants and docs/architecture/security-model.md.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

_DEV_TOKEN = "dev-token"


@dataclass(frozen=True)
class AuthenticatedUser:
    """Represents the authenticated caller on a request.

    Attributes:
        id: The user's UUID (from Supabase Auth JWT ``sub`` claim, or synthetic in dev).
        role: One of ``editor`` or ``admin`` in Phase 1.
        email: The user's email address.
    """

    id: str
    role: str
    email: str


async def _validate_supabase_jwt(request: Request) -> AuthenticatedUser:
    """Validate a Supabase-issued JWT from the Authorization header.

    Args:
        request: The incoming FastAPI request.

    Returns:
        An AuthenticatedUser populated from the JWT claims.

    Raises:
        HTTPException: 401 if the token is absent or invalid.
    """
    # TODO: implement full JWT validation against SUPABASE_JWT_SECRET (Component 1 auth task).
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Supabase JWT validation not yet implemented.",
    )


async def get_current_user(request: Request) -> AuthenticatedUser:
    """FastAPI dependency that returns the authenticated user for the current request.

    Dispatches to the development bypass (when AUTH_MODE=local) or full Supabase JWT
    validation. The dev bypass is guarded by an ENVIRONMENT check to ensure it can
    never activate in staging or production.

    Args:
        request: The incoming FastAPI request.

    Returns:
        The authenticated user.

    Raises:
        RuntimeError: If AUTH_MODE=local is set with a non-local ENVIRONMENT.
        HTTPException: 401 if the token is missing or invalid.
    """
    environment = os.environ.get("ENVIRONMENT", "production")
    auth_mode = os.environ.get("AUTH_MODE", "supabase")

    if auth_mode == "local":
        if environment != "local":
            raise RuntimeError(
                "AUTH_MODE=local is set but ENVIRONMENT is not 'local'. "
                "This configuration is invalid and the application will not start. "
                f"ENVIRONMENT={environment!r}"
            )
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if token != _DEV_TOKEN:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid dev token.",
            )
        return AuthenticatedUser(id="dev-user", role="admin", email="dev@local")

    return await _validate_supabase_jwt(request)


def require_role(role: str) -> Annotated[AuthenticatedUser, Depends]:
    """Dependency factory that enforces a minimum role requirement.

    This is the **only** permitted way to enforce roles in route handlers.
    Do not perform inline role checks in route handlers or service functions.

    Usage::

        @router.post("/fragments/{id}/approve")
        async def approve_fragment(
            id: UUID,
            _: Annotated[AppUser, Depends(require_role("editor"))],
        ) -> Fragment:
            ...

    Args:
        role: The minimum role required. Currently ``"editor"`` or ``"admin"``.

    Returns:
        A FastAPI Depends that resolves to the authenticated user if authorised,
        or raises HTTP 403 Forbidden.
    """
    _ROLE_HIERARCHY = {"editor": 1, "admin": 2}

    async def _check(user: Annotated[AuthenticatedUser, Depends(get_current_user)]) -> AuthenticatedUser:
        required_level = _ROLE_HIERARCHY.get(role, 0)
        user_level = _ROLE_HIERARCHY.get(user.role, 0)
        if user_level < required_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{role}' required; caller has role '{user.role}'.",
            )
        return user

    return Depends(_check)
