"""Authentication middleware.

``validate_auth()`` is the entry point called by the ``get_current_user``
dependency in ``api/dependencies.py``. Full Supabase JWT validation is
implemented here; the dev bypass lives in dependencies.py.

See docs/architecture/security-model.md § The development auth bypass.
"""

from __future__ import annotations

import os

from fastapi import HTTPException, Request, status

from api.dependencies import AuthenticatedUser


async def validate_supabase_jwt(request: Request) -> AuthenticatedUser:
    """Validate a Supabase JWT from the Authorization header.

    Verifies the token signature against ``SUPABASE_JWT_SECRET`` and extracts
    the ``sub`` (user id), ``email``, and ``role`` claims.

    Args:
        request: The incoming FastAPI request.

    Returns:
        An AuthenticatedUser populated from the JWT claims.

    Raises:
        HTTPException: 401 if the Authorization header is missing, the token
            is malformed, the signature is invalid, or the token is expired.
    """
    # TODO: implement full JWT validation (Component 1 auth task).
    # Steps:
    #   1. Extract bearer token from Authorization header.
    #   2. Decode with python-jose using SUPABASE_JWT_SECRET and HS256.
    #   3. Validate exp, iss claims.
    #   4. Extract sub (user id), email, and app_metadata.role.
    #   5. Return AuthenticatedUser(id=sub, role=role, email=email).
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Supabase JWT validation not yet implemented.",
        headers={"WWW-Authenticate": "Bearer"},
    )
