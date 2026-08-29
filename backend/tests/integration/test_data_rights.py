"""Integration tests for data rights (Component 12 Steps 8 and 9).

Hard gate 4 of the component plan asks for these to be proven "by an
integration test, not inspection", and it is right to: the whole design lives
in foreign keys. ``fragment_review.reviewer_id`` is ``ON DELETE RESTRICT``, so
a deletion that forgot to reassign would fail against a real database and pass
against a mock.

Requires ``docker compose up`` (PostgreSQL) before the test session.

Verification cases:
    1. Export returns every section, with the user's own rows in them.
    2. Export excludes editorial content (fragments created, reviews given).
    3. Deletion reassigns ``fragment.created_by`` to the system user.
    4. Deletion reassigns ``fragment_review.reviewer_id`` to the system user —
       the RESTRICT case that would otherwise refuse.
    5. Deletion removes user-owned rows: role grants, exercise sessions and
       results, reading history, and the account itself.
    6. Deletion re-points ``user_role.granted_by`` on *other people's* grants,
       which would otherwise block the delete outright.
    7. The system user cannot be deleted.
    8. A non-admin cannot delete somebody else's account.
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

_SYSTEM_USER = uuid.UUID("00000000-0000-0000-0000-0000000000ff")


@dataclass(frozen=True)
class _Caller:
    """A stand-in for ``api.dependencies.AppUser`` (the ``Caller`` protocol)."""

    id: str
    roles: frozenset[str]
    email_verified: bool = True


async def _new_user(db: AsyncSession, *, opted_in: bool = False) -> uuid.UUID:
    """Insert an ``app_user`` row and return its id."""
    user_id = uuid.uuid4()
    await db.execute(
        text(
            "INSERT INTO app_user (id, email, reading_history_opt_in) "
            "VALUES (:id, :email, :opt)"
        ),
        {
            "id": user_id,
            "email": f"rights-{user_id.hex[:8]}@test.local",
            "opt": opted_in,
        },
    )
    await db.commit()
    return user_id


async def _seed_movement(db: AsyncSession) -> uuid.UUID:
    """Insert the composer → corpus → work → movement chain and return the movement."""
    sfx = uuid.uuid4().hex[:8]
    composer_id, corpus_id, work_id, movement_id = (uuid.uuid4() for _ in range(4))
    await db.execute(
        text(
            "INSERT INTO composer (id, slug, name, sort_name) "
            "VALUES (:id, :slug, :n, :sn)"
        ),
        {
            "id": composer_id,
            "slug": f"mozart-{sfx}",
            "n": "W. A. Mozart",
            "sn": "Mozart, W. A.",
        },
    )
    await db.execute(
        text(
            "INSERT INTO corpus (id, composer_id, slug, title, analysis_source, licence) "
            "VALUES (:id, :cid, :slug, :t, 'DCML', 'CC-BY-SA-4.0')"
        ),
        {"id": corpus_id, "cid": composer_id, "slug": f"sonatas-{sfx}", "t": "Sonatas"},
    )
    await db.execute(
        text(
            "INSERT INTO work (id, corpus_id, slug, title, catalogue_number) "
            "VALUES (:id, :cid, :slug, :t, 'K. 331')"
        ),
        {"id": work_id, "cid": corpus_id, "slug": f"k331-{sfx}", "t": "Sonata No. 11"},
    )
    await db.execute(
        text(
            "INSERT INTO movement "
            "(id, work_id, slug, movement_number, key_signature, meter, mei_object_key) "
            "VALUES (:id, :wid, :slug, 1, 'A major', '6/8', :mei)"
        ),
        {
            "id": movement_id,
            "wid": work_id,
            "slug": f"movement-1-{sfx}",
            "mei": f"test/{sfx}/movement-1.mei",
        },
    )
    await db.commit()
    return movement_id


async def _insert_fragment(
    db: AsyncSession, movement_id: uuid.UUID, creator: uuid.UUID
) -> uuid.UUID:
    """Insert one approved fragment created by ``creator``."""
    fragment_id = uuid.uuid4()
    await db.execute(
        text(
            "INSERT INTO fragment "
            "(id, movement_id, bar_start, bar_end, mc_start, mc_end, "
            " summary, status, created_by, data_licence) "
            "VALUES (:id, :mid, 1, 4, 1, 4, CAST(:s AS jsonb), 'approved', "
            " :creator, 'CC-BY-SA-4.0')"
        ),
        {"id": fragment_id, "mid": movement_id, "s": "{}", "creator": creator},
    )
    await db.commit()
    return fragment_id


@pytest_asyncio.fixture
async def workspace(db_session: AsyncSession) -> AsyncGenerator[dict[str, Any], None]:
    """A departing editor with editorial contributions and user-owned state.

    Yields:
        A mapping of the seeded ids.
    """
    movement_id = await _seed_movement(db_session)
    leaver = await _new_user(db_session, opted_in=True)
    colleague = await _new_user(db_session)

    fragment_id = await _insert_fragment(db_session, movement_id, leaver)
    # A fragment created by someone else, reviewed by the leaver: the RESTRICT
    # foreign key that a naive DELETE would trip over.
    other_fragment = await _insert_fragment(db_session, movement_id, colleague)
    await db_session.execute(
        text(
            "INSERT INTO fragment_review (fragment_id, reviewer_id, decision) "
            "VALUES (:fid, :rid, 'approved')"
        ),
        {"fid": other_fragment, "rid": leaver},
    )
    # The leaver holds a grant, and granted one to the colleague.
    await db_session.execute(
        text("INSERT INTO user_role (user_id, role) VALUES (:uid, 'editor')"),
        {"uid": leaver},
    )
    await db_session.execute(
        text(
            "INSERT INTO user_role (user_id, role, granted_by) "
            "VALUES (:uid, 'editor', :by)"
        ),
        {"uid": colleague, "by": leaver},
    )
    await db_session.commit()

    yield {
        "movement_id": movement_id,
        "leaver": leaver,
        "colleague": colleague,
        "fragment_id": fragment_id,
        "other_fragment": other_fragment,
    }

    # Teardown: the leaver may already be gone; the colleague and the corpus
    # chain are not, and the system user must not accumulate test fragments.
    for statement in (
        "DELETE FROM fragment_review WHERE fragment_id IN (:f1, :f2)",
        "DELETE FROM fragment WHERE id IN (:f1, :f2)",
    ):
        await db_session.execute(
            text(statement), {"f1": fragment_id, "f2": other_fragment}
        )
    await db_session.execute(
        text(
            "DELETE FROM movement WHERE id = :mid",
        ),
        {"mid": movement_id},
    )
    # Role grants first, in both directions: a grant *made by* one of these
    # users blocks deleting them, which is the same foreign key the deletion
    # service has to reassign.
    await db_session.execute(
        text(
            "DELETE FROM user_role WHERE user_id IN (:a, :b) "
            "OR granted_by IN (:a, :b)"
        ),
        {"a": leaver, "b": colleague},
    )
    await db_session.execute(
        text("DELETE FROM app_user WHERE id IN (:a, :b)"),
        {"a": leaver, "b": colleague},
    )
    await db_session.commit()


async def _column(db: AsyncSession, sql: str, params: dict) -> Any:
    """Return the first column of the first row, or ``None``."""
    result = await db.execute(text(sql), params)
    row = result.first()
    return row[0] if row else None


@pytest.mark.asyncio(loop_scope="session")
class TestExport:
    """The export document is complete, and contains nothing it should not."""

    async def test_export_contains_every_registered_section(
        self, db_session: AsyncSession, workspace: dict[str, Any]
    ) -> None:
        from services.data_export import build_export, registered_sections
        from services.reading_history import record_visit

        leaver = workspace["leaver"]
        await record_visit(
            db_session, str(leaver), "fragment", str(workspace["fragment_id"])
        )

        document = await build_export(db_session, str(leaver))

        for section in registered_sections():
            assert section in document, section
        assert document["profile"]["id"] == str(leaver)
        assert document["profile"]["roles"] == ["editor"]
        assert document["profile"]["reading_history_opt_in"] is True
        assert [entry["content_ref"] for entry in document["reading_history"]] == [
            str(workspace["fragment_id"])
        ]
        assert document["exercise_history"] == []

    async def test_export_excludes_editorial_content(
        self, db_session: AsyncSession, workspace: dict[str, Any]
    ) -> None:
        """Fragments created and reviews given belong to the platform record."""
        from services.data_export import build_export

        document = await build_export(db_session, str(workspace["leaver"]))

        serialised = str(document)
        assert str(workspace["other_fragment"]) not in serialised
        assert "fragments" not in document
        assert "reviews" not in document


@pytest.fixture(autouse=True)
def _no_supabase_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run deletions on the dev auth bypass so no Supabase call is attempted.

    The PostgreSQL half is what these tests are about; the Auth half has no
    local counterpart and is covered by unit tests against a mocked client.
    """
    monkeypatch.setenv("AUTH_MODE", "local")


