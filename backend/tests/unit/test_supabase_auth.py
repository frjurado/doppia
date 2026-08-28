"""Unit tests for services/supabase_auth.py (Component 10 Step 7).

Covers the server-side Supabase Auth client's response parsing and error
mapping, with Supabase's HTTP responses faked via ``httpx.MockTransport`` — no
network and no live project.
"""

from __future__ import annotations

import json
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
        "email_confirmed_at": "2026-08-01T00:00:00Z",
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
    # The grant reports verification; roles are read from user_role, not here.
    assert session.email_verified is True


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


# ---------------------------------------------------------------------------
# OAuth (PKCE) — Component 12 Step 4
# ---------------------------------------------------------------------------


def test_pkce_challenge_is_the_s256_of_the_verifier() -> None:
    """The challenge must be base64url(SHA-256(verifier)), unpadded.

    Supabase verifies this relation on the exchange; getting the encoding wrong
    fails only at the very end of a live round trip, which is an expensive place
    to discover a typo.
    """
    import base64
    import hashlib

    verifier, challenge = supabase_auth.generate_pkce_pair()
    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
        .decode("ascii")
        .rstrip("=")
    )
    assert challenge == expected
    assert "=" not in challenge


def test_pkce_pair_is_fresh_each_time() -> None:
    """Two flows must not share a verifier."""
    assert (
        supabase_auth.generate_pkce_pair()[0] != supabase_auth.generate_pkce_pair()[0]
    )


def test_authorize_url_carries_provider_pkce_and_the_configured_return(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The return address comes from PUBLIC_APP_URL, never from a caller."""
    from urllib.parse import parse_qs, urlparse

    monkeypatch.setenv("PUBLIC_APP_URL", "https://doppia-staging.fly.dev/")
    url = supabase_auth.oauth_authorize_url("google", "chal-123")
    parsed = urlparse(url)
    query = parse_qs(parsed.query)

    assert parsed.netloc == "test-project.supabase.co"
    assert parsed.path == "/auth/v1/authorize"
    assert query["provider"] == ["google"]
    assert query["code_challenge"] == ["chal-123"]
    assert query["code_challenge_method"] == ["s256"]
    assert query["redirect_to"] == ["https://doppia-staging.fly.dev/auth/callback"]


def test_authorize_url_rejects_an_unsupported_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The provider name is interpolated into a URL; the set is closed."""
    monkeypatch.setenv("PUBLIC_APP_URL", "https://doppia-staging.fly.dev")
    with pytest.raises(ValueError):
        supabase_auth.oauth_authorize_url("github", "chal-123")


def test_public_app_url_refuses_to_guess_outside_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unset PUBLIC_APP_URL in staging is a 503, not a localhost redirect."""
    monkeypatch.delenv("PUBLIC_APP_URL", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "staging")
    with pytest.raises(SupabaseAuthError) as exc:
        supabase_auth.public_app_url()
    assert exc.value.status_code == 503


def test_public_app_url_falls_back_to_the_vite_origin_locally(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PUBLIC_APP_URL", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "local")
    assert supabase_auth.public_app_url() == "http://localhost:5173"


async def test_pkce_grant_posts_the_code_and_verifier(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The exchange is a server-side token grant, not a browser round trip."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["grant_type"] = request.url.params.get("grant_type")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=_TOKEN_BODY)

    _mock_httpx(monkeypatch, handler)
    session = await supabase_auth.pkce_grant("auth-code-1", "verifier-1")

    assert seen["grant_type"] == "pkce"
    assert seen["body"] == {"auth_code": "auth-code-1", "code_verifier": "verifier-1"}
    assert session.refresh_token == "refresh-xyz"


async def test_pkce_grant_bad_code_maps_to_401_invalid_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A used or mismatched code is an expired sign-in, not bad credentials."""
    _mock_httpx(
        monkeypatch,
        lambda request: httpx.Response(400, json={"error": "invalid_request"}),
    )
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.pkce_grant("stale-code", "verifier-1")
    assert exc.value.status_code == 401
    assert exc.value.code == "invalid_grant"


async def test_password_reset_link_returns_to_the_page_that_can_act_on_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The recovery email must land on /auth/reset-password, not the generic
    callback: the SPA route is what renders the set-a-new-password form, and
    the redirect target is the only thing that tells it why the user arrived.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["redirect_to"] = request.url.params.get("redirect_to")
        return httpx.Response(200, json={})

    monkeypatch.setenv("PUBLIC_APP_URL", "https://doppia-staging.fly.dev")
    _mock_httpx(monkeypatch, handler)
    await supabase_auth.request_password_reset("someone@test.com")

    assert seen["path"] == "/auth/v1/recover"
    assert seen["redirect_to"] == "https://doppia-staging.fly.dev/auth/reset-password"


async def test_verify_email_link_redeems_the_token_hash_server_side(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The browser carries an opaque hash; the session is established here.

    This is what keeps ADR-035 intact on the email-link path: Supabase's own
    verify endpoint would redirect back with the session in the URL.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=_TOKEN_BODY)

    _mock_httpx(monkeypatch, handler)
    session = await supabase_auth.verify_email_link("hash-abc", "recovery")

    assert seen["path"] == "/auth/v1/verify"
    assert seen["body"] == {"type": "recovery", "token_hash": "hash-abc"}
    assert session.refresh_token == "refresh-xyz"


async def test_verify_email_link_rejects_an_unknown_type() -> None:
    """The type is forwarded to Supabase as the kind of token being redeemed."""
    with pytest.raises(ValueError):
        await supabase_auth.verify_email_link("hash-abc", "magiclink")


async def test_verify_email_link_maps_a_used_link_to_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Email links are single-use, so a reload of a consumed one must fail."""
    _mock_httpx(
        monkeypatch,
        lambda request: httpx.Response(401, json={"error": "invalid_token"}),
    )
    with pytest.raises(SupabaseAuthError) as exc:
        await supabase_auth.verify_email_link("stale-hash", "invite")
    assert exc.value.status_code == 401
