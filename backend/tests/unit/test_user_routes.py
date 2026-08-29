"""Route-level unit tests for the account surface (Component 12 Steps 6 and 8).

The profile is the first surface every registered user reaches, so the cases
that matter most are the ones that keep it *only* theirs: it is gated on
authentication rather than on a role, writes go through the verification gate,
and the granted role set is read-only here — changing it is an admin action.

The export route is tested here for what the *route* owns — who it acts for,
what it returns. That the document itself is complete is proven against a real
database in ``tests/integration/test_data_rights.py``.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

_USER_SUB = "11111111-1111-4111-8111-111111111111"


@asynccontextmanager
async def _noop_lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    yield


def _profile(**overrides: object) -> dict:
    from models.profile import ProfileResponse

    base = {
        "id": _USER_SUB,
        "email": "editor@test.com",
        "email_verified": True,
        "display_name": None,
        "self_declared_role": None,
        "reading_history_opt_in": False,
        "roles": ["editor"],
    }
    base.update(overrides)
    return ProfileResponse(**base).model_dump()  # type: ignore[arg-type]


@pytest_asyncio.fixture
async def profile_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[tuple[AsyncClient, object], None]:
    """Client with ``get_current_user`` overridden to a verified editor.

    Yields:
        ``(client, dev_user)`` so a test can flip the caller's verification
        state without rebuilding the app.
    """
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

    dev_user = AppUser(
        id=_USER_SUB,
        roles=frozenset({"editor"}),
        email="editor@test.com",
        email_verified=True,
    )

    async def _mock_db() -> AsyncGenerator[AsyncMock, None]:
        yield AsyncMock(spec=AsyncSession)

    app.dependency_overrides[get_db] = _mock_db
    app.dependency_overrides[get_current_user] = lambda: dev_user

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client, dev_user


class TestReadProfile:
    async def test_returns_the_callers_own_account(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, _ = profile_client
        monkeypatch.setattr(
            "services.users.get_profile",
            AsyncMock(return_value=_profile(display_name="Francisco")),
        )
        response = await client.get("/api/v1/users/me")
        assert response.status_code == 200
        body = response.json()
        assert body["email"] == "editor@test.com"
        assert body["display_name"] == "Francisco"

    async def test_exposes_granted_roles_read_only(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """`roles` (granted) and `self_declared_role` (self-reported) are
        different things and must never be conflated: only the latter is
        writable here."""
        client, _ = profile_client
        update = AsyncMock(return_value=_profile())
        monkeypatch.setattr("services.users.update_profile", update)

        await client.patch("/api/v1/users/me", json={"roles": ["admin"]})

        # The request model has no `roles` field, so an attempt to send one is
        # simply not part of the parsed payload.
        payload = update.await_args.args[2]
        assert not hasattr(payload, "roles")


class TestUpdateProfile:
    async def test_applies_a_partial_edit(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, _ = profile_client
        update = AsyncMock(return_value=_profile(display_name="Francisco"))
        monkeypatch.setattr("services.users.update_profile", update)

        response = await client.patch(
            "/api/v1/users/me", json={"display_name": "Francisco"}
        )
        assert response.status_code == 200
        payload = update.await_args.args[2]
        # Only the supplied field is in the set; the others must stay untouched
        # rather than being overwritten with None.
        assert payload.model_fields_set == {"display_name"}

    async def test_null_clears_rather_than_meaning_absent(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Withdrawing a self-description is a real edit, not a no-op."""
        client, _ = profile_client
        update = AsyncMock(return_value=_profile())
        monkeypatch.setattr("services.users.update_profile", update)

        await client.patch("/api/v1/users/me", json={"self_declared_role": None})

        payload = update.await_args.args[2]
        assert payload.model_fields_set == {"self_declared_role"}
        assert payload.self_declared_role is None

    async def test_rejects_a_role_outside_the_vocabulary(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, _ = profile_client
        update = AsyncMock()
        monkeypatch.setattr("services.users.update_profile", update)

        response = await client.patch(
            "/api/v1/users/me", json={"self_declared_role": "conductor"}
        )
        assert response.status_code == 422
        update.assert_not_awaited()

    async def test_unverified_caller_is_blocked_with_the_error_envelope(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The gate lives in the service, so the route just propagates it."""
        from errors import EmailNotVerifiedError

        client, _ = profile_client
        monkeypatch.setattr(
            "services.users.update_profile",
            AsyncMock(side_effect=EmailNotVerifiedError("Confirm your address.")),
        )
        response = await client.patch(
            "/api/v1/users/me", json={"display_name": "Francisco"}
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "EMAIL_NOT_VERIFIED"

    async def test_reading_history_consent_is_a_plain_boolean_edit(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The consent lands before the history table it governs (Step 7)."""
        client, _ = profile_client
        update = AsyncMock(return_value=_profile(reading_history_opt_in=True))
        monkeypatch.setattr("services.users.update_profile", update)

        response = await client.patch(
            "/api/v1/users/me", json={"reading_history_opt_in": True}
        )
        assert response.status_code == 200
        assert response.json()["reading_history_opt_in"] is True


class TestExport:
    """GET /api/v1/users/me/export — the caller's own data, as one document."""

    async def test_returns_the_document_for_the_caller(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, dev_user = profile_client
        build = AsyncMock(
            return_value={
                "export_version": 1,
                "generated_at": "2026-08-29T10:00:00+00:00",
                "user_id": _USER_SUB,
                "profile": {"id": _USER_SUB},
                "exercise_history": [],
                "reading_history": [],
            }
        )
        monkeypatch.setattr("api.routes.users.build_export", build)

        response = await client.get("/api/v1/users/me/export")

        assert response.status_code == 200
        assert response.json()["user_id"] == _USER_SUB
        # The id passed to the exporter is the *caller's*, never a parameter:
        # there is no way to ask this route for somebody else's data.
        assert build.await_args.args[1] == dev_user.id  # type: ignore[attr-defined]

    async def test_offers_a_filename_for_a_direct_fetch(
        self,
        profile_client: tuple[AsyncClient, object],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, _ = profile_client
        monkeypatch.setattr(
            "api.routes.users.build_export",
            AsyncMock(
                return_value={
                    "export_version": 1,
                    "generated_at": "2026-08-29T10:00:00+00:00",
                    "user_id": _USER_SUB,
                }
            ),
        )
        response = await client.get("/api/v1/users/me/export")
        assert (
            "doppia-export-2026-08-29.json" in response.headers["content-disposition"]
        )

    async def test_requires_authentication(self) -> None:
        """Without the dependency override, a tokenless request is refused."""
        from api.middleware.auth import AuthMiddleware
        from api.router import router as api_router
        from models.base import get_db
        from sqlalchemy.ext.asyncio import AsyncSession

        app = FastAPI(lifespan=_noop_lifespan)
        app.add_middleware(AuthMiddleware)
        app.include_router(api_router)

        async def _mock_db() -> AsyncGenerator[AsyncMock, None]:
            yield AsyncMock(spec=AsyncSession)

        # Overridden only so the session dependency resolves; the 401 comes
        # from ``get_current_user``, before anything touches it.
        app.dependency_overrides[get_db] = _mock_db
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/api/v1/users/me/export")
        assert response.status_code == 401
