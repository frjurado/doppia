"""Create ``moderation_report``.

The shape is the sketch in ``roles-and-permissions.md`` § 4. Two details are
worth stating because they are load-bearing rather than incidental:

* **``resource_ref`` is one opaque string with no foreign key.**
  ``collection:{uuid}`` today, other surfaces later. A type column plus a
  foreign key would have to be replaced the moment a second kind of resource
  becomes reportable, and no single FK can point at two tables.
* **The one-open-report rule is a partial unique index**, not application logic:
  unique on ``(reporter_id, resource_ref)`` *where status = 'open'*. Partial on
  purpose — once a report is resolved the same person may report the same
  resource again, because it may have changed since.

The table ships **before** anything reportable exists (Component 13's shared
collections), because the moderation tool must be live before sharing is
(``phase-2.md`` § Component 13).

RLS per the migration 0005 pattern: the rows carry who reported whom, which is
exactly the sort of thing PostgREST must never serve to the anon role.

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "moderation_report",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("resource_ref", sa.Text, nullable=False),
        sa.Column(
            "reporter_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("detail", sa.Text, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default=sa.text("'open'")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "resolved_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app_user.id"),
            nullable=True,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "reason IN ('spam', 'abuse', 'copyright', 'other')",
            name="moderation_report_reason_vocabulary",
        ),
        sa.CheckConstraint(
            "status IN ('open', 'dismissed', 'actioned')",
            name="moderation_report_status_vocabulary",
        ),
    )
    op.create_index(
        "moderation_report_open_unique",
        "moderation_report",
        ["reporter_id", "resource_ref"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )
    op.create_index(
        "moderation_report_queue_idx", "moderation_report", ["status", "created_at"]
    )
    op.create_index(
        "moderation_report_resource_idx", "moderation_report", ["resource_ref"]
    )
    op.execute("ALTER TABLE moderation_report ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("moderation_report")
