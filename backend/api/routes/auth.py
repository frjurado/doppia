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

from fastapi import APIRouter, Cookie, Depends, Path, Request, Response, status
from fastapi.responses import JSONResponse
from models.auth import (
    AuthUser,
    EmailLinkRequest,
    EmailRequest,
    LoginRequest,
    OAuthCallbackRequest,
    OAuthStartResponse,
    PasswordUpdateRequest,
    SessionResponse,
    SignUpRequest,
)
from models.base import get_db
from models.errors import ErrorCode, ErrorResponse
from services import supabase_auth
from services.supabase_auth import SupabaseAuthError, SupabaseSession
from services.users import ensure_app_user, load_roles
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/auth", tags=["Auth"])

# The refresh cookie: HttpOnly (invisible to JS), SameSite=Lax + path-scoped
# (CSRF), Secure outside local dev (http on localhost would otherwise drop it).
_REFRESH_COOKIE = "doppia_refresh"
# The PKCE verifier, held across the OAuth round trip. Same HttpOnly/path-scoped
# treatment as the refresh cookie and for the same reason: an authorization code
# intercepted in transit is worthless without a verifier no script can read.
_PKCE_COOKIE = "doppia_pkce"
_PKCE_MAX_AGE_S = 10 * 60  # one consent screen, generously timed
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


def _set_pkce_cookie(response: Response, verifier: str) -> None:
    """Store the PKCE verifier for the duration of the OAuth round trip.

    Args:
        response: The response to attach the ``Set-Cookie`` header to.
        verifier: The verifier minted by ``supabase_auth.generate_pkce_pair``.
    """
    response.set_cookie(
        key=_PKCE_COOKIE,
        value=verifier,
        max_age=_PKCE_MAX_AGE_S,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path=_COOKIE_PATH,
    )


def _clear_pkce_cookie(response: Response) -> None:
    """Expire the PKCE cookie (same attributes as when set).

    Args:
        response: The response to attach the clearing ``Set-Cookie`` header to.
    """
    response.delete_cookie(
        key=_PKCE_COOKIE,
        path=_COOKIE_PATH,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
    )


