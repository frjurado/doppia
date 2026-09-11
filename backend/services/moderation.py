"""Moderation: filing reports and working the admin queue (Step 11).

Half of this ships dark. :func:`file_report` has no route in Component 12
because nothing is reportable yet — Component 13 adds the endpoint alongside
the shared-collection surface it reports on. It is written and tested now so
the moderation tool is genuinely live before sharing is, rather than nominally
so (``phase-2.md`` § Component 13).

:func:`resolve_report` takes the outcome as an argument, so Component 13's
"unpublish share" joins as the first ``actioned`` resolution without touching
this module. Component 12 exposes only dismissal, because there is nothing to
action.

No deletion of user content by moderation, and no bans: an admin can disable an
egregious account through Supabase (``roles-and-permissions.md`` § 4).
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone

from errors import (
    ModerationReportNotFoundError,
    ReportAlreadyOpenError,
    ReportAlreadyResolvedError,
)
from models.moderation import (
    REPORT_REASONS,
    RESOLUTIONS,
    ModerationReport,
    ReportItem,
    ReportListResponse,
    ReportRequest,
)
from models.user import AppUser
from services.permissions import Caller, require_verified
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

_DEFAULT_PAGE_SIZE = 50


async def file_report(
    db: AsyncSession, reporter: Caller, payload: ReportRequest
) -> uuid.UUID:
    """File a report against a resource.

    Ships without a route in Component 12 (see the module docstring).

    Args:
        db: Async database session.
        reporter: The authenticated caller filing the report.
        payload: What is being reported and why.

    Returns:
        The new report's id.

    Raises:
        EmailNotVerifiedError: If the reporter's address is unconfirmed —
            filing a report is content creation for this purpose
            (``roles-and-permissions.md`` § 3).
        ReportAlreadyOpenError: If this reporter already has an open report
            against this resource.
        ValueError: If ``reason`` is outside the vocabulary. Pydantic has
            already refused it at the API boundary; this guards the service's
            other callers.
    """
    require_verified(reporter)
    if payload.reason not in REPORT_REASONS:
        raise ValueError(f"'{payload.reason}' is not a reporting reason.")

    report = ModerationReport(
        resource_ref=payload.resource_ref,
        reporter_id=uuid.UUID(reporter.id),
        reason=payload.reason,
        detail=payload.detail,
        status="open",
    )
    db.add(report)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # The partial unique index, not a prior SELECT: two simultaneous reports
        # would both pass a check-then-insert, and only the index closes that.
        raise ReportAlreadyOpenError(
            "You already have an open report against this resource.",
            detail={"resource_ref": payload.resource_ref},
        ) from exc
    return report.id


async def list_reports(
    db: AsyncSession,
    *,
    status: str | None = "open",
    cursor: str | None = None,
    page_size: int = _DEFAULT_PAGE_SIZE,
) -> ReportListResponse:
    """Return one page of the moderation queue, oldest first.

    Oldest first because it is a queue: the report that has waited longest is
    the one that should be looked at next.

    Args:
        db: Async database session.
        status: Filter by status; ``None`` returns every report regardless.
        cursor: Opaque cursor from a previous page.
        page_size: Maximum rows to return.

    Returns:
        A :class:`~models.moderation.ReportListResponse`.
    """
    statement = (
        select(ModerationReport, AppUser.email)
        .join(AppUser, AppUser.id == ModerationReport.reporter_id)
        .order_by(ModerationReport.created_at, ModerationReport.id)
        .limit(page_size + 1)
    )
    if status is not None:
        statement = statement.where(ModerationReport.status == status)

    keyset = _decode_cursor(cursor)
    if keyset is not None:
        created_at, report_id = keyset
        statement = statement.where(
            (ModerationReport.created_at, ModerationReport.id) > (created_at, report_id)
        )

    rows = (await db.execute(statement)).all()
    has_next = len(rows) > page_size
    page = rows[:page_size]
    items = [
        ReportItem(
            id=str(report.id),
            resource_ref=report.resource_ref,
            reporter_id=str(report.reporter_id),
            reporter_email=email,
            reason=report.reason,
            detail=report.detail,
            status=report.status,
            created_at=report.created_at,
            resolved_by=str(report.resolved_by) if report.resolved_by else None,
            resolved_at=report.resolved_at,
        )
        for report, email in page
    ]
    next_cursor = (
        _encode_cursor(page[-1][0].created_at, page[-1][0].id)
        if has_next and page
        else None
    )
    return ReportListResponse(items=items, next_cursor=next_cursor)


async def resolve_report(
    db: AsyncSession, admin: Caller, report_id: uuid.UUID, resolution: str
) -> ReportItem:
    """Close a report, recording who closed it and when.

    Args:
        db: Async database session.
        admin: The resolving admin (authorised by ``require_role(ADMIN)`` on the
            route; this function records them, it does not re-check them).
        report_id: The report to close.
        resolution: ``dismissed`` (no change to the resource) or ``actioned``
            (the resource was changed). Component 13's unpublish-share is the
            first ``actioned`` outcome.

    Returns:
        The updated report.

    Raises:
        ModerationReportNotFoundError: If no such report exists.
        ReportAlreadyResolvedError: If it has already been closed — a second
            resolution would overwrite the audit trail of the first.
        ValueError: If ``resolution`` is not an outcome.
    """
    if resolution not in RESOLUTIONS:
        raise ValueError(f"'{resolution}' is not a resolution.")

    report = await db.get(ModerationReport, report_id)
    if report is None:
        raise ModerationReportNotFoundError(
            "No moderation report with this id exists.",
            detail={"report_id": str(report_id)},
        )
    if report.status != "open":
        raise ReportAlreadyResolvedError(
            "This report has already been closed.",
            detail={"report_id": str(report_id), "status": report.status},
        )

    report.status = resolution
    report.resolved_by = uuid.UUID(admin.id)
    report.resolved_at = datetime.now(timezone.utc)
    reporter_email = await db.scalar(
        select(AppUser.email).where(AppUser.id == report.reporter_id)
    )
    await db.commit()

    return ReportItem(
        id=str(report.id),
        resource_ref=report.resource_ref,
        reporter_id=str(report.reporter_id),
        reporter_email=reporter_email or "",
        reason=report.reason,
        detail=report.detail,
        status=report.status,
        created_at=report.created_at,
        resolved_by=str(report.resolved_by),
        resolved_at=report.resolved_at,
    )


def _encode_cursor(created_at: datetime, report_id: uuid.UUID) -> str:
    """Encode a ``(created_at, id)`` keyset position as an opaque cursor."""
    return base64.urlsafe_b64encode(
        f"{created_at.isoformat()}|{report_id}".encode()
    ).decode()


def _decode_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    """Decode a cursor, or return ``None`` for absent or malformed input.

    A malformed cursor restarts from the first page rather than raising: it is
    an opaque token the client should not be constructing, and a 500 on a stale
    bookmark helps nobody.
    """
    if not cursor:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        timestamp, report_id = raw.split("|", 1)
        return datetime.fromisoformat(timestamp), uuid.UUID(report_id)
    except Exception:
        return None
