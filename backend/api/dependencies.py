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

import os
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Request, status
from models.base import get_db
from neo4j import AsyncDriver
from redis.asyncio import Redis
from services.i18n import normalize_language, parse_accept_language
from services.object_storage import StorageClient, make_storage_client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_ROLE_HIERARCHY: dict[str, int] = {"editor": 1, "admin": 2}


@dataclass(frozen=True)
class AppUser:
    """Represents the authenticated caller on a request.

    Attributes:
        id: The user's UUID (from Supabase Auth JWT ``sub`` claim, or synthetic in dev).
        role: One of ``editor`` or ``admin`` in Phase 1.
        email: The user's email address.
    """

    id: str
    role: str
    email: str


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> AppUser:
    """FastAPI dependency that returns the authenticated user for the current request.

    Reads the user attached to ``request.state.user`` by ``AuthMiddleware``.
    Raises HTTP 401 if no user is present (i.e. the request carried no
    ``Authorization`` header).

    When ``AUTH_MODE=supabase`` (staging/production), also upserts a row into
    ``app_user`` so that ``fragment.created_by`` FK constraints pass without
    requiring a separate provisioning step. The upsert is idempotent and also
    keeps ``email`` and ``role`` current with the Supabase JWT claims. In
    ``AUTH_MODE=local`` the dev users are seeded separately via
    ``scripts/seed_dev_users.py``.

    Args:
        request: The incoming FastAPI request.
        db: Async database session (injected).

    Returns:
        The authenticated user.

    Raises:
        HTTPException: 401 if no user is attached to the request state.
    """
    user: AppUser | None = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if os.environ.get("AUTH_MODE", "supabase") == "supabase" and user.role:
        await db.execute(
            text(
                "INSERT INTO app_user (id, email, role) "
                "VALUES (:id, :email, :role) "
                "ON CONFLICT (id) DO UPDATE "
                "SET email = EXCLUDED.email, role = EXCLUDED.role"
            ),
            {"id": user.id, "email": user.email, "role": user.role},
        )
        await db.commit()
    return user


def require_role(role: str) -> Annotated[AppUser, Depends]:
    """Dependency factory that enforces a minimum role requirement.

    This is the **only** permitted way to enforce roles in route handlers.
    Do not perform inline role checks in route handlers or service functions.

    Usage::

        @router.post("/fragments/{id}/approve")
        async def approve_fragment(
            id: UUID,
            db: AsyncSession = Depends(get_db),
        ) -> Fragment:
            ...

        # Register the role check via the router decorator:
        @router.post(
            "/fragments/{id}/approve",
            dependencies=[require_role("editor")],
        )

    Args:
        role: The minimum role required. Currently ``"editor"`` or ``"admin"``.

    Returns:
        A FastAPI Depends that resolves to the authenticated user if authorised,
        or raises HTTP 403 Forbidden.
    """

    async def _check(user: Annotated[AppUser, Depends(get_current_user)]) -> AppUser:
        required_level = _ROLE_HIERARCHY.get(role, 0)
        user_level = _ROLE_HIERARCHY.get(user.role, 0)
        if user_level < required_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{role}' required; caller has role '{user.role}'.",
            )
        return user

    return Depends(_check)


def get_language(
    request: Request,
    language: str | None = Query(
        None,
        description=(
            "Explicit BCP 47 language tag (e.g. 'es'). Overrides the "
            "Accept-Language header. Unsupported values fall back to 'en'."
        ),
    ),
) -> str:
    """FastAPI dependency resolving the effective response language (ADR-006).

    Resolution order: an explicit ``?language=`` query parameter wins;
    otherwise the request's ``Accept-Language`` header is parsed; otherwise the
    canonical default ('en'). The result is always a supported language — an
    unsupported or malformed request degrades to 'en' rather than erroring, so
    the translation overlay never raises on locale negotiation.

    Args:
        request: The incoming FastAPI request (source of ``Accept-Language``).
        language: Optional explicit language query parameter.

    Returns:
        A language tag guaranteed to be in
        :data:`~services.i18n.SUPPORTED_LANGUAGES`.
    """
    if language is not None:
        return normalize_language(language)
    return parse_accept_language(request.headers.get("accept-language"))


async def get_neo4j(request: Request) -> AsyncDriver:
    """FastAPI dependency that returns the application Neo4j async driver.

    The driver is stored on ``app.state.neo4j_driver`` by the lifespan hook in
    ``main.py``.  Override this dependency in tests to inject a mock driver
    without touching application state.

    Args:
        request: The incoming FastAPI request.

    Returns:
        The application-scoped :class:`neo4j.AsyncDriver` instance.
    """
    return request.app.state.neo4j_driver


async def get_redis(request: Request) -> Redis | None:
    """FastAPI dependency that returns the application Redis client, or None.

    The client is stored on ``app.state.redis_client`` by the lifespan hook.
    Returns ``None`` when Redis is unavailable (the subtree cache is skipped
    gracefully).

    Args:
        request: The incoming FastAPI request.

    Returns:
        The application-scoped :class:`redis.asyncio.Redis` instance, or
        ``None`` if Redis was not reachable at startup.
    """
    return getattr(request.app.state, "redis_client", None)


def get_storage() -> StorageClient:
    """FastAPI dependency that returns a configured object storage client.

    Returns:
        A :class:`~services.object_storage.StorageClient` built from
        environment variables.  Use ``app.dependency_overrides[get_storage]``
        in tests to inject a fake storage without hitting MinIO/R2.
    """
    return make_storage_client()
