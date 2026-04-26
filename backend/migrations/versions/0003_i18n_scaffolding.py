"""ADR-006 Phase 1 i18n scaffolding: translation tables + fragment.language column.

Adds the minimum viable internationalisation schema required by ADR-006
"Phase 1 (immediately)" list. No service-layer logic; tables are empty
except for English records added by the seeding script. Schema-only —
adding a second language is then a data migration, not a code change.

Tables created:
  - concept_translation
  - property_schema_translation
  - property_value_translation
  - fragment_annotation_translation

Column added:
  - fragment.language TEXT NOT NULL DEFAULT 'en'

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. fragment.language — records the language of the original annotation.
    #    Default 'en'; BCP 47 tag. Existing rows backfilled to 'en' by
    #    server_default; Phase 1 has no production fragment data yet.
    # ------------------------------------------------------------------
    op.add_column(
        "fragment",
        sa.Column(
            "language",
            sa.Text,
            nullable=False,
            server_default="en",
            comment="BCP 47 language tag for the original annotation (ADR-006)",
        ),
    )

    # ------------------------------------------------------------------
    # 2. concept_translation — localised name/aliases/definition for Neo4j
    #    Concept nodes. Keyed by (concept_id, language); concept_id is the
    #    language-agnostic PascalCase id from Neo4j (no DB-level FK).
    #    English is the first row, not a special-cased column.
    # ------------------------------------------------------------------
    op.create_table(
        "concept_translation",
        sa.Column("concept_id", sa.Text, nullable=False),
        sa.Column(
            "language",
            sa.Text,
            nullable=False,
            comment="BCP 47 tag: 'en', 'de', 'es', 'fr', …",
        ),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("aliases", sa.ARRAY(sa.Text), nullable=True),
        sa.Column("definition", sa.Text, nullable=True),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default="machine",
            comment="machine | reviewed | authoritative",
        ),
        sa.Column(
            "source_hash",
            sa.Text,
            nullable=True,
            comment="SHA-256 of English source text at translation time; used for staleness detection",
        ),
        sa.Column("translated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "translator_id",
            UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("concept_id", "language"),
        sa.CheckConstraint(
            "status IN ('machine', 'reviewed', 'authoritative')",
            name="concept_translation_status_check",
        ),
    )

    # ------------------------------------------------------------------
    # 3. property_schema_translation — localised name/description for
    #    PropertySchema nodes.
    # ------------------------------------------------------------------
    op.create_table(
        "property_schema_translation",
        sa.Column("schema_id", sa.Text, nullable=False),
        sa.Column("language", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default="machine",
            comment="machine | reviewed | authoritative",
        ),
        sa.Column("source_hash", sa.Text, nullable=True),
        sa.PrimaryKeyConstraint("schema_id", "language"),
        sa.CheckConstraint(
            "status IN ('machine', 'reviewed', 'authoritative')",
            name="property_schema_translation_status_check",
        ),
    )

    # ------------------------------------------------------------------
    # 4. property_value_translation — localised name for PropertyValue nodes.
    # ------------------------------------------------------------------
    op.create_table(
        "property_value_translation",
        sa.Column("value_id", sa.Text, nullable=False),
        sa.Column("language", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default="machine",
            comment="machine | reviewed | authoritative",
        ),
        sa.Column("source_hash", sa.Text, nullable=True),
        sa.PrimaryKeyConstraint("value_id", "language"),
        sa.CheckConstraint(
            "status IN ('machine', 'reviewed', 'authoritative')",
            name="property_value_translation_status_check",
        ),
    )

    # ------------------------------------------------------------------
    # 5. fragment_annotation_translation — sibling records for translated
    #    prose annotations. Separate table (not nullable columns) so each
    #    translation can carry its own editorial status and staleness hash.
    # ------------------------------------------------------------------
    op.create_table(
        "fragment_annotation_translation",
        sa.Column(
            "fragment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("fragment.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("language", sa.Text, nullable=False),
        sa.Column("prose_annotation", sa.Text, nullable=True),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default="machine",
            comment="machine | reviewed | authoritative",
        ),
        sa.Column(
            "source_hash",
            sa.Text,
            nullable=True,
            comment="SHA-256 of English prose_annotation at translation time",
        ),
        sa.Column("translated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "translator_id",
            UUID(as_uuid=True),
            sa.ForeignKey("app_user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("fragment_id", "language"),
        sa.CheckConstraint(
            "status IN ('machine', 'reviewed', 'authoritative')",
            name="fragment_annotation_translation_status_check",
        ),
    )

    # ------------------------------------------------------------------
    # Indexes
    # ------------------------------------------------------------------
    op.create_index("fragment_language_idx", "fragment", ["language"])
    op.create_index(
        "concept_translation_language_idx", "concept_translation", ["language"]
    )
    op.create_index(
        "fat_language_idx", "fragment_annotation_translation", ["language"]
    )


def downgrade() -> None:
    op.drop_index("fat_language_idx", table_name="fragment_annotation_translation")
    op.drop_index(
        "concept_translation_language_idx", table_name="concept_translation"
    )
    op.drop_index("fragment_language_idx", table_name="fragment")

    op.drop_table("fragment_annotation_translation")
    op.drop_table("property_value_translation")
    op.drop_table("property_schema_translation")
    op.drop_table("concept_translation")

    op.drop_column("fragment", "language")
