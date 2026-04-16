"""FastAPI application factory for the Doppia backend.

Creates and configures the FastAPI application instance, including CORS middleware,
router registration, and lifespan events for database connection management.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Allowed origins per environment — never use ["*"] with allow_credentials=True.
# See docs/architecture/security-model.md § CORS policy.
_ALLOWED_ORIGINS: dict[str, list[str]] = {
    "local": [
        "http://localhost:5173",  # Vite dev server
        "http://localhost:4173",  # Vite preview
    ],
    "staging": [
        "https://doppia-staging.fly.dev",
    ],
    "production": [
        "https://doppia.app",
    ],
}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application lifespan: open DB connections on startup, close on shutdown."""
    # TODO: initialise Neo4j driver and SQLAlchemy engine here (Component 1+)
    yield
    # TODO: close Neo4j driver and SQLAlchemy engine here


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Returns:
        A fully configured FastAPI instance ready for use with uvicorn.
    """
    app = FastAPI(
        title="Doppia API",
        description="Open music analysis repository — notation infrastructure and editorial tools.",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    # CORS — allowlist driven by ENVIRONMENT; never wildcard with credentials.
    environment = os.environ.get("ENVIRONMENT", "production")
    origins = _ALLOWED_ORIGINS.get(environment, [])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Routers — registered here as components are built (all prefixed /api/v1/).
    # Example: from api.routers import scores
    #          app.include_router(scores.router, prefix="/api/v1")

    return app


app = create_app()
