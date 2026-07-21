"""Rate limiting for the Doppia API (``slowapi`` + Redis).

The public read path (``/api/v1/public/``) is the first surface that will see
anonymous traffic, so it is the primary consumer of these limits; the editor
API inherits the per-category values from ``security-model.md`` § 2.

Design (see ``docs/architecture/security-model.md`` § 2):

* **Key function** — authenticated requests are keyed on the JWT ``sub`` claim
  (``user:{id}``) so two users behind one NAT do not share a bucket; anonymous
  requests fall back to the client IP. Behind Fly.io the true client IP is in
  the ``Fly-Client-IP`` header (the edge sets it and a client cannot forge it),
  so it is preferred over ``request.client.host`` (which is the proxy).
* **Storage** — ``RATELIMIT_STORAGE_URI`` selects the backend. Deployed
  environments point it at the Upstash Redis already in the stack (``redis://``,
  the sync client from the ``redis`` package — no new dependency), so counters
  survive a restart and are shared across machines. It defaults to ``memory://``
  for local dev and tests, which need no Redis.
* **Response** — a breach returns ``429`` with the standard error envelope
  (``code: RATE_LIMIT_EXCEEDED``) and a ``Retry-After`` header, via
  :func:`rate_limit_exceeded_handler`.

The per-category limit strings are module constants; a route opts in with
``@limiter.limit(<CONST>)`` and a ``request: Request`` parameter. Applying a
limit to a new route is a one-line decorator, not a config change here.
"""

from __future__ import annotations

import os

from models.errors import ErrorCode, ErrorResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request
from starlette.responses import JSONResponse

# ---------------------------------------------------------------------------
# Per-category limits (security-model.md § 2 — Phase 2 starting values).
# Tune against observed traffic; these are deliberately generous.
# ---------------------------------------------------------------------------

# Read endpoints (fragments, concepts) — cheap.
READ_AUTHENTICATED = "300/minute"
READ_ANONYMOUS = "60/minute"

# Write endpoints (fragment create/patch) — editor role only.
WRITE = "60/minute"

# Graph traversal (concept neighbourhood, tree) — more expensive (Neo4j).
GRAPH_AUTHENTICATED = "60/minute"
GRAPH_ANONYMOUS = "30/minute"

# Exercise generation (graph + PostgreSQL) — reserved for its Phase-2 consumer.
EXERCISE_AUTHENTICATED = "120/minute"
EXERCISE_ANONYMOUS = "30/minute"

# File upload (MEI corpus ZIP) — admin only; prevent runaway ingestion.
UPLOAD = "20/minute"


def _client_ip(request: Request) -> str:
    """Return the true client IP, trusting Fly.io's edge headers.

    ``get_remote_address`` reads ``request.client.host``, which behind the
    Fly.io proxy is the proxy's address — every anonymous caller would then
    share one bucket. Fly sets ``Fly-Client-IP`` to the real client IP (and
    overwrites any client-supplied value), so it is authoritative on our
    infrastructure; ``X-Forwarded-For`` is a secondary fallback.

    Args:
        request: The incoming request.

    Returns:
        The client IP string to key an anonymous rate-limit bucket on.
    """
    fly_ip = request.headers.get("Fly-Client-IP")
    if fly_ip:
        return fly_ip.strip()
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return get_remote_address(request)


def get_user_or_ip(request: Request) -> str:
    """Rate-limit key: per-user when authenticated, per-IP when anonymous.

    ``AuthMiddleware`` runs before any route and sets ``request.state.user`` to
    an ``AppUser`` (or ``None``). Keying authenticated traffic on the immutable
    ``sub`` claim prevents one bad actor from throttling every other user behind
    the same NAT.

    Args:
        request: The incoming request, after ``AuthMiddleware`` has run.

    Returns:
        ``"user:{id}"`` for an authenticated caller, else the client IP.
    """
    user = getattr(request.state, "user", None)
    if user is not None:
        return f"user:{user.id}"
    return _client_ip(request)


def _storage_uri() -> str:
    """Return the ``limits`` storage URI for the limiter.

    Deployed environments set ``RATELIMIT_STORAGE_URI`` to the Upstash Redis
    URL so counters are shared and survive restarts; local dev and tests fall
    back to in-process memory, which needs no Redis.

    Returns:
        A ``limits`` storage URI (e.g. ``redis://...`` or ``memory://``).
    """
    return os.environ.get("RATELIMIT_STORAGE_URI") or "memory://"


# The application-wide limiter. ``default_limits=[]`` means no global cap is
# applied implicitly — a route is limited only when it opts in with a
# ``@limiter.limit(...)`` decorator, so every limited surface is explicit.
limiter = Limiter(
    key_func=get_user_or_ip,
    default_limits=[],
    storage_uri=_storage_uri(),
    headers_enabled=False,  # Retry-After is set by our handler below.
    # Fail open: if the Redis store is momentarily unreachable, allow the
    # request rather than returning 500. A rate limiter must never be a single
    # point of failure for the endpoints it guards.
    swallow_errors=True,
)


async def rate_limit_exceeded_handler(
    request: Request,
    exc: RateLimitExceeded,
) -> JSONResponse:
    """Render a rate-limit breach as the standard error envelope + ``Retry-After``.

    slowapi's built-in handler returns a bare ``{"error": "..."}`` string and no
    ``Retry-After``; this replaces it with the Doppia envelope
    (``code: RATE_LIMIT_EXCEEDED``, ``detail.retry_after_seconds``) and the
    header, matching ``security-model.md`` § 2.

    Args:
        request: The request that breached the limit (unused; required by the
            exception-handler signature).
        exc: The raised :class:`~slowapi.errors.RateLimitExceeded`, carrying the
            breached limit.

    Returns:
        A ``429`` :class:`~starlette.responses.JSONResponse` with the envelope
        and a ``Retry-After`` header.
    """
    retry_after = int(exc.limit.limit.get_expiry())
    body = ErrorResponse.make(
        code=ErrorCode.RATE_LIMIT_EXCEEDED,
        message=f"Too many requests. Please retry after {retry_after} seconds.",
        detail={"retry_after_seconds": retry_after},
    )
    return JSONResponse(
        status_code=429,
        content=body.model_dump(),
        headers={"Retry-After": str(retry_after)},
    )
