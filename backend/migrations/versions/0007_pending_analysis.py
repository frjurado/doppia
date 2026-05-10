"""Add pending_analysis flag to movement.

Per R2/I12: when the DB commits but Celery dispatch crashes (broker
unreachable, process kill), the movement row exists and the MEI is in R2,
but no movement_analysis row will ever be written.  The pending_analysis
flag is the canonical "this movement still needs analysis" signal.

Design decisions:
- DEFAULT TRUE so that every row — including existing rows — is immediately
  eligible for the re-dispatch endpoint.  The backfill is intentional: all
  staging movements currently lack movement_analysis.
- Flipped to FALSE only on a successful analysis write (in
  services/tasks/ingest_analysis.py `_dcml_branch`).  If the task fails
  partway, the flag stays TRUE and the movement is re-eligible.
- Partial index keeps the index small as the corpus grows; steady-state is
  "almost all movements are FALSE".
- Re-ingest (on_conflict_do_update in services/ingestion.py) resets the flag
  to TRUE: a re-uploaded ZIP implies the analysis should re-run.

See docs/adr/ADR-018-partial-failure-recovery-for-ingestion.md.

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-10
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add nullable first — we need to backfill before tightening to NOT NULL.
    op.add_column(
        "movement",
        sa.Column("pending_analysis", sa.Boolean(), nullable=True),
    )

    # Backfill: every existing row is set to TRUE (none have movement_analysis yet).
    op.execute("UPDATE movement SET pending_analysis = TRUE")

    # Now tighten to NOT NULL with a server-side default for future inserts.
    op.alter_column("movement", "pending_analysis", nullable=False)
    op.execute("ALTER TABLE movement ALTER COLUMN pending_analysis SET DEFAULT TRUE")

    # Partial index — stays small since steady-state is almost all FALSE.
    op.execute(
        "CREATE INDEX movement_pending_analysis_idx "
        "ON movement (id) WHERE pending_analysis = TRUE"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS movement_pending_analysis_idx")
    op.drop_column("movement", "pending_analysis")
