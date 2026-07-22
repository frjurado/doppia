"""Unit tests for the rate limiter (Component 10 Step 8, security-model.md § 2).

Two surfaces are exercised:

* :func:`api.rate_limiting.get_user_or_ip` — the key function. Authenticated
  callers key on ``user:{sub}``; anonymous callers key on the true client IP,
  preferring Fly.io's ``Fly-Client-IP`` header over the proxy address.
* :func:`api.rate_limiting.rate_limit_exceeded_handler` — a breach returns 429
  with the Doppia error envelope (``RATE_LIMIT_EXCEEDED`` +
  ``detail.retry_after_seconds``) and a ``Retry-After`` header, and two users
  behind one IP do not share a bucket.

Each app-level test builds a **fresh** ``Limiter`` with in-memory storage so no
count leaks between tests (the module-level limiter is a process singleton). The
handler and key function under test are the real ones — only the storage and
the trivial limited route are test scaffolding. The end-to-end 429 on the real
public route is verified on the staging deploy (needs a live DB).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest_asyncio
from api.dependencies import AppUser
from api.rate_limiting import get_user_or_ip, rate_limit_exceeded_handler
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from starlette.requests import Request as StarletteRequest


def _make_request(
    headers: dict[str, str] | None = None,
    client: tuple[str, int] | None = ("203.0.113.7", 12345),
    user: AppUser | None = None,
) -> Request:
    """Construct a Starlette ``Request`` with the given headers/client/user."""
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope: dict = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": raw,
        "client": client,
    }
    request = StarletteRequest(scope)
    request.state.user = user
    return request


# ---------------------------------------------------------------------------
# get_user_or_ip — the key function
# ---------------------------------------------------------------------------


def test_key_is_user_scoped_when_authenticated() -> None:
    """An authenticated caller keys on the JWT sub, not the IP."""
    user = AppUser(id="sub-abc", role="editor", email="e@test")
    request = _make_request(client=("203.0.113.7", 1), user=user)
    assert get_user_or_ip(request) == "user:sub-abc"


def test_key_prefers_fly_client_ip_for_anonymous() -> None:
    """Anonymous keying trusts Fly's edge header over the proxy address."""
    request = _make_request(
        headers={"Fly-Client-IP": "198.51.100.42", "X-Forwarded-For": "1.1.1.1"},
        client=("10.0.0.1", 1),  # the Fly proxy, not the real client
    )
    assert get_user_or_ip(request) == "198.51.100.42"


def test_key_falls_back_to_forwarded_for_then_remote_addr() -> None:
    """Without Fly's header, X-Forwarded-For's first hop wins; else client.host."""
    xff = _make_request(headers={"X-Forwarded-For": "198.51.100.9, 10.0.0.1"})
    assert get_user_or_ip(xff) == "198.51.100.9"

    direct = _make_request(client=("203.0.113.7", 1))
    assert get_user_or_ip(direct) == "203.0.113.7"


# ---------------------------------------------------------------------------
# Handler + limiter behaviour (fresh limiter per app)
# ---------------------------------------------------------------------------


def _build_limited_app(limit: str) -> FastAPI:
    """Build an app whose one route is limited by a fresh in-memory limiter.

    A middleware sets ``request.state.user`` from an ``X-Test-User`` header so a
    test can simulate distinct authenticated callers sharing one client IP.
    """
    limiter = Limiter(
        key_func=get_user_or_ip, default_limits=[], storage_uri="memory://"
    )
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    @app.middleware("http")
    async def _attach_user(request: Request, call_next):  # type: ignore[no-untyped-def]
        uid = request.headers.get("X-Test-User")
        request.state.user = (
            AppUser(id=uid, role="editor", email="e@test") if uid else None
        )
        return await call_next(request)

    @app.get("/ping")
    @limiter.limit(limit)
    async def ping(request: Request) -> dict[str, bool]:
        return {"ok": True}

    return app


@pytest_asyncio.fixture
async def client_factory() -> AsyncGenerator:
    """Yield a helper that opens an async client over a freshly limited app."""
    clients: list[AsyncClient] = []

    def _make(limit: str) -> AsyncClient:
        app = _build_limited_app(limit)
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(c)
        return c

    yield _make
    for c in clients:
        await c.aclose()


async def test_breach_returns_429_envelope_and_retry_after(client_factory) -> None:
    """The (N+1)-th request in the window is 429 with the envelope + Retry-After."""
    client = client_factory("2/minute")
    assert (await client.get("/ping")).status_code == 200
    assert (await client.get("/ping")).status_code == 200

    resp = await client.get("/ping")
    assert resp.status_code == 429
    assert resp.headers["Retry-After"] == "60"
    body = resp.json()
    assert body["error"]["code"] == "RATE_LIMIT_EXCEEDED"
    assert body["error"]["detail"]["retry_after_seconds"] == 60
    assert "60 seconds" in body["error"]["message"]


async def test_two_users_behind_one_ip_do_not_share_a_bucket(client_factory) -> None:
    """Per-user keying: user B is unaffected by user A exhausting the limit."""
    client = client_factory("2/minute")
    a = {"X-Test-User": "user-a"}
    b = {"X-Test-User": "user-b"}

    assert (await client.get("/ping", headers=a)).status_code == 200
    assert (await client.get("/ping", headers=a)).status_code == 200
    assert (await client.get("/ping", headers=a)).status_code == 429  # A exhausted

    # Same client IP, different user → fresh bucket.
    assert (await client.get("/ping", headers=b)).status_code == 200
    assert (await client.get("/ping", headers=b)).status_code == 200


async def test_anonymous_callers_share_by_ip(client_factory) -> None:
    """Anonymous requests from one IP share a bucket (no user identity)."""
    client = client_factory("2/minute")
    assert (await client.get("/ping")).status_code == 200
    assert (await client.get("/ping")).status_code == 200
    assert (await client.get("/ping")).status_code == 429


async def test_unreachable_store_fails_over_to_memory_not_500() -> None:
    """A configured-but-unreachable store must degrade to in-memory limiting.

    Regression guard for the staging incident: with only ``swallow_errors=True``,
    slowapi swallows the storage error but then reads the unset
    ``request.state.view_rate_limit`` → ``AttributeError`` → 500 on every guarded
    route. ``in_memory_fallback_enabled=True`` (the module limiter's config)
    limits via memory on a store outage instead, so the route stays up and the
    limit is still enforced.
    """
    app = FastAPI()
    limiter = Limiter(
        key_func=get_user_or_ip,
        default_limits=[],
        storage_uri="rediss://default:pw@10.255.255.1:6379",  # unroutable
        storage_options={"socket_connect_timeout": 1, "socket_timeout": 1},
        in_memory_fallback_enabled=True,
    )
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    @app.get("/probe")
    @limiter.limit("2/minute")
    async def _probe(request: Request) -> dict[str, bool]:
        return {"ok": True}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/probe")).status_code == 200  # not 500
        assert (await client.get("/probe")).status_code == 200
        assert (await client.get("/probe")).status_code == 429  # memory enforces
