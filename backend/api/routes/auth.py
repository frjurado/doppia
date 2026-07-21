"""Session endpoints for the browser: login, silent refresh, and logout.

**The ADR-016 revisit (Component 10 Step 7).** Phase 1 stored the Supabase
access token in ``localStorage`` and refreshed it by re-running the password
grant from the browser. Phase 2 moves the credential exchange server-side:

* ``POST /api/v1/auth/login`` — proxies the password grant to Supabase, sets the
  refresh token in an HttpOnly cookie, and returns only the short-lived access
  token in the body.
* ``POST /api/v1/auth/refresh`` — reads the refresh cookie, runs the refresh
  grant, rotates the cookie, and returns a new access token. This is the silent
  renewal the frontend calls on load and before access-token expiry.
* ``POST /api/v1/auth/logout`` — revokes the session at Supabase (best-effort)
  and clears the cookie.

Why a cookie and not ``localStorage``: the refresh token — the long-lived
credential — never reaches JavaScript, so an XSS foothold cannot exfiltrate it.
The access token still lives in the SPA's memory, but it expires in an hour and
is gone on reload.

**CSRF posture.** The cookie is ``SameSite=Lax`` and scoped to ``Path=/api/v1/auth``,
so it is sent only on same-site requests to these three endpoints and never on
a cross-site POST. The rest of the API authenticates with the bearer access
token in the ``Authorization`` header (unreachable cross-origin), not the
cookie, so there is no cookie-driven state change to forge. Deployment is
single-origin (FastAPI serves the SPA and the API — see ``deployment.md``), so a
same-site cookie is delivered on every refresh XHR. See
``docs/architecture/security-model.md`` § 1 and the ADR extending ADR-016.

These routes carry **no** ``require_role()`` dependency: login and refresh
establish a session (there is no bearer yet, or it has expired), and logout must
succeed even when the access token is already expired. ``AuthMiddleware`` lets a
tokenless request through, so the frontend calls all three without an
``Authorization`` header.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Cookie, Response, status
from fastapi.responses import JSONResponse
from models.auth import AuthUser, LoginRequest, SessionResponse
from models.errors import ErrorCode, ErrorResponse
from services import supabase_auth
from services.supabase_auth import SupabaseAuthError, SupabaseSession

router = APIRouter(prefix="/auth", tags=["Auth"])

# The refresh cookie: HttpOnly (invisible to JS), SameSite=Lax + path-scoped
# (CSRF), Secure outside local dev (http on localhost would otherwise drop it).
_REFRESH_COOKIE = "doppia_refresh"
_COOKIE_PATH = "/api/v1/auth"
# Aligns with the Supabase session lifetime; if Supabase invalidates the refresh
# token earlier, the refresh grant returns 401 and the user logs in again.
_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60  # 30 days


def _cookie_secure() -> bool:
    """Return whether the refresh cookie should carry the ``Secure`` flag.

    Secure is required in staging/production (HTTPS) and must be off in local
    development, where the SPA is served over plain HTTP and a Secure cookie
    would be silently dropped by the browser.

    Returns:
        ``False`` only when ``ENVIRONMENT=local``; ``True`` otherwise.
    """
    return os.environ.get("ENVIRONMENT", "production") != "local"


def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    """Write the HttpOnly refresh cookie onto ``response``.

    Args:
        response: The response to attach the ``Set-Cookie`` header to.
        refresh_token: The Supabase refresh token to store.
    """
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=refresh_token,
        max_age=_COOKIE_MAX_AGE_S,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path=_COOKIE_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    """Expire the refresh cookie on ``response`` (same attributes as when set).

    ``delete_cookie`` must match ``path`` (and the Secure/SameSite attributes on
    modern browsers) or the browser keeps the original cookie.

    Args:
        response: The response to attach the clearing ``Set-Cookie`` header to.
    """
    response.delete_cookie(
        key=_REFRESH_COOKIE,
        path=_COOKIE_PATH,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )


def _session_body(session: SupabaseSession) -> dict:
    """Serialise a Supabase session into the ``SessionResponse`` envelope.

    Args:
        session: The session from a Supabase grant.

    Returns:
        A JSON-serialisable dict (the refresh token is deliberately omitted).
    """
    return SessionResponse(
        access_token=session.access_token,
        expires_in=session.expires_in,
        user=AuthUser(id=session.user_id, email=session.email, role=session.role),
    ).model_dump()


def _auth_error(exc: SupabaseAuthError, *, on_login: bool) -> JSONResponse:
    """Map a :class:`SupabaseAuthError` to the standard error envelope.

    A 503 from the service (Auth unreachable/misconfigured) surfaces as
    ``AUTH_SERVICE_UNAVAILABLE``; a 401 becomes ``INVALID_CREDENTIALS`` on the
    login path and ``UNAUTHORIZED`` on the refresh path (an expired session, not
    a typo'd password).

    Args:
        exc: The raised service error.
        on_login: Whether this is the login route (affects the 401 code).

    Returns:
        A ``JSONResponse`` carrying the envelope and the mapped status.
    """
    if exc.status_code >= 503:
        code = ErrorCode.AUTH_SERVICE_UNAVAILABLE
        http_status = status.HTTP_503_SERVICE_UNAVAILABLE
    else:
        code = ErrorCode.INVALID_CREDENTIALS if on_login else ErrorCode.UNAUTHORIZED
        http_status = status.HTTP_401_UNAUTHORIZED
    body = ErrorResponse.make(code=code, message=exc.message)
    return JSONResponse(status_code=http_status, content=body.model_dump())


@router.post(
    "/login",
    response_model=SessionResponse,
    summary="Sign in with email and password",
    response_description="A short-lived access token; the refresh token is set "
    "as an HttpOnly cookie.",
)
async def login(payload: LoginRequest, response: Response) -> dict | JSONResponse:
    """Exchange credentials for a session, setting the refresh cookie.

    Args:
        payload: The email/password credentials.
        response: The response FastAPI injects so the cookie can be attached
            alongside the returned body.

    Returns:
        The ``SessionResponse`` body on success, or an error envelope on failure.
    """
    try:
        session = await supabase_auth.password_grant(payload.email, payload.password)
    except SupabaseAuthError as exc:
        return _auth_error(exc, on_login=True)
    _set_refresh_cookie(response, session.refresh_token)
    return _session_body(session)


@router.post(
    "/refresh",
    response_model=SessionResponse,
    summary="Silently renew the session from the refresh cookie",
    response_description="A fresh access token; the rotated refresh token "
    "replaces the cookie.",
)
async def refresh(
    response: Response,
    doppia_refresh: str | None = Cookie(default=None),
) -> dict | JSONResponse:
    """Rotate the refresh token and issue a new access token.

    Args:
        response: The injected response, for setting/clearing the cookie.
        doppia_refresh: The refresh token from the HttpOnly cookie (``None`` if
            no cookie is present — i.e. no active session).

    Returns:
        The ``SessionResponse`` body on success; a 401 envelope (with the cookie
        cleared) when there is no valid session; a 503 envelope (cookie left
        intact) when Auth is transiently unreachable.
    """
    if not doppia_refresh:
        # No cookie → no session. Not an error the user needs to see; the
        # frontend treats a 401 here as "anonymous" during bootstrap.
        err = JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=ErrorResponse.make(
                code=ErrorCode.UNAUTHORIZED, message="No active session."
            ).model_dump(),
        )
        _clear_refresh_cookie(err)
        return err

    try:
        session = await supabase_auth.refresh_grant(doppia_refresh)
    except SupabaseAuthError as exc:
        err = _auth_error(exc, on_login=False)
        # Clear the cookie only when the token itself is bad (401); on a
        # transient 503 keep it so a later retry can still succeed.
        if exc.status_code < 503:
            _clear_refresh_cookie(err)
        return err

    _set_refresh_cookie(response, session.refresh_token)
    return _session_body(session)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Sign out: revoke the session and clear the cookie",
)
async def logout(
    response: Response,
    doppia_refresh: str | None = Cookie(default=None),
) -> Response:
    """End the session server- and client-side.

    Revocation uses only the cookie: the refresh token is exchanged for a fresh
    access token, which authorises the Supabase logout — so logout works even
    when the browser's in-memory access token has already expired. Revocation is
    best-effort; the cookie is always cleared.

    Args:
        response: The injected 204 response (the cookie is cleared on it).
        doppia_refresh: The refresh token from the HttpOnly cookie, if any.

    Returns:
        A 204 response with the refresh cookie cleared.
    """
    if doppia_refresh:
        try:
            session = await supabase_auth.refresh_grant(doppia_refresh)
            await supabase_auth.logout(session.access_token)
        except SupabaseAuthError:
            # Best-effort: an expired/unreachable session still clears locally.
            pass
    _clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
