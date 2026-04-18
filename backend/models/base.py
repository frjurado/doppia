"""SQLAlchemy 2.0 async engine setup and declarative base.

Provides the engine lifecycle functions called by the application lifespan
(``init_db`` / ``close_db``) and the ``get_db`` FastAPI dependency used by
route handlers to obtain a database session.

The engine is stored in module-level variables initialised once during
startup, so ``get_db`` can reference it without importing the FastAPI app.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

# Module-level singletons — set by init_db(), read by get_db().
_engine: AsyncEngine | None = None
_async_session_factory: async_sessionmaker[AsyncSession] | None = None


class Base(DeclarativeBase):
    """Declarative base class for all SQLAlchemy ORM models."""


def init_db(database_url: str) -> AsyncEngine:
    """Initialise the async SQLAlchemy engine and session factory.

    Must be called once during application lifespan startup before any
    database operations are attempted. Subsequent calls overwrite the
    previous engine without disposing it — call ``close_db()`` first if
    reinitialising.

    Args:
        database_url: Full async DSN, e.g.
            ``postgresql+asyncpg://user:pass@host/db``.

    Returns:
        The configured ``AsyncEngine`` instance.
    """
    global _engine, _async_session_factory
    _engine = create_async_engine(
        database_url,
        echo=False,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
    )
    _async_session_factory = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    return _engine


async def close_db() -> None:
    """Dispose the async engine and release all pooled connections.

    Called during application lifespan shutdown.

    Raises:
        RuntimeError: If ``init_db()`` was never called.
    """
    if _engine is None:
        raise RuntimeError("close_db() called before init_db().")
    await _engine.dispose()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a scoped async database session.

    Yields:
        An ``AsyncSession`` bound to the initialised engine. The session
        is closed automatically when the request completes.

    Raises:
        RuntimeError: If ``init_db()`` was never called (lifespan incomplete).
    """
    if _async_session_factory is None:
        raise RuntimeError(
            "Database not initialised. Was init_db() called during lifespan startup?"
        )
    async with _async_session_factory() as session:
        yield session
