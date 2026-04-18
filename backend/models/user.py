"""SQLAlchemy ORM model for user infrastructure.

Only ``app_user`` is created in Phase 1. The deferred tables (collection,
collection_fragment, exercise_result, reading_history) and the deferred
``self_declared_role`` column are defined in Phase 2 documents.

Note: the table is named ``app_user`` rather than ``user`` because ``USER``
is a SQL reserved keyword (an alias for ``CURRENT_USER`` in PostgreSQL);
avoiding it means no double-quoting in queries and no surprising semantics.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class AppUser(Base):
    """Registered user account.

    Phase 1 creates trusted annotators and admins only. Reader-facing user
    features (self_declared_role, collections, exercise history) are deferred
    to Phase 2 when their consumers exist.
    """

    __tablename__ = "app_user"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(
        String,
        nullable=False,
        server_default="user",
        comment="user | editor | admin",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
