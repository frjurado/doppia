"""Integration tests for admin user management (Component 12 Step 10).

Two things here cannot be proven against a mock: cursor pagination has to walk
real rows in a real order, and a grant is what the ``user_role`` table actually
holds afterwards, audit columns included.

Requires ``docker compose up`` (PostgreSQL) before the test session.

Verification cases:
    1. The account listing pages by cursor and never repeats or drops a row.
    2. A grant records ``granted_by``; re-granting does not rewrite the audit.
    3. Revoking a role removes it; revoking your own admin is refused.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class _Caller:
    """A stand-in for ``api.dependencies.AppUser`` (the ``Caller`` protocol)."""

    id: str
    roles: frozenset[str]
    email_verified: bool = True


async def _new_user(db: AsyncSession, label: str) -> uuid.UUID:
    """Insert an ``app_user`` row and return its id."""
    user_id = uuid.uuid4()
    await db.execute(
        text("INSERT INTO app_user (id, email) VALUES (:id, :email)"),
        {"id": user_id, "email": f"{label}-{user_id.hex[:8]}@test.local"},
    )
    await db.commit()
    return user_id


@pytest_asyncio.fixture
async def people(db_session: AsyncSession) -> AsyncGenerator[dict[str, Any], None]:
    """An admin and two ordinary accounts, cleaned up afterwards.

    Yields:
        A mapping of the seeded ids.
    """
    admin = await _new_user(db_session, "admin")
    alice = await _new_user(db_session, "alice")
    bob = await _new_user(db_session, "bob")
    ids = {"admin": admin, "alice": alice, "bob": bob}
    yield ids

    everyone = list(ids.values())
    await db_session.execute(
        text(
            "DELETE FROM user_role WHERE user_id = ANY(:ids) OR granted_by = ANY(:ids)"
        ),
        {"ids": everyone},
    )
    await db_session.execute(
        text("DELETE FROM app_user WHERE id = ANY(:ids)"), {"ids": everyone}
    )
    await db_session.commit()


@pytest.mark.asyncio(loop_scope="session")
class TestAccountListing:
    """The listing is cursor-paginated over a table that already has real rows."""

    async def test_a_search_finds_the_account_and_its_roles(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from services.users import grant_role, list_users

        alice = people["alice"]
        await grant_role(db_session, alice, "editor", granted_by=people["admin"])

        page = await list_users(db_session, query=f"alice-{alice.hex[:8]}")

        assert [item.id for item in page.items] == [str(alice)]
        assert page.items[0].roles == ["editor"]

    async def test_paging_by_cursor_neither_repeats_nor_drops(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        # The table carries real accounts, so walk the whole thing rather than
        # assuming the seeded three are all there is.
        from services.users import list_users

        seen: list[str] = []
        cursor: str | None = None
        for _ in range(200):
            page = await list_users(db_session, cursor=cursor, page_size=2)
            seen.extend(item.id for item in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break

        assert len(seen) == len(set(seen)), "a cursor page repeated a row"
        for key in ("admin", "alice", "bob"):
            assert str(people[key]) in seen


@pytest.mark.asyncio(loop_scope="session")
class TestRoleGrants:
    """Grants are rows with an audit trail, not a token claim."""

    async def test_a_grant_records_who_made_it(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from services.users import grant_role, load_roles

        await grant_role(
            db_session, people["alice"], "editor", granted_by=people["admin"]
        )

        assert await load_roles(db_session, str(people["alice"])) == frozenset(
            {"editor"}
        )
        granted_by = await db_session.scalar(
            text("SELECT granted_by FROM user_role WHERE user_id = :id"),
            {"id": people["alice"]},
        )
        assert granted_by == people["admin"]

    async def test_regranting_does_not_rewrite_the_audit_trail(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        """Re-granting a held role is a no-op, not a fresh grant."""
        from services.users import grant_role

        await grant_role(
            db_session, people["alice"], "editor", granted_by=people["admin"]
        )
        original = await db_session.scalar(
            text("SELECT granted_at FROM user_role WHERE user_id = :id"),
            {"id": people["alice"]},
        )
        await grant_role(
            db_session, people["alice"], "editor", granted_by=people["bob"]
        )

        row = (
            await db_session.execute(
                text(
                    "SELECT granted_by, granted_at FROM user_role WHERE user_id = :id"
                ),
                {"id": people["alice"]},
            )
        ).one()
        assert row[0] == people["admin"]
        assert row[1] == original

    async def test_revoking_removes_the_grant(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from services.users import grant_role, load_roles, revoke_role

        await grant_role(
            db_session, people["alice"], "editor", granted_by=people["admin"]
        )
        await revoke_role(
            db_session, people["alice"], "editor", revoked_by=people["admin"]
        )

        assert await load_roles(db_session, str(people["alice"])) == frozenset()

    async def test_an_admin_cannot_revoke_their_own_admin(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        """There is no self-service path back from an instance with no admin."""
        from errors import SelfAdminRevocationError
        from services.users import grant_role, load_roles, revoke_role

        admin = people["admin"]
        await grant_role(db_session, admin, "admin", granted_by=None)

        with pytest.raises(SelfAdminRevocationError):
            await revoke_role(db_session, admin, "admin", revoked_by=admin)

        assert "admin" in await load_roles(db_session, str(admin))

    async def test_an_admin_can_revoke_someone_elses_admin(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        """A normal, reversible administrative act — not the guarded case."""
        from services.users import grant_role, load_roles, revoke_role

        await grant_role(db_session, people["bob"], "admin", granted_by=people["admin"])
        await revoke_role(
            db_session, people["bob"], "admin", revoked_by=people["admin"]
        )

        assert await load_roles(db_session, str(people["bob"])) == frozenset()
