"""FastAPI dependency functions for authentication and authorisation.

``require_role()`` is one of the two permitted permission mechanisms; the other
is ``require_owner_or_role()`` in ``services/permissions.py``. No inline role or
ownership checks anywhere else.
See CONTRIBUTING.md § Invariants and docs/architecture/security-model.md.

Authentication is handled upstream by ``api.middleware.auth.AuthMiddleware``,
which validates the JWT and attaches the user to ``request.state.user``.
``get_current_user`` reads from that state, loads the caller's role set from
PostgreSQL, and ``require_role`` checks it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Request, status
from models.base import get_db
from neo4j import AsyncDriver
from redis.asyncio import Redis
from services.i18n import normalize_language, parse_accept_language
from services.object_storage import StorageClient, make_storage_client
from services.users import ensure_app_user, load_roles
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class AppUser:
    """Represents the authenticated caller on a request.

    Attributes:
        id: The user's UUID (from Supabase Auth JWT ``sub`` claim, or synthetic in dev).
        roles: The roles granted to the user in ``user_role``. Empty for a plain
            registered account — ``registered`` is implicit in authenticating and
            is never stored as a grant (ADR-037).
        email: The user's email address.
        email_verified: Whether Supabase has confirmed the address
            (``email_confirmed_at`` on the token). Unverified accounts may log
            in but not create content — see ``services.permissions.require_verified``.
        declared_role: The optional self-description captured at registration,
            read from Supabase user metadata. Profile data, never authorisation:
            it seeds the ``app_user`` row on first sight and is ignored
            afterwards, the profile page being authoritative.
    """

    id: str
    roles: frozenset[str]
    email: str
    email_verified: bool = False
    declared_role: str | None = None


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> AppUser:
    """FastAPI dependency that returns the authenticated user for the current request.

    Reads the user attached to ``request.state.user`` by ``AuthMiddleware`` and
    resolves its role set from ``user_role``. The JWT is not consulted for roles:
    PostgreSQL is the sole source of truth (ADR-037).

    When ``AUTH_MODE=supabase`` (staging/production), also upserts a row into
    ``app_user`` so that ``fragment.created_by`` FK constraints pass without
    requiring a separate provisioning step. The upsert carries no role — grants
    are made by an admin, never inferred from a token claim. In ``AUTH_MODE=local``
    the dev users and their grants are seeded by ``scripts/seed_dev_users.py``.

    Args:
        request: The incoming FastAPI request.
        db: Async database session (injected).

    Returns:
        The authenticated user, with ``roles`` populated.

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
    if os.environ.get("AUTH_MODE", "supabase") == "supabase" and user.email:
        await ensure_app_user(db, user.id, user.email, user.declared_role)
    roles = await load_roles(db, user.id)
    # The role lookup autobegins a transaction on the request-scoped session.
    # Close it: service functions that own a unit of work open their own
    # ``async with db.begin()`` block, which raises if a transaction is already
    # open. Nothing can be lost here — dependencies resolve before the route
    # handler runs, and ``ensure_app_user`` has already committed its upsert.
    await db.rollback()
    return replace(user, roles=roles)


def require_role(*roles: str) -> Annotated[AppUser, Depends]:
    """Dependency factory enforcing that the caller holds any of ``roles``.

    This is the only permitted way to enforce roles in route handlers; ownership
    checks go through ``services.permissions.require_owner_or_role``. Do not
    perform inline role checks in route handlers or service functions.

    The check is **any-of**, not a hierarchy: ``require_role(EDITOR)`` admits an
    editor only. Where the permission matrix
    (``docs/architecture/roles-and-permissions.md`` § 2) gives a capability to
    several roles, every one of them is named — ``require_role(EDITOR, ADMIN)``.
    An implicit "admin passes everything" rule is deliberately absent: it would
    also hand admin the author-only capabilities the matrix withholds.

    Usage::

        @router.post(
            "/fragments/{id}/approve",
            dependencies=[require_role(EDITOR, ADMIN)],
        )

    Args:
        *roles: The accepted role names, from :mod:`models.roles`.

    Returns:
        A FastAPI Depends that resolves to the authenticated user if authorised,
        or raises HTTP 403 Forbidden.
    """

    accepted = frozenset(roles)

    async def _check(user: Annotated[AppUser, Depends(get_current_user)]) -> AppUser:
        if not accepted & user.roles:
            held = ", ".join(sorted(user.roles)) or "none"
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"One of the roles [{', '.join(sorted(accepted))}] is required; "
                    f"caller holds [{held}]."
                ),
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
