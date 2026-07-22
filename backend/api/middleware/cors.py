"""Path-scoped CORS dispatch: public prefix vs credentialed editor API.

``security-model.md`` § 1 forbids ``allow_origins=["*"]`` together with
``allow_credentials=True`` and requires that a public read-only endpoint
"either disable credentials or be served from a separate API prefix."  The
Phase-2 public read path (``/api/v1/public/``) is that separate prefix, and it
needs the opposite CORS posture from the editor API:

* **Public prefix** — any origin may read it (it is anonymous, read-only
  GET), and credentials are never allowed, so a wildcard origin is safe.
* **Everything else** — the credentialed editor API keeps its explicit
  per-environment origin allowlist with ``allow_credentials=True``.

Starlette's ``CORSMiddleware`` applies one policy to the whole app, so this
module provides a thin ASGI dispatcher that wraps the application in *two*
``CORSMiddleware`` instances and routes each request to exactly one of them
by path.  Only one policy ever touches a given response, so the wildcard and
the credentialed allowlist can never combine.
"""

from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

PUBLIC_API_PREFIX = "/api/v1/public"


class PathScopedCORSMiddleware:
    """ASGI middleware that selects a CORS policy by request path.

    Requests under :data:`PUBLIC_API_PREFIX` get a broad-origin,
    no-credentials, GET-only policy; every other request gets the
    credentialed editor allowlist.  Both policies wrap the same inner
    application, so exactly one ``CORSMiddleware`` handles any request
    (including CORS preflights, which carry the target path in the scope).

    Attributes:
        _public: ``CORSMiddleware`` with the public (wildcard, no-credentials)
            policy.
        _editor: ``CORSMiddleware`` with the credentialed allowlist policy.
    """

    def __init__(self, app: ASGIApp, allowed_origins: list[str]) -> None:
        """Initialise both CORS policies around the same inner app.

        Args:
            app: The inner ASGI application.
            allowed_origins: Explicit origin allowlist for the credentialed
                editor API (per-environment, from ``main._ALLOWED_ORIGINS``).
        """
        self._public = CORSMiddleware(
            app,
            allow_origins=["*"],
            allow_credentials=False,
            allow_methods=["GET"],
            allow_headers=["Accept-Language"],
        )
        self._editor = CORSMiddleware(
            app,
            allow_origins=allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "Accept-Language"],
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Dispatch the request to the policy matching its path.

        Args:
            scope: The ASGI connection scope.
            receive: The ASGI receive callable.
            send: The ASGI send callable.
        """
        if scope["type"] == "http" and _is_public_path(scope.get("path", "")):
            await self._public(scope, receive, send)
        else:
            await self._editor(scope, receive, send)


def _is_public_path(path: str) -> bool:
    """Return True when *path* belongs to the public API prefix.

    Args:
        path: The request path from the ASGI scope.

    Returns:
        True for the prefix itself or any path nested under it.
    """
    return path == PUBLIC_API_PREFIX or path.startswith(PUBLIC_API_PREFIX + "/")
