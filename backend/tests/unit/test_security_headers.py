"""Unit tests for SecurityHeadersMiddleware (Component 10 Step 9).

Verifies the response headers from ``security-model.md`` § 7 are present, that
HSTS is gated to production, that ``CSP_REPORT_ONLY`` swaps the enforcing header
for the report-only one, and that the CSP carries the directives the SPA needs
(the Verovio WASM ``'wasm-unsafe-eval'`` and the R2 hosts for MEI / soundfonts /
preview images). The browser-level "no console violations, Verovio renders, MIDI
plays" check is a post-deploy manual step (it needs a real browser) — these
tests pin the header contract.
"""

from __future__ import annotations

from api.middleware.security_headers import SecurityHeadersMiddleware, build_csp
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


def _app(environment: str, *, report_only: bool = False) -> FastAPI:
    """Build a one-route app wrapped in the security-headers middleware."""
    app = FastAPI()
    app.add_middleware(
        SecurityHeadersMiddleware,
        environment=environment,
        report_only=report_only,
    )

    @app.get("/x")
    async def _x() -> dict[str, bool]:
        return {"ok": True}

    return app


async def _get(app: FastAPI):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get("/x")


async def test_core_headers_present_on_every_response() -> None:
    resp = await _get(_app("staging"))
    assert resp.headers["content-security-policy"] == build_csp()
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["x-frame-options"] == "DENY"


async def test_hsts_only_in_production() -> None:
    assert "strict-transport-security" not in (await _get(_app("staging"))).headers
    assert "strict-transport-security" not in (await _get(_app("local"))).headers
    prod = (await _get(_app("production"))).headers
    assert prod["strict-transport-security"] == "max-age=63072000; includeSubDomains"


async def test_report_only_swaps_the_header() -> None:
    resp = await _get(_app("staging", report_only=True))
    assert "content-security-policy-report-only" in resp.headers
    assert "content-security-policy" not in resp.headers
    assert resp.headers["content-security-policy-report-only"] == build_csp()


def test_csp_allows_what_the_spa_actually_loads() -> None:
    csp = build_csp()
    # Verovio WASM instantiation.
    assert "'wasm-unsafe-eval'" in csp
    # MEI text + presigned preview/incipit fetches, and public soundfonts.
    assert (
        "connect-src 'self' https://*.r2.cloudflarestorage.com https://*.r2.dev" in csp
    )
    assert "https://*.r2.cloudflarestorage.com" in csp  # img-src previews/incipits
    # Verovio SVG inline <style> blocks.
    assert "style-src 'self' 'unsafe-inline'" in csp
    # Clickjacking + base-tag hardening.
    assert "frame-ancestors 'none'" in csp
    assert "object-src 'none'" in csp
    # The browser no longer talks to Supabase directly (ADR-035).
    assert "supabase" not in csp
