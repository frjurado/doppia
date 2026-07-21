"""Security response headers (Component 10 Step 9; security-model.md § 7).

Adds a restrictive Content-Security-Policy, ``X-Content-Type-Options: nosniff``,
``X-Frame-Options: DENY``, and — in production only — HSTS to every response.

The CSP is derived from what the SPA actually loads (verified against the tree,
Component 10 Step 9):

* ``script-src 'self' 'wasm-unsafe-eval' blob:`` — the entry bundle is a
  same-origin module (no inline script in ``index.html``); ``'wasm-unsafe-eval'``
  is required to instantiate the Verovio WASM toolkit; ``blob:`` covers any
  blob-URL worker/worklet the renderer or Tone.js audio graph spins up.
* ``style-src 'self' 'unsafe-inline'`` — Verovio's SVG output carries inline
  ``<style>`` blocks; component CSS is same-origin.
* ``img-src … https://*.r2.cloudflarestorage.com`` — fragment previews and
  movement incipits are ``<img>`` tags pointing at presigned R2 URLs.
* ``connect-src … https://*.r2.cloudflarestorage.com https://*.r2.dev`` — MEI is
  fetched as text from presigned R2 URLs; Tone.js fetches piano soundfonts from
  the public ``r2.dev`` bucket.
* ``font-src 'self'`` — fonts are bundled (``@fontsource``), served same-origin.
* No ``*.supabase.co`` origin: the browser never calls Supabase directly — the
  ``/api/v1/auth`` router proxies the grant (ADR-035).

``CSP_REPORT_ONLY=1`` emits ``Content-Security-Policy-Report-Only`` instead of
the enforcing header — a safety valve to diagnose a violation on a live
environment without shipping code. HSTS is emitted only when
``ENVIRONMENT=production`` (the production domain is confirmed there); on
staging (``*.fly.dev``) it is intentionally omitted.
"""

from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# The Content-Security-Policy directives, in source order. Kept as a list so the
# policy is readable and diffable; joined with "; " at construction time.
_CSP_DIRECTIVES: list[str] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.r2.cloudflarestorage.com",
    "font-src 'self'",
    "connect-src 'self' https://*.r2.cloudflarestorage.com https://*.r2.dev",
    "media-src 'self' blob: https://*.r2.dev",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "form-action 'self'",
]

# max-age = 2 years, the value recommended for HSTS preload eligibility.
_HSTS_VALUE = "max-age=63072000; includeSubDomains"


def build_csp() -> str:
    """Return the assembled Content-Security-Policy header value."""
    return "; ".join(_CSP_DIRECTIVES)


class SecurityHeadersMiddleware:
    """Pure-ASGI middleware that stamps security headers on every HTTP response.

    A pure-ASGI implementation (wrapping ``send``) is used rather than
    ``BaseHTTPMiddleware`` so it never buffers response bodies — important with
    the large static assets (the ~7–10 MB Verovio WASM) served by the SPA mount.

    Attributes:
        app: The wrapped ASGI application.
        environment: The deployment environment; HSTS is emitted only when it is
            ``"production"``.
        report_only: When true, the CSP is sent as
            ``Content-Security-Policy-Report-Only`` (observed, not enforced).
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        environment: str,
        report_only: bool = False,
    ) -> None:
        """Initialise the middleware and precompute the static header set.

        Args:
            app: The inner ASGI application.
            environment: ``ENVIRONMENT`` value (``local`` | ``staging`` |
                ``production``); gates HSTS.
            report_only: Emit the CSP in report-only mode instead of enforcing.
        """
        self.app = app
        self.environment = environment
        self.report_only = report_only

        csp_header = (
            "content-security-policy-report-only"
            if report_only
            else "content-security-policy"
        )
        headers: list[tuple[str, str]] = [
            (csp_header, build_csp()),
            ("x-content-type-options", "nosniff"),
            ("x-frame-options", "DENY"),
        ]
        if environment == "production":
            headers.append(("strict-transport-security", _HSTS_VALUE))
        self._headers = headers

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Stamp the security headers onto the outgoing response start message."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in self._headers:
                    headers[name] = value
            await send(message)

        await self.app(scope, receive, send_with_headers)


__all__ = ["SecurityHeadersMiddleware", "build_csp"]
