"""Account deletion: delete what the user owns, reassign what the platform owns.

The asymmetry is the whole design (``roles-and-permissions.md`` § 5, ADR-038):

* **Deleted** — profile, role grants, exercise sessions and results, reading
  history, and (from Component 13) collections and reports filed. These are the
  user's own data and go with them.
* **Reassigned** to the ``deleted-user`` system account — fragments created,
  reviews given, translations made. These are the platform's editorial record;
  removing them would rewrite the corpus's provenance and break the
  review-integrity history that ``SelfReviewForbiddenError`` depends on.

The reassignment is not merely a policy: `fragment_review.reviewer_id` is
``ON DELETE RESTRICT``, so a bare ``DELETE FROM app_user`` fails loudly rather
than quietly taking reviews with it. That constraint is the design working.

Ordering: PostgreSQL commits first, the Supabase Auth user is deleted after. An
``app_user`` row whose auth user is gone is recoverable by an admin; an auth
user whose application data is gone is an account that logs in to nothing and
can no longer be deleted through this path.
"""

from __future__ import annotations

import logging
import os
import uuid

from errors import AuthorizationError, UserNotFoundError
from models.roles import ADMIN
from models.user import SYSTEM_USER_ID, AppUser
from services.permissions import Caller, require_owner_or_role
from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

#: Editorial columns that point at ``app_user`` and must survive the account
#: they point at. Each entry is ``(table, column)``; every one is reassigned to
#: :data:`~models.user.SYSTEM_USER_ID` before the row is deleted.
#:
#: ``user_role.granted_by`` is here for a different reason: it is an audit
#: trail on *other people's* grants, and its foreign key has no ``ON DELETE``
#: action, so leaving it would simply block the deletion. Pointing it at the
#: system user says "granted by an account that no longer exists", which is
#: truer than the ``NULL`` that means "no known granter".
#:
#: The two ``translator_id`` columns are ``ON DELETE SET NULL``, so they would
#: not block anything — but nulling them would anonymise an editorial
#: contribution, which is exactly what the reassignment rule exists to prevent.
#: Reassigning explicitly means the SET NULL never fires.
_REASSIGNED: tuple[tuple[str, str], ...] = (
    ("fragment", "created_by"),
    ("fragment_review", "reviewer_id"),
    ("concept_translation", "translator_id"),
    ("fragment_annotation_translation", "translator_id"),
    ("user_role", "granted_by"),
)


async def delete_account(db: AsyncSession, caller: Caller, target_id: str) -> None:
    """Delete an account, reassigning its editorial contributions.

    The PostgreSQL side is one transaction: either every reassignment lands and
    the row goes, or nothing changes. The Supabase Auth deletion follows, once
    that transaction has committed.

    Args:
        db: Async database session.
        caller: The authenticated caller. Deleting your own account is allowed;
            deleting someone else's requires ``admin``.
        target_id: UUID of the account to delete.

    Raises:
        AuthorizationError: If the caller neither owns the account nor is an
            admin, or if the target is the system user.
        UserNotFoundError: If no such account exists.
        SupabaseAuthError: If the Auth deletion fails *after* the database
            commit. The application data is gone by then; the auth user is not,
            and an admin must remove it.
    """
    account_id = uuid.UUID(target_id)
    if account_id == SYSTEM_USER_ID:
        # Not merely unauthorised — deleting the reassignment target would
        # orphan every editorial contribution already pointed at it.
        raise AuthorizationError(
            "The system user cannot be deleted.",
            detail={"user_id": target_id},
        )

    row = await db.get(AppUser, account_id)
    if row is None:
        raise UserNotFoundError(
            "No account exists with this id.", detail={"user_id": target_id}
        )
    # The account is its own owner, so ``id`` is the owner column here.
    require_owner_or_role(caller, row, ADMIN, owner_attr="id")

    # One unit of work: every reassignment and the delete land together, or
    # nothing does. Written as commit/rollback rather than ``db.begin()``
    # because the request-scoped session may already have an open transaction,
    # and a service must not care which.
    try:
        await _reassign(db, account_id)
        # Everything still pointing here is ON DELETE CASCADE — role grants,
        # exercise sessions (and their results), reading history.
        await db.execute(delete(AppUser).where(AppUser.id == account_id))
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    await _delete_auth_user(target_id)


async def reassign_to_system_user(db: AsyncSession, target_id: str) -> None:
    """Reassign one account's editorial contributions without deleting it.

    Exposed for operational repair — an interrupted deletion, or a data fix-up
    that needs the reassignment half on its own. Ordinary deletion goes through
    :func:`delete_account`.

    Args:
        db: Async database session.
        target_id: UUID of the account whose contributions move.
    """
    try:
        await _reassign(db, uuid.UUID(target_id))
        await db.commit()
    except Exception:
        await db.rollback()
        raise


async def _reassign(db: AsyncSession, account_id: uuid.UUID) -> None:
    """Point every editorial reference to ``account_id`` at the system user.

    Does not commit: the caller owns the transaction boundary.

    Args:
        db: Async database session.
        account_id: The account whose references move.
    """
    for table, column in _REASSIGNED:
        await db.execute(
            text(f"UPDATE {table} SET {column} = :system WHERE {column} = :target"),
            {"system": SYSTEM_USER_ID, "target": account_id},
        )


async def _delete_auth_user(target_id: str) -> None:
    """Remove the Supabase Auth user, unless running on the dev auth bypass.

    Args:
        target_id: The Supabase user id.

    Raises:
        SupabaseAuthError: If Auth is unreachable or refuses the deletion.
    """
    if os.environ.get("AUTH_MODE", "supabase") != "supabase":
        # The dev bypass has no Supabase account behind its synthetic users.
        logger.info("AUTH_MODE is not 'supabase'; skipping the Supabase Auth deletion.")
        return
    from services.supabase_auth import delete_auth_user

    await delete_auth_user(target_id)
