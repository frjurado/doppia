"""Recording of what a user reads, gated on their own consent.

The history is **opt-in**: ``app_user.reading_history_opt_in`` defaults to false
(migration 0011) and only the profile page turns it on. Every write in this
module therefore carries the consent check inside the same SQL statement as the
insert — ``INSERT ... SELECT ... WHERE reading_history_opt_in`` — so there is no
window between checking and writing, and no branch a future caller can forget.

Recording never fails a request. A visit that was not recorded is a lost
analytics row; a read that 500s because of one is a broken page. Callers treat
this as fire-and-forget.

See docs/architecture/roles-and-permissions.md § 5 (data rights) and
docs/architecture/tech-stack-and-database-reference.md § User infrastructure.
"""

from __future__ import annotations

import logging
import uuid

from models.user import AppUser
from models.user_state import READING_CONTENT_TYPES, ReadingHistory
from sqlalchemy import insert, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def record_visit(
    db: AsyncSession,
    user_id: str,
    content_type: str,
    content_ref: str,
) -> bool:
    """Record one visit, if the user has consented to being recorded.

    The consent lookup and the insert are a single statement: the row to write
    is ``SELECT``-ed from ``app_user`` filtered on ``reading_history_opt_in``,
    so a user who has not opted in — or who has no ``app_user`` row at all —
    produces zero rows and no write.

    One row per visit, by design: the surrogate primary key exists so repeat
    visits are recordable, which is what makes the table analytically useful.

    Args:
        db: Async database session.
        user_id: The visiting user's UUID as a string.
        content_type: One of :data:`~models.user_state.READING_CONTENT_TYPES`.
        content_ref: Fragment UUID as text, or blog-post slug.

    Returns:
        ``True`` if a row was written; ``False`` if the user had not opted in,
        does not exist, or the write failed.

    Raises:
        ValueError: If ``content_type`` is outside the vocabulary — a
            programming error, surfaced rather than silently skipped.
    """
    if content_type not in READING_CONTENT_TYPES:
        raise ValueError(f"'{content_type}' is not a readable content type.")

    try:
        account_id = uuid.UUID(user_id)
    except ValueError:
        # A caller id that is not a UUID cannot own an app_user row, so there is
        # nothing to record. Reachable only through the dev auth bypass.
        return False

    consented_row = select(
        AppUser.id,
        literal(content_type),
        literal(content_ref),
    ).where(
        AppUser.id == account_id,
        AppUser.reading_history_opt_in.is_(True),
    )
    statement = insert(ReadingHistory).from_select(
        ["user_id", "content_type", "content_ref"], consented_row
    )

    try:
        result = await db.execute(statement)
        await db.commit()
    except Exception:  # pragma: no cover - defensive; recording is optional
        await db.rollback()
        logger.warning(
            "Failed to record a reading-history visit.",
            extra={"content_type": content_type, "content_ref": content_ref},
            exc_info=True,
        )
        return False
    return bool(result.rowcount)
