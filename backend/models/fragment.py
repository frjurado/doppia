"""SQLAlchemy ORM models and Pydantic schemas for the fragment data model.

Covers:
- Fragment              — the central record; one row per tagged musical excerpt
- FragmentConceptTag    — join surface between PostgreSQL and Neo4j
- FragmentReview        — per-reviewer decisions on a fragment
- FragmentSummary       — Pydantic schema for the versioned summary JSONB field
- ConceptTagCreate      — write model for a single concept tag
- SubPartFragmentCreate — write model for a sub-part (child) fragment
- FragmentCreate        — write model for a top-level fragment create request

The summary JSONB schema is versioned and documented in
docs/architecture/fragment-schema.md. The ``version`` field inside ``summary``
must be incremented and a migration script written for any breaking change to
field names, types, or structure.

``fragment_concept_tag.concept_id`` values are Neo4j Concept.id strings. There
is no database-level foreign key across systems; referential integrity is
enforced by the Pydantic validation layer at write time (see
``services/fragment_validation.py``).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from models.base import Base
from pydantic import BaseModel, ConfigDict, Field, model_validator
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

# ---------------------------------------------------------------------------
# Pydantic schema for fragment.summary JSONB
# ---------------------------------------------------------------------------


class ActualKey(BaseModel):
    """Inferred local key at the fragment's position.

    ``confidence`` reflects the machine's certainty at analysis time and is
    preserved even after a human edit (when ``auto`` becomes ``False``).
    Treat ``confidence`` as meaningful only when ``auto = True``.

    ``confidence`` is optional to support the DCML-only seeding path (option b
    in Component 5): when ``actual_key`` is seeded from the DCML ``local_key``
    with ``auto: false, reviewed: true``, no machine confidence score exists.
    """

    model_config = ConfigDict(extra="forbid")

    value: str
    confidence: float | None = None
    auto: bool
    reviewed: bool


class FragmentSummary(BaseModel):
    """Pydantic schema for the versioned ``fragment.summary`` JSONB field.

    Every field matches the version-1 spec in
    ``docs/architecture/fragment-schema.md``.  The ``version`` field is a
    ``Literal[1]`` discriminator so that readers can branch on schema version
    before interpreting any other field.  Any version value other than 1 is a
    validation error until a version-2 schema is introduced.

    Callers must validate every summary dict through this model before writing
    it to the database.  A dict that bypasses validation and reaches the DB
    with a missing or wrong-version ``version`` key breaks the invariant that
    ``fragment.summary["version"]`` is always present and interpretable.

    ``music21_version`` is required when any auto-derived field (e.g. a
    ``actual_key`` with ``auto: true``) is present; it may be ``None`` (or the
    sentinel ``"none"``) in the DCML-only path where no music21 analysis runs.
    """

    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    key: str
    meter: str
    music21_version: str | None = None
    concepts: list[str] = Field(min_length=1)
    actual_key: ActualKey | None = None
    properties: dict[str, str | list[str]] = {}
    concept_extensions: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Write models (used by POST /api/v1/fragments and sub-part payloads)
# ---------------------------------------------------------------------------


class ConceptTagCreate(BaseModel):
    """A single concept tag in a fragment write request.

    ``concept_id`` is the immutable Neo4j Concept.id.  Existence is verified
    against the graph by ``services.fragment_validation.validate_concept_existence``
    before any database write; there is no DB-level foreign key.

    ``is_primary`` must be ``True`` for exactly one tag per fragment — the
    concept that drove the tagging decision.  Additional tags carry
    ``is_primary=False`` and are applied for cross-referencing purposes only.
    """

    model_config = ConfigDict(extra="forbid")

    concept_id: str = Field(min_length=1)
    is_primary: bool = True


class _FragmentWriteBase(BaseModel):
    """Shared coordinate and content fields for top-level and sub-part writes.

    Beat constraints follow ADR-005:
    - ``beat_start`` and ``beat_end`` must both be set or both be null.
    - When set, ``beat_start`` must be strictly less than ``beat_end``.

    The measure-level floor/ceil bounds from ADR-005 (floor(beat_start) >=
    bar_start, ceil(beat_end) <= bar_end) are omitted here because the beat
    encoding (1-indexed beat number within a measure) makes those inequalities
    unsatisfiable for any measure beyond bar 1.  The tagging tool enforces the
    spatial bounds at the ghost-overlay layer before the selection is committed.
    """

    model_config = ConfigDict(extra="forbid")

    bar_start: int = Field(ge=0)
    bar_end: int = Field(ge=0)
    mc_start: int = Field(ge=1)
    mc_end: int = Field(ge=1)
    beat_start: float | None = None
    beat_end: float | None = None
    repeat_context: str | None = None
    summary: FragmentSummary
    prose_annotation: str | None = None
    concept_tags: list[ConceptTagCreate] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_beat_constraints(self) -> "_FragmentWriteBase":
        """Enforce ADR-005 beat constraints."""
        bs, be = self.beat_start, self.beat_end
        if bs is None and be is None:
            return self
        if (bs is None) != (be is None):
            raise ValueError(
                "beat_start and beat_end must both be set or both be null "
                "(ADR-005: null means measure-level selection)"
            )
        # Both are non-null at this point.
        assert bs is not None and be is not None  # narrow type for mypy
        if bs >= be:
            raise ValueError(
                f"beat_start ({bs}) must be strictly less than beat_end ({be}) "
                "(ADR-005)"
            )
        return self


class SubPartFragmentCreate(_FragmentWriteBase):
    """Write model for a sub-part (child) fragment.

    Sub-parts share the same coordinate and content fields as the parent.
    The service layer checks containment: every sub-part's bar range must
    fall within the parent's range before the atomic write proceeds.
    """


class FragmentCreate(_FragmentWriteBase):
    """Write model for a top-level fragment create request.

    Sent as the body of ``POST /api/v1/fragments``.  The ``movement_id``
    identifies the MEI source; ``sub_parts`` are written atomically alongside
    the parent (all succeed or all roll back).

    The ``data_licence`` field is not in the payload — it is derived from the
    movement's harmony event sources (ADR-009) and set by the service layer
    at write time.
    """

    movement_id: uuid.UUID
    sub_parts: list[SubPartFragmentCreate] = Field(default_factory=list)


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
