"""User account and role-grant service.

PostgreSQL is the sole source of truth for roles (ADR-037). Supabase Auth
authenticates; it does not authorise. Everything that needs a caller's role set
— the ``get_current_user`` dependency, the login route, the admin user-management
surface — reads it from ``user_role`` through this module, never from a JWT
claim.

See docs/architecture/roles-and-permissions.md § 1 and ADR-037.
"""

from __future__ import annotations

import uuid

from models.roles import GRANTABLE_ROLES
from models.user import AppUser, UserRole
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession


async def ensure_app_user(db: AsyncSession, user_id: str, email: str) -> None:
    """Insert or refresh the ``app_user`` row backing an authenticated caller.

    Supabase Auth owns the account; this mirror row exists so that
    ``fragment.created_by`` and ``fragment_review.reviewer_id`` foreign keys
    resolve without a separate provisioning step. The upsert is idempotent and
    keeps ``email`` current with the token.

    It deliberately writes **no** role: grants live in ``user_role`` and are
    made by an admin, never inferred from a token claim.

    Args:
        db: Async database session.
        user_id: The Supabase user id (the JWT ``sub`` claim).
        email: The user's email address as carried by the token.
    """
    statement = (
        insert(AppUser)
        .values(id=uuid.UUID(user_id), email=email)
        .on_conflict_do_update(index_elements=[AppUser.id], set_={"email": email})
    )
    await db.execute(statement)
    await db.commit()


async def load_roles(db: AsyncSession, user_id: str) -> frozenset[str]:
    """Return the set of roles granted to a user.

    An account with no grants is a plain registered user and yields an empty
    set — ``registered`` is implicit in holding an account and is never stored.

    Args:
        db: Async database session.
        user_id: The user's UUID as a string.

    Returns:
        The granted role names, or an empty set for a plain registered user.
    """
    result = await db.execute(
        select(UserRole.role).where(UserRole.user_id == uuid.UUID(user_id))
    )
    return frozenset(result.scalars().all())


async def grant_role(
    db: AsyncSession, user_id: uuid.UUID, role: str, granted_by: uuid.UUID | None
) -> None:
    """Grant ``role`` to a user, recording who granted it.

    Idempotent: re-granting an existing role leaves the original
    ``granted_by``/``granted_at`` audit values untouched rather than rewriting
    the grant's history.

    Args:
        db: Async database session.
        user_id: The user receiving the grant.
        role: One of :data:`~models.roles.GRANTABLE_ROLES`.
        granted_by: The admin making the grant, or ``None`` for system grants
            (migrated Phase 1 roles, seeded dev users).

    Raises:
        ValueError: If ``role`` is not a grantable role name.
    """
    if role not in GRANTABLE_ROLES:
        raise ValueError(f"'{role}' is not a grantable role.")
    statement = (
        insert(UserRole)
        .values(user_id=user_id, role=role, granted_by=granted_by)
        .on_conflict_do_nothing(index_elements=[UserRole.user_id, UserRole.role])
    )
    await db.execute(statement)
    await db.commit()


async def revoke_role(db: AsyncSession, user_id: uuid.UUID, role: str) -> None:
    """Remove a role grant. A no-op if the user does not hold it.

    Args:
        db: Async database session.
        user_id: The user losing the grant.
        role: The role to revoke.
    """
    await db.execute(
        delete(UserRole).where(UserRole.user_id == user_id, UserRole.role == role)
    )
    await db.commit()
