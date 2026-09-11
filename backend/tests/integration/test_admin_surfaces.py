"""Integration tests for the admin surfaces (Component 12 Steps 10 and 11).

Three things here cannot be proven against a mock:

* the one-open-report rule is a **partial unique index**, not application logic,
  so only the database can refuse the second report;
* cursor pagination has to walk real rows in a real order;
* role grants and revocations are what the ``user_role`` table actually holds
  afterwards, audit columns included.

Requires ``docker compose up`` (PostgreSQL) before the test session.

Verification cases:
    1. The account listing pages by cursor and never repeats or drops a row.
    2. A grant records ``granted_by``; re-granting does not rewrite the audit.
    3. Revoking a role removes it; revoking your own admin is refused.
    4. A second open report against the same resource by the same reporter is
       refused; a different reporter, or the same one after resolution, is not.
    5. The queue lists oldest first and filters by status.
    6. Resolving records who and when, and a second resolution is refused.
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
        text("DELETE FROM moderation_report WHERE reporter_id = ANY(:ids)"),
        {"ids": everyone},
    )
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


@pytest.mark.asyncio(loop_scope="session")
class TestReportFiling:
    """One open report per user per resource, enforced by a partial index."""

    async def test_a_second_open_report_is_refused(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from errors import ReportAlreadyOpenError
        from models.moderation import ReportRequest
        from services.moderation import file_report

        reporter = _Caller(id=str(people["alice"]), roles=frozenset())
        payload = ReportRequest(resource_ref="collection:abc", reason="spam")

        await file_report(db_session, reporter, payload)
        with pytest.raises(ReportAlreadyOpenError):
            await file_report(db_session, reporter, payload)

    async def test_a_different_reporter_may_report_the_same_resource(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from models.moderation import ReportRequest
        from services.moderation import file_report

        payload = ReportRequest(resource_ref="collection:shared", reason="abuse")
        await file_report(
            db_session, _Caller(id=str(people["alice"]), roles=frozenset()), payload
        )
        await file_report(
            db_session, _Caller(id=str(people["bob"]), roles=frozenset()), payload
        )

        count = await db_session.scalar(
            text(
                "SELECT count(*) FROM moderation_report "
                "WHERE resource_ref = 'collection:shared'"
            )
        )
        assert count == 2

    async def test_the_same_reporter_may_report_again_after_resolution(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        """The index is partial on purpose: the resource may have changed."""
        from models.moderation import ReportRequest
        from services.moderation import file_report, resolve_report

        reporter = _Caller(id=str(people["alice"]), roles=frozenset())
        admin = _Caller(id=str(people["admin"]), roles=frozenset({"admin"}))
        payload = ReportRequest(resource_ref="collection:again", reason="other")

        first = await file_report(db_session, reporter, payload)
        await resolve_report(db_session, admin, first, "dismissed")
        second = await file_report(db_session, reporter, payload)

        assert second != first

    async def test_an_unverified_reporter_is_refused(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        """Filing a report is content creation for the verification gate."""
        from errors import EmailNotVerifiedError
        from models.moderation import ReportRequest
        from services.moderation import file_report

        unverified = _Caller(
            id=str(people["alice"]), roles=frozenset(), email_verified=False
        )
        with pytest.raises(EmailNotVerifiedError):
            await file_report(
                db_session,
                unverified,
                ReportRequest(resource_ref="collection:x", reason="spam"),
            )


@pytest.mark.asyncio(loop_scope="session")
class TestModerationQueue:
    """The queue is worked from the front and closes reports once."""

    async def test_lists_open_reports_oldest_first(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from models.moderation import ReportRequest
        from services.moderation import file_report, list_reports

        alice = _Caller(id=str(people["alice"]), roles=frozenset())
        bob = _Caller(id=str(people["bob"]), roles=frozenset())
        first = await file_report(
            db_session, alice, ReportRequest(resource_ref="collection:1", reason="spam")
        )
        second = await file_report(
            db_session, bob, ReportRequest(resource_ref="collection:2", reason="abuse")
        )

        # The queue carries whatever else exists; scope to the ids inserted here.
        ordered = [
            item.id
            for item in (await list_reports(db_session, page_size=200)).items
            if item.id in {str(first), str(second)}
        ]
        assert ordered == [str(first), str(second)]

    async def test_the_queue_carries_the_reporter_email(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        """A queue that cannot be triaged at a glance is not a tool."""
        from models.moderation import ReportRequest
        from services.moderation import file_report, list_reports

        alice = _Caller(id=str(people["alice"]), roles=frozenset())
        report_id = await file_report(
            db_session,
            alice,
            ReportRequest(resource_ref="collection:email", reason="copyright"),
        )

        page = await list_reports(db_session, page_size=200)
        item = next(i for i in page.items if i.id == str(report_id))
        assert item.reporter_email.startswith("alice-")

    async def test_resolution_records_who_and_when_and_happens_once(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from errors import ReportAlreadyResolvedError
        from models.moderation import ReportRequest
        from services.moderation import file_report, resolve_report

        alice = _Caller(id=str(people["alice"]), roles=frozenset())
        admin = _Caller(id=str(people["admin"]), roles=frozenset({"admin"}))
        report_id = await file_report(
            db_session,
            alice,
            ReportRequest(resource_ref="collection:resolve", reason="spam"),
        )

        resolved = await resolve_report(db_session, admin, report_id, "dismissed")

        assert resolved.status == "dismissed"
        assert resolved.resolved_by == str(people["admin"])
        assert resolved.resolved_at is not None

        # A second resolution would overwrite the audit trail of the first.
        with pytest.raises(ReportAlreadyResolvedError):
            await resolve_report(db_session, admin, report_id, "actioned")

    async def test_a_dismissed_report_leaves_the_open_filter(
        self, db_session: AsyncSession, people: dict[str, Any]
    ) -> None:
        from models.moderation import ReportRequest
        from services.moderation import file_report, list_reports, resolve_report

        alice = _Caller(id=str(people["alice"]), roles=frozenset())
        admin = _Caller(id=str(people["admin"]), roles=frozenset({"admin"}))
        report_id = await file_report(
            db_session,
            alice,
            ReportRequest(resource_ref="collection:filter", reason="other"),
        )
        await resolve_report(db_session, admin, report_id, "dismissed")

        open_ids = {i.id for i in (await list_reports(db_session, page_size=200)).items}
        dismissed_ids = {
            i.id
            for i in (
                await list_reports(db_session, status="dismissed", page_size=200)
            ).items
        }
        assert str(report_id) not in open_ids
        assert str(report_id) in dismissed_ids
