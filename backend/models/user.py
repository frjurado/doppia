"""SQLAlchemy ORM models for user infrastructure.

``app_user`` mirrors the subset of Supabase Auth fields the application needs;
``user_role`` carries role grants, one row per (user, role) pair.

Phase 1 stored a single ``role`` string on ``app_user``. Component 12 replaced
it with the join table: a user holds a *set* of roles (editor + author + admin
are independent grants), and each grant carries its own audit trail. The
``registered`` role is implicit in having an account and is never stored;
``anonymous`` is the absence of a session. See ADR-037 and
``docs/architecture/roles-and-permissions.md`` § 1.

The remaining deferred tables (collection, collection_fragment, exercise_*,
reading_history) are defined in later Component 12 / 13 steps.

Note: the table is named ``app_user`` rather than ``user`` because ``USER``
is a SQL reserved keyword (an alias for ``CURRENT_USER`` in PostgreSQL);
avoiding it means no double-quoting in queries and no surprising semantics.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from models.base import Base
from sqlalchemy import DateTime, ForeignKey, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column


class AppUser(Base):
    """Registered user account.

    Roles are not an attribute of the account: they live in
    :class:`UserRole`. An account with no ``user_role`` rows is a plain
    registered user, which is the default for every new registration.
    """

    __tablename__ = "app_user"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class UserRole(Base):
    """A single role grant, with its audit trail.

    The composite primary key ``(user_id, role)`` makes a grant idempotent —
    granting a role twice is a no-op rather than a duplicate row. ``granted_by``
    is nullable because the migrated Phase 1 grants and the seeded dev users
    have no granting admin to point at.
    """

    __tablename__ = "user_role"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role: Mapped[str] = mapped_column(
        String,
        primary_key=True,
        comment="editor | author | admin (see models/roles.py)",
    )
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_user.id"),
        nullable=True,
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
