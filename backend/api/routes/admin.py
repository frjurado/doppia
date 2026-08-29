"""Admin-only management endpoints.

    POST   /api/v1/admin/dispatch-pending-analysis
    GET    /api/v1/admin/users
    POST   /api/v1/admin/users/{user_id}/roles
    DELETE /api/v1/admin/users/{user_id}/roles/{role}
    POST   /api/v1/admin/invites

Every route here carries ``require_role(ADMIN)``. User management is what makes
an invite-only launch operable without handing anyone the Supabase dashboard
(``roles-and-permissions.md`` § 2).

See docs/adr/ADR-018-partial-failure-recovery-for-ingestion.md,
docs/adr/ADR-037-role-model-migration.md.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Annotated

from api.dependencies import AppUser, require_role
from fastapi import APIRouter, Depends, Path, Query
from models.admin import (
    AdminUserItem,
    AdminUserListResponse,
    InviteRequest,
    InviteResponse,
    RoleGrantRequest,
)
from models.base import get_db
from models.roles import ADMIN
from pydantic import BaseModel
from services import users as users_service
from services.supabase_auth import invite_user
from services.task_dispatch import dispatch_task
from services.tasks.ingest_analysis import ingest_movement_analysis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])


class DispatchPendingAnalysisReport(BaseModel):
    """Response body for POST /admin/dispatch-pending-analysis.

    Attributes:
        dispatched: Number of tasks successfully enqueued.
        failed_to_dispatch: Movement UUIDs whose task could not be enqueued
            (broker unreachable or unexpected error).  Empty list on full
            success.
    """

    dispatched: int
    failed_to_dispatch: list[str]


@router.post(
    "/dispatch-pending-analysis",
    status_code=200,
    response_model=DispatchPendingAnalysisReport,
    dependencies=[require_role(ADMIN)],
    summary="Re-dispatch analysis tasks for all pending movements",
    response_description="Count of dispatched tasks and list of any dispatch failures.",
)
async def dispatch_pending_analysis(
    db: AsyncSession = Depends(get_db),
) -> DispatchPendingAnalysisReport:
    """Enqueue ingest_movement_analysis for every movement with pending_analysis=TRUE.

    Each movement is eligible for dispatch if its ``pending_analysis`` flag is
    ``TRUE``, which happens when the original task dispatch failed (broker
    unreachable) or the task itself crashed before the analysis was written.

    The endpoint does **not** flip the flag — ``pending_analysis`` stays
    ``TRUE`` until a successful analysis write clears it inside the task.
    Re-running the endpoint is therefore safe: movements that have already
    been analysed since the last call will have ``pending_analysis=FALSE`` and
    will not be re-dispatched.

    Note: for DCML corpora, ``harmonies_tsv_content`` is not stored in R2 and
    is not available at re-dispatch time.  Those tasks will fail at execution
    with ``ValueError: harmonies_tsv_content is required``; ``pending_analysis``
    will remain ``TRUE``.  The proper recovery path for DCML movements is to
    re-upload the corpus ZIP, which passes the harmonies file through the normal
    ingestion pipeline.

    Args:
        db: Async database session (injected).

    Returns:
        :class:`DispatchPendingAnalysisReport` with dispatch counts.
    """
    rows = (
        await db.execute(
            text(
                "SELECT m.id, c.analysis_source "
                "FROM movement m "
                "JOIN work w ON w.id = m.work_id "
                "JOIN corpus c ON c.id = w.corpus_id "
                "WHERE m.pending_analysis = TRUE"
            )
        )
    ).fetchall()

    dispatched = 0
    failed: list[str] = []

    for row in rows:
        movement_id: uuid.UUID = row.id
        analysis_source: str = row.analysis_source or "none"
        try:
            dispatch_task(
                ingest_movement_analysis,
                movement_id=str(movement_id),
                analysis_source=analysis_source,
                harmonies_tsv_content=None,
            )
            dispatched += 1
        except Exception as exc:
            logger.warning(
                "dispatch-pending-analysis: could not enqueue movement %s: %s",
                movement_id,
                exc,
            )
            failed.append(str(movement_id))

    return DispatchPendingAnalysisReport(
        dispatched=dispatched,
        failed_to_dispatch=failed,
    )


# ── User management (Step 10) ─────────────────────────────────────────────────


@router.get(
    "/users",
    response_model=AdminUserListResponse,
    dependencies=[require_role(ADMIN)],
    summary="List accounts with their granted roles",
    response_description=(
        "Cursor-paginated accounts, newest first, each with the roles granted "
        "in ``user_role``."
    ),
)
async def list_users(
    query: str | None = Query(
        None,
        description="Case-insensitive substring match on email or display name.",
        max_length=200,
    ),
    cursor: str | None = Query(None, description="Opaque cursor from a prior page."),
    page_size: int = Query(50, ge=1, le=200, description="Accounts per page."),
    db: AsyncSession = Depends(get_db),
) -> AdminUserListResponse:
    """Return one page of accounts.

    Args:
        query: Optional substring filter on email or display name.
        cursor: Opaque pagination cursor.
        page_size: Accounts per page.
        db: Async database session.

    Returns:
        An :class:`~models.admin.AdminUserListResponse`.
    """
    return await users_service.list_users(
        db, query=query, cursor=cursor, page_size=page_size
    )


@router.post(
    "/users/{user_id}/roles",
    response_model=AdminUserItem,
    summary="Grant a role to an account",
    response_description="The account with its roles after the grant.",
)
async def grant_role(
    payload: RoleGrantRequest,
    admin: Annotated[AppUser, require_role(ADMIN)],
    user_id: uuid.UUID = Path(..., description="Account receiving the grant"),
    db: AsyncSession = Depends(get_db),
) -> AdminUserItem:
    """Grant one role, recording who granted it.

    Idempotent: re-granting a held role leaves the original ``granted_by`` and
    ``granted_at`` untouched rather than rewriting the grant's history.

    Args:
        payload: The role to grant.
        admin: The granting admin (recorded as ``granted_by``).
        user_id: The account receiving the grant.
        db: Async database session.

    Returns:
        The updated :class:`~models.admin.AdminUserItem`.

    Raises:
        UserNotFoundError: 404 if the account does not exist.
    """
    # Fetch first: granting into a nonexistent account would otherwise surface
    # as a foreign-key error rather than an honest 404.
    await users_service.get_admin_user(db, user_id)
    await users_service.grant_role(
        db, user_id, payload.role, granted_by=uuid.UUID(admin.id)
    )
    return await users_service.get_admin_user(db, user_id)


@router.delete(
    "/users/{user_id}/roles/{role}",
    response_model=AdminUserItem,
    summary="Revoke a role from an account",
    response_description="The account with its roles after the revocation.",
)
async def revoke_role(
    admin: Annotated[AppUser, require_role(ADMIN)],
    user_id: uuid.UUID = Path(..., description="Account losing the grant"),
    role: str = Path(..., description="The role to revoke"),
    db: AsyncSession = Depends(get_db),
) -> AdminUserItem:
    """Revoke one role.

    A no-op if the account does not hold it. Revoking your **own** admin role
    is refused: an instance can end up with no admin at all and there is no
    self-service path back. Revoking somebody else's is a normal, reversible
    administrative act and is allowed.

    Args:
        admin: The revoking admin.
        user_id: The account losing the grant.
        role: The role to revoke.
        db: Async database session.

    Returns:
        The updated :class:`~models.admin.AdminUserItem`.

    Raises:
        UserNotFoundError: 404 if the account does not exist.
        SelfAdminRevocationError: 409 if an admin revokes their own admin role.
    """
    await users_service.get_admin_user(db, user_id)
    await users_service.revoke_role(db, user_id, role, revoked_by=uuid.UUID(admin.id))
    return await users_service.get_admin_user(db, user_id)


@router.post(
    "/invites",
    response_model=InviteResponse,
    status_code=202,
    dependencies=[require_role(ADMIN)],
    summary="Invite someone to create an account",
    response_description="The address invited and when.",
)
async def issue_invite(payload: InviteRequest) -> InviteResponse:
    """Send a Supabase invitation email.

    202 rather than 201: what this creates is an email in flight, not an
    account the caller can then read back. The account exists in Supabase in an
    unconfirmed state and reaches ``app_user`` on first sign-in.

    Args:
        payload: The address to invite.

    Returns:
        An :class:`~models.admin.InviteResponse`.

    Raises:
        SupabaseAuthError: 503 if Auth is unreachable or admin credentials are
            unset; 422 if the address already has an account.
    """
    await invite_user(payload.email)
    return InviteResponse(email=payload.email, invited_at=datetime.now(timezone.utc))
