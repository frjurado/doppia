"""Add the movement_section table (editorial section spans within a movement).

Some movements restart their notated bar numbers partway through — K331/ii
numbers 1-48 for the Menuetto and then 1-52 again for the Trio — so the human
coordinate (``fragment.bar_start``/``bar_end``, the MEI ``@n``) cannot on its own
say which "m. 12" a fragment means. This table carries the editorial section
spans a display label is qualified with ("Trio, mm. 12-15").

Spans are keyed on ``mc`` (1-based document-order position index, ADR-015), never
on ``@n``: ``mc`` is unique and survives a re-ingest, and ``@n`` is the very
coordinate being disambiguated. Bounds are inclusive and span ``<ending>``
measures — K331/ii's Trio ends at mc 101, not 99, because its last two measures
sit inside a volta ending.

A movement with fewer than two sections has no rows at all, so movements without
the ambiguity are untouched and the read path short-circuits on an empty result.

RLS is enabled with no policies, matching migration 0005: default-deny for every
connection that is not the table owner, so PostgREST's anon role cannot read it.

See ADR-036 and docs/roadmap/component-11-concept-glossary.md § Step 9.

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-25
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "movement_section",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "movement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("movement.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ordinal", sa.Integer, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("mc_start", sa.Integer, nullable=False),
        sa.Column("mc_end", sa.Integer, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("movement_id", "ordinal", name="movement_section_ordinal"),
        sa.CheckConstraint("ordinal >= 1", name="movement_section_ordinal_positive"),
        sa.CheckConstraint("mc_start >= 1", name="movement_section_mc_start_positive"),
        sa.CheckConstraint(
            "mc_end >= mc_start", name="movement_section_mc_range_ordered"
        ),
    )
    op.create_index(
        "ix_movement_section_movement_id", "movement_section", ["movement_id"]
    )
    op.execute("ALTER TABLE movement_section ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_index("ix_movement_section_movement_id", table_name="movement_section")
    op.drop_table("movement_section")
