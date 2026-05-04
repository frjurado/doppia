"""Add mc_start and mc_end position-index columns to fragment.

mc_start and mc_end are 1-based document-order position indices over
<measure> elements in the MEI source. They map directly to Verovio's
measureRange operands. bar_start/bar_end retain their existing semantics
(@n values, human-readable bar numbers) and are not changed.

Existing rows receive mc_start = bar_start, mc_end = bar_end as a
temporary default. These values are incorrect for any fragment that
crosses a non-integer @n measure or a repeat ending; they will be
corrected on next re-tag. Do not use mc_start/mc_end from existing
rows for rendering until the movement has been re-ingested.

See docs/adr/ADR-015-dual-measure-coordinate-system.md for the rationale.

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add nullable first — PostgreSQL does not allow column references in DEFAULT
    # expressions, so we cannot use bar_start/bar_end as a server_default directly.
    op.add_column("fragment", sa.Column("mc_start", sa.Integer, nullable=True))
    op.add_column("fragment", sa.Column("mc_end", sa.Integer, nullable=True))

    # Backfill from bar_start/bar_end.  These values are incorrect for any
    # fragment that crosses a non-integer @n measure or a repeat ending; they
    # will be corrected on next re-tag.
    op.execute("UPDATE fragment SET mc_start = bar_start, mc_end = bar_end")

    # Now that every row has a value, tighten to NOT NULL.
    op.alter_column("fragment", "mc_start", nullable=False)
    op.alter_column("fragment", "mc_end", nullable=False)


def downgrade() -> None:
    op.drop_column("fragment", "mc_end")
    op.drop_column("fragment", "mc_start")
