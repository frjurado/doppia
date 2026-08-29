"""User account and role-grant service.

PostgreSQL is the sole source of truth for roles (ADR-037). Supabase Auth
authenticates; it does not authorise. Everything that needs a caller's role set
— the ``get_current_user`` dependency, the login route, the admin user-management
surface — reads it from ``user_role`` through this module, never from a JWT
claim.

See docs/architecture/roles-and-permissions.md § 1 and ADR-037.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime

from errors import SelfAdminRevocationError, UserNotFoundError
from models.admin import AdminUserItem, AdminUserListResponse
from models.profile import SELF_DECLARED_ROLES, ProfileResponse, ProfileUpdateRequest
from models.roles import ADMIN, GRANTABLE_ROLES
from models.user import AppUser, UserRole
from services.permissions import Caller, require_verified
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

_DEFAULT_PAGE_SIZE = 50


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


async def revoke_role(
    db: AsyncSession,
    user_id: uuid.UUID,
    role: str,
    *,
    revoked_by: uuid.UUID | None = None,
) -> None:
    """Remove a role grant. A no-op if the user does not hold it.

    Args:
        db: Async database session.
        user_id: The user losing the grant.
        role: The role to revoke.
        revoked_by: The admin performing the revocation, when there is one.
            Supplied so the self-demotion guard can fire; ``None`` for system
            revocations, which are not guarded.

    Raises:
        SelfAdminRevocationError: If an admin revokes their own ``admin`` role.
            The one guard worth having here: an instance can end up with no
            admin at all, and there is no self-service path back. Revoking
            somebody *else's* admin is allowed — that is a normal, reversible
            administrative act.
    """
    if role == ADMIN and revoked_by is not None and revoked_by == user_id:
        raise SelfAdminRevocationError(
            "You cannot revoke your own admin role.",
            detail={"user_id": str(user_id), "role": role},
        )
    await db.execute(
        delete(UserRole).where(UserRole.user_id == user_id, UserRole.role == role)
    )
    await db.commit()


async def list_users(
    db: AsyncSession,
    *,
    query: str | None = None,
    cursor: str | None = None,
    page_size: int = _DEFAULT_PAGE_SIZE,
) -> AdminUserListResponse:
    """Return one page of accounts with their granted roles.

    Newest first: during an invite-only launch the account an admin wants is
    almost always the one they just invited.

    Roles are fetched in a second query keyed on the page's ids rather than by
    joining, so that a user holding three roles stays one row and the page size
    means what it says.

    Args:
        db: Async database session.
        query: Optional case-insensitive substring match on email or display
            name.
        cursor: Opaque cursor from a previous page.
        page_size: Maximum accounts to return.

    Returns:
        An :class:`~models.admin.AdminUserListResponse`.
    """
    statement = (
        select(AppUser)
        .order_by(AppUser.created_at.desc(), AppUser.id.desc())
        .limit(page_size + 1)
    )
    if query:
        pattern = f"%{query.strip()}%"
        statement = statement.where(
            func.lower(AppUser.email).like(func.lower(pattern))
            | func.lower(func.coalesce(AppUser.display_name, "")).like(
                func.lower(pattern)
            )
        )
    keyset = _decode_user_cursor(cursor)
    if keyset is not None:
        created_at, user_id = keyset
        statement = statement.where(
            (AppUser.created_at, AppUser.id) < (created_at, user_id)
        )

    rows = list((await db.execute(statement)).scalars().all())
    has_next = len(rows) > page_size
    page = rows[:page_size]

    grants: dict[uuid.UUID, list[str]] = {}
    if page:
        granted = await db.execute(
            select(UserRole.user_id, UserRole.role).where(
                UserRole.user_id.in_([row.id for row in page])
            )
        )
        for user_id, role in granted.all():
            grants.setdefault(user_id, []).append(role)

    return AdminUserListResponse(
        items=[
            AdminUserItem(
                id=str(row.id),
                email=row.email,
                display_name=row.display_name,
                roles=sorted(grants.get(row.id, [])),
                created_at=row.created_at,
            )
            for row in page
        ],
        next_cursor=(
            _encode_user_cursor(page[-1].created_at, page[-1].id)
            if has_next and page
            else None
        ),
    )


async def get_admin_user(db: AsyncSession, user_id: uuid.UUID) -> AdminUserItem:
    """Return one account as the admin list shows it.

    Args:
        db: Async database session.
        user_id: The account to read.

    Returns:
        The :class:`~models.admin.AdminUserItem`.

    Raises:
        UserNotFoundError: If no such account exists.
    """
    row = await db.get(AppUser, user_id)
    if row is None:
        raise UserNotFoundError(
            "No account exists with this id.", detail={"user_id": str(user_id)}
        )
    return AdminUserItem(
        id=str(row.id),
        email=row.email,
        display_name=row.display_name,
        roles=sorted(await load_roles(db, str(row.id))),
        created_at=row.created_at,
    )


def _encode_user_cursor(created_at: datetime, user_id: uuid.UUID) -> str:
    """Encode a ``(created_at, id)`` keyset position as an opaque cursor."""
    return base64.urlsafe_b64encode(
        f"{created_at.isoformat()}|{user_id}".encode()
    ).decode()


def _decode_user_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    """Decode a cursor, or return ``None`` for absent or malformed input."""
    if not cursor:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        timestamp, user_id = raw.split("|", 1)
        return datetime.fromisoformat(timestamp), uuid.UUID(user_id)
    except Exception:
        return None


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
