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
    # Temporary server_default lets us add NOT NULL columns to a populated table.
    # The default is intentionally wrong (bar_start ≠ mc_start in general);
    # existing rows must be re-tagged to get correct values.
    op.add_column(
        "fragment",
        sa.Column(
            "mc_start",
            sa.Integer,
            nullable=False,
            server_default=sa.text("bar_start"),
        ),
    )
    op.add_column(
        "fragment",
        sa.Column(
            "mc_end",
            sa.Integer,
            nullable=False,
            server_default=sa.text("bar_end"),
        ),
    )
    # Drop server defaults after backfill — they must not persist in the schema.
    op.alter_column("fragment", "mc_start", server_default=None)
    op.alter_column("fragment", "mc_end", server_default=None)


def downgrade() -> None:
    op.drop_column("fragment", "mc_end")
    op.drop_column("fragment", "mc_start")
