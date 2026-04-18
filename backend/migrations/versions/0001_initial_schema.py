"""Initial schema: full Phase 1 PostgreSQL table definitions.

Creates all tables required for Phase 1 in foreign-key dependency order,
along with all indexes. Enables the pgvector extension first.

Tables NOT included (deferred to Phase 2):
- collection
- collection_fragment
- exercise_result
- reading_history
- self_declared_role column on app_user

Indexes deferred to Phase 3:
- prose_chunk_embedding_idx  (created once embeddings are populated)

Revision ID: 0001
Revises: (none — initial migration)
Create Date: 2026-04-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 0. Extensions
    # ------------------------------------------------------------------
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # ------------------------------------------------------------------
    # 1. User infrastructure
    # ------------------------------------------------------------------
    op.create_table(
        "app_user",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("email", sa.Text, unique=True, nullable=False),
        sa.Column("display_name", sa.Text, nullable=True),
        sa.Column(
            "role",
            sa.Text,
            nullable=False,
            server_default="user",
            comment="user | editor | admin",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ------------------------------------------------------------------
    # 2. Music works infrastructure
    # ------------------------------------------------------------------
    op.create_table(
        "composer",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("slug", sa.Text, unique=True, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("sort_name", sa.Text, nullable=False),
        sa.Column("birth_year", sa.Integer, nullable=True),
        sa.Column("death_year", sa.Integer, nullable=True),
        sa.Column("nationality", sa.Text, nullable=True),
        sa.Column("wikidata_id", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    op.create_table(
        "corpus",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "composer_id",
            UUID(as_uuid=True),
            sa.ForeignKey("composer.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("slug", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("source_repository", sa.Text, nullable=True),
        sa.Column("source_url", sa.Text, nullable=True),
        sa.Column("source_commit", sa.Text, nullable=True),
        sa.Column("analysis_source", sa.Text, nullable=True),
        sa.Column("licence", sa.Text, nullable=False),
        sa.Column("licence_notice", sa.Text, nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("composer_id", "slug"),
        sa.CheckConstraint(
            "analysis_source IN ('DCML', 'WhenInRome', 'music21_auto', 'none')",
            name="corpus_analysis_source_check",
        ),
    )

    op.create_table(
        "work",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "corpus_id",
            UUID(as_uuid=True),
            sa.ForeignKey("corpus.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("slug", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("catalogue_number", sa.Text, nullable=True),
        sa.Column("year_composed", sa.Integer, nullable=True),
        sa.Column("year_notes", sa.Text, nullable=True),
        sa.Column("key_signature", sa.Text, nullable=True),
        sa.Column("instrumentation", sa.Text, nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("corpus_id", "slug"),
    )

    op.create_table(
        "movement",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "work_id",
            UUID(as_uuid=True),
            sa.ForeignKey("work.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("slug", sa.Text, nullable=False),
        sa.Column("movement_number", sa.Integer, nullable=False),
        sa.Column("title", sa.Text, nullable=True),
        sa.Column("tempo_marking", sa.Text, nullable=True),
        sa.Column("key_signature", sa.Text, nullable=True),
        sa.Column("meter", sa.Text, nullable=True),
        sa.Column("mei_object_key", sa.Text, nullable=False),
        sa.Column("mei_original_object_key", sa.Text, nullable=True),
        sa.Column("duration_bars", sa.Integer, nullable=True),
        sa.Column("normalization_warnings", JSONB, nullable=True),
        sa.Column(
            "ingested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("work_id", "movement_number"),
        sa.UniqueConstraint("work_id", "slug"),
    )

    # ------------------------------------------------------------------
    # 3. Fragment and tagging
    # ------------------------------------------------------------------
    op.create_table(
        "fragment",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "movement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("movement.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("bar_start", sa.Integer, nullable=False),
        sa.Column("bar_end", sa.Integer, nullable=False),
        # Phase 1 leaves beat_start/beat_end null (ADR-005).
        sa.Column("beat_start", sa.Float, nullable=True),
        sa.Column("beat_end", sa.Float, nullable=True),
        sa.Column("repeat_context", sa.Text, nullable=True),
        sa.Column(
            "parent_fragment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("fragment.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("summary", JSONB, nullable=False),
        # Prose stored now; embedded in Phase 3 (ADR-007).
        sa.Column("prose_annotation", sa.Text, nullable=True),
        # Per-fragment licence field (ADR-009).
        sa.Column("data_licence", sa.Text, nullable=True),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default="draft",
        ),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("app_user.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'submitted', 'approved', 'rejected')",
            name="fragment_status_check",
        ),
    )

    op.create_table(
        "fragment_concept_tag",
        sa.Column(
            "fragment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("fragment.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        # Stable Neo4j concept id — no DB-level FK across systems.
        sa.Column("concept_id", sa.Text, primary_key=True, nullable=False),
        sa.Column(
            "is_primary",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
    )

    op.create_table(
        "fragment_review",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "fragment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("fragment.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "reviewer_id",
            UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("decision", sa.Text, nullable=False),
        sa.Column("comment", sa.Text, nullable=True),
        sa.Column(
            "reviewed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("fragment_id", "reviewer_id"),
        sa.CheckConstraint(
            "decision IN ('approved', 'rejected')",
            name="fragment_review_decision_check",
        ),
    )

    # ------------------------------------------------------------------
    # 4. music21 preprocessing — movement-level harmonic analysis
    # ------------------------------------------------------------------
    op.create_table(
        "movement_analysis",
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
            unique=True,
            nullable=False,
        ),
        sa.Column("events", JSONB, nullable=False),
        sa.Column("music21_version", sa.Text, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ------------------------------------------------------------------
    # 5. Prose / RAG layer (scaffolded for Phase 3; not populated until then)
    # ------------------------------------------------------------------
    op.create_table(
        "prose_chunk",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("content_type", sa.Text, nullable=False),
        sa.Column("source_id", sa.Text, nullable=False),
        sa.Column("chunk_text", sa.Text, nullable=False),
        # embedding vector(1536) added below via raw SQL — see comment there.
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "content_type IN ('concept_annotation', 'fragment_annotation', 'blog_post')",
            name="prose_chunk_content_type_check",
        ),
    )
    # The pgvector ``vector`` type requires the extension to be loaded first.
    # We add it after table creation via raw DDL to avoid type-resolution issues
    # when Alembic imports this migration module on systems where pgvector is not
    # installed (e.g. CI environments that only run offline SQL generation).
    # Null until Phase 3; dimension fixed at 1536 (text-embedding-3-small).
    op.execute(
        "ALTER TABLE prose_chunk ADD COLUMN embedding vector(1536)"
    )

    # ------------------------------------------------------------------
    # Indexes
    # ------------------------------------------------------------------
    op.create_index("composer_sort_name_idx", "composer", ["sort_name"])
    op.create_index("corpus_analysis_source_idx", "corpus", ["analysis_source"])
    op.create_index("movement_mei_key_idx", "movement", ["mei_object_key"])

    # GIN index on fragment.summary JSONB
    op.create_index(
        "fragment_summary_gin",
        "fragment",
        ["summary"],
        postgresql_using="gin",
    )
    # Partial index — only rows with a non-null parent_fragment_id
    op.create_index(
        "fragment_parent_idx",
        "fragment",
        ["parent_fragment_id"],
        postgresql_where=sa.text("parent_fragment_id IS NOT NULL"),
    )
    op.create_index("fragment_status_idx", "fragment", ["status"])
    op.create_index("fragment_movement_idx", "fragment", ["movement_id"])
    op.create_index("fct_concept_idx", "fragment_concept_tag", ["concept_id"])
    op.create_index(
        "fragment_review_fragment_idx", "fragment_review", ["fragment_id"]
    )
    op.create_index(
        "movement_analysis_music21_version_idx",
        "movement_analysis",
        ["music21_version"],
    )
    # GIN index on movement_analysis.events JSONB
    op.create_index(
        "movement_analysis_events_gin",
        "movement_analysis",
        ["events"],
        postgresql_using="gin",
    )

    # prose_chunk_embedding_idx is created in Phase 3 once embeddings are populated.


def downgrade() -> None:
    # Drop indexes first (implicit via table drops, but explicit is cleaner).
    op.drop_index("movement_analysis_events_gin", table_name="movement_analysis")
    op.drop_index(
        "movement_analysis_music21_version_idx", table_name="movement_analysis"
    )
    op.drop_index("fragment_review_fragment_idx", table_name="fragment_review")
    op.drop_index("fct_concept_idx", table_name="fragment_concept_tag")
    op.drop_index("fragment_movement_idx", table_name="fragment")
    op.drop_index("fragment_status_idx", table_name="fragment")
    op.drop_index("fragment_parent_idx", table_name="fragment")
    op.drop_index("fragment_summary_gin", table_name="fragment")
    op.drop_index("movement_mei_key_idx", table_name="movement")
    op.drop_index("corpus_analysis_source_idx", table_name="corpus")
    op.drop_index("composer_sort_name_idx", table_name="composer")

    # Drop tables in reverse dependency order.
    op.drop_table("prose_chunk")
    op.drop_table("movement_analysis")
    op.drop_table("fragment_review")
    op.drop_table("fragment_concept_tag")
    op.drop_table("fragment")
    op.drop_table("movement")
    op.drop_table("work")
    op.drop_table("corpus")
    op.drop_table("composer")
    op.drop_table("app_user")

    # Drop the vector extension last.
    # Note: only safe if no other tables use it. In production, consider
    # leaving the extension in place rather than dropping it.
    op.execute("DROP EXTENSION IF EXISTS vector")
