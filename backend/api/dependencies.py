"""FastAPI dependency functions for authentication and authorisation.

The sole permitted role enforcement mechanism is ``require_role()``.
No inline role checks in route handlers or service functions.
See CONTRIBUTING.md § Invariants and docs/architecture/security-model.md.

Authentication is handled upstream by ``api.middleware.auth.AuthMiddleware``,
which validates the JWT and attaches the user to ``request.state.user``.
``get_current_user`` reads from that state; ``require_role`` enforces the
minimum role level.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status


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


async def get_current_user(request: Request) -> AuthenticatedUser:
    """FastAPI dependency that returns the authenticated user for the current request.

    Reads the user attached to ``request.state.user`` by ``AuthMiddleware``.
    Raises HTTP 401 if no user is present (i.e. the request carried no
    ``Authorization`` header).

    Args:
        request: The incoming FastAPI request.

    Returns:
        The authenticated user.

    Raises:
        HTTPException: 401 if no user is attached to the request state.
    """
    user: AuthenticatedUser | None = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


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

    async def _check(
        user: Annotated[AuthenticatedUser, Depends(get_current_user)]
    ) -> AuthenticatedUser:
        required_level = _ROLE_HIERARCHY.get(role, 0)
        user_level = _ROLE_HIERARCHY.get(user.role, 0)
        if user_level < required_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{role}' required; caller has role '{user.role}'.",
            )
        return user

    return Depends(_check)