async def _session_body(session: SupabaseSession, db: AsyncSession) -> dict:
    """Serialise a Supabase session into the ``SessionResponse`` envelope.

    The caller's roles come from ``user_role``, not from the Supabase grant —
    the same source ``get_current_user`` reads on every subsequent request, so
    the SPA's view of its own permissions can never drift from the API's
    (ADR-037). The ``app_user`` mirror row is ensured first, so a first-ever
    login resolves against a row that exists.

    Args:
        session: The session from a Supabase grant.
        db: Async database session.

    Returns:
        A JSON-serialisable dict (the refresh token is deliberately omitted).
    """
    await ensure_app_user(db, session.user_id, session.email)
    roles = await load_roles(db, session.user_id)
    return SessionResponse(
        access_token=session.access_token,
        expires_in=session.expires_in,
        user=AuthUser(
            id=session.user_id,
            email=session.email,
            roles=sorted(roles),
            email_verified=session.email_verified,
        ),
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
async def login(
    payload: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict | JSONResponse:
    """Exchange credentials for a session, setting the refresh cookie.

    Args:
        payload: The email/password credentials.
        response: The response FastAPI injects so the cookie can be attached
            alongside the returned body.
        db: Async database session, for the caller's role set.

    Returns:
        The ``SessionResponse`` body on success, or an error envelope on failure.
    """
    try:
        session = await supabase_auth.password_grant(payload.email, payload.password)
    except SupabaseAuthError as exc:
        return _auth_error(exc, on_login=True)
    _set_refresh_cookie(response, session.refresh_token)
    return await _session_body(session, db)


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
    db: AsyncSession = Depends(get_db),
) -> dict | JSONResponse:
    """Rotate the refresh token and issue a new access token.

    Args:
        response: The injected response, for setting/clearing the cookie.
        doppia_refresh: The refresh token from the HttpOnly cookie (``None`` if
            no cookie is present — i.e. no active session).
        db: Async database session, for the caller's role set.

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
    return await _session_body(session, db)


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


@router.post(
    "/oauth/{provider}/start",
    response_model=OAuthStartResponse,
    summary="Begin an OAuth sign-in; returns the URL to navigate to",
    response_description="The Supabase authorize URL, plus the PKCE cookie.",
)
async def oauth_start(
    response: Response,
    provider: str = Path(description="OAuth provider; 'google' at launch."),
) -> dict | JSONResponse:
    """Mint a PKCE pair and hand back the provider's authorize URL.

    The SPA must **navigate** to the returned URL (``location.assign``), not
    fetch it: the CSP has no ``*.supabase.co`` in ``connect-src`` and does not
    need one, because a top-level navigation is not a fetch.

    The return address is not a parameter. Supabase does not validate
    ``redirect_to`` when handing off to the provider, so a caller-supplied one
    would make this an open redirect; it comes from ``PUBLIC_APP_URL`` instead.

    Args:
        response: The injected response, for setting the PKCE cookie.
        provider: The OAuth provider to start a flow with.

    Returns:
        The ``OAuthStartResponse`` body, or an error envelope: 404 for an
        unsupported provider, 503 when Auth or ``PUBLIC_APP_URL`` is
        unconfigured.
    """
    if provider not in supabase_auth.SUPPORTED_OAUTH_PROVIDERS:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content=ErrorResponse.make(
                code=ErrorCode.NOT_FOUND,
                message=f"OAuth provider '{provider}' is not supported.",
                detail={"supported": sorted(supabase_auth.SUPPORTED_OAUTH_PROVIDERS)},
            ).model_dump(),
        )
    verifier, challenge = supabase_auth.generate_pkce_pair()
    try:
        authorize_url = supabase_auth.oauth_authorize_url(provider, challenge)
    except SupabaseAuthError as exc:
        return _auth_error(exc, on_login=True)
    _set_pkce_cookie(response, verifier)
    return OAuthStartResponse(authorize_url=authorize_url).model_dump()


@router.post(
    "/oauth/callback",
    response_model=SessionResponse,
    summary="Complete an OAuth sign-in from the authorization code",
    response_description="A session, exactly as password login returns.",
)
async def oauth_callback(
    payload: OAuthCallbackRequest,
    response: Response,
    doppia_pkce: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict | JSONResponse:
    """Exchange the authorization code for a session, server-side.

    This is the leg that keeps ADR-035 intact for OAuth: the code arrives in the
    browser, but the *tokens* never do — the exchange happens here and the
    refresh token goes straight into the HttpOnly cookie, exactly as it does on
    the password path.

    Args:
        payload: The authorization code from the callback redirect.
        response: The injected response, for the cookie swap.
        doppia_pkce: The verifier from the HttpOnly cookie (``None`` if the flow
            was never started here, or took longer than the cookie's lifetime).
        db: Async database session, for the caller's role set.

    Returns:
        The ``SessionResponse`` body on success; a 401 envelope when the
        verifier is missing or the code does not match it; a 503 envelope when
        Auth is unreachable.
    """
    if not doppia_pkce:
        err = JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=ErrorResponse.make(
                code=ErrorCode.UNAUTHORIZED,
                message="No sign-in is in progress. Start again.",
            ).model_dump(),
        )
        _clear_pkce_cookie(err)
        return err

    try:
        session = await supabase_auth.pkce_grant(payload.code, doppia_pkce)
    except SupabaseAuthError as exc:
        err = _auth_error(exc, on_login=False)
        # The verifier is single-use: a failed exchange cannot be retried with
        # the same code, so the cookie goes regardless of why it failed.
        _clear_pkce_cookie(err)
        return err

    _clear_pkce_cookie(response)
    _set_refresh_cookie(response, session.refresh_token)
    return await _session_body(session, db)


@router.post(
    "/signup",
    response_model=None,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Register an account (refused while registration is invite-only)",
    response_description="202 once the confirmation email is on its way.",
)
async def signup(payload: SignUpRequest) -> Response | JSONResponse:
    """Create an unverified account and let Supabase send the confirmation.

    The gate lives here rather than in the service so that the registration
    policy has exactly one home. While ``REGISTRATION_MODE=invite`` there is no
    self-service path at all: accounts come from admin-issued invite emails
    (Step 10), and this endpoint refuses everything.

    Args:
        payload: The email and chosen password.

    Returns:
        202 with no body on success; 403 ``REGISTRATION_CLOSED`` while
        invite-only; an error envelope if Supabase rejects or is unreachable.
    """
    if supabase_auth.registration_mode() != supabase_auth.REGISTRATION_OPEN:
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content=ErrorResponse.make(
                code=ErrorCode.REGISTRATION_CLOSED,
                message="Registration is currently by invitation only.",
            ).model_dump(),
        )
    try:
        await supabase_auth.sign_up(payload.email, payload.password)
    except SupabaseAuthError as exc:
        return _auth_error(exc, on_login=True)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.post(
    "/resend-verification",
    response_model=None,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Re-send the sign-up confirmation email",
    response_description="202 whether or not the address is registered.",
)
async def resend_verification(payload: EmailRequest) -> Response | JSONResponse:
    """Ask Supabase to re-send a confirmation email.

    Always answers 202, even for an address that was never registered. Reporting
    the difference would turn this into an oracle for which addresses hold
    accounts, and the caller has no legitimate use for the distinction: someone
    who owns the address learns the answer from their inbox.

    Args:
        payload: The address awaiting confirmation.

    Returns:
        202 with no body; a 503 envelope only if Auth is unreachable.
    """
    try:
        await supabase_auth.resend_verification(payload.email)
    except SupabaseAuthError as exc:
        if exc.status_code >= 503:
            return _auth_error(exc, on_login=False)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.post(
    "/password-reset",
    response_model=None,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Send a password-recovery email",
    response_description="202 whether or not the address is registered.",
)
async def password_reset(payload: EmailRequest) -> Response | JSONResponse:
    """Ask Supabase to send a recovery link.

    Answers 202 regardless of whether the address exists, for the same reason
    as :func:`resend_verification`.

    Args:
        payload: The address to recover.

    Returns:
        202 with no body; a 503 envelope only if Auth is unreachable.
    """
    try:
        await supabase_auth.request_password_reset(payload.email)
    except SupabaseAuthError as exc:
        if exc.status_code >= 503:
            return _auth_error(exc, on_login=False)
    return Response(status_code=status.HTTP_202_ACCEPTED)


@router.post(
    "/password",
    response_model=None,
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Set a new password for the authenticated caller",
    response_description="204 once the password is changed.",
)
async def update_password(
    payload: PasswordUpdateRequest,
    request: Request,
) -> Response | JSONResponse:
    """Change the caller's password.

    Serves both entry points with one endpoint: a user who followed a recovery
    link (the exchanged session authorises exactly this) and a signed-in user
    changing their password deliberately. Supabase authorises the write with the
    caller's own bearer token, so no admin credential is in play and no role
    check is needed — holding the token *is* the authorisation.

    Args:
        payload: The new password.
        request: The incoming request, for the bearer token.

    Returns:
        204 on success; 401 if the request carries no bearer token or Supabase
        rejects it; a 503 envelope if Auth is unreachable.
    """
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=ErrorResponse.make(
                code=ErrorCode.UNAUTHORIZED,
                message="Authentication required.",
            ).model_dump(),
        )
    try:
        await supabase_auth.update_password(
            authorization.removeprefix("Bearer ").strip(), payload.password
        )
    except SupabaseAuthError as exc:
        return _auth_error(exc, on_login=False)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/verify-link",
    response_model=SessionResponse,
    summary="Redeem an emailed one-time token for a session",
    response_description="A session, exactly as password login returns.",
)
async def verify_link(
    payload: EmailLinkRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict | JSONResponse:
    """Establish a session from a recovery, invite, or confirmation link.

    The email-link counterpart to the OAuth callback, and server-side for the
    same reason: Supabase's own verify endpoint redirects back with the session
    in the URL, which would hand a refresh token to JavaScript. Here the browser
    carries only an opaque single-use hash and receives only the cookie.

    Args:
        payload: The ``token_hash`` and link type from the link's query string.
        response: The injected response, for setting the refresh cookie.
        db: Async database session, for the caller's role set.

    Returns:
        The ``SessionResponse`` body on success; 404 for an unknown link type;
        401 if the link is expired or already redeemed; 503 if Auth is
        unreachable.
    """
    if payload.type not in supabase_auth.VERIFIABLE_LINK_TYPES:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content=ErrorResponse.make(
                code=ErrorCode.NOT_FOUND,
                message=f"Link type '{payload.type}' is not supported.",
                detail={"supported": sorted(supabase_auth.VERIFIABLE_LINK_TYPES)},
            ).model_dump(),
        )
    try:
        session = await supabase_auth.verify_email_link(
            payload.token_hash, payload.type
        )
    except SupabaseAuthError as exc:
        return _auth_error(exc, on_login=False)

    _set_refresh_cookie(response, session.refresh_token)
    return await _session_body(session, db)
