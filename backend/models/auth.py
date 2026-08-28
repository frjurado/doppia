"""Pydantic models for the ``/api/v1/auth`` session endpoints (Component 10 Step 7).

The access token is returned in the JSON body (the client holds it in memory);
the refresh token is never modelled here — it lives only in the HttpOnly cookie
set by the router and never crosses into JavaScript.
"""

from __future__ import annotations

from pydantic import BaseModel, EmailStr


class LoginRequest(BaseModel):
    """Credentials posted to ``POST /api/v1/auth/login``.

    Attributes:
        email: The user's email address.
        password: The user's password (never logged).
    """

    email: EmailStr
    password: str


class AuthUser(BaseModel):
    """The authenticated user summary returned alongside a session.

    Attributes:
        id: The Supabase user id (``sub``).
        email: The user's email.
        roles: The roles granted to the account in ``user_role``. Empty for a
            plain registered user — ``registered`` is implicit in holding an
            account and is never stored as a grant (ADR-037).
        email_verified: Whether the address is confirmed. Unverified accounts
            can sign in but cannot create content, so the SPA shows the
            resend-verification banner on this flag.
    """

    id: str
    email: str
    roles: list[str]
    email_verified: bool


class SessionResponse(BaseModel):
    """The body returned by login and refresh.

    The refresh token is deliberately absent — it is delivered only via the
    HttpOnly ``doppia_refresh`` cookie.

    Attributes:
        access_token: The short-lived JWT the client sends as a bearer token.
        token_type: Always ``"bearer"``.
        expires_in: Access-token lifetime in seconds, for scheduling refresh.
        user: The authenticated user summary.
    """

    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: AuthUser


class OAuthStartResponse(BaseModel):
    """The body returned by ``POST /api/v1/auth/oauth/{provider}/start``.

    Attributes:
        authorize_url: The Supabase URL the browser must *navigate* to (a
            full-page redirect, not a fetch — see ADR-035's OAuth amendment).
    """

    authorize_url: str


class OAuthCallbackRequest(BaseModel):
    """The authorization code the SPA received on the callback redirect.

    The PKCE verifier is deliberately absent: it never reached the browser. It
    travels in the HttpOnly ``doppia_pkce`` cookie and is read server-side.

    Attributes:
        code: The ``code`` query parameter Supabase appended to the redirect.
    """

    code: str


class SignUpRequest(BaseModel):
    """Credentials posted to ``POST /api/v1/auth/signup``.

    Attributes:
        email: The address to register.
        password: The chosen password (never logged). Strength rules are
            Supabase's; duplicating them here would be a second source of truth.
    """

    email: EmailStr
    password: str


class EmailRequest(BaseModel):
    """An address alone — resend-verification and password-reset requests.

    Attributes:
        email: The address to send to.
    """

    email: EmailStr


class PasswordUpdateRequest(BaseModel):
    """A new password for the authenticated caller.

    Attributes:
        password: The new password (never logged).
    """

    password: str


class EmailLinkRequest(BaseModel):
    """The one-time token carried by a Supabase email link.

    Attributes:
        token_hash: The ``token_hash`` query parameter — opaque and single-use.
        type: The link kind (``recovery``, ``invite``, ``signup``,
            ``email_change``), which tells Supabase what is being redeemed.
    """

    token_hash: str
    type: str
