"""Add incipit_object_key and incipit_generated_at to movement.

These columns support the incipit generation pipeline introduced in
Component 2. incipit_object_key is null until the generate_incipit Celery
task completes; incipit_generated_at distinguishes "never generated" from
"generated" without hitting object storage.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-23
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "movement",
        sa.Column("incipit_object_key", sa.Text, nullable=True),
    )
    op.add_column(
        "movement",
        sa.Column("incipit_generated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("movement", "incipit_generated_at")
    op.drop_column("movement", "incipit_object_key")
