"""Create the user-state tables: exercises and reading history.

Four tables, created before the features that fill them (Component 12 Step 7).
The asymmetry between them is deliberate:

* ``exercise_type`` exists **only** as the foreign-key target
  ``exercise_session.exercise_type_id`` requires. It stays empty until
  Component 15 seeds it from YAML. Deferring the FK instead would buy nothing
  and cost a second migration.
* ``exercise_session`` / ``exercise_result`` take the sketch in
  ``component-15-exercises.md`` § 6 verbatim, including ``mode`` and the
  deliberately FK-less ``fragment_id`` — a result records what a user was
  asked and answered, and stays true after the fragment is deleted.
* ``reading_history`` starts recording immediately, for the one reading
  surface that exists (public fragment detail), gated on the
  ``reading_history_opt_in`` consent that landed in migration 0011.

``exercise_activation`` is not created: nothing references it and its status
vocabulary is a Component 15 design question. ``collection`` /
``collection_fragment`` wait for Component 13 (plan decision 4, 2026-08-26).

RLS is enabled on all four, per migration 0005: Supabase's PostgREST exposes
every public-schema table to the anon role, whose key ships in the frontend
bundle. These four hold per-user history, so a missing default-deny here would
be a data leak, not merely an inconsistency.

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = (
    "exercise_type",
    "exercise_session",
    "exercise_result",
    "reading_history",
)


def upgrade() -> None:
    op.create_table(
        "exercise_type",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("definition", postgresql.JSONB, nullable=False),
        sa.Column(
            "seeded_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.create_table(
        "exercise_session",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "exercise_type_id",
            sa.Text,
            sa.ForeignKey("exercise_type.id"),
            nullable=False,
        ),
        sa.Column(
            "mode",
            sa.String,
            nullable=False,
            server_default=sa.text("'standard'"),
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "mode IN ('standard', 'preview')",
            name="exercise_session_mode_vocabulary",
        ),
    )
    op.create_index(
        "exercise_session_user_time_idx", "exercise_session", ["user_id", "started_at"]
    )

    op.create_table(
        "exercise_result",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("exercise_session.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # No FK on fragment_id: results outlive the fragments they were drawn
        # from. A cascade here would erase a user's history as a side effect of
        # an editorial deletion.
        sa.Column("fragment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("concept_id", sa.Text, nullable=False),
        sa.Column("distractors", postgresql.JSONB, nullable=False),
        sa.Column("response", sa.Text, nullable=True),
        sa.Column("correct", sa.Boolean, nullable=False),
        sa.Column("latency_ms", sa.Integer, nullable=True),
        sa.Column("aids", postgresql.JSONB, nullable=True),
        sa.Column(
            "answered_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_exercise_result_session_id", "exercise_result", ["session_id"])

    op.create_table(
        "reading_history",
        # Surrogate key, not (user_id, content_ref): the composite cannot record
        # a repeat visit, which is the whole point of the table.
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("content_ref", sa.Text, nullable=False),
        sa.Column(
            "visited_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "content_type IN ('fragment', 'blog_post')",
            name="reading_history_content_type_vocabulary",
        ),
    )
    op.execute(
        "CREATE INDEX reading_history_user_time_idx "
        "ON reading_history (user_id, visited_at DESC)"
    )
    op.create_index(
        "reading_history_content_idx",
        "reading_history",
        ["content_type", "content_ref"],
    )

    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("reading_history")
    op.drop_table("exercise_result")
    op.drop_index("exercise_session_user_time_idx", table_name="exercise_session")
    op.drop_table("exercise_session")
    op.drop_table("exercise_type")
