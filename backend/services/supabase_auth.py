"""Server-side Supabase Auth REST client (Component 10 Step 7).

The Phase-1 frontend called the Supabase Auth token endpoint directly from the
browser and kept the access token in ``localStorage`` (ADR-016). Phase 2 moves
the credential exchange to the backend so the **refresh token never reaches
JavaScript**: the browser POSTs credentials to our ``/api/v1/auth`` router, the
backend performs the Supabase grant, stores the refresh token in an HttpOnly
cookie, and returns only the short-lived access token to the client.

This module is the thin async HTTP client for the three Supabase Auth calls the
router needs: the password grant (login), the refresh grant (silent renewal),
and logout (refresh-token revocation). It holds no cookie or FastAPI concerns —
those live in ``api/routes/auth.py``.

The Supabase anon key is public by design (it grants nothing without a valid
grant); it is sent as the ``apikey`` header Supabase requires.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlencode

import httpx

# Client-facing token exchanges are short; keep the timeout tight so a stalled
# Supabase Auth call surfaces as a 503 rather than hanging the request.
_AUTH_TIMEOUT_S = 10.0


class SupabaseAuthError(Exception):
    """A Supabase Auth grant failed.

    Attributes:
        status_code: The HTTP status Supabase returned (or 502/503 for
            transport failures), used by the router to choose its own response.
        code: A short machine code (``invalid_credentials``, ``invalid_grant``,
            ``unavailable``) for mapping to the API error envelope.
        message: A human-readable description (never shown verbatim to end
            users — the frontend substitutes a translated string).
    """

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(frozen=True)
class SupabaseSession:
    """The subset of a Supabase token response the auth router needs.

    Attributes:
        access_token: The short-lived JWT the client sends as a bearer token.
        refresh_token: The long-lived token stored in the HttpOnly cookie and
            never exposed to the browser's JavaScript.
        expires_in: Access-token lifetime in seconds (Supabase default 3600),
            returned to the client so it can schedule a silent refresh.
        user_id: The Supabase user id (``sub``).
        email: The user's email.
        email_verified: Whether Supabase has confirmed the address. Roles are
            deliberately absent: they live in ``user_role`` and are read from
            PostgreSQL by the route, never from Supabase metadata (ADR-037).
    """

    access_token: str
    refresh_token: str
    expires_in: int
    user_id: str
    email: str
    email_verified: bool


def _auth_base_url() -> str:
    """Return the Supabase Auth v1 base URL, or raise if unconfigured.

    Returns:
        ``<SUPABASE_URL>/auth/v1`` with no trailing slash.

    Raises:
        SupabaseAuthError: 503 if ``SUPABASE_URL`` is not set (the backend
            cannot perform a grant), so the router returns a service error
            rather than constructing a malformed request.
    """
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="Supabase Auth is not configured (SUPABASE_URL unset).",
        )
    return f"{supabase_url}/auth/v1"


def _anon_key() -> str:
    """Return the Supabase anon key for the ``apikey`` header, or raise.

    Returns:
        The value of ``SUPABASE_ANON_KEY``.

    Raises:
        SupabaseAuthError: 503 if the anon key is not configured.
    """
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not anon_key:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="Supabase Auth is not configured (SUPABASE_ANON_KEY unset).",
        )
    return anon_key


def _session_from_payload(payload: dict) -> SupabaseSession:
    """Build a :class:`SupabaseSession` from a Supabase token-response body.

    Args:
        payload: The parsed JSON body of a Supabase token grant.

    Returns:
        The extracted session.

    Raises:
        SupabaseAuthError: 502 if the response is missing the tokens (an
            unexpected Supabase contract change), so the router does not set an
            empty cookie or hand back a null access token.
    """
    access_token = payload.get("access_token")
    refresh_token = payload.get("refresh_token")
    if not access_token or not refresh_token:
        raise SupabaseAuthError(
            status_code=502,
            code="unavailable",
            message="Supabase Auth returned no tokens.",
        )
    user = payload.get("user") or {}
    user_metadata = user.get("user_metadata") or {}
    return SupabaseSession(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=int(payload.get("expires_in", 3600)),
        user_id=user.get("id", ""),
        email=user.get("email", ""),
        email_verified=bool(
            user.get("email_confirmed_at") or user_metadata.get("email_verified")
        ),
    )


async def _token_grant(params: dict[str, str], body: dict[str, str]) -> SupabaseSession:
    """POST a token grant to Supabase Auth and parse the session.

    Args:
        params: Query parameters (the ``grant_type`` selector).
        body: The JSON request body (credentials or the refresh token).

    Returns:
        The parsed :class:`SupabaseSession`.

    Raises:
        SupabaseAuthError: On a non-2xx Supabase response (mapped from the
            status) or a transport failure (503).
    """
    base = _auth_base_url()
    headers = {"apikey": _anon_key(), "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=_AUTH_TIMEOUT_S) as client:
            response = await client.post(
                f"{base}/token", params=params, headers=headers, json=body
            )
    except httpx.HTTPError as exc:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="Could not reach the authentication service.",
        ) from exc

    if response.status_code >= 400:
        # 400 grant_type=password → bad credentials; 400 refresh → expired/reused
        # refresh token. Both map to 401 at our boundary (the client must
        # re-authenticate); a 5xx from Supabase maps to 503.
        code = (
            "invalid_credentials"
            if params.get("grant_type") == "password"
            else "invalid_grant"
        )
        if response.status_code >= 500:
            raise SupabaseAuthError(
                status_code=503,
                code="unavailable",
                message="The authentication service is unavailable.",
            )
        raise SupabaseAuthError(
            status_code=401, code=code, message="Authentication failed."
        )

    return _session_from_payload(response.json())


async def password_grant(email: str, password: str) -> SupabaseSession:
    """Exchange email/password for a Supabase session (login).

    Args:
        email: The user's email.
        password: The user's password.

    Returns:
        The new :class:`SupabaseSession`.

    Raises:
        SupabaseAuthError: 401 on bad credentials, 503 if Auth is unreachable.
    """
    return await _token_grant(
        params={"grant_type": "password"},
        body={"email": email, "password": password},
    )


async def refresh_grant(refresh_token: str) -> SupabaseSession:
    """Exchange a refresh token for a fresh Supabase session (silent renewal).

    Supabase rotates refresh tokens: the returned session carries a **new**
    refresh token, which the router writes back into the cookie.

    Args:
        refresh_token: The refresh token from the HttpOnly cookie.

    Returns:
        The rotated :class:`SupabaseSession`.

    Raises:
        SupabaseAuthError: 401 if the refresh token is expired/revoked/reused,
            503 if Auth is unreachable.
    """
    return await _token_grant(
        params={"grant_type": "refresh_token"},
        body={"refresh_token": refresh_token},
    )


async def logout(access_token: str) -> None:
    """Best-effort server-side logout: revoke the session at Supabase.

    Failures are swallowed — the router clears the cookie regardless, so the
    client session ends even if the revocation call does not land.

    Args:
        access_token: The caller's current access token (Supabase authorises
            the logout with the user's own bearer token).
    """
    try:
        base = _auth_base_url()
        headers = {
            "apikey": _anon_key(),
            "Authorization": f"Bearer {access_token}",
        }
        async with httpx.AsyncClient(timeout=_AUTH_TIMEOUT_S) as client:
            await client.post(f"{base}/logout", headers=headers)
    except (SupabaseAuthError, httpx.HTTPError):
        # Revocation is best-effort; the cookie is cleared by the router.
        return


# ── OAuth (PKCE, brokered by Supabase) ────────────────────────────────────────

# Supabase's authorize endpoint spells the SHA-256 challenge method lowercase.
_PKCE_METHOD = "s256"

#: Providers this proxy will start a flow for. Deliberately a closed set: the
#: provider name is interpolated into the authorize URL, and the roles doc
#: settles Google as the only provider at launch.
SUPPORTED_OAUTH_PROVIDERS: frozenset[str] = frozenset({"google"})


def public_app_url() -> str:
    """Return the origin users are sent back to after an OAuth round trip.

    Read from ``PUBLIC_APP_URL``. This is *not* derived from the request: the
    callback target is a server-side constant, because Supabase does **not**
    validate ``redirect_to`` when it hands off to the provider (verified by
    probe, 2026-08-28 — it forwarded a redirect to an unrelated domain without
    complaint). Accepting a caller-supplied return URL would therefore turn this
    endpoint into an open redirect wearing an OAuth flow as a disguise.

    Returns:
        The origin with no trailing slash.

    Raises:
        SupabaseAuthError: 503 outside local development when ``PUBLIC_APP_URL``
            is unset. Failing loudly beats silently sending staging users to
            localhost.
    """
    configured = os.environ.get("PUBLIC_APP_URL", "").rstrip("/")
    if configured:
        return configured
    if os.environ.get("ENVIRONMENT", "production") == "local":
        return "http://localhost:5173"
    raise SupabaseAuthError(
        status_code=503,
        code="unavailable",
        message="OAuth is not configured (PUBLIC_APP_URL unset).",
    )


def generate_pkce_pair() -> tuple[str, str]:
    """Generate a PKCE verifier and its S256 challenge.

    The verifier never leaves the server — it goes into an HttpOnly cookie and
    comes back on the callback request. That is what makes the brokered flow
    safe to run through a proxy: an authorization code intercepted in transit is
    worthless without the verifier, which no script can read.

    Returns:
        A tuple of ``(verifier, challenge)``, both base64url without padding.
    """
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def oauth_authorize_url(provider: str, code_challenge: str) -> str:
    """Build the Supabase authorize URL for a full-page redirect.

    The browser *navigates* here; it never fetches it. That distinction is what
    keeps ADR-035's CSP intact — ``connect-src`` has no ``*.supabase.co`` entry
    and does not need one, and ``form-action 'self'`` governs form submissions,
    not ``location.assign``.

    Args:
        provider: An entry of :data:`SUPPORTED_OAUTH_PROVIDERS`.
        code_challenge: The S256 challenge from :func:`generate_pkce_pair`.

    Returns:
        The absolute authorize URL, ready to redirect to.

    Raises:
        SupabaseAuthError: 503 if Supabase or the app URL is unconfigured.
        ValueError: If ``provider`` is not supported — a programming error; the
            route validates the caller's input before reaching here.
    """
    if provider not in SUPPORTED_OAUTH_PROVIDERS:
        raise ValueError(f"'{provider}' is not a supported OAuth provider.")
    query = urlencode(
        {
            "provider": provider,
            "redirect_to": f"{public_app_url()}/auth/callback",
            "code_challenge": code_challenge,
            "code_challenge_method": _PKCE_METHOD,
        }
    )
    return f"{_auth_base_url()}/authorize?{query}"


async def pkce_grant(auth_code: str, code_verifier: str) -> SupabaseSession:
    """Exchange an OAuth authorization code for a Supabase session.

    The final leg of the dance: Supabase redirected the browser back to our
    origin with ``?code=``, the SPA handed that code to us, and we complete the
    exchange server-side so the refresh token goes straight into the HttpOnly
    cookie without ever existing in JavaScript.

    Args:
        auth_code: The ``code`` query parameter from the callback redirect.
        code_verifier: The verifier minted at the start of the flow.

    Returns:
        The new :class:`SupabaseSession`.

    Raises:
        SupabaseAuthError: 401 if the code is invalid, already used, or does not
            match the verifier; 503 if Auth is unreachable.
    """
    return await _token_grant(
        params={"grant_type": "pkce"},
        body={"auth_code": auth_code, "code_verifier": code_verifier},
    )


# ── Registration, verification, password reset ────────────────────────────────

#: Registration modes. ``invite`` refuses self-service sign-up entirely (admins
#: issue Supabase invite emails); ``open`` proxies Supabase's signup endpoint.
#: Invite-only at launch, flipped when Collections ship
#: (``roles-and-permissions.md`` § 3) — a config flag, not a code change.
REGISTRATION_INVITE: Final[str] = "invite"
REGISTRATION_OPEN: Final[str] = "open"


def registration_mode() -> str:
    """Return the effective registration mode.

    Defaults to ``invite``: an unset or misspelt value must not accidentally
    open public registration, so anything other than a literal ``open`` closes
    it.

    Returns:
        Either :data:`REGISTRATION_INVITE` or :data:`REGISTRATION_OPEN`.
    """
    configured = (
        os.environ.get("REGISTRATION_MODE", REGISTRATION_INVITE).strip().lower()
    )
    return REGISTRATION_OPEN if configured == REGISTRATION_OPEN else REGISTRATION_INVITE


async def _auth_post(path: str, body: dict, *, params: dict | None = None) -> dict:
    """POST to a Supabase Auth endpoint and return the parsed body.

    Args:
        path: Path under ``/auth/v1`` (leading slash included).
        body: The JSON request body.
        params: Optional query parameters.

    Returns:
        The parsed JSON response, or an empty dict for an empty 200/204.

    Raises:
        SupabaseAuthError: 503 on transport failure or a Supabase 5xx; the
            upstream status otherwise, with the message Supabase supplied.
    """
    base = _auth_base_url()
    headers = {"apikey": _anon_key(), "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=_AUTH_TIMEOUT_S) as client:
            response = await client.post(
                f"{base}{path}", params=params or {}, headers=headers, json=body
            )
    except httpx.HTTPError as exc:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="Could not reach the authentication service.",
        ) from exc

    if response.status_code >= 500:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="The authentication service is unavailable.",
        )
    if response.status_code >= 400:
        raise SupabaseAuthError(
            status_code=response.status_code,
            code="invalid_request",
            message="The authentication service rejected the request.",
        )
    try:
        return response.json()
    except ValueError:
        return {}


async def sign_up(email: str, password: str) -> None:
    """Create an account with email + password, pending email confirmation.

    Supabase sends the confirmation email; the account exists but is unverified
    until the recipient follows it, and ``require_verified`` refuses content
    creation in the meantime.

    The caller is responsible for checking :func:`registration_mode` first —
    this function performs no gating of its own, so the policy lives in exactly
    one place (the route).

    Args:
        email: The address to register.
        password: The chosen password (Supabase enforces its own strength rules).

    Raises:
        SupabaseAuthError: On rejection (weak password, malformed address) or
            an unreachable service.
    """
    await _auth_post(
        "/signup",
        {
            "email": email,
            "password": password,
            "options": {"email_redirect_to": f"{public_app_url()}/auth/callback"},
        },
    )


async def resend_verification(email: str) -> None:
    """Ask Supabase to re-send the sign-up confirmation email.

    Args:
        email: The address awaiting confirmation.

    Raises:
        SupabaseAuthError: Only for transport/service failures. An unknown
            address is *not* an error here — see the route, which reports
            success regardless so the endpoint cannot be used to test whether
            an address is registered.
    """
    await _auth_post(
        "/resend",
        {
            "type": "signup",
            "email": email,
            "options": {"email_redirect_to": f"{public_app_url()}/auth/callback"},
        },
    )


async def request_password_reset(email: str) -> None:
    """Ask Supabase to send a password-recovery email.

    Args:
        email: The address to recover.

    Raises:
        SupabaseAuthError: Only for transport/service failures; see
            :func:`resend_verification` on why an unknown address is not one.
    """
    await _auth_post(
        "/recover",
        {"email": email},
        params={"redirect_to": f"{public_app_url()}/auth/callback"},
    )


async def update_password(access_token: str, password: str) -> None:
    """Set a new password for the caller of ``access_token``.

    Serves both paths that need it: a user who followed a recovery link (whose
    exchanged session authorises exactly this) and a signed-in user changing
    their password. Supabase authorises the write with the user's own bearer
    token, so no admin credential is involved.

    Args:
        access_token: The caller's Supabase access token.
        password: The new password.

    Raises:
        SupabaseAuthError: 401 if the token is expired or already used, 503 if
            Auth is unreachable, or the upstream status on rejection.
    """
    base = _auth_base_url()
    headers = {
        "apikey": _anon_key(),
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=_AUTH_TIMEOUT_S) as client:
            response = await client.put(
                f"{base}/user", headers=headers, json={"password": password}
            )
    except httpx.HTTPError as exc:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="Could not reach the authentication service.",
        ) from exc

    if response.status_code >= 500:
        raise SupabaseAuthError(
            status_code=503,
            code="unavailable",
            message="The authentication service is unavailable.",
        )
    if response.status_code >= 400:
        raise SupabaseAuthError(
            status_code=response.status_code,
            code="invalid_request",
            message="The password could not be updated.",
        )
