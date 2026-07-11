"""Health check endpoints for liveness probes and keep-alive pings.

``/api/v1/health`` is the cheap liveness probe used by Fly.io — it touches
nothing. ``/api/v1/health/deep`` additionally runs a trivial query against PostgreSQL
(Supabase) and Neo4j (AuraDB); the scheduled keep-alive workflow hits it so
the free-tier stores register activity and never auto-pause (see
``docs/deployment.md`` § "Free-tier operations").

No authentication is required — probes do not carry bearer tokens. Neither
endpoint returns data beyond per-store status strings.
"""

from __future__ import annotations

import logging

from api.dependencies import get_neo4j
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from models.base import get_db
from neo4j import AsyncDriver
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

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


@router.get(
    "/health/deep",
    summary="Deep health probe (touches PostgreSQL and Neo4j)",
    response_description="Per-store connectivity status.",
)
async def deep_health_check(
    db: AsyncSession = Depends(get_db),
    driver: AsyncDriver = Depends(get_neo4j),
) -> JSONResponse:
    """Run a trivial query against each backing store and report per-store status.

    Purpose-built for the scheduled keep-alive ping: Supabase pauses free
    projects after ~1 week without activity and Neo4j AuraDB Free pauses after
    ~3 days, so a periodic request here keeps both awake (and, via Fly's
    ``auto_start_machines``, wakes the app machine itself). Also useful as a
    manual connectivity check.

    Returns:
        200 with ``{"status": "ok", "postgres": "ok", "neo4j": "ok"}`` when
        both stores respond; 503 with the failing store(s) marked ``"error"``
        otherwise. No store data is exposed either way.
    """
    postgres_status = "ok"
    neo4j_status = "ok"

    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("deep health: PostgreSQL check failed")
        postgres_status = "error"

    try:
        async with driver.session() as session:
            await session.run("RETURN 1")
    except Exception:
        logger.exception("deep health: Neo4j check failed")
        neo4j_status = "error"

    healthy = postgres_status == "ok" and neo4j_status == "ok"
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={
            "status": "ok" if healthy else "degraded",
            "postgres": postgres_status,
            "neo4j": neo4j_status,
        },
    )
