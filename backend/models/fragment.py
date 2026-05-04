"""SQLAlchemy ORM models for the fragment data model.

Covers:
- Fragment          — the central record; one row per tagged musical excerpt
- FragmentConceptTag — join surface between PostgreSQL and Neo4j
- FragmentReview    — per-reviewer decisions on a fragment

The summary JSONB schema is versioned and documented in
docs/architecture/fragment-schema.md. The ``version`` field inside ``summary``
must be incremented and a migration script written for any breaking change to
field names, types, or structure.

``fragment_concept_tag.concept_id`` values are Neo4j Concept.id strings. There
is no database-level foreign key across systems; referential integrity is
enforced by the Pydantic validation layer at write time.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from models.base import Base
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column


class Fragment(Base):
    """A tagged musical excerpt.

    Bar positions use two coordinate systems. ``bar_start``/``bar_end`` are
    ``<measure @n>`` values from the MEI source — human-readable, but fragile
    (non-integer in some exports, repeating across volta endings).
    ``mc_start``/``mc_end`` are 1-based document-order position indices over
    ``<measure>`` elements — machine-stable, directly usable as ``measureRange``
    operands in Verovio. Both coordinates are written at tag time by the tagging
    tool, which has the MEI in memory. ``repeat_context`` is display-only
    ("first ending", "second ending") and is no longer needed for measure
    disambiguation. See ADR-015 for the full rationale.

    Beat positions define sub-measure precision; see ADR-005 and
    fragment-schema.md for the onset-based inclusion semantics.

    ``status`` drives the peer review state machine:
    draft → submitted → approved (or rejected → draft). Only ``approved``
    fragments are visible in the public fragment browser.
    """

    __tablename__ = "fragment"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'submitted', 'approved', 'rejected')",
            name="fragment_status_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    movement_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("movement.id", ondelete="RESTRICT"),
        nullable=False,
    )
    bar_start: Mapped[int] = mapped_column(Integer, nullable=False)
    bar_end: Mapped[int] = mapped_column(Integer, nullable=False)
    # Machine coordinates (ADR-015): 1-based document-order position indices
    # over <measure> elements in the MEI source. Map directly to Verovio
    # measureRange operands at render time without any conversion.
    # TODO(tagging-tool): mc_start, mc_end must be supplied at write time by
    # the tagging tool (Component 3), which computes them from the MEI in
    # memory. Do not derive from bar_start/bar_end — they are different
    # coordinate systems.
    mc_start: Mapped[int] = mapped_column(Integer, nullable=False)
    mc_end: Mapped[int] = mapped_column(Integer, nullable=False)
    # Sub-measure precision (ADR-005); null in Phase 1 until beat-level
    # extraction is implemented.
    beat_start: Mapped[float | None] = mapped_column(Float, nullable=True)
    beat_end: Mapped[float | None] = mapped_column(Float, nullable=True)
    repeat_context: Mapped[str | None] = mapped_column(String, nullable=True)
    parent_fragment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("fragment.id", ondelete="CASCADE"),
        nullable=True,
    )
    summary: Mapped[dict] = mapped_column(JSONB, nullable=False)
    prose_annotation: Mapped[str | None] = mapped_column(Text, nullable=True)
    data_licence: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="draft")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class FragmentConceptTag(Base):
    """Join table between a fragment and the Neo4j concept(s) it instantiates.

    ``concept_id`` is the stable Neo4j Concept.id string; it is immutable
    once seeded (renaming a concept changes its ``name``, never its ``id``).

    ``is_primary`` distinguishes the concept that drove the tagging decision
    (the one the annotator was explicitly claiming) from contextual concepts
    applied for cross-referencing purposes. Queries for "fragments of type X"
    filter on ``is_primary = true``.
    """

    __tablename__ = "fragment_concept_tag"

    fragment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("fragment.id", ondelete="CASCADE"),
        primary_key=True,
    )
    concept_id: Mapped[str] = mapped_column(String, primary_key=True, nullable=False)
    is_primary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )


class FragmentReview(Base):
    """A single reviewer's decision on a fragment.

    Kept separate from the fragment row so that the approval threshold can
    grow without a data migration. ``fragment.status`` is the aggregate state;
    this table records the individual decisions that drove it.

    ``UNIQUE (fragment_id, reviewer_id)`` prevents multiple decisions per
    reviewer per fragment; a reviewer who changes their mind updates their
    existing row.
    """

    __tablename__ = "fragment_review"
    __table_args__ = (
        UniqueConstraint("fragment_id", "reviewer_id"),
        CheckConstraint(
            "decision IN ('approved', 'rejected')",
            name="fragment_review_decision_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    fragment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("fragment.id", ondelete="CASCADE"),
        nullable=False,
    )
    reviewer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id", ondelete="RESTRICT"),
        nullable=False,
    )
    decision: Mapped[str] = mapped_column(String, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
