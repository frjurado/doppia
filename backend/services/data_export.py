"""Self-service data export: one JSON document per user (Component 12 Step 8).

The exporter is a **registry**, not a function with a growing body. Each kind of
user-owned data registers a *section* — a name and an async callable that
returns that section's rows for one user — and the exporter walks the registry.
Component 13 adds collections by calling :func:`register_section` from its own
module; it does not edit this one. That is the whole design constraint from
``roles-and-permissions.md`` § 5, made structural.

What is **not** exported: editorial content. Fragments created and reviews given
belong to the platform's editorial record, not to the account
(``roles-and-permissions.md`` § 5) — the same asymmetry that makes deletion
reassign them rather than remove them (Step 9).

Sections are emitted in registration order, so the document reads
profile-first regardless of import order elsewhere.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from models.user import AppUser
from models.user_state import ExerciseResult, ExerciseSession, ReadingHistory
from services.users import load_roles
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: The version of the export document's *shape*. Bump it when a section is
#: added, removed, or restructured, so a consumer holding an old file can tell
#: what it has. Adding rows to an existing section is not a shape change.
EXPORT_VERSION = 1

SectionLoader = Callable[[AsyncSession, uuid.UUID], Awaitable[Any]]

_SECTIONS: dict[str, SectionLoader] = {}


def register_section(name: str, loader: SectionLoader) -> None:
    """Register one section of the export document.

    Args:
        name: The key this section appears under in the exported JSON.
        loader: Async callable taking ``(db, user_id)`` and returning
            JSON-serialisable data for that user.

    Raises:
        ValueError: If ``name`` is already registered — a silent overwrite
            would drop someone's data from every future export.
    """
    if name in _SECTIONS:
        raise ValueError(f"Export section '{name}' is already registered.")
    _SECTIONS[name] = loader


def registered_sections() -> tuple[str, ...]:
    """Return the registered section names, in registration order.

    Returns:
        The section names that :func:`build_export` will emit.
    """
    return tuple(_SECTIONS)


async def build_export(db: AsyncSession, user_id: str) -> dict[str, Any]:
    """Assemble the complete export document for one user.

    Args:
        db: Async database session.
        user_id: The requesting user's UUID as a string.

    Returns:
        A JSON-serialisable document: export metadata plus one key per
        registered section.

    Raises:
        UserNotFoundError: If the account does not exist.
    """
    account_id = uuid.UUID(user_id)
    document: dict[str, Any] = {
        "export_version": EXPORT_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "user_id": user_id,
    }
    for name, loader in _SECTIONS.items():
        document[name] = await loader(db, account_id)
    return document


# ---------------------------------------------------------------------------
# The sections Component 12 owns
# ---------------------------------------------------------------------------


async def _profile_section(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    """Export the account itself, including the roles granted to it.

    Roles are included because they are a fact about the account the user is
    entitled to see, not because export is an authorisation surface.

    Args:
        db: Async database session.
        user_id: The user's UUID.

    Returns:
        The profile fields as a JSON-serialisable mapping.

    Raises:
        UserNotFoundError: If the account does not exist.
    """
    from errors import UserNotFoundError

    row = await db.get(AppUser, user_id)
    if row is None:
        raise UserNotFoundError(
            "No account exists for this caller.", detail={"user_id": str(user_id)}
        )
    return {
        "id": str(row.id),
        "email": row.email,
        "display_name": row.display_name,
        "self_declared_role": row.self_declared_role,
        "reading_history_opt_in": row.reading_history_opt_in,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "roles": sorted(await load_roles(db, str(user_id))),
    }


async def _exercise_history_section(
    db: AsyncSession, user_id: uuid.UUID
) -> list[dict[str, Any]]:
    """Export exercise sessions with their answered questions nested inside.

    Nested rather than flat: a result is meaningless without the session that
    frames it, and the point of an export is that it can be read.

    Args:
        db: Async database session.
        user_id: The user's UUID.

    Returns:
        One entry per session, oldest first, each carrying its results.
    """
    sessions = (
        (
            await db.execute(
                select(ExerciseSession)
                .where(ExerciseSession.user_id == user_id)
                .order_by(ExerciseSession.started_at)
            )
        )
        .scalars()
        .all()
    )
    if not sessions:
        return []

    results = (
        (
            await db.execute(
                select(ExerciseResult)
                .where(ExerciseResult.session_id.in_([s.id for s in sessions]))
                .order_by(ExerciseResult.answered_at)
            )
        )
        .scalars()
        .all()
    )
    by_session: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for result in results:
        by_session.setdefault(result.session_id, []).append(
            {
                "fragment_id": str(result.fragment_id),
                "concept_id": result.concept_id,
                "distractors": result.distractors,
                "response": result.response,
                "correct": result.correct,
                "latency_ms": result.latency_ms,
                "aids": result.aids,
                "answered_at": result.answered_at.isoformat(),
            }
        )

    return [
        {
            "id": str(session.id),
            "exercise_type_id": session.exercise_type_id,
            "mode": session.mode,
            "started_at": session.started_at.isoformat(),
            "completed_at": (
                session.completed_at.isoformat() if session.completed_at else None
            ),
            "results": by_session.get(session.id, []),
        }
        for session in sessions
    ]


async def _reading_history_section(
    db: AsyncSession, user_id: uuid.UUID
) -> list[dict[str, Any]]:
    """Export the visit log, oldest first.

    Args:
        db: Async database session.
        user_id: The user's UUID.

    Returns:
        One entry per recorded visit.
    """
    rows = (
        (
            await db.execute(
                select(ReadingHistory)
                .where(ReadingHistory.user_id == user_id)
                .order_by(ReadingHistory.visited_at, ReadingHistory.id)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "content_type": row.content_type,
            "content_ref": row.content_ref,
            "visited_at": row.visited_at.isoformat(),
        }
        for row in rows
    ]


register_section("profile", _profile_section)
register_section("exercise_history", _exercise_history_section)
register_section("reading_history", _reading_history_section)
