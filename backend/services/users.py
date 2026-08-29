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

from errors import UserNotFoundError
from models.profile import SELF_DECLARED_ROLES, ProfileResponse, ProfileUpdateRequest
from models.roles import GRANTABLE_ROLES
from models.user import AppUser, UserRole
from services.permissions import Caller, require_verified
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession


async def ensure_app_user(
    db: AsyncSession,
    user_id: str,
    email: str,
    self_declared_role: str | None = None,
) -> None:
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
        self_declared_role: Optional registration-time self-description. Seeded
            **on insert only** — once the row exists the profile page owns the
            field, and a stale metadata copy must never overwrite a later edit.
    """
    values: dict = {"id": uuid.UUID(user_id), "email": email}
    if self_declared_role in SELF_DECLARED_ROLES:
        values["self_declared_role"] = self_declared_role
    statement = (
        insert(AppUser)
        .values(**values)
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


async def get_profile(db: AsyncSession, user: Caller) -> ProfileResponse:
    """Return the caller's own account, roles included read-only.

    Verification status comes from the caller rather than from the row: it lives
    on the Supabase token, and ``app_user`` deliberately does not mirror it —
    one source of truth, checked fresh on every request.

    Args:
        db: Async database session.
        user: The authenticated caller.

    Returns:
        The assembled :class:`~models.profile.ProfileResponse`.

    Raises:
        UserNotFoundError: If no ``app_user`` row exists. In practice the JIT
            upsert in ``get_current_user`` has already created it, so this means
            something is genuinely inconsistent rather than merely new.
    """
    return await _profile_for(db, user)


async def update_profile(
    db: AsyncSession,
    user: Caller,
    payload: ProfileUpdateRequest,
) -> ProfileResponse:
    """Apply a partial profile edit for the authenticated caller.

    Only fields actually present in the request are touched: ``None`` means
    "clear this" for the two nullable fields, so absence has to be distinguished
    from an explicit null. ``model_fields_set`` is what draws that line.

    Args:
        db: Async database session.
        user: The authenticated caller (needs ``id`` and ``email_verified``).
        payload: The partial edit.

    Returns:
        The updated profile.

    Raises:
        EmailNotVerifiedError: If the caller's address is unconfirmed — profile
            edits are content creation for this purpose.
        UserNotFoundError: If no ``app_user`` row exists.
    """
    require_verified(user)

    row = await _row_for(db, user.id)
    supplied = payload.model_fields_set
    if "display_name" in supplied:
        # An all-whitespace name is not a name; treat it as clearing the field
        # rather than storing a string that renders as an empty account menu.
        cleaned = (payload.display_name or "").strip()
        row.display_name = cleaned or None
    if "self_declared_role" in supplied:
        row.self_declared_role = payload.self_declared_role
    if (
        "reading_history_opt_in" in supplied
        and payload.reading_history_opt_in is not None
    ):
        row.reading_history_opt_in = payload.reading_history_opt_in

    await db.commit()
    return await _profile_for(db, user, row=row)


async def _row_for(db: AsyncSession, user_id: str) -> AppUser:
    """Load the caller's ``app_user`` row or raise.

    Args:
        db: Async database session.
        user_id: The caller's UUID.

    Returns:
        The ORM row.

    Raises:
        UserNotFoundError: If no row exists.
    """
    row = await db.get(AppUser, uuid.UUID(user_id))
    if row is None:
        raise UserNotFoundError(
            "No account exists for this caller.", detail={"user_id": user_id}
        )
    return row


async def _profile_for(
    db: AsyncSession, user: Caller, *, row: AppUser | None = None
) -> ProfileResponse:
    """Assemble the profile response for a caller.

    Args:
        db: Async database session.
        user: The authenticated caller (source of verification status).
        row: The already-loaded row, when the caller has one.

    Returns:
        The assembled response.

    Raises:
        UserNotFoundError: If no row exists.
    """
    row = row or await _row_for(db, user.id)
    return ProfileResponse(
        id=str(row.id),
        email=row.email,
        email_verified=user.email_verified,
        display_name=row.display_name,
        self_declared_role=row.self_declared_role,
        reading_history_opt_in=row.reading_history_opt_in,
        roles=sorted(await load_roles(db, user.id)),
    )
