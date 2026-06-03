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

Pydantic request/response models for the harmony-event correction API are
defined at the bottom of this file (Step 7 — Component 5).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from models.base import Base

# pgvector Vector type — installed via the pgvector package.
# The dimension (1536) matches OpenAI text-embedding-3-small and is fixed at
# table creation; changing it requires re-embedding the entire corpus.
from pgvector.sqlalchemy import Vector
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column


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
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# ── Pydantic models for harmony event correction API (Step 7 — Component 5) ──
#
# Routes live in api/routes/movements.py; service logic in services/analysis.py.
# Event identity is always (mn, volta, beat); mc is an optional DCML cross-check.


# Chord quality values per fragment-schema.md and the ingest_analysis quality map.
HarmonyQuality = Literal[
    "major",
    "minor",
    "diminished",
    "augmented",
    "half-diminished",
    "dominant-seventh",
]


class HarmonyEventOut(BaseModel):
    """A single harmony event as returned by the analysis API."""

    mc: int | None = None
    mn: int
    volta: int | None = None
    beat: float
    local_key: str | None = None
    root: int | None = None
    quality: str | None = None
    inversion: int | None = None
    numeral: str | None = None
    root_accidental: str | None = None
    applied_to: str | None = None
    extensions: list[str] = []
    bass_pitch: str | None = None
    soprano_pitch: str | None = None
    source: str
    auto: bool
    reviewed: bool

    model_config = {"extra": "ignore"}


class HarmonyEventInsert(BaseModel):
    """Payload for inserting a new harmony event at a given beat position."""

    mn: int = Field(..., ge=0, description="Notated measure number (0 = pickup bar)")
    volta: int | None = Field(None, description="Volta/ending number, or null")
    beat: float = Field(..., gt=0.0, description="1-indexed beat within the bar")
    mc: int | None = Field(None, description="Machine measure count (DCML cross-check)")
    local_key: str | None = None
    root: int = Field(..., ge=1, le=7, description="Scale degree 1–7")
    quality: HarmonyQuality
    inversion: int = Field(0, ge=0, le=3)
    numeral: str
    root_accidental: Literal["flat", "sharp"] | None = None
    applied_to: str | None = None
    extensions: list[str] = []


class HarmonyEventDeleteRequest(BaseModel):
    """Identifies the harmony event to remove."""

    mn: int
    volta: int | None = None
    beat: float
    mc: int | None = None


class HarmonyEventMoveBoundary(BaseModel):
    """Move an event's beat position without touching chord identity fields.

    ``beat`` is the current position used to locate the event; ``new_beat``
    is the target position. They must differ.
    """

    mn: int
    volta: int | None = None
    beat: float = Field(..., description="Current beat (event identity)")
    mc: int | None = None
    new_beat: float = Field(..., gt=0.0, description="Target beat position")

    @model_validator(mode="after")
    def new_beat_differs(self) -> "HarmonyEventMoveBoundary":
        """Reject a move that would leave the beat unchanged."""
        if self.new_beat == self.beat:
            raise ValueError("new_beat must differ from the current beat")
        return self


class HarmonyEventEditChord(BaseModel):
    """Edit chord fields on an existing event without moving its beat position.

    Fields left as ``None`` (the default) are not modified. At least one chord
    field must be non-None. Setting a field to its current value is a no-op but
    still sets provenance flags (source="manual", auto=False, reviewed=True).

    Note: explicitly clearing a nullable field back to null is not supported in
    Phase 1 — pass the new non-null value.
    """

    mn: int
    volta: int | None = None
    beat: float
    mc: int | None = None
    local_key: str | None = None
    root: int | None = Field(None, ge=1, le=7)
    quality: HarmonyQuality | None = None
    inversion: int | None = Field(None, ge=0, le=3)
    numeral: str | None = None
    root_accidental: Literal["flat", "sharp"] | None = None
    applied_to: str | None = None
    extensions: list[str] | None = None

    @model_validator(mode="after")
    def at_least_one_chord_field(self) -> "HarmonyEventEditChord":
        """Reject a payload that would change nothing."""
        chord_fields = (
            self.local_key,
            self.root,
            self.quality,
            self.inversion,
            self.numeral,
            self.root_accidental,
            self.applied_to,
            self.extensions,
        )
        if all(f is None for f in chord_fields):
            raise ValueError(
                "At least one chord field must be provided: "
                "local_key, root, quality, inversion, numeral, "
                "root_accidental, applied_to, or extensions"
            )
        return self


class HarmonyEventConfirm(BaseModel):
    """Mark a harmony event as reviewed=True without changing any other field.

    The common-case action for DCML events that are correct as imported.
    Does NOT update source or auto.
    """

    mn: int
    volta: int | None = None
    beat: float
    mc: int | None = None
