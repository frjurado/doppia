"""SQLAlchemy ORM models for music analysis and prose embedding tables.

Covers:
- MovementAnalysis  — beat-level harmonic timeline for a movement (one per movement)
- ProseChunk        — prose annotation chunks with pgvector embeddings (Phase 3)

MovementAnalysis is the single source of truth for chord-level harmonic data.
Fragments do not store a harmony array; they query this table at read time,
sliced by their bar/beat range. See fragment-schema.md § "Harmonic analysis:
movement-level single source of truth".

ProseChunk is scaffolded now so the table structure is stable before embedding
generation begins in Phase 3. The ``embedding`` column is null until Phase 3;
the ivfflat index is also deferred until embeddings are populated.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

# pgvector Vector type — installed via the pgvector package.
# The dimension (1536) matches OpenAI text-embedding-3-small and is fixed at
# table creation; changing it requires re-embedding the entire corpus.
from pgvector.sqlalchemy import Vector


class MovementAnalysis(Base):
    """Beat-level harmonic analysis record for a single movement.

    One row per movement (enforced by UNIQUE on movement_id). Created by the
    Celery task triggered on MEI upload. The ``events`` JSONB array stores the
    full harmonic timeline as change events; each event asserts the harmony
    starting at a given (bar, beat) and extending until the next event.

    ``music21_version`` identifies the version used for the initial auto-
    analysis; individual manually-reviewed events may predate re-runs, but the
    column reflects the most recent re-analysis for coarse version filtering.
    """

    __tablename__ = "movement_analysis"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    movement_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        # Intentionally CASCADE: if a movement is deleted, its analysis goes too.
        ForeignKey("movement.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    events: Mapped[list] = mapped_column(JSONB, nullable=False)
    music21_version: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ProseChunk(Base):
    """A prose annotation chunk with a pgvector embedding.

    Scaffolded in Phase 1; embeddings are generated and the ivfflat index is
    created in Phase 3. The ``embedding`` column is nullable until then.

    ``content_type`` identifies the source of the prose:
    - ``concept_annotation`` — an expert prose annotation on a knowledge graph concept
    - ``fragment_annotation`` — the prose_annotation field of a fragment
    - ``blog_post``           — body text of a blog post (table defined in Phase 2)

    ``source_id`` is the concept.id, fragment.id (UUID as text), or blog post slug.
    """

    __tablename__ = "prose_chunk"
    __table_args__ = (
        CheckConstraint(
            "content_type IN ('concept_annotation', 'fragment_annotation', 'blog_post')",
            name="prose_chunk_content_type_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    source_id: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    # Null until Phase 3; dimension fixed at 1536 (text-embedding-3-small).
    # Do not change the dimension without a documented re-embedding migration.
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(1536), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
