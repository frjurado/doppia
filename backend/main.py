"""FastAPI application entry point for the Doppia backend.

Creates and configures the FastAPI application: CORS middleware,
JWT authentication middleware, global exception handlers, versioned router,
and lifespan hooks that open and close database connections.

Usage with uvicorn::

    uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

# Load .env from repo root when running locally (no-op if vars already set).
load_dotenv(Path(__file__).parent.parent / ".env")

import httpx
from api.middleware.auth import AuthMiddleware
from api.middleware.errors import (
    doppia_error_handler,
    http_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from errors import DoppiaError
from api.router import router
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from models.base import close_db, init_db
from neo4j import AsyncDriver, AsyncGraphDatabase
from starlette.exceptions import HTTPException

logger = logging.getLogger(__name__)

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
    """Manage application lifespan: open DB connections on startup, close on shutdown.

    Raises ``RuntimeError`` at startup if ``AUTH_MODE=local`` is set outside a
    local environment — the misconfiguration must fail loudly at deploy time, not
    silently per-request. See ``docs/architecture/security-model.md`` § auth bypass.

    Initialises:
        - SQLAlchemy async engine (PostgreSQL via asyncpg) via ``models.base.init_db``
        - Neo4j async driver

    Both are stored on ``app.state`` for direct access where needed.
    The SQLAlchemy engine is also registered module-globally in ``models.base``
    so that the ``get_db()`` dependency can resolve sessions without importing
    the app object.

    Args:
        app: The FastAPI application instance.

    Yields:
        Control to the running application between startup and shutdown.
    """
    # Refuse to start if the dev auth bypass is enabled outside a local environment.
    # Per docs/architecture/security-model.md: misconfiguration must be loud at
    # deploy time, not silent until someone hits the API and gets 401s.
    auth_mode = os.environ.get("AUTH_MODE", "supabase")
    environment = os.environ.get("ENVIRONMENT", "production")
    if auth_mode == "local" and environment != "local":
        raise RuntimeError(
            f"AUTH_MODE=local is set but ENVIRONMENT={environment!r}. "
            "Refusing to start: the dev auth bypass is only permitted when "
            "ENVIRONMENT=local. Set AUTH_MODE=supabase (or remove AUTH_MODE) "
            "for non-local environments."
        )

    database_url = os.environ["DATABASE_URL"]
    neo4j_uri = os.environ["NEO4J_URI"]
    neo4j_user = os.environ["NEO4J_USER"]
    neo4j_password = os.environ["NEO4J_PASSWORD"]

    logger.info("Startup: initialising database connections.")

    engine = init_db(database_url)
    app.state.db_engine = engine

    neo4j_driver: AsyncDriver = AsyncGraphDatabase.driver(
        neo4j_uri,
        auth=(neo4j_user, neo4j_password),
    )
    await neo4j_driver.verify_connectivity()
    app.state.neo4j_driver = neo4j_driver

    # Fetch Supabase JWKS for ES256 token verification (new Supabase projects).
    # Stored on app.state so the auth middleware can access it without an env var.
    # Falls back gracefully to None; middleware then tries SUPABASE_JWT_SECRET (HS256).
    supabase_url = os.environ.get("SUPABASE_URL", "")
    app.state.jwks: dict | None = None
    if supabase_url:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{supabase_url}/auth/v1/.well-known/jwks.json", timeout=5.0
                )
                resp.raise_for_status()
                app.state.jwks = resp.json()
                logger.info("Startup: Supabase JWKS fetched successfully.")
        except Exception as exc:
            logger.warning("Startup: could not fetch Supabase JWKS: %s", exc)

    logger.info("Startup complete: all connections established.")

    yield

    logger.info("Shutdown: closing database connections.")
    await close_db()
    await neo4j_driver.close()
    logger.info("Shutdown complete.")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Registers exception handlers, middleware (in correct Starlette order),
    and the versioned API router. Called once at module import time.

    Returns:
        A fully configured ``FastAPI`` instance ready for use with uvicorn.
    """
    application = FastAPI(
        title="Doppia API",
        description="Open music analysis repository — notation infrastructure and editorial tools.",  # noqa: E501
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    # Exception handlers — registered before middleware so they apply globally.
    # DoppiaError is registered first: typed domain exceptions take priority
    # over the bare HTTPException fallback.
    application.add_exception_handler(DoppiaError, doppia_error_handler)
    application.add_exception_handler(HTTPException, http_exception_handler)
    application.add_exception_handler(
        RequestValidationError, validation_exception_handler
    )
    application.add_exception_handler(Exception, unhandled_exception_handler)

    # Middleware — Starlette inserts each at the front of the stack, so
    # registration order is the reverse of execution order on ingress.
    # AuthMiddleware registered first → executes second (inner, closer to routes).
    # CORSMiddleware registered second → executes first (outer, handles preflight).
    application.add_middleware(AuthMiddleware)

    environment = os.environ.get("ENVIRONMENT", "production")
    origins = _ALLOWED_ORIGINS.get(environment, [])
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Versioned API router — all endpoints live under /api/v1/.
    application.include_router(router)

    # Serve the built React SPA in staging/production.
    # The static/ directory is present in the Docker image (copied from the
    # frontend build stage) but absent in local development, where Vite runs
    # separately.
    #
    # StaticFiles(html=True) only serves index.html for directory requests, not
    # for unknown paths like /login. A catch-all route is required so React
    # Router can handle client-side navigation: serve the requested file if it
    # exists (JS/CSS assets), otherwise fall back to index.html.
    _static_dir = Path(__file__).parent / "static"
    if _static_dir.is_dir():
        application.mount(
            "/assets",
            StaticFiles(directory=str(_static_dir / "assets")),
            name="assets",
        )

        @application.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(full_path: str) -> FileResponse:
            file_path = _static_dir / full_path
            if file_path.is_file():
                return FileResponse(file_path)
            return FileResponse(_static_dir / "index.html")

    return application


app = create_app()
