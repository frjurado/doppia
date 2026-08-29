"""SQLAlchemy ORM models for per-user state: exercises and reading history.

These four tables are created **before** the features that fill them
(Component 12 Step 7). The reason is not tidiness: history that was not
recorded cannot be reconstructed later, so the tables have to exist from the
day the surfaces they observe go live. ``exercise_type`` is empty until
Component 15 seeds it from YAML; ``reading_history`` starts recording
immediately, for the one reading surface that exists.

Shapes are the sketches in ``docs/roadmap/component-15-exercises.md`` § 6 and
``docs/architecture/tech-stack-and-database-reference.md`` § User
infrastructure, adopted verbatim rather than re-derived.

``exercise_activation`` is deliberately absent — nothing references it, and its
status vocabulary is a Component 15 design question. ``collection`` /
``collection_fragment`` are likewise deferred to Component 13, where they can be
designed against real use.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from models.base import Base
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

#: Exercise sessions run either for real or from the admin preview tool. The
#: distinction is on the *session*, not the caller's role: an admin genuinely
#: practising produces valid data, while any user driving the preview tool does
#: not. Preview results are stored and then excluded from every aggregate
#: (``component-15-exercises.md`` § 6).
EXERCISE_MODES: tuple[str, ...] = ("standard", "preview")

#: What a ``reading_history`` row can point at. ``blog_post`` is in the
#: vocabulary from the start — Component 16 adds rows, not a migration.
READING_CONTENT_TYPES: tuple[str, ...] = ("fragment", "blog_post")


class ExerciseType(Base):
    """A declarative exercise definition, seeded from YAML in Component 15.

    Created now only because :class:`ExerciseSession` needs a foreign-key
    target. It stays empty until Component 15 seeds ``backend/seed/exercises/``,
    which means no session can be created before then — exactly the right
    failure mode for a table whose consumers do not exist yet.

    ``definition`` holds the validated YAML payload rather than a spread of
    columns: the schema is still being designed in Component 15, and JSONB lets
    it move without a migration per field. The id is the authored string
    (``'cadence-identification'``), so it is stable across re-seeds.
    """

    __tablename__ = "exercise_type"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    definition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    seeded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ExerciseSession(Base):
    """One sitting at an exercise type by one user.

    ``completed_at`` is nullable because an abandoned session is a real and
    informative outcome, not a row to delete.
    """

    __tablename__ = "exercise_session"
    __table_args__ = (
        CheckConstraint(
            "mode IN ('standard', 'preview')",
            name="exercise_session_mode_vocabulary",
        ),
        Index("exercise_session_user_time_idx", "user_id", "started_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id", ondelete="CASCADE"),
        nullable=False,
    )
    exercise_type_id: Mapped[str] = mapped_column(
        Text,
        ForeignKey("exercise_type.id"),
        nullable=False,
    )
    mode: Mapped[str] = mapped_column(
        String,
        nullable=False,
        server_default=text("'standard'"),
        comment="standard | preview — preview sessions are excluded from aggregates",
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class ExerciseResult(Base):
    """One answered question inside a session.

    ``fragment_id`` carries **no** foreign key on purpose: a result is a record
    of what a user was asked and answered, and it stays true after the fragment
    is deleted or re-ingested. A cascade would erase the user's history as a
    side effect of an editorial action.

    ``distractors`` stores the option ids *in the order shown*, so a later
    analysis can ask about position bias without re-deriving what the user saw.
    """

    __tablename__ = "exercise_result"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("exercise_session.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    fragment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
        comment="No FK: results outlive the fragments they were drawn from",
    )
    concept_id: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Neo4j Concept.id of the correct answer (immutable join key)",
    )
    distractors: Mapped[list] = mapped_column(JSONB, nullable=False)
    response: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="Concept id chosen; NULL means the question was skipped",
    )
    correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    aids: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
        comment='Playback aids used, e.g. {"listens": 3, "slowed": true}',
    )
    answered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ReadingHistory(Base):
    """One visit to one piece of readable content by one opted-in user.

    The surrogate ``BIGSERIAL`` primary key is the point of the design: the
    obvious ``(user_id, content_ref)`` composite cannot record a second visit,
    which is precisely what the table exists to observe.

    ``content_ref`` is text rather than a UUID column because it addresses two
    different things — a fragment UUID today, a blog-post slug in Component 16 —
    and a polymorphic reference cannot carry a foreign key anyway.

    Rows are written only for users who have turned
    ``app_user.reading_history_opt_in`` on, and are deleted with the account
    (``ON DELETE CASCADE``). One row per visit: de-duplication is a decision for
    when storage growth is real, not before (see the tech-stack reference).
    """

    __tablename__ = "reading_history"
    __table_args__ = (
        CheckConstraint(
            "content_type IN ('fragment', 'blog_post')",
            name="reading_history_content_type_vocabulary",
        ),
        Index("reading_history_user_time_idx", "user_id", text("visited_at DESC")),
        Index("reading_history_content_idx", "content_type", "content_ref"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id", ondelete="CASCADE"),
        nullable=False,
    )
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    content_ref: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="Fragment UUID as text, or blog-post slug",
    )
    visited_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
