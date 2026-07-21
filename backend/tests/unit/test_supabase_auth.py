"""Unit tests for services/supabase_auth.py (Component 10 Step 7).

Covers the server-side Supabase Auth client's response parsing and error
mapping, with Supabase's HTTP responses faked via ``httpx.MockTransport`` — no
network and no live project.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from httpx import AsyncClient as _RealAsyncClient
from services import supabase_auth
from services.supabase_auth import SupabaseAuthError

_TOKEN_BODY = {
    "access_token": "access-xyz",
    "refresh_token": "refresh-xyz",
    "expires_in": 3600,
    "user": {
        "id": "user-1",
        "email": "editor@test.com",
        "app_metadata": {"role": "editor"},
    },
}


@pytest.fixture(autouse=True)
def _configure_supabase(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://test-project.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")


def _mock_httpx(monkeypatch: pytest.MonkeyPatch, handler: Callable) -> None:
    """Route the service's ``httpx.AsyncClient`` through a MockTransport."""

    def factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        # _RealAsyncClient is captured before the patch, so this does not recurse
        # into the factory when the service constructs its client.
        return _RealAsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(supabase_auth.httpx, "AsyncClient", factory)


async def test_password_grant_parses_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("grant_type") == "password"
        assert request.headers["apikey"] == "anon-key"
        return httpx.Response(200, json=_TOKEN_BODY)

    _mock_httpx(monkeypatch, handler)
    session = await supabase_auth.password_grant("editor@test.com", "pw")
    assert session.access_token == "access-xyz"
    assert session.refresh_token == "refresh-xyz"
    assert session.expires_in == 3600
    assert session.user_id == "user-1"
    assert session.role == "editor"


async def test_password_grant_bad_credentials_maps_to_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_httpx(
        monkeypatch,
        lambda request: httpx.Response(400, json={"error": "invalid_grant"}),
    )
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.password_grant("editor@test.com", "wrong")
    assert exc.value.status_code == 401
    assert exc.value.code == "invalid_credentials"


async def test_refresh_grant_bad_token_maps_to_401_invalid_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("grant_type") == "refresh_token"
        return httpx.Response(400, json={"error": "invalid_grant"})

    _mock_httpx(monkeypatch, handler)
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.refresh_grant("rt-expired")
    assert exc.value.status_code == 401
    assert exc.value.code == "invalid_grant"


async def test_server_error_maps_to_503(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_httpx(monkeypatch, lambda request: httpx.Response(500, text="boom"))
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.password_grant("editor@test.com", "pw")
    assert exc.value.status_code == 503


async def test_missing_tokens_maps_to_502(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_httpx(
        monkeypatch,
        lambda request: httpx.Response(200, json={"user": {"id": "u"}}),
    )
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.password_grant("editor@test.com", "pw")
    assert exc.value.status_code == 502


async def test_transport_error_maps_to_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    _mock_httpx(monkeypatch, handler)
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.refresh_grant("rt")
    assert exc.value.status_code == 503


async def test_unconfigured_supabase_url_maps_to_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.password_grant("editor@test.com", "pw")
    assert exc.value.status_code == 503
