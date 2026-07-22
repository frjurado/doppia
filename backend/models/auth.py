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
        role: The application role (``editor`` or ``admin``); empty if unset.
    """

    id: str
    email: str
    role: str


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
