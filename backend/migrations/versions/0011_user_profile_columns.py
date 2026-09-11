"""Add the profile columns to ``app_user``.

Three additions, all belonging to the account rather than to any feature:

* ``self_declared_role`` — how the user describes themselves, from the CHECK
  vocabulary drafted in ``tech-stack-and-database-reference.md``. Optional and
  self-reported; it carries **no** authorisation meaning and must never be
  confused with ``user_role``, which is the granted set (ADR-037). Nullable
  because "prefer not to say" is a legitimate answer and is better expressed as
  an absent value than as another vocabulary entry.
* ``reading_history_opt_in`` — consent for recording what the user reads.
  ``NOT NULL DEFAULT false``: the history is opt-in by design
  (``project-architecture.md`` § User state), so every existing and future row
  starts off, and only an explicit toggle turns it on. The column lands before
  the ``reading_history`` table (Step 7) deliberately — the consent has to exist
  before anything could be recorded under it.

The CHECK vocabulary is enforced in the database as well as in Pydantic. The
duplication is intentional: Pydantic guards the API, the constraint guards the
data against anything that reaches the table another way (a migration, a fix-up
script, a future service).

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SELF_DECLARED_ROLES = (
    "student",
    "educator",
    "researcher",
    "hobbyist",
    "professional_musician",
    "other",
)


def upgrade() -> None:
    op.add_column("app_user", sa.Column("self_declared_role", sa.Text, nullable=True))
    op.create_check_constraint(
        "app_user_self_declared_role_vocabulary",
        "app_user",
        sa.column("self_declared_role").in_(_SELF_DECLARED_ROLES),
    )
    op.add_column(
        "app_user",
        sa.Column(
            "reading_history_opt_in",
            sa.Boolean,
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("app_user", "reading_history_opt_in")
    op.drop_constraint("app_user_self_declared_role_vocabulary", "app_user")
    op.drop_column("app_user", "self_declared_role")
