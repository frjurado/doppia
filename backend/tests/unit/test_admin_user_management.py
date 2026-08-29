"""Route-level unit tests for the admin surfaces (Component 12 Steps 10 and 11).

What matters here is who may reach these routes and what the route itself owns:
every one is admin-only, grants record who made them, and the self-demotion
guard fires. That the queries paginate and that the one-open-report index holds
are database questions, proven in ``tests/integration/test_admin_surfaces.py``.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

_ADMIN_SUB = "11111111-1111-4111-8111-111111111111"
_OTHER_SUB = "22222222-2222-4222-8222-222222222222"


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _user_item(**overrides: Any) -> Any:
    from models.admin import AdminUserItem

    base: dict[str, Any] = {
        "id": _OTHER_SUB,
        "email": "someone@test.com",
        "display_name": None,
        "roles": [],
        "created_at": datetime(2026, 8, 1, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return AdminUserItem(**base)


def _report_item(**overrides: Any) -> Any:
    from models.moderation import ReportItem

    base: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "resource_ref": "collection:8f14e45f-ceea-467a-9575-5e1b0cba1a49",
        "reporter_id": _OTHER_SUB,
        "reporter_email": "reporter@test.com",
        "reason": "spam",
        "detail": None,
        "status": "open",
        "created_at": datetime(2026, 8, 20, tzinfo=timezone.utc),
        "resolved_by": None,
        "resolved_at": None,
    }
    base.update(overrides)
    return ReportItem(**base)


def _build_app(roles: frozenset[str]) -> FastAPI:
    """Build a test app whose caller holds ``roles``."""
    from api.dependencies import AppUser, get_current_user
    from api.middleware.errors import (
        doppia_error_handler,
        http_exception_handler,
        unhandled_exception_handler,
        validation_exception_handler,
    )
    from api.router import router as api_router
    from errors import DoppiaError
    from models.base import get_db
    from sqlalchemy.ext.asyncio import AsyncSession

    app = FastAPI(lifespan=_noop_lifespan)
    app.add_exception_handler(DoppiaError, doppia_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
    app.include_router(api_router)

    caller = AppUser(
        id=_ADMIN_SUB,
        roles=roles,
        email="admin@test.com",
        email_verified=True,
    )

    async def _mock_db() -> AsyncGenerator[AsyncMock, None]:
        yield AsyncMock(spec=AsyncSession)

    app.dependency_overrides[get_db] = _mock_db
    app.dependency_overrides[get_current_user] = lambda: caller
    return app


@pytest_asyncio.fixture
async def admin_client() -> AsyncGenerator[AsyncClient, None]:
    """Client whose caller holds ``admin``."""
    app = _build_app(frozenset({"admin"}))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest_asyncio.fixture
async def editor_client() -> AsyncGenerator[AsyncClient, None]:
    """Client whose caller holds ``editor`` only — every route here must refuse."""
    app = _build_app(frozenset({"editor"}))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


class TestAdminOnly:
    """Every route in this batch is admin-only, and any-of means any-of."""

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/api/v1/admin/users"),
            ("post", f"/api/v1/admin/users/{_OTHER_SUB}/roles"),
            ("delete", f"/api/v1/admin/users/{_OTHER_SUB}/roles/editor"),
            ("post", "/api/v1/admin/invites"),
            ("get", "/api/v1/admin/moderation/reports"),
            ("post", f"/api/v1/admin/moderation/reports/{uuid.uuid4()}/dismiss"),
        ],
    )
    async def test_an_editor_is_refused(
        self, editor_client: AsyncClient, method: str, path: str
    ) -> None:
        # An editor is not a lesser admin: since ADR-037 require_role is any-of,
        # so holding `editor` grants nothing here.
        kwargs = {"json": {}} if method == "post" else {}
        response = await getattr(editor_client, method)(path, **kwargs)
        assert response.status_code == 403


class TestUserList:
    """GET /api/v1/admin/users"""

    async def test_lists_accounts_with_their_granted_roles(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from models.admin import AdminUserListResponse

        monkeypatch.setattr(
            "services.users.list_users",
            AsyncMock(
                return_value=AdminUserListResponse(
                    items=[_user_item(roles=["admin", "editor"])], next_cursor="next"
                )
            ),
        )
        response = await admin_client.get("/api/v1/admin/users?query=some&page_size=10")

        assert response.status_code == 200
        body = response.json()
        assert body["items"][0]["roles"] == ["admin", "editor"]
        assert body["next_cursor"] == "next"

    async def test_rejects_an_out_of_range_page_size(
        self, admin_client: AsyncClient
    ) -> None:
        response = await admin_client.get("/api/v1/admin/users?page_size=500")
        assert response.status_code == 422


class TestRoleGrants:
    """POST/DELETE /api/v1/admin/users/{id}/roles"""

    async def test_grant_records_the_granting_admin(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        grant = AsyncMock(return_value=None)
        monkeypatch.setattr(
            "services.users.get_admin_user",
            AsyncMock(return_value=_user_item(roles=["editor"])),
        )
        monkeypatch.setattr("services.users.grant_role", grant)

        response = await admin_client.post(
            f"/api/v1/admin/users/{_OTHER_SUB}/roles", json={"role": "editor"}
        )

        assert response.status_code == 200
        assert response.json()["roles"] == ["editor"]
        assert grant.await_args.kwargs["granted_by"] == uuid.UUID(_ADMIN_SUB)

    async def test_refuses_a_role_outside_the_grantable_set(
        self, admin_client: AsyncClient
    ) -> None:
        """``registered`` is implicit in holding an account and is never granted."""
        response = await admin_client.post(
            f"/api/v1/admin/users/{_OTHER_SUB}/roles", json={"role": "registered"}
        )
        assert response.status_code == 422

    async def test_revoke_passes_the_caller_for_the_self_demotion_guard(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        revoke = AsyncMock(return_value=None)
        monkeypatch.setattr(
            "services.users.get_admin_user", AsyncMock(return_value=_user_item())
        )
        monkeypatch.setattr("services.users.revoke_role", revoke)

        await admin_client.delete(f"/api/v1/admin/users/{_OTHER_SUB}/roles/editor")

        assert revoke.await_args.kwargs["revoked_by"] == uuid.UUID(_ADMIN_SUB)

    async def test_revoking_your_own_admin_is_a_409(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The one guard worth having: there is no self-service path back."""
        from errors import SelfAdminRevocationError

        monkeypatch.setattr(
            "services.users.get_admin_user",
            AsyncMock(return_value=_user_item(id=_ADMIN_SUB)),
        )
        monkeypatch.setattr(
            "services.users.revoke_role",
            AsyncMock(
                side_effect=SelfAdminRevocationError(
                    "You cannot revoke your own admin."
                )
            ),
        )

        response = await admin_client.delete(
            f"/api/v1/admin/users/{_ADMIN_SUB}/roles/admin"
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "SELF_ADMIN_REVOCATION"


class TestInvites:
    """POST /api/v1/admin/invites"""

    async def test_issues_an_invitation(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        invite = AsyncMock(return_value=None)
        monkeypatch.setattr("api.routes.admin.invite_user", invite)

        response = await admin_client.post(
            "/api/v1/admin/invites", json={"email": "newcomer@test.com"}
        )

        # 202: what this creates is an email in flight, not a readable account.
        assert response.status_code == 202
        assert response.json()["email"] == "newcomer@test.com"
        invite.assert_awaited_once_with("newcomer@test.com")

    async def test_rejects_a_malformed_address(self, admin_client: AsyncClient) -> None:
        response = await admin_client.post(
            "/api/v1/admin/invites", json={"email": "not-an-address"}
        )
        assert response.status_code == 422


class TestModerationQueue:
    """GET /api/v1/admin/moderation/reports and its one resolution."""

    async def test_lists_open_reports_by_default(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from models.moderation import ReportListResponse

        listing = AsyncMock(
            return_value=ReportListResponse(items=[_report_item()], next_cursor=None)
        )
        monkeypatch.setattr("services.moderation.list_reports", listing)

        response = await admin_client.get("/api/v1/admin/moderation/reports")

        assert response.status_code == 200
        assert response.json()["items"][0]["reason"] == "spam"
        assert listing.await_args.kwargs["status"] == "open"

    async def test_dismissal_records_the_resolving_admin(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        resolve = AsyncMock(
            return_value=_report_item(status="dismissed", resolved_by=_ADMIN_SUB)
        )
        monkeypatch.setattr("services.moderation.resolve_report", resolve)
        report_id = uuid.uuid4()

        response = await admin_client.post(
            f"/api/v1/admin/moderation/reports/{report_id}/dismiss"
        )

        assert response.status_code == 200
        assert response.json()["status"] == "dismissed"
        # The outcome is an argument, so Component 13's "unpublish share" lands
        # as a second route rather than a change to the service.
        assert resolve.await_args.args[3] == "dismissed"

    async def test_dismissing_a_closed_report_is_a_409(
        self, admin_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from errors import ReportAlreadyResolvedError

        monkeypatch.setattr(
            "services.moderation.resolve_report",
            AsyncMock(side_effect=ReportAlreadyResolvedError("Already closed.")),
        )
        response = await admin_client.post(
            f"/api/v1/admin/moderation/reports/{uuid.uuid4()}/dismiss"
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "REPORT_ALREADY_RESOLVED"

    async def test_there_is_no_report_endpoint_yet(
        self, admin_client: AsyncClient
    ) -> None:
        """The report *action* ships dark: nothing is reportable until 13.

        The service exists and is tested; deliberately no route exposes it, so
        there is no dead UI and no endpoint accepting refs to resources that
        cannot exist.
        """
        response = await admin_client.post(
            "/api/v1/moderation/reports",
            json={"resource_ref": "collection:x", "reason": "spam"},
        )
        assert response.status_code == 404
