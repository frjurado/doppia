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

import os
from dataclasses import dataclass

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
        role: The application role read from ``app_metadata.role`` (``editor``
            or ``admin``); empty string if unset.
    """

    access_token: str
    refresh_token: str
    expires_in: int
    user_id: str
    email: str
    role: str


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
    app_metadata = user.get("app_metadata") or {}
    return SupabaseSession(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=int(payload.get("expires_in", 3600)),
        user_id=user.get("id", ""),
        email=user.get("email", ""),
        role=app_metadata.get("role", ""),
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
            "invalid_grant"
            if params.get("grant_type") == "refresh_token"
            else ("invalid_credentials")
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
