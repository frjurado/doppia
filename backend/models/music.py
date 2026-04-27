"""SQLAlchemy ORM models for the music works infrastructure.

The corpus is organised as a four-level hierarchy:
    Composer → Corpus → Work → Movement

The MEI object key lives on Movement as ``mei_object_key`` and follows the
convention ``{composer.slug}/{corpus.slug}/{work.slug}/{movement.slug}.mei``.
Fragments reach the source via ``movement_id``; they carry no MEI pointer of
their own.

Slugs are unique per parent: corpus per composer, work per corpus, movement
per work. This makes the composed S3 key globally unique without a central
registry.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from models.base import Base
from sqlalchemy import (
    CheckConstraint,
    DateTime,
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


class Composer(Base):
    """A composer whose works appear in one or more corpora."""

    __tablename__ = "composer"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    sort_name: Mapped[str] = mapped_column(String, nullable=False)
    birth_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    death_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    nationality: Mapped[str | None] = mapped_column(String, nullable=True)
    wikidata_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Corpus(Base):
    """A corpus of works by one composer, ingested from a single source repository."""

    __tablename__ = "corpus"
    __table_args__ = (
        UniqueConstraint("composer_id", "slug"),
        CheckConstraint(
            "analysis_source IN ('DCML', 'WhenInRome', 'music21_auto', 'none')",
            name="corpus_analysis_source_check",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    composer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("composer.id", ondelete="RESTRICT"),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    source_repository: Mapped[str | None] = mapped_column(String, nullable=True)
    source_url: Mapped[str | None] = mapped_column(String, nullable=True)
    source_commit: Mapped[str | None] = mapped_column(String, nullable=True)
    analysis_source: Mapped[str | None] = mapped_column(String, nullable=True)
    licence: Mapped[str] = mapped_column(Text, nullable=False)
    licence_notice: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Work(Base):
    """A single musical work within a corpus."""

    __tablename__ = "work"
    __table_args__ = (UniqueConstraint("corpus_id", "slug"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    corpus_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("corpus.id", ondelete="RESTRICT"),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    catalogue_number: Mapped[str | None] = mapped_column(String, nullable=True)
    year_composed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    year_notes: Mapped[str | None] = mapped_column(String, nullable=True)
    key_signature: Mapped[str | None] = mapped_column(String, nullable=True)
    instrumentation: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Movement(Base):
    """A movement within a work, owning the MEI object key.

    ``mei_object_key`` is the S3 key of the normalised MEI file. It follows
    the convention ``{composer.slug}/{corpus.slug}/{work.slug}/{movement.slug}.mei``.
    Fragments do not carry their own MEI pointer; they reach the source via
    this table through their ``movement_id`` foreign key.

    ``ingested_at`` records when the MEI passed the normalisation pipeline,
    distinct from ``created_at`` (row insertion). A re-ingest after an MEI
    correction updates ``ingested_at`` without recreating the row.
    """

    __tablename__ = "movement"
    __table_args__ = (
        UniqueConstraint("work_id", "movement_number"),
        UniqueConstraint("work_id", "slug"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    work_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("work.id", ondelete="RESTRICT"),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(String, nullable=False)
    movement_number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    tempo_marking: Mapped[str | None] = mapped_column(String, nullable=True)
    key_signature: Mapped[str | None] = mapped_column(String, nullable=True)
    meter: Mapped[str | None] = mapped_column(String, nullable=True)
    mei_object_key: Mapped[str] = mapped_column(String, nullable=False)
    mei_original_object_key: Mapped[str | None] = mapped_column(String, nullable=True)
    duration_bars: Mapped[int | None] = mapped_column(Integer, nullable=True)
    normalization_warnings: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    incipit_object_key: Mapped[str | None] = mapped_column(String, nullable=True)
    incipit_generated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
