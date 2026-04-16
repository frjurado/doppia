"""Health check endpoint for liveness probes.

Used by Fly.io and other load balancers to verify the process is alive.
No authentication is required — probes do not carry bearer tokens.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(tags=["Health"])


@router.get(
    "/health",
    summary="Liveness probe",
    response_description="Service is alive.",
)
async def health_check() -> JSONResponse:
    """Return a liveness status response.

    No authentication required. Used by load balancers and uptime monitors
    to verify the process is running and accepting connections.

    Returns:
        JSON body ``{"status": "ok"}``.
    """
    return JSONResponse(content={"status": "ok"})
