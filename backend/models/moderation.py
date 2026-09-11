"""Moderation reports: ORM row and API models (Component 12 Step 11).

Shared collections — titles, descriptions, per-entry annotations — are the first
user-generated content strangers will see, so the moderation tool has to be live
*before* sharing is (``phase-2.md`` § Component 13). Nothing is reportable yet,
which is why this ships with a queue and a service but **no report endpoint**:
Component 13 wires the report button when it ships the surface being reported.

``resource_ref`` is a single opaque string (``collection:{uuid}``) rather than a
type column plus a foreign key. It keeps the table generic for future reportable
surfaces without a migration, and a foreign key would be impossible anyway once
more than one kind of resource is reportable
(``roles-and-permissions.md`` § 4).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final, Literal

from models.base import Base
from pydantic import BaseModel, Field
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

#: Why a resource was reported. A closed enum rather than free text: the free
#: text is ``detail``, and an enum is what makes a queue triageable at a glance.
REPORT_REASONS: Final[tuple[str, ...]] = ("spam", "abuse", "copyright", "other")
ReportReason = Literal["spam", "abuse", "copyright", "other"]

#: ``open`` awaits an admin; ``dismissed`` closed it with no change;
#: ``actioned`` closed it by changing the resource. Component 13's
#: unpublish-share is the first ``actioned`` outcome — there is nothing to
#: action until then, so the queue offers only dismissal.
REPORT_STATUSES: Final[tuple[str, ...]] = ("open", "dismissed", "actioned")
ReportStatus = Literal["open", "dismissed", "actioned"]

#: The outcomes an admin can choose. ``open`` is a starting state, not a
#: decision, so it is not among them.
RESOLUTIONS: Final[tuple[str, ...]] = ("dismissed", "actioned")


class ModerationReport(Base):
    """One report filed by one user against one resource.

    The partial unique index — one **open** report per (reporter, resource) —
    is the enforcement of § 4's "one open report per user per resource". It is
    partial on purpose: once a report is resolved the same person may report
    the same resource again, because the resource may have changed since.
    """

    __tablename__ = "moderation_report"
    __table_args__ = (
        CheckConstraint(
            "reason IN ('spam', 'abuse', 'copyright', 'other')",
            name="moderation_report_reason_vocabulary",
        ),
        CheckConstraint(
            "status IN ('open', 'dismissed', 'actioned')",
            name="moderation_report_status_vocabulary",
        ),
        Index(
            "moderation_report_open_unique",
            "reporter_id",
            "resource_ref",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
        Index("moderation_report_queue_idx", "status", "created_at"),
        Index("moderation_report_resource_idx", "resource_ref"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    resource_ref: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="'collection:{uuid}' — opaque and extensible, deliberately no FK",
    )
    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id", ondelete="CASCADE"),
        nullable=False,
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'open'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app_user.id"), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# ---------------------------------------------------------------------------
# API models
# ---------------------------------------------------------------------------


class ReportRequest(BaseModel):
    """A new report. Filed by any verified registered user.

    Ships dark in Component 12: the service accepts this, but no route does
    yet — Component 13 adds the endpoint alongside the surface it reports on.

    Attributes:
        resource_ref: What is being reported, e.g. ``collection:{uuid}``.
        reason: Why, from the closed vocabulary.
        detail: Optional free text from the reporter.
    """

    resource_ref: str = Field(min_length=1, max_length=200)
    reason: ReportReason
    detail: str | None = Field(default=None, max_length=2000)


class ReportItem(BaseModel):
    """One row of the admin moderation queue.

    ``reporter_email`` is joined in rather than being an id the admin would
    have to look up: a queue that cannot be triaged at a glance is not a tool.

    Attributes:
        id: The report's id.
        resource_ref: What was reported.
        reporter_id: Who reported it.
        reporter_email: That reporter's address.
        reason: The selected reason.
        detail: Their free text, if any.
        status: ``open`` | ``dismissed`` | ``actioned``.
        created_at: When it was filed.
        resolved_by: The admin who closed it, if closed.
        resolved_at: When it was closed, if closed.
    """

    id: str
    resource_ref: str
    reporter_id: str
    reporter_email: str
    reason: str
    detail: str | None
    status: str
    created_at: datetime
    resolved_by: str | None
    resolved_at: datetime | None


class ReportListResponse(BaseModel):
    """Cursor-paginated moderation queue.

    Attributes:
        items: Reports, oldest first — a queue is worked from the front.
        next_cursor: Opaque cursor for the next page, or ``None`` at the end.
    """

    items: list[ReportItem]
    next_cursor: str | None
