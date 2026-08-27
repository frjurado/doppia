"""Replace ``app_user.role`` with the ``user_role`` join table.

Phase 1 carried one role string per account and treated it as a hierarchy
(admin implied editor). Component 12 needs a *set*: editor, author, and admin
are independent grants that one person can hold together, and each grant needs
an audit trail (who granted it, when). Both requirements are a join table, not
an array column.

``registered`` is implicit in having an account and is therefore **not** stored:
the Phase 1 default ``'user'`` migrates to no rows at all. ``anonymous`` is the
absence of authentication and was never stored.

The data migration is the whole point of the ordering here — rows are copied
out of ``app_user.role`` *before* the column is dropped, so an existing editor
or admin keeps working across the deploy without a manual grant. Supabase's
``app_metadata.role`` claim is migrated by this same copy (it was JIT-upserted
into ``app_user.role`` on every authenticated request) and is ignored from here
on: PostgreSQL is the sole source of truth for roles.

``granted_by`` is left NULL for migrated grants — the granting admin is not
recoverable retrospectively, and a NULL reads correctly as "predates the
grant log".

RLS is enabled with no policies, matching migration 0005: default-deny for
every connection that is not the table owner, so PostgREST's anon role cannot
read the grant table.

See ADR-037 and docs/architecture/roles-and-permissions.md § 1.

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_role",
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "role",
            sa.Text,
            primary_key=True,
            comment="editor | author | admin (see backend/models/roles.py)",
        ),
        sa.Column(
            "granted_by",
            UUID(as_uuid=True),
            sa.ForeignKey("app_user.id"),
            nullable=True,
        ),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.execute("ALTER TABLE user_role ENABLE ROW LEVEL SECURITY")

    # Copy the existing grants across before the column disappears. 'user' (the
    # Phase 1 default) is deliberately not copied: registered is implicit.
    op.execute(
        """
        INSERT INTO user_role (user_id, role)
        SELECT id, role FROM app_user WHERE role IN ('editor', 'author', 'admin')
        ON CONFLICT (user_id, role) DO NOTHING
        """
    )

    op.drop_column("app_user", "role")


def downgrade() -> None:
    op.add_column(
        "app_user",
        sa.Column(
            "role",
            sa.Text,
            nullable=False,
            server_default="user",
            comment="user | editor | admin",
        ),
    )
    # Collapse the role set back onto the Phase 1 hierarchy: the highest grant
    # wins, and a user with no grants returns to the 'user' default.
    op.execute(
        """
        UPDATE app_user SET role = sub.role
        FROM (
            SELECT user_id,
                   CASE WHEN bool_or(role = 'admin') THEN 'admin' ELSE 'editor' END
                   AS role
            FROM user_role
            WHERE role IN ('editor', 'admin')
            GROUP BY user_id
        ) AS sub
        WHERE app_user.id = sub.user_id
        """
    )
    op.drop_table("user_role")
