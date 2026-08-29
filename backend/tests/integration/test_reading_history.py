"""Integration tests for reading-history recording (Component 12 Step 7).

The consent gate lives inside the SQL statement rather than in Python, so it
cannot be verified with a mocked session — a mock would happily report a
rowcount for a user who never opted in. These tests run the real statement
against PostgreSQL.

Requires ``docker compose up`` (PostgreSQL) before the test session.

Verification cases (plan Step 7, hard gate 3):
    1. An opted-in user's visit writes exactly one row with the right fields.
    2. An opted-out user's visit writes nothing.
    3. A user with no ``app_user`` row at all writes nothing (and does not raise).
    4. Repeat visits accumulate — the surrogate key is what makes the table
       analytically useful, so the second visit must not collide with the first.
    5. Withdrawing consent stops recording immediately.
    6. Deleting the account deletes its history (ON DELETE CASCADE).
    7. A content type outside the vocabulary is a programming error, not a
       silently skipped write.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def reader(db_session: AsyncSession) -> AsyncGenerator[uuid.UUID, None]:
    """An ``app_user`` row that has **not** opted in (the default state).

    Yields:
        The new user's id.
    """
    user_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO app_user (id, email) VALUES (:id, :email)",
        ),
        {"id": user_id, "email": f"reader-{user_id.hex[:8]}@test.local"},
    )
    await db_session.commit()
    yield user_id
    await db_session.execute(
        text("DELETE FROM app_user WHERE id = :id"), {"id": user_id}
    )
    await db_session.commit()


async def _opt_in(db: AsyncSession, user_id: uuid.UUID, value: bool = True) -> None:
    """Set the reading-history consent for a user."""
    await db.execute(
        text("UPDATE app_user SET reading_history_opt_in = :v WHERE id = :id"),
        {"v": value, "id": user_id},
    )
    await db.commit()


async def _rows(db: AsyncSession, user_id: uuid.UUID) -> list[tuple]:
    """Return this user's history rows, oldest first."""
    result = await db.execute(
        text(
            "SELECT content_type, content_ref FROM reading_history "
            "WHERE user_id = :id ORDER BY id"
        ),
        {"id": user_id},
    )
    return [tuple(row) for row in result.all()]


@pytest.mark.asyncio(loop_scope="session")
class TestConsentGate:
    """Whether a row is written at all is decided by the user, not the caller."""

    async def test_opted_in_visit_is_recorded(
        self, db_session: AsyncSession, reader: uuid.UUID
    ) -> None:
        from services.reading_history import record_visit

        await _opt_in(db_session, reader)
        fragment_id = str(uuid.uuid4())

        assert await record_visit(db_session, str(reader), "fragment", fragment_id)
        assert await _rows(db_session, reader) == [("fragment", fragment_id)]

    async def test_opted_out_visit_writes_nothing(
        self, db_session: AsyncSession, reader: uuid.UUID
    ) -> None:
        from services.reading_history import record_visit

        # No _opt_in call: the column defaults to false, which is the whole
        # point of the consent being opt-in.
        recorded = await record_visit(
            db_session, str(reader), "fragment", str(uuid.uuid4())
        )

        assert recorded is False
        assert await _rows(db_session, reader) == []

    async def test_unknown_account_writes_nothing(
        self, db_session: AsyncSession
    ) -> None:
        """A caller with no ``app_user`` row is a no-op, not a foreign-key error."""
        from services.reading_history import record_visit

        stranger = uuid.uuid4()
        recorded = await record_visit(
            db_session, str(stranger), "fragment", str(uuid.uuid4())
        )

        assert recorded is False
        assert await _rows(db_session, stranger) == []

    async def test_withdrawing_consent_stops_recording(
        self, db_session: AsyncSession, reader: uuid.UUID
    ) -> None:
        from services.reading_history import record_visit

        await _opt_in(db_session, reader)
        await record_visit(db_session, str(reader), "fragment", "first")
        await _opt_in(db_session, reader, value=False)
        await record_visit(db_session, str(reader), "fragment", "second")

        # The already-recorded row stays — withdrawal stops future recording;
        # erasing the history is the deletion/export surface's job (Step 8/9).
        assert await _rows(db_session, reader) == [("fragment", "first")]


@pytest.mark.asyncio(loop_scope="session")
class TestRepeatVisits:
    """The surrogate primary key exists so a second visit is recordable."""

    async def test_same_fragment_twice_yields_two_rows(
        self, db_session: AsyncSession, reader: uuid.UUID
    ) -> None:
        from services.reading_history import record_visit

        await _opt_in(db_session, reader)
        fragment_id = str(uuid.uuid4())

        await record_visit(db_session, str(reader), "fragment", fragment_id)
        await record_visit(db_session, str(reader), "fragment", fragment_id)

        assert await _rows(db_session, reader) == [
            ("fragment", fragment_id),
            ("fragment", fragment_id),
        ]


@pytest.mark.asyncio(loop_scope="session")
class TestVocabulary:
    """The content-type vocabulary is enforced before the statement is built."""

    async def test_unknown_content_type_raises(
        self, db_session: AsyncSession, reader: uuid.UUID
    ) -> None:
        from services.reading_history import record_visit

        await _opt_in(db_session, reader)
        with pytest.raises(ValueError, match="not a readable content type"):
            await record_visit(db_session, str(reader), "podcast", "ep-1")

    async def test_blog_post_is_already_in_the_vocabulary(
        self, db_session: AsyncSession, reader: uuid.UUID
    ) -> None:
        """Component 16 adds rows, not a migration."""
        from services.reading_history import record_visit

        await _opt_in(db_session, reader)
        assert await record_visit(db_session, str(reader), "blog_post", "why-cadences")
        assert await _rows(db_session, reader) == [("blog_post", "why-cadences")]


@pytest.mark.asyncio(loop_scope="session")
class TestAccountDeletion:
    """History is user-owned data and goes with the account (Step 9's rule)."""

    async def test_deleting_the_account_deletes_the_history(
        self, db_session: AsyncSession
    ) -> None:
        from services.reading_history import record_visit

        user_id = uuid.uuid4()
        await db_session.execute(
            text(
                "INSERT INTO app_user (id, email, reading_history_opt_in) "
                "VALUES (:id, :email, true)"
            ),
            {"id": user_id, "email": f"leaving-{user_id.hex[:8]}@test.local"},
        )
        await db_session.commit()
        await record_visit(db_session, str(user_id), "fragment", str(uuid.uuid4()))
        assert len(await _rows(db_session, user_id)) == 1

        await db_session.execute(
            text("DELETE FROM app_user WHERE id = :id"), {"id": user_id}
        )
        await db_session.commit()

        assert await _rows(db_session, user_id) == []