@pytest.mark.asyncio(loop_scope="session")
class TestDeletion:
    """Delete what the user owns; reassign what the platform owns."""

    async def test_editorial_contributions_move_to_the_system_user(
        self, db_session: AsyncSession, workspace: dict[str, Any]
    ) -> None:
        from services.account_deletion import delete_account

        leaver = workspace["leaver"]
        caller = _Caller(id=str(leaver), roles=frozenset())

        await delete_account(db_session, caller, str(leaver))

        assert (
            await _column(
                db_session,
                "SELECT created_by FROM fragment WHERE id = :id",
                {"id": workspace["fragment_id"]},
            )
            == _SYSTEM_USER
        )
        # The RESTRICT foreign key: this is the one that would have refused.
        assert (
            await _column(
                db_session,
                "SELECT reviewer_id FROM fragment_review WHERE fragment_id = :id",
                {"id": workspace["other_fragment"]},
            )
            == _SYSTEM_USER
        )
        # An audit trail on somebody else's grant, re-pointed rather than lost.
        assert (
            await _column(
                db_session,
                "SELECT granted_by FROM user_role WHERE user_id = :id",
                {"id": workspace["colleague"]},
            )
            == _SYSTEM_USER
        )

    async def test_user_owned_data_is_deleted(
        self, db_session: AsyncSession, workspace: dict[str, Any]
    ) -> None:
        from services.account_deletion import delete_account
        from services.reading_history import record_visit

        leaver = workspace["leaver"]
        await record_visit(db_session, str(leaver), "fragment", "read-before-leaving")
        caller = _Caller(id=str(leaver), roles=frozenset())

        await delete_account(db_session, caller, str(leaver))

        for table, column in (
            ("app_user", "id"),
            ("user_role", "user_id"),
            ("reading_history", "user_id"),
            ("exercise_session", "user_id"),
        ):
            remaining = await _column(
                db_session,
                f"SELECT count(*) FROM {table} WHERE {column} = :id",
                {"id": leaver},
            )
            assert remaining == 0, f"{table}.{column} still has rows"

    async def test_the_system_user_cannot_be_deleted(
        self, db_session: AsyncSession
    ) -> None:
        """It is the reassignment target; removing it would orphan the record."""
        from errors import AuthorizationError
        from services.account_deletion import delete_account

        admin = _Caller(id=str(uuid.uuid4()), roles=frozenset({"admin"}))
        with pytest.raises(AuthorizationError, match="system user"):
            await delete_account(db_session, admin, str(_SYSTEM_USER))

        assert (
            await _column(
                db_session,
                "SELECT count(*) FROM app_user WHERE id = :id",
                {"id": _SYSTEM_USER},
            )
            == 1
        )

    async def test_a_stranger_cannot_delete_someone_elses_account(
        self, db_session: AsyncSession, workspace: dict[str, Any]
    ) -> None:
        from errors import AuthorizationError
        from services.account_deletion import delete_account

        stranger = _Caller(id=str(uuid.uuid4()), roles=frozenset({"editor"}))
        with pytest.raises(AuthorizationError):
            await delete_account(db_session, stranger, str(workspace["leaver"]))

        assert (
            await _column(
                db_session,
                "SELECT count(*) FROM app_user WHERE id = :id",
                {"id": workspace["leaver"]},
            )
            == 1
        )

    async def test_an_admin_can_delete_another_account(
        self, db_session: AsyncSession, workspace: dict[str, Any]
    ) -> None:
        from services.account_deletion import delete_account

        admin = _Caller(id=str(uuid.uuid4()), roles=frozenset({"admin"}))
        await delete_account(db_session, admin, str(workspace["leaver"]))

        assert (
            await _column(
                db_session,
                "SELECT count(*) FROM app_user WHERE id = :id",
                {"id": workspace["leaver"]},
            )
            == 0
        )


@pytest.mark.asyncio(loop_scope="session")
class TestExportOverHttp:
    """The export route end to end: real app, real database, real session."""

    async def test_the_dev_editor_can_export_their_own_account(
        self, integration_test_client: Any
    ) -> None:
        response = await integration_test_client.get(
            "/api/v1/users/me/export",
            headers={"Authorization": "Bearer dev-token"},
        )

        assert response.status_code == 200
        document = response.json()
        assert document["export_version"] == 1
        assert document["profile"]["email"] == "dev@local"
        assert document["profile"]["roles"] == ["editor"]
        assert "exercise_history" in document
        assert "reading_history" in document
        assert "doppia-export-" in response.headers["content-disposition"]

    async def test_an_anonymous_caller_gets_401(
        self, integration_test_client: Any
    ) -> None:
        response = await integration_test_client.get("/api/v1/users/me/export")
        assert response.status_code == 401
