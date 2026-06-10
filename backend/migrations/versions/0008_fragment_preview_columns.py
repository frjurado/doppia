"""Add preview_object_key and preview_generated_at to fragment.

These columns support the fragment-preview generation pipeline introduced in
Component 8 (ADR-008). preview_object_key is null until the
render_fragment_preview Celery task completes; preview_generated_at
distinguishes "never generated" from "generated" without querying object
storage — the same pattern as movement.incipit_object_key / incipit_generated_at
(migration 0002).

The list endpoint returns preview_url: null while these columns are null,
and the frontend renders a placeholder card until the task completes.

Revision ID: 0008
Revises: 0007
Create Date: 2026-06-09
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "fragment",
        sa.Column("preview_object_key", sa.Text, nullable=True),
    )
    op.add_column(
        "fragment",
        sa.Column("preview_generated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("fragment", "preview_generated_at")
    op.drop_column("fragment", "preview_object_key")
